# EdgeCoder Deployment Guide

This document covers deploying EdgeCoder services across Fly.io, Docker, systemd, and native installers.

## Table of Contents

- [Fly.io Deployment](#flyio-deployment)
  - [Database: current state](#database-current-state)
  - [Accounts and machines at a glance](#accounts-and-machines-at-a-glance)
- [Docker Deployment](#docker-deployment)
- [Self-Hosted Linux (systemd)](#self-hosted-linux-systemd)
- [macOS Installer](#macos-installer)
- [Linux .deb Package](#linux-deb-package)
- [Windows .msi Installer](#windows-msi-installer)
- [Environment Variables Reference](#environment-variables-reference)
- [Database migrations](database-migrations.md) (Postgres schema upgrades, locks, and concurrent starts)

---

## Fly.io Deployment

Fly.io configuration files are in `deploy/fly/` (seeds, portal, anchor proxy) and `deploy/lnd-*/`
(Lightning nodes). There is no separate coordinator, inference or control-plane app any more (#33):
the seeds run `EDGE_RUNTIME_MODE=all-in-one`, so a seed *is* the coordinator, inference service and
control plane.

### Services

| Config File | App Name | Region | Entrypoint | Port | VM |
|-------------|----------|--------|------------|------|-----|
| `fly.seed-node.toml` | `edgecoder-seed` | `ord` | `node dist/cli/edgecoder.js all-in-one` (coordinator-only, `SKIP_OLLAMA`) | 4301 | 16 GB, 2 perf CPUs |
| `fly.seed-eu.toml` | `edgecoder-seed-eu` | `cdg` | `node dist/cli/edgecoder.js all-in-one` (+ Ollama via the agent image entrypoint) | 4301 | 8 GB, 2 perf CPUs |
| `fly.portal.toml` | `edgecoder-portal` | `ord` | `node dist/cli/edgecoder.js portal` | 4310 | 1 GB, shared |
| `fly.anchor-proxy.toml` | `edgecoder-anchor-proxy` | `ord` | `node dist/economy/anchor-proxy-service.js` | 4311 | 256 MB, shared |

**The anchor proxy is not deployed.** It is the Bitcoin OP_RETURN broadcast proxy; anchoring is off
in production and planned for mainnet (see [Going to mainnet](going-to-mainnet.md#ledger-anchoring)).

Other apps in the production org:

| App | Config | What it is |
|-----|--------|------------|
| `edgecoder-pg` | created by `fly postgres create` (see [Database: current state](#database-current-state)) | Postgres (postgres-flex 18.1), one node |
| `edgecoder-lnd-test` | `deploy/lnd-test/fly.toml` | LND on regtest, for the payout end-to-end tests |
| `edgecoder-lnd-signet` | `deploy/lnd-signet/fly.toml` | LND on signet ([README](../deploy/lnd-signet/README.md)) |
| `edgecoder-lnd` | `deploy/lnd-mainnet/fly.toml` | LND on mainnet; **not live** ([README](../deploy/lnd-mainnet/README.md)) |
| `edgecoder-agents` | none in this repo | test agents |
| `edgecoder-loadgen` | `scripts/loadgen/fly.sh` | load generator ([load testing](load-testing.md)) |
| `edgecoder-probe` | none in this repo | probe |

### Database: current state

Production runs one Fly Postgres app, `edgecoder-pg` (postgres-flex 18.1), shared by the seeds
(`DATABASE_URL`) and the portal (`PORTAL_DATABASE_URL`):

- **A single node, no replicas.** If its machine or volume fails, the coordinators and the portal
  are down until it is restored.
- **Daily volume snapshots, kept 5 days** (Fly's default). That is the only backup.
- **No backups or point-in-time recovery beyond that.** Fly Postgres backups / PITR are not enabled,
  so up to a day of ledger, wallet and payout data can be lost.

**Known gap before mainnet:** add a replica and enable backups with point-in-time recovery before
real Bitcoin flows through the ledger.

Both seeds set `DISABLE_SELF_AGENT=1` (#39): Fly machines have no Docker, so the embedded worker
could never pass the `SANDBOX_MODE=docker` check. Swarm compute comes from enrolled agents.

**The US seed is coordinator-only (#39, owner decision).** `edgecoder-seed` runs no model: it sets
`SKIP_OLLAMA=true`, leaves `LOCAL_MODEL_PROVIDER` / `OLLAMA_*` unset and mounts no Ollama volume.
It registers agents, schedules work, settles the economy and gossips with the mesh. A chat that
needs a coordinator-hosted model is served by a seed that has one (`edgecoder-seed-eu`, which keeps
Ollama and its `ollama_data_eu` volume):

- The portal checks capacity before it sends a chat (`src/portal/chat-capacity.ts`). For each vetted
  coordinator it reads `GET /health/runtime` (is the coordinator's own Ollama reachable, and does it
  hold a model) and, for chats on network compute, `GET /inference/models` (which models connected
  agents can run). It prefers the first coordinator in `COORDINATOR_DISCOVERY_URLS`, falls over to
  the next one that reports capacity, retries once on another coordinator when the chosen one fails
  before any token was streamed, and answers "No compute is available right now" at once when no
  coordinator can serve the request. Answers are cached for `PORTAL_CHAT_CAPACITY_TTL_MS`.
- Network calls (portal chat on a network model or Auto, hosted `/v1`) then take latency into
  account (`src/portal/coordinator-latency.ts`): expected latency = the portal machine's measured
  round trip to the coordinator + its pickup p90 (+ queued rounds x call p50 when no slot is free) +
  its round trip to the agents holding the model. The load pick (most free slots) is replaced only
  by a coordinator that is faster by `PORTAL_COORD_LATENCY_MARGIN_MS` and
  `PORTAL_COORD_LATENCY_MARGIN_PCT` and has a free slot, or by a faster one when the load pick has
  no free slot (overflow). The portal relays every call, so the buyer's own location only matters
  through which portal machine serves them: a European buyer reaches the EU coordinator on latency
  only when a portal machine runs in Europe. The choice and why are kept on the call's routing
  decision (Settings > Network, "Routing decisions", Coordinator column).
- Only coordinators that pass the portal's URL policy (`PORTAL_COORDINATOR_HOSTS` plus the hosts of
  `COORDINATOR_DISCOVERY_URLS` / `CONTROL_PLANE_URL`) are probed or sent a chat.
- Callers that reach the US seed's `/portal/chat` directly still get an answer while a mesh peer
  with a model is up: the coordinator forwards the chat to it (`tryMeshPeerChat`), else it answers
  `502 no_models_available`.

What the unset variables change on the US seed: `LOCAL_MODEL_PROVIDER` defaults to
`edgecoder-local`, so the coordinator skips the model pull at boot and `/escalate` goes straight to
the inference service and the escalation resolver; `/health/runtime` stays `200` (the Fly check
does not depend on Ollama) and reports `ollama.reachable: false`.

**The old `ollama_data` volume.** Removing `[mounts]` from the config detaches the volume but does
not delete it, and Fly keeps billing for it. Keep it until the coordinator-only seed has run
cleanly (it is the fast way back: restore the `[mounts]` block and the Ollama variables, redeploy,
and the pulled model is still there), then remove it:

```bash
fly volumes list -a edgecoder-seed
fly volumes destroy <volume-id> -a edgecoder-seed
```

### Fresh Fly organization (one command)

`scripts/fly-bootstrap-org.sh` stands the whole stack up in a Fly org of its own, idempotently:

```bash
fly auth login                      # or export FLY_API_TOKEN=...
export RESEND_API_KEY=re_...        # portal signup email (required in production)
# optional: PORTAL_DOMAIN=edgecoder.io, OAUTH_*_CLIENT_ID/SECRET, BITCOIND_RPC_* (deploys the anchor proxy)
npm run fly:bootstrap -- <org-slug> [app-prefix]
```

It creates the apps (`<prefix>-seed`, `<prefix>-seed-eu`, `<prefix>-portal`, and `<prefix>-anchor-proxy`
when `BITCOIND_RPC_URL` is set), one Fly Postgres cluster attached as `DATABASE_URL` (seeds) and
`PORTAL_DATABASE_URL` (portal), the Ollama volumes, every production-required secret (generated
once and kept in `.fly-bootstrap/<org>.env`, git-ignored), renders the TOML files for the prefix
and domain, deploys seeds then portal, runs the #9 volume chown + restart, and smoke-tests
`/health/runtime`, `/capacity` and the portal `/health`. Re-running it redeploys without rotating
secrets. `SKIP_DEPLOY=1` prepares everything without building.

App names are global on Fly: if the default `edgecoder-*` names are taken, pass a prefix (second
argument), e.g. `npm run fly:bootstrap -- my-org rightway`.

### Deploying a Service by hand

```bash
# Seeds first (all-in-one coordinator + inference + control plane; Ollama chat)
fly deploy -c deploy/fly/fly.seed-node.toml --remote-only
fly deploy -c deploy/fly/fly.seed-eu.toml --remote-only
# Then the portal
fly deploy -c deploy/fly/fly.portal.toml --remote-only
# Anchor proxy (only with a bitcoind behind it)
fly deploy -c deploy/fly/fly.anchor-proxy.toml --remote-only
```

### Setting Secrets

Secrets are not stored in the TOML files. With `NODE_ENV=production` every service refuses to
start without its required secrets (`src/common/env-guard.ts`, `src/*/config.ts`). The bootstrap
script sets all of these; by hand (app names default to `<prefix>-seed`, `<prefix>-seed-eu`,
`<prefix>-portal` and `<prefix>-anchor-proxy`; substitute your own):

```bash
# Seeds (coordinator + inference + control plane in one process)
fly secrets set -a <seed app> \
  MESH_AUTH_TOKEN="<token>" ADMIN_API_TOKEN="<token>" INFERENCE_AUTH_TOKEN="<32+ chars>" \
  PORTAL_SERVICE_URL="https://<your-portal-domain>" PORTAL_SERVICE_TOKEN="<token>" \
  PAYMENT_WEBHOOK_SECRET="<token>" COORDINATOR_REGISTRATION_TOKEN="<token>" \
  COORDINATOR_BOOTSTRAP_URLS="https://<seed-eu app>.fly.dev" \
  DATABASE_URL="postgresql://..."
# same for <seed-eu app> (same MESH_AUTH_TOKEN / PORTAL_SERVICE_TOKEN; bootstrap URL = the other seed)
# Optional, recommended: PORTAL_COORDINATOR_TOKEN="<token>" on both seeds and the portal. Coordinators
# then present it, not PORTAL_SERVICE_TOKEN, to the portal's read/validate /internal routes.
# The portal sends PORTAL_SERVICE_TOKEN only to https coordinators on PORTAL_COORDINATOR_HOSTS
# (default: the COORDINATOR_DISCOVERY_URLS hosts). Node approval needs CONTROL_PLANE_ADMIN_TOKEN.

# Portal
fly secrets set -a <portal app> \
  PORTAL_SERVICE_TOKEN="<same as seeds>" CONTROL_PLANE_ADMIN_TOKEN="<ADMIN_API_TOKEN of the seeds>" \
  RESEND_API_KEY="<key>" RESEND_FROM_EMAIL="noreply@<your-portal-domain>" \
  PORTAL_DATABASE_URL="postgresql://..." \
  SYSTEM_ADMIN_EMAILS="admin@example.com,ops@example.com" \
  OAUTH_GOOGLE_CLIENT_ID="<id>" OAUTH_GOOGLE_CLIENT_SECRET="<secret>" \
  OAUTH_MICROSOFT_CLIENT_ID="<id>" OAUTH_MICROSOFT_CLIENT_SECRET="<secret>"

# Anchor proxy
fly secrets set -a <anchor app> \
  ANCHOR_PROXY_TOKEN="<token>" BITCOIND_RPC_URL="http://..." BITCOIND_RPC_USER="..." BITCOIND_RPC_PASSWORD="..."
```

`SYSTEM_ADMIN_EMAILS` (the portal admin allowlist) is set as a secret rather than in
`fly.portal.toml`, so operator email addresses stay out of the repository. The bootstrap script
forwards it when you export it before running.

### Seed Node Configuration

The US seed TOML (`fly.seed-node.toml`) is coordinator-only (#39) and sets these environment
variables (payment and identity settings omitted):

```toml
[env]
  NODE_ENV = "production"
  EDGE_RUNTIME_MODE = "all-in-one"
  NETWORK_MODE = "public_mesh"
  COORDINATOR_PUBLIC_URL = "https://coordinator.edgecoder.io"
  DISABLE_SELF_AGENT = "1"
  SKIP_OLLAMA = "true"
```

It has no `[mounts]` section. The EU seed (`fly.seed-eu.toml`) is the seed that runs a model:

```toml
[env]
  LOCAL_MODEL_PROVIDER = "ollama-local"
  OLLAMA_AUTO_INSTALL = "true"
  OLLAMA_MODEL = "qwen3.5:4b"
  DISABLE_SELF_AGENT = "1"

[mounts]
  source = "ollama_data_eu"
  destination = "/data/ollama" # owned by uid 1000 after the #9 post-deploy step
```

### Portal Configuration

```toml
[env]
  NODE_ENV = "production"
  PORTAL_PUBLIC_URL = "https://edgecoder.io"
  PASSKEY_RP_ID = "edgecoder.io"
  PASSKEY_ORIGIN = "https://edgecoder.io"
  DOCS_SITE_URL = "https://codyrs82.github.io/Edgecoder/"
  COORDINATOR_DISCOVERY_URLS = "https://edgecoder-seed-eu.fly.dev,https://edgecoder-seed.fly.dev"
```

### Accounts and machines at a glance

A read-only owner view of every account, its balance and its machines, for testing across the network:

```bash
npm run ops:accounts                       # all accounts
npm run ops:accounts -- proton             # email substring (or a user id, its first 8 chars, acct-<userId>)
npm run ops:accounts -- --online           # accounts with a machine online now, online machines only
npm run ops:accounts -- --with-machines --json
```

Each block shows the account (short id, email, name, admin / system admin, host-approved and how,
email verified, created, last sign-in), its balance and today's spend in cSats, API keys and payout
destination (counts and "set"/"not set" only), and its machines: agent id, online/offline and last
seen, compute class/tier, models, engine, approved node, host role (serves network or own work only)
and the coordinator it is on.

How it works (`scripts/ops/accounts.mjs`): it needs `fly` signed in to the org and nothing else. It
runs `fly ssh console -C "node -e …"` on `edgecoder-portal` (portal tables, `PORTAL_DATABASE_URL`),
`edgecoder-seed` (ledger and agent tables on `edgecoder_seed`, `DATABASE_URL`, plus
`GET /admin/network`) and `edgecoder-seed-eu` (`GET /admin/network`) in parallel, so database URLs and
admin tokens stay on the machines; only the result JSON comes back. Every SQL statement must be a
single SELECT (checked here and again on the machine) and the connection is opened with
`default_transaction_read_only=on`. Tokens, hashes, keys and payout destinations are never selected
or printed. Bots are in coordinator memory with no read-only admin endpoint, so they show as `n/a`.
App names can be overridden with `OPS_PORTAL_APP`, `OPS_LEDGER_APP` and `OPS_COORDINATOR_APPS`.

---

## Docker Deployment

### Docker Compose (Full Stack)

The `docker-compose.yml` at the project root starts a complete local stack:

```bash
docker compose up --build
```

This starts:

1. **postgres** -- PostgreSQL 16 with `edgecoder` database (local stack only; production runs postgres-flex 18.1 on Fly, see [Database: current state](#database-current-state)).
2. **seed-node** -- all-in-one EdgeCoder process (coordinator + inference + control plane + worker).
3. **ide-provider** -- IDE provider endpoint.

Ports exposed:

| Service | Port |
|---------|------|
| PostgreSQL | 5432 |
| Coordinator | 4301 |
| Inference | 4302 |
| Control Plane | 4303 |
| IDE Provider | 4304 |

Environment for seed-node:

```yaml
- EDGE_RUNTIME_MODE=all-in-one
- DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
- LOCAL_MODEL_PROVIDER=ollama-local
- OLLAMA_AUTO_INSTALL=false
- OLLAMA_MODEL=qwen3.5:9b
```

### Building the Docker Images

There are two multi-stage images (#9), both based on `node:22-bookworm-slim` (pinned by digest). Both run as the non-root `node` user (uid 1000), contain production dependencies only, and ship no `tests/` or compilers.

| Image | Used by | Contents |
|---|---|---|
| `deploy/docker/Dockerfile.server` | portal (`fly.portal.toml`) | Node runtime + `dist/` only. No Ollama, no BLE. |
| `deploy/docker/Dockerfile.agent` | seeds (`fly.seed-node.toml`, `fly.seed-eu.toml`), `docker-compose.yml` | Server image plus BLE runtime libs and a pinned, sha256-verified Ollama (`OLLAMA_VERSION` / `OLLAMA_SHA256` build args). Models live in `OLLAMA_MODELS=/data/ollama`. Set `SKIP_OLLAMA=true` to skip starting Ollama. |

```bash
docker build -f deploy/docker/Dockerfile.server -t edgecoder-server .
docker build -f deploy/docker/Dockerfile.agent  -t edgecoder-agent .
docker run -p 4301:4301 -p 4302:4302 -p 4303:4303 edgecoder-agent
```

The root `Dockerfile` has been removed. `Dockerfile.anchor-proxy` is unchanged. The docs site is published only to GitHub Pages (`deploy-docs.yml`); the Fly docs app and `Dockerfile.docs` were dropped (#33).

**Volumes (after the first deploy).** This applies to a seed that mounts `/data/ollama` (the EU seed; the US seed is coordinator-only and has no volume). Fly volumes are root-owned, and the volume mount hides the image's own `chown`, so the `node` user (uid 1000) can't write to `/data/ollama` at first. The seed mounts moved from `/root/.ollama` to `/data/ollama`, so that path only exists *after* the new image is deployed. The correct sequence is:

1. Deploy the new image.
2. `fly ssh console` (runs as root), then `chown -R 1000:1000 /data/ollama`.
3. Restart the machine, then smoke-test the portal.

`scripts/fly-post-deploy.sh <toml>` does steps 2 and 3 when the config mounts `/data/ollama` and skips them otherwise. The deploy workflow runs it after each seed deploy. Like the deploy, it refuses to run unless `DEPLOY_ENABLED=true` (deploys are disabled until #31). If the models dir isn't writable, the entrypoint logs a clear error and doesn't start Ollama.

**Bluetooth.** Running the agent image as non-root on hardware with a Bluetooth radio needs `--cap-add=NET_RAW --cap-add=NET_ADMIN` (and `--net=host`) for raw HCI sockets. This doesn't matter on Fly, which has no radio.

**Architecture.** The agent image is amd64-only (pinned `ollama-linux-amd64` tarball).

### Docker Sandbox Images

Workers use Docker sandbox images for code execution:

- `edgecoder/sandbox-python:latest` -- Python execution sandbox
- `edgecoder/sandbox-node:latest` -- Node.js execution sandbox

Sandbox containers run with: `--network=none`, `--read-only`, `--memory=256m`, `--cpus=0.50`, `--pids-limit=50`.

---

## Self-Hosted Linux (systemd)

### One-Step Bootstrap

The `deploy/linux/bootstrap-host.sh` script automates the entire setup on Debian/Ubuntu:

```bash
sudo bash deploy/linux/bootstrap-host.sh <role> <repo_url> [branch] [install_dir]
```

**Roles:** `agent`, `coordinator`, `seed`

**Example:**

```bash
sudo bash deploy/linux/bootstrap-host.sh agent https://github.com/codyrs82/Edgecoder.git main /opt/edgecoder/app
```

This script:

1. Installs Node.js 22 from NodeSource.
2. Clones (or updates) the repository.
3. Runs `npm ci && npm run build`.
4. Calls `scripts/linux/systemd/install-systemd.sh` to install the systemd unit.

### Manual systemd Setup

If you prefer manual control:

```bash
# 1. Clone and build
git clone <repo_url> /opt/edgecoder/app
cd /opt/edgecoder/app
npm ci
npm run build

# 2. Install systemd unit
sudo bash scripts/linux/systemd/install-systemd.sh agent /opt/edgecoder/app
# or
sudo bash scripts/linux/systemd/install-systemd.sh coordinator /opt/edgecoder/app
```

### systemd Units

**Agent unit** (`edgecoder-agent.service`):

```ini
[Service]
Type=simple
User=edgecoder
Group=edgecoder
WorkingDirectory=/opt/edgecoder/app
EnvironmentFile=/etc/edgecoder/agent.env
ExecStart=/usr/bin/node /opt/edgecoder/app/dist/swarm/worker-runner.js
Restart=always
RestartSec=5
```

**Coordinator unit** (`edgecoder-coordinator.service`):

```ini
[Service]
Type=simple
User=edgecoder
Group=edgecoder
WorkingDirectory=/opt/edgecoder/app
EnvironmentFile=/etc/edgecoder/coordinator.env
ExecStart=/usr/bin/node /opt/edgecoder/app/dist/swarm/coordinator.js
Restart=always
RestartSec=5
```

### Environment Files

Agent environment (`/etc/edgecoder/agent.env`):

```bash
AGENT_ID=linux-agent-001
AGENT_OS=linux
AGENT_MODE=swarm-only
AGENT_REGISTRATION_TOKEN=<token-from-portal-node-enrollment>
COORDINATOR_URL=https://coordinator.edgecoder.io
MESH_AUTH_TOKEN=<mesh-token>
LOCAL_MODEL_PROVIDER=edgecoder-local
```

Coordinator environment (`/etc/edgecoder/coordinator.env`):

```bash
MESH_AUTH_TOKEN=<mesh-token>
COORDINATOR_PUBLIC_URL=https://<your-coordinator>
CONTROL_PLANE_URL=https://<your-coordinator>        # the control plane runs in the all-in-one process
COORDINATOR_BOOTSTRAP_URLS=https://<a-peer-coordinator>
COORDINATOR_REGISTRATION_TOKEN=<token-from-portal-node-enrollment>
PORTAL_SERVICE_URL=https://<your-portal>
PORTAL_SERVICE_TOKEN=<portal-service-token>
```

### Service Management

```bash
# Start / stop / restart
sudo systemctl start io.edgecoder.agent.service
sudo systemctl stop io.edgecoder.agent.service
sudo systemctl restart io.edgecoder.agent.service

# Status and logs
sudo systemctl status io.edgecoder.agent.service
sudo journalctl -u io.edgecoder.agent.service -f
```

---

## macOS Installer

Build a `.pkg` installer:

```bash
npm run build:macos-installer
# or directly:
bash scripts/macos/build-installer.sh
```

This produces `build/EdgeCoder-<version>-macos-installer.pkg`. The installer:

- Copies the built runtime to `/Library/EdgeCoder/`.
- Installs a `launchd` plist for automatic startup.
- Runs as a system service.

### Local Install (Development)

```bash
npm run install:macos-local
# or:
bash scripts/macos/install-local.sh
```

### Restart Local Agent

```bash
bash scripts/macos/restart-local-agent.sh
```

### BLE Proxy

Build the BLE proxy helper (for Bluetooth mesh on macOS):

```bash
npm run build:ble-proxy
# or:
bash scripts/macos/build-ble-proxy.sh
```

---

## Linux .deb Package

Build a Debian package:

```bash
npm run build:linux-deb
# or:
bash scripts/linux/build-deb.sh
```

The resulting `.deb` installs:

- Application files to `/opt/edgecoder/`.
- systemd service units.
- Environment file templates in `/etc/edgecoder/`.
- Ollama systemd service (`edgecoder-ollama.service`) for Ollama management.

---

## Windows .msi Installer

Build a Windows MSI installer (requires WiX Toolset):

```bash
npm run build:windows-msi
# or:
bash scripts/windows/build-msi.sh [version]
```

The MSI installs:

- Application files.
- Windows service registration.
- Configuration in the application directory.

The WiX source is at `scripts/windows/edgecoder.wxs`.

---

## Environment Variables Reference

### Service Ports

| Variable | Default | Description |
|----------|---------|-------------|
| `COORDINATOR_PORT` | `4301` | Coordinator listen port |
| `INFERENCE_PORT` | `4302` | Inference service listen port |
| `CONTROL_PLANE_PORT` | `4303` | Control plane listen port |

### Agent Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_ID` | `worker-1` | Unique agent identifier |
| `AGENT_MODE` | `swarm-only` | Agent mode: `swarm-only` or `ide-enabled` |
| `AGENT_OS` | auto-detected | OS: `debian`, `ubuntu`, `windows`, `macos`, `ios` |
| `AGENT_REGISTRATION_TOKEN` | | Token from portal node enrollment |
| `AGENT_CLIENT_TYPE` | `edgecoder-native` | Client type identifier |
| `AGENT_DEVICE_ID` | | Device ID (auto-derived for iOS) |
| `MAX_CONCURRENT_TASKS` | `1` | Maximum concurrent task executions |
| `COORDINATOR_URL` | `http://127.0.0.1:4301` | Bootstrap coordinator URL |
| `COORDINATOR_DISCOVERY_URL` | | URL to discover coordinators (falls back to control plane) |
| `CONTROL_PLANE_URL` | | Control plane URL for discovery |
| `EDGECODER_CONFIG_DIR` | platform default | Configuration directory override |
| `EDGECODER_LOG_DIR` | platform default | Log directory override |

### Model Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LOCAL_MODEL_PROVIDER` | `edgecoder-local` | Model provider: `edgecoder-local` or `ollama-local` |
| `OLLAMA_MODEL` | `qwen3.5:9b` | Ollama model name |
| `OLLAMA_COORDINATOR_MODEL` | `qwen3.5:9b` | Model for coordinator inference calls |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama API host |
| `OLLAMA_AUTO_INSTALL` | `false` | Auto-install Ollama if missing |

### Sandbox

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_MODE` | `docker` (swarm) / `none` (IDE) | Sandbox mode: `docker`, `none`, `vm`. Unknown values (e.g. the old `process`) are treated as `none` with a warning |
| `SANDBOX_REQUIRED` | `false` | Block execution when sandbox is unavailable |
| `SNAPSHOT_ENFORCEMENT` | `warn` | Snapshot ref enforcement: `warn` or `strict` |

### Mesh Networking

| Variable | Default | Description |
|----------|---------|-------------|
| `MESH_AUTH_TOKEN` | | Shared mesh authentication token |
| `NETWORK_MODE` | `public_mesh` | Network mode: `public_mesh` or `enterprise_overlay` |
| `COORDINATOR_PUBLIC_URL` | `http://127.0.0.1:4301` | Public URL for this coordinator |
| `COORDINATOR_PEER_ID` | auto-derived | Explicit coordinator peer ID |
| `COORDINATOR_BOOTSTRAP_URLS` | | Comma-separated seed coordinator URLs |
| `COORDINATOR_REGISTRATION_TOKEN` | | Token for coordinator registration with portal |
| `COORDINATOR_PEER_CACHE_FILE` | `~/.edgecoder/coordinator-peer-cache.json` | Peer cache file path |
| `COORDINATOR_PRIVATE_KEY_PEM` | auto-generated | Ed25519 private key for coordinator identity |
| `COORDINATOR_PUBLIC_KEY_PEM` | auto-derived | Ed25519 public key |
| `COORDINATOR_HTTP_TIMEOUT_MS` | `15000` | HTTP request timeout for coordinator calls |
| `COORDINATOR_POST_RETRIES` | `2` | Number of POST retries to coordinator |
| `PEER_DIRECT_WORK_ITEMS` | preset list | Direct work items offered to peers (double-pipe separated) |
| `PEER_OFFER_COOLDOWN_MS` | `20000` | Cooldown between direct work offers per peer |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_API_TOKEN` | | Admin API token for control plane (at least 32 characters when `NODE_ENV=production`; the control plane refuses to start otherwise) |
| `ALLOWED_ADMIN_IPS` | | Comma-separated IP allowlist for admin |
| `ALLOWED_UI_IPS` | | Comma-separated IP allowlist for UI |
| `INFERENCE_AUTH_TOKEN` | | Token for inference service access |
| `INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS` | `false` | Require signed requests on inference |
| `INFERENCE_COORDINATOR_PEER_ID` | | Trusted coordinator peer ID |
| `INFERENCE_COORDINATOR_PUBLIC_KEY_PEM` | | Trusted coordinator public key |
| `INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON` | | JSON map of trusted coordinator keys |
| `INFERENCE_MAX_SIGNATURE_SKEW_MS` | `120000` | Max clock skew for signed requests |
| `INFERENCE_NONCE_TTL_MS` | `300000` | Nonce TTL for replay protection |

### Portal

| Variable | Default | Description |
|----------|---------|-------------|
| `PORTAL_PUBLIC_URL` | `http://127.0.0.1:4310` | Portal public URL |
| `PORTAL_SERVICE_TOKEN` | | Token for inter-service authentication |
| `PORTAL_SERVICE_URL` | | Portal URL for coordinator callbacks |
| `PORTAL_SESSION_TTL_MS` | `604800000` (7 days) | Session cookie TTL |
| `PORTAL_EMAIL_VERIFY_TTL_MS` | `86400000` (24h) | Email verification token TTL |
| `PORTAL_EXTERNAL_HTTP_TIMEOUT_MS` | `7000` | Timeout for external HTTP requests |
| `PORTAL_COOKIE_SECURE` | unset (on when `NODE_ENV=production`) | `1` forces `Secure` + `__Host-` session cookies outside production (#10). Renaming the cookie logs everyone out once. |
| `PORTAL_CONNECT_ORIGINS` | | Comma list of extra CSP `connect-src` origins (#10) |
| `PORTAL_TRUSTED_ORIGINS` | | Comma list of extra origins allowed to send state-changing requests (CSRF check). The desktop origins are always allowed (#10) |
| `PORTAL_CSP_ENFORCE` | unset | The CSP is enforced, with a per-request nonce on the pages' inline scripts and `<style>` blocks (no `'unsafe-inline'`, #27). `0` sends it as `Content-Security-Policy-Report-Only` instead, for diagnosing a page the policy breaks (#10) |
| `PORTAL_TRUST_PROXY_HOPS` | `1` | Proxy hops to trust for the client IP (Fly = 1). Used by rate limits (#10) |

### Brand-account posting

Settings > Social posts drafts posts for the brand X account (cross-posted to Nostr) and sends each one only after an admin approves it. Nothing is sent until both the page's **Posting** switch is turned on (it starts paused) and `SOCIAL_POSTING_ENABLED=1` is set. The X credentials are Fly secrets on `edgecoder-portal`:

```bash
fly secrets set -a edgecoder-portal X_API_KEY=... X_API_SECRET=... X_ACCESS_TOKEN=... X_ACCESS_TOKEN_SECRET=...
fly secrets set -a edgecoder-portal NOSTR_BRAND_NSEC=nsec1...   # optional: without it Nostr is skipped
fly secrets set -a edgecoder-portal SOCIAL_POSTING_ENABLED=1     # last: lets approved posts go out
```

| Variable | Default | Description |
|---|---|---|
| `SOCIAL_POSTING_ENABLED` | unset | Exactly `1` lets approved posts leave the portal (X and Nostr). Anything else keeps everything as drafts, whatever the admin switch says. |
| `X_API_KEY` | unset | The brand X app's API key (OAuth 1.0a consumer key). All four `X_*` values are needed to post; the admin page shows only whether they are set. |
| `X_API_SECRET` | unset | The X app's API key secret (consumer secret). Never logged or returned. |
| `X_ACCESS_TOKEN` | unset | The brand account's access token (user context, read and write). |
| `X_ACCESS_TOKEN_SECRET` | unset | The brand account's access token secret. Never logged or returned. |
| `NOSTR_BRAND_NSEC` | unset | The brand Nostr key, 64 hex characters or `nsec1...`. Each X post is also published as a kind-1 note. Unset (or invalid): Nostr is skipped and recorded on the post; X still posts. Never logged or returned. |
| `SOCIAL_NOSTR_RELAYS` | `wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net` | Comma-separated `wss://` relays for the Nostr cross-post. A note counts as published when at least one relay accepts it. |
| `SOCIAL_TICK_MINUTES` | `15` | How often the drafting and sending job runs (1 to 1440). |
| `SOCIAL_DOCS_SITEMAP_URL` | `https://docs.edgecoder.io/sitemap.xml` | The docs sitemap new pages are detected from. The weekly report links `PORTAL_PUBLIC_URL`. |

See [Environment variables](../site-docs/reference/environment-variables.md#brand-account-posting-portal) for the rules every post is checked against.

### Passkey / WebAuthn

| Variable | Default | Description |
|----------|---------|-------------|
| `PASSKEY_RP_ID` | portal hostname | Relying party ID |
| `PASSKEY_RP_NAME` | `EdgeCoder Portal` | Relying party display name |
| `PASSKEY_ORIGIN` | portal origin | Expected origin for WebAuthn |
| `PASSKEY_ALLOWED_ORIGINS` | portal origin | Comma-separated allowed origins |
| `PASSKEY_CHALLENGE_TTL_MS` | `300000` | Challenge TTL |

### OAuth SSO

| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH_GOOGLE_CLIENT_ID` | | Google OAuth client ID |
| `OAUTH_GOOGLE_CLIENT_SECRET` | | Google OAuth client secret |
| `OAUTH_GOOGLE_AUTHORIZE_URL` | Google default | Authorization endpoint |
| `OAUTH_GOOGLE_TOKEN_URL` | Google default | Token endpoint |
| `OAUTH_GOOGLE_USERINFO_URL` | Google default | Userinfo endpoint |
| `OAUTH_MICROSOFT_CLIENT_ID` | | Microsoft OAuth client ID |
| `OAUTH_MICROSOFT_CLIENT_SECRET` | | Microsoft OAuth client secret |
| `OAUTH_MICROSOFT_AUTHORIZE_URL` | Microsoft default | Authorization endpoint |
| `OAUTH_MICROSOFT_TOKEN_URL` | Microsoft default | Token endpoint |
| `OAUTH_MICROSOFT_USERINFO_URL` | Microsoft default | Userinfo endpoint |
| `OAUTH_MICROSOFT_PROMPT` | `select_account` | Microsoft OAuth prompt parameter |
| `IOS_OAUTH_CALLBACK_PREFIX` | `edgecoder://oauth-callback` | iOS OAuth deep link prefix |
| `MOBILE_OAUTH_TOKEN_TTL_MS` | `300000` | Mobile OAuth session token TTL |

### Wallet

| Variable | Default | Description |
|----------|---------|-------------|
| `WALLET_SECRET_PEPPER` | unused | Was the pepper for server-side wallet seeds, which were removed; ignored if set |
| `WALLET_DEFAULT_NETWORK` | `signet` | Default Bitcoin network for wallets |
| `WALLET_SEND_MFA_TTL_MS` | `600000` | MFA challenge TTL for wallet sends |

### Email

| Variable | Default | Description |
|----------|---------|-------------|
| `RESEND_API_KEY` | | Resend email API key |
| `RESEND_FROM_EMAIL` | | Sender email address |

### Economy

| Variable | Default | Description |
|----------|---------|-------------|
| `BITCOIN_NETWORK` | `testnet` | Bitcoin network: `bitcoin`, `testnet`, `signet` |
| `COORDINATOR_FEE_BPS` | `0` | Fee on buying cSats (basis points); 0 = 1 sat buys 1 cSat |
| `FEE_POOL_HOST_DISTRIBUTION` | off | Share the network fee with infrastructure hosts; off = EdgeCoder keeps it |
| `COORDINATOR_FEE_ACCOUNT` | `coordinator-fee:default` | Fee collection account |
| `APPROVED_COORDINATOR_IDS` | | Comma-separated approved coordinator peer IDs |
| `PRICE_EPOCH_CPU_MIN_SATS` / `PRICE_EPOCH_CPU_MAX_SATS` | `10` / `120` | Band for the legacy CPU price epoch (sats per compute unit) |
| `PRICE_EPOCH_GPU_MIN_SATS` / `PRICE_EPOCH_GPU_MAX_SATS` | `42` / `480` | Band for the legacy GPU price epoch |
| `PRICE_EPOCH_MAX_CHANGE_BPS` | `2500` | Largest move of a price epoch from the previous one, in basis points |
| `PRICE_CONSENSUS_QUORUM` | majority | Signed allowlisted coordinators a price consensus needs (can only raise the majority) |
| `LIGHTNING_PROVIDER` | `mock` | Lightning provider: `mock`, `lnd`, `cln` |
| `PAYMENT_INTENT_TTL_MS` | `900000` (15 min) | Payment intent expiry |
| `PAYMENT_WEBHOOK_SECRET` | | Webhook secret for payment notifications |
| `CONTRIBUTION_BURST_CREDITS` | `25` | Credits for burst contributions |
| `MIN_CONTRIBUTION_RATIO` | `1.0` | Minimum contribution ratio |

### Issuance

| Variable | Default | Description |
|----------|---------|-------------|
| `ISSUANCE_WINDOW_MS` | `86400000` (24h) | Issuance calculation window |
| `ISSUANCE_RECALC_MS` | `3600000` (1h) | Issuance recalculation interval |
| `ISSUANCE_BASE_DAILY_POOL_TOKENS` | `10000` | Base daily token pool |
| `ISSUANCE_MIN_DAILY_POOL_TOKENS` | `2500` | Minimum daily pool |
| `ISSUANCE_MAX_DAILY_POOL_TOKENS` | `100000` | Maximum daily pool |
| `ISSUANCE_LOAD_CURVE_SLOPE` | `0.35` | Load curve slope factor |
| `ISSUANCE_SMOOTHING_ALPHA` | `0.35` | EMA smoothing alpha |
| `ISSUANCE_COORDINATOR_SHARE` | `0.05` | Coordinator share of issuance (5%) |
| `ISSUANCE_RESERVE_SHARE` | `0.05` | Reserve share of issuance (5%) |
| `ANCHOR_INTERVAL_MS` | `7200000` (2h) | Bitcoin anchoring interval |

### Result Verification

Sampled redundant execution of worker results (`src/swarm/verification.ts`, #50). A sampled result is re-run by an agent on a different reward account, and credits wait until two executions agree. Off by default.

Only subtask kinds with a comparator can be verified (#104):

- `micro_loop` and `single_step` (code tasks) compare the **execution result**: the exit status (`ok`) plus stdout, with CRLF, trailing whitespace on each line, and leading or trailing blank lines ignored. Any other difference is a mismatch.
- `inference` (LLM text generation) is **never verified**. Two honest generations differ, and fuzzy text similarity could be gamed. Inference results are paid unverified. Listing `inference` in `RESULT_VERIFICATION_KINDS` is ignored with a startup warning.

Even for code tasks, generated programs can print differently between honest runs, so turn the rate on gradually and watch the `result_verification_mismatch` security events.

| Variable | Default | Description |
|----------|---------|-------------|
| `RESULT_VERIFICATION_RATE` | `0` (off) | Base fraction of eligible results re-executed (0..1). Effective rate is `min(1, rate * (2 - reputation))` |
| `RESULT_VERIFICATION_KINDS` | `micro_loop,single_step` | Comma-separated subtask kinds eligible for sampling; `none` disables every kind. `inference` and unknown kinds are ignored |
| `RESULT_VERIFICATION_MAX_EXECUTIONS` | `3` | Total executions, including the original, before a subtask is unresolved (2..3) |
| `RESULT_VERIFICATION_MISMATCH_PENALTY` | `0.25` | Reputation lost on a mismatch (0..1) |
| `RESULT_VERIFICATION_TIMEOUT_MS` | `900000` (15 min) | Hold time before a result no replica picked up is released unverified |
| `RESULT_VERIFICATION_INITIAL_REPUTATION` | `0.5` | Reputation of an agent never seen before (0..1) |
| `RESULT_VERIFICATION_ABANDON_PENALTY` | `0.25` | Reputation lost for claiming a replica and never reporting it (0..1) |
| `RESULT_VERIFICATION_REPLICA_CLAIM_TIMEOUT_MS` | `300000` (5 min) | A claimed replica with no report after this long is reassigned |
| `RESULT_VERIFICATION_MAX_REASSIGNMENTS` | `1` | How many times one sampled subtask's stalled replicas are reassigned (0..10) |
| `RESULT_VERIFICATION_MINT_REPLICA_REWARDS` | `false` | Pay winning replicas from newly minted credits. The original execution is always paid |

### Stats and Audit

| Variable | Default | Description |
|----------|---------|-------------|
| `STATS_LEDGER_SYNC_INTERVAL_MS` | `10000` | Stats ledger sync interval |
| `STATS_ANCHOR_INTERVAL_MS` | `600000` (10 min) | Stats anchor interval |
| `STATS_ANCHOR_MIN_CONFIRMATIONS` | `1` | Extra floor for stats hard finality; the effective depth is the larger of this and `BITCOIN_ANCHOR_CONFIRMATIONS` (default 6) |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_RATE_LIMIT_MAX` | `300` | Max signed requests per agent per window (counted only once the signature verifies); over it the agent gets `429 agent_rate_limited` with `Retry-After` |
| `AGENT_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `AGENT_CHUNK_RATE_LIMIT_MAX` | `3000` | Streamed reply pieces (`/inference/chunks`) per agent per window, counted apart from `AGENT_RATE_LIMIT_MAX` |
| `INFERENCE_CLAIM_TIMEOUT_MS` | `45000` | A network inference call no agent has claimed by then is cancelled, refunded in full and answered `503 no_capacity` with `Retry-After` (keep it well under the 100 s a proxy such as Cloudflare waits for a response) |
| `INFERENCE_DEFAULT_MAX_TOKENS` | `4096` | Output cap for a network model call that sets no `maxTokens`. An agent is never paid for output past a call's cap, so this bounds the worst case of every call |
| `PREAUTH_FAILURE_MAX_PER_IP` | `120` | Signed requests per client address per window whose signature fails (bad signature, clock skew); past it the address is refused for the rest of the window. Such failures are never counted against the agent id the request names. Behind a reverse proxy other than Fly, set `COORDINATOR_TRUST_PROXY` so the client address is known |
| `SECURITY_NONCE_TTL_MS` | `300000` | Nonce TTL for signed requests |
| `SECURITY_MAX_SKEW_MS` | `120000` | Max clock skew for signed requests |

### iOS Power Policy

| Variable | Default | Description |
|----------|---------|-------------|
| `IOS_ON_EXTERNAL_POWER` | | Whether iOS device is on external power |
| `IOS_BATTERY_LEVEL_PCT` | | iOS battery level percentage |
| `IOS_LOW_POWER_MODE` | | Whether iOS Low Power Mode is enabled |
| `IOS_BATTERY_PULL_MIN_INTERVAL_MS` | `45000` | Min interval between task pulls on battery |
| `IOS_BATTERY_TASK_STOP_LEVEL_PCT` | `20` | Battery level below which tasks are blocked |

### Robot Queue

| Variable | Default | Description |
|----------|---------|-------------|
| `ROBOT_QUEUE_ENABLED` | `false` | Enable robot task queue |
| `ROBOT_COORDINATOR_FEE_BPS` | `200` | Robot queue coordinator fee |
| `ROBOT_SWEEP_INTERVAL_MS` | `86400000` (24h) | Robot fee sweep interval |
| `ROBOT_MIN_SWEEP_SATS` | `10000` | Minimum sats for fee sweep |
| `ROBOT_TASK_DEFAULT_TIMEOUT_MS` | `3600000` (1h) | Default robot task timeout |
| `ROBOT_AUTO_SETTLE_DELAY_MS` | `86400000` (24h) | Auto-settle delay |

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | | PostgreSQL connection string. Required for a coordinator in production (#55) |

### UI Links

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCS_SITE_URL` | `http://127.0.0.1:5173` | External docs URL in portal nav |
| `GITHUB_REPO_URL` | `https://github.com/codyrs82/Edgecoder` | Repo URL in portal nav |

### Admin Emails

| Variable | Default | Description |
|----------|---------|-------------|
| `SYSTEM_ADMIN_EMAILS` | | System admin emails (comma-separated). Set as a secret, not in the TOML |
| `COORDINATOR_OPERATIONS_OWNER_EMAILS` | `admin@example.com` | Coordinator ops owner emails |
| `COORDINATOR_ADMIN_EMAILS` | | Additional coordinator admin emails |
