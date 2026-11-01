# EdgeCoder Deployment Guide

This document covers deploying EdgeCoder services across Fly.io, Docker, systemd, and native installers.

## Table of Contents

- [Fly.io Deployment](#flyio-deployment)
- [Docker Deployment](#docker-deployment)
- [Self-Hosted Linux (systemd)](#self-hosted-linux-systemd)
- [macOS Installer](#macos-installer)
- [Linux .deb Package](#linux-deb-package)
- [Windows .msi Installer](#windows-msi-installer)
- [Environment Variables Reference](#environment-variables-reference)

---

## Fly.io Deployment

Fly.io configuration files are in `deploy/fly/`. Each service has its own TOML config. There are
four apps; there is no separate coordinator, inference or control-plane app any more (#33): the
seed runs `EDGE_RUNTIME_MODE=all-in-one`, so the seed *is* the coordinator, inference service and
control plane.

### Services

| Config File | App Name | Region | Entrypoint | Port | VM |
|-------------|----------|--------|------------|------|-----|
| `fly.seed-node.toml` | `edgecoder-seed` | `ord` | `node dist/index.js` (+ Ollama via the agent image entrypoint) | 4301 | 16 GB, 2 perf CPUs |
| `fly.seed-eu.toml` | `edgecoder-seed-eu` | `cdg` | `node dist/index.js` (+ Ollama) | 4301 | 8 GB, 2 perf CPUs |
| `fly.portal.toml` | `edgecoder-portal` | `ord` | `node dist/portal/server.js` | 4310 | 1 GB, shared |
| `fly.anchor-proxy.toml` | `edgecoder-anchor-proxy` | `ord` | `node dist/economy/anchor-proxy-service.js` | 4311 | 256 MB, shared |

Both seeds set `DISABLE_SELF_AGENT=1` (#39): Fly machines have no Docker, so the embedded worker
could never pass the `SANDBOX_MODE=docker` check. Seeds coordinate and serve Ollama chat; swarm
compute comes from enrolled agents.

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
script sets all of these; by hand:

```bash
# Seeds (coordinator + inference + control plane in one process)
fly secrets set -a edgecoder-seed \
  MESH_AUTH_TOKEN="<token>" ADMIN_API_TOKEN="<token>" INFERENCE_AUTH_TOKEN="<32+ chars>" \
  PORTAL_SERVICE_URL="https://edgecoder.io" PORTAL_SERVICE_TOKEN="<token>" \
  PAYMENT_WEBHOOK_SECRET="<token>" COORDINATOR_REGISTRATION_TOKEN="<token>" \
  COORDINATOR_BOOTSTRAP_URLS="https://edgecoder-seed-eu.fly.dev" \
  DATABASE_URL="postgresql://..."
# same for edgecoder-seed-eu (same MESH_AUTH_TOKEN / PORTAL_SERVICE_TOKEN; bootstrap URL = the other seed)

# Portal
fly secrets set -a edgecoder-portal \
  PORTAL_SERVICE_TOKEN="<same as seeds>" CONTROL_PLANE_ADMIN_TOKEN="<ADMIN_API_TOKEN of the seeds>" \
  WALLET_SECRET_PEPPER="<secret>" RESEND_API_KEY="<key>" RESEND_FROM_EMAIL="noreply@edgecoder.io" \
  PORTAL_DATABASE_URL="postgresql://..." \
  OAUTH_GOOGLE_CLIENT_ID="<id>" OAUTH_GOOGLE_CLIENT_SECRET="<secret>" \
  OAUTH_MICROSOFT_CLIENT_ID="<id>" OAUTH_MICROSOFT_CLIENT_SECRET="<secret>"

# Anchor proxy
fly secrets set -a edgecoder-anchor-proxy \
  ANCHOR_PROXY_TOKEN="<token>" BITCOIND_RPC_URL="http://..." BITCOIND_RPC_USER="..." BITCOIND_RPC_PASSWORD="..."
```

### Seed Node Configuration

The seed node TOML (`fly.seed-node.toml`) sets these environment variables:

```toml
[env]
  NODE_ENV = "production"
  EDGE_RUNTIME_MODE = "all-in-one"
  NETWORK_MODE = "public_mesh"
  COORDINATOR_PUBLIC_URL = "https://edgecoder-seed.fly.dev"
  LOCAL_MODEL_PROVIDER = "ollama-local"
  OLLAMA_AUTO_INSTALL = "true"
  OLLAMA_MODEL = "qwen2.5:7b"
  DISABLE_SELF_AGENT = "1"
```

It mounts persistent storage for Ollama model data (owned by uid 1000 after the #9 post-deploy step):

```toml
[mounts]
  source = "ollama_data"
  destination = "/data/ollama"
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

---

## Docker Deployment

### Docker Compose (Full Stack)

The `docker-compose.yml` at the project root starts a complete local stack:

```bash
docker compose up --build
```

This starts:

1. **postgres** -- PostgreSQL 16 with `edgecoder` database.
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

**Volumes (after the first deploy).** Fly volumes are root-owned, and the volume mount hides the image's own `chown`, so the `node` user (uid 1000) can't write to `/data/ollama` at first. The seed mounts moved from `/root/.ollama` to `/data/ollama`, so that path only exists *after* the new image is deployed. The correct sequence is:

1. Deploy the new image.
2. `fly ssh console` (runs as root), then `chown -R 1000:1000 /data/ollama`.
3. Restart the machine, then smoke-test the portal.

`scripts/fly-post-deploy.sh <toml>` does steps 2 and 3. The deploy workflow runs it after each seed deploy. Like the deploy, it refuses to run unless `DEPLOY_ENABLED=true` (deploys are disabled until #31). If the models dir isn't writable, the entrypoint logs a clear error and doesn't start Ollama.

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
COORDINATOR_PUBLIC_URL=https://coordinator.edgecoder.io
CONTROL_PLANE_URL=https://control.edgecoder.io
COORDINATOR_BOOTSTRAP_URLS=https://coordinator.edgecoder.io
COORDINATOR_REGISTRATION_TOKEN=<token-from-portal-node-enrollment>
PORTAL_SERVICE_URL=https://portal.edgecoder.io
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
| `ADMIN_API_TOKEN` | | Admin API token for control plane |
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
| `PORTAL_CSP_ENFORCE` | unset | `1` enforces the CSP. Otherwise it is sent as `Content-Security-Policy-Report-Only` (#10) |
| `PORTAL_TRUST_PROXY_HOPS` | `1` | Proxy hops to trust for the client IP (Fly = 1). Used by rate limits (#10) |

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
| `WALLET_SECRET_PEPPER` | **required** | Secret pepper for wallet key derivation |
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
| `COORDINATOR_FEE_BPS` | `150` | Coordinator fee in basis points |
| `COORDINATOR_FEE_ACCOUNT` | `coordinator-fee:default` | Fee collection account |
| `APPROVED_COORDINATOR_IDS` | | Comma-separated approved coordinator peer IDs |
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

### Stats and Audit

| Variable | Default | Description |
|----------|---------|-------------|
| `STATS_LEDGER_SYNC_INTERVAL_MS` | `10000` | Stats ledger sync interval |
| `STATS_ANCHOR_INTERVAL_MS` | `600000` (10 min) | Stats anchor interval |
| `STATS_ANCHOR_MIN_CONFIRMATIONS` | `1` | Min Bitcoin confirmations for anchors |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_RATE_LIMIT_MAX` | `30` | Max requests per agent per window |
| `AGENT_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
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
| `DATABASE_URL` | | PostgreSQL connection string |

### UI Links

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCS_SITE_URL` | `http://127.0.0.1:5173` | External docs URL in portal nav |
| `GITHUB_REPO_URL` | `https://github.com/codyrs82/Edgecoder` | Repo URL in portal nav |

### Admin Emails

| Variable | Default | Description |
|----------|---------|-------------|
| `SYSTEM_ADMIN_EMAILS` | `admin@example.com` | System admin emails (comma-separated) |
| `COORDINATOR_OPERATIONS_OWNER_EMAILS` | `admin@example.com` | Coordinator ops owner emails |
| `COORDINATOR_ADMIN_EMAILS` | | Additional coordinator admin emails |
