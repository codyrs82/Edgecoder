# Agent and Coordinator Installation Guide

This guide covers how to install your own EdgeCoder agents and how to add additional coordinators to the mesh.

## Endpoints

Examples below use placeholders:

- `<your-portal>`: the portal you enrol nodes in (the public network's portal is `https://edgecoder.io`)
- `<your-coordinator>`: the coordinator your nodes connect to. In the default all-in-one runtime
  the control plane runs in the same process, so control-plane routes live on the same host.

## Prerequisites

- Node.js 22+
- Valid portal account with verified email
- Mesh token (`MESH_AUTH_TOKEN`) for coordinator/agent runtime auth

## Enrollment and activation model (required)

Every agent/coordinator node follows this flow:

1. Sign in to portal.
2. Enroll node and get one-time `registrationToken`.
3. Configure node runtime with registration token.
4. Start node runtime.
5. The coordinator's operator approves the node (control-plane approval routes, see
   [API.md](API.md); they require `ADMIN_API_TOKEN` and, if set, a source IP in `ALLOWED_ADMIN_IPS`).
6. Node becomes active only when:
   - owner email is verified
   - coordinator admin approval is complete

Association model:

- You do not enter email into the runtime config.
- Node ownership is bound by the portal-issued `registrationToken` tied to your signed-in user account.

## Install your own agents

Worker mode options:

- `AGENT_MODE=swarm-only`: mesh compute only.
- `AGENT_MODE=ide-enabled`: mesh compute + advertise IDE-capable agent mode.

Dedicated IDE provider:

- `EDGE_RUNTIME_MODE=ide-provider` runs the provider service itself.
- If you need both on one machine, run two processes/services:
  - worker (`EDGE_RUNTIME_MODE=worker`, `AGENT_MODE=ide-enabled`)
  - ide provider (`EDGE_RUNTIME_MODE=ide-provider`)

### Option A: macOS installer package

Build package:

```bash
npm run build:macos-installer
```

Install:

```bash
sudo installer -pkg build/EdgeCoder-<version>-macos-installer.pkg -target /
```

Configure `/etc/edgecoder/edgecoder.env`:

```dotenv
EDGE_RUNTIME_MODE=worker
AGENT_ID=mac-worker-001
AGENT_OS=macos
AGENT_MODE=swarm-only
AGENT_REGISTRATION_TOKEN=<token-from-portal-node-enrollment>
COORDINATOR_URL=https://<your-coordinator>
MESH_AUTH_TOKEN=<mesh-token>
LOCAL_MODEL_PROVIDER=edgecoder-local
```

Restart service:

```bash
sudo launchctl kickstart -k system/io.edgecoder.runtime
```

### Option B: Linux/Windows-style direct runtime (no package)

From repo root:

```bash
npm install
npm run build
```

Run worker:

```bash
AGENT_ID=node-1 \
AGENT_OS=ubuntu \
AGENT_MODE=swarm-only \
AGENT_REGISTRATION_TOKEN=<token-from-portal-node-enrollment> \
COORDINATOR_URL=https://<your-coordinator> \
MESH_AUTH_TOKEN=<mesh-token> \
npm run dev:worker
```

### Option C: Linux managed service (`systemd`)

Build once on host:

```bash
npm install
npm run build
```

Install service unit:

```bash
sudo bash scripts/linux/systemd/install-systemd.sh agent "$(pwd)"
```

Edit runtime env:

```bash
sudo nano /etc/edgecoder/agent.env
```

Minimum example:

```dotenv
AGENT_ID=linux-agent-001
AGENT_OS=linux
AGENT_MODE=swarm-only
AGENT_REGISTRATION_TOKEN=<token-from-portal-node-enrollment>
COORDINATOR_URL=https://<your-coordinator>
MESH_AUTH_TOKEN=<mesh-token>
```

Service operations:

```bash
sudo systemctl status io.edgecoder.agent.service
sudo journalctl -u io.edgecoder.agent.service -f
sudo systemctl restart io.edgecoder.agent.service
```

### Option D: Linux host bootstrap script (one-shot install)

For new Debian/Ubuntu hosts:

```bash
sudo bash deploy/linux/bootstrap-host.sh agent https://github.com/<your-org>/Edgecoder.git main /opt/edgecoder/app
```

Then edit `/etc/edgecoder/agent.env` and restart:

```bash
sudo systemctl restart io.edgecoder.agent.service
```

### Approval

A newly enrolled agent stays inactive until the coordinator's operator approves it. If you run
your own coordinator, approval uses the control-plane admin API (`ADMIN_API_TOKEN`); see
[API.md](API.md).

## Install additional coordinators

Use this for horizontal scale or regional redundancy.

### 1) Enroll coordinator node in portal

- Sign in to portal (or use a portal API key: `POST /nodes/enroll` with `Authorization: Bearer <api-key>`)
- Enroll node with `nodeKind=coordinator` and a node ID of your choice
- Capture returned `registrationToken`
- Run the coordinator with `COORDINATOR_PEER_ID` set to that node ID. The mesh looks the coordinator up
  in the portal by its peer ID, and the default peer ID (derived from `COORDINATOR_PUBLIC_URL`) does not
  match the enrolled node ID.

### 2) Deploy coordinator runtime

If using Fly, create a new coordinator app and deploy the same build. Any node in the gossip mesh can act as a coordinator — there is no fixed "coordinator-2" role.

```bash
fly apps create <your-app> --org <your-org>
fly postgres create --name <your-app>-db --org <your-org> --region <region> --initial-cluster-size 1 --flex
fly postgres attach <your-app>-db -a <your-app>     # sets DATABASE_URL (the output shows the password)
```

Keep your `fly.toml` outside the repository if you like, but `[build] dockerfile` is resolved relative
to the directory of the `fly.toml`, so point it into your checkout (`<checkout>/deploy/docker/Dockerfile.agent`
as a relative path). The build context is the directory `fly deploy` is given, so pass the checkout and
an absolute config path: `fly deploy <checkout> -c /abs/path/fly.toml` (otherwise the build fails with
`deploy/docker/agent-entrypoint.sh: not found`). Use `deploy/fly/fly.seed-node.toml` as the template for a coordinator without a
local model (`SKIP_OLLAMA=true`, `DISABLE_SELF_AGENT=1`). Do not run agents as extra machines in the
coordinator's app: every machine in a Fly app receives the app's secrets.

A production coordinator (`NODE_ENV=production`) refuses to start unless all of these are set
(`src/common/env-guard.ts`):

```dotenv
# your own values
DATABASE_URL=<your Postgres>
ADMIN_API_TOKEN=<random>
PAYMENT_WEBHOOK_SECRET=<random>
COORDINATOR_PRIVATE_KEY_PEM=<your Ed25519 PKCS#8 key; keep it stable>
# from the network you join
MESH_AUTH_TOKEN=<mesh token of the network>
PORTAL_SERVICE_URL=<your-portal>
# The portal's public key (raw Ed25519, base64), from the portal operator. Portal calls are signed for
# this coordinator, and this coordinator signs its own calls to the portal: no portal token is shared.
PORTAL_ACTION_VERIFY_KEYS=<portal public key>
```

Plus the join settings:

```dotenv
COORDINATOR_PUBLIC_URL=https://<your-coordinator>.fly.dev
COORDINATOR_PEER_ID=<enrolled node ID>
COORDINATOR_REGISTRATION_TOKEN=<token-from-portal-node-enrollment>
COORDINATOR_BOOTSTRAP_URLS=<existing coordinators, comma separated>
MESH_PEER_ALLOWLIST=<peerId:fingerprint@url of each existing coordinator>
ECONOMY_PAYMENTS_ENABLED=false   # until you run your own Lightning node (LIGHTNING_PROVIDER=lnd|cln)
```

`MESH_PEER_ALLOWLIST` entries are the `trustEntry` that each existing coordinator's public `GET /identity`
reports, followed by `@<its URL>`. Send your own `trustEntry` (from your coordinator's `GET /identity`
after the first start) to the mesh operator: every existing coordinator must add it to its own
`MESH_PEER_ALLOWLIST` and restart before peering works (see [public-mesh-operations](public-mesh-operations.md)).

Recommended:

- keep coordinator sizing near `performance-2x / 8GB` for Ollama-local workloads
- set `OLLAMA_AUTO_INSTALL=false` and pre-pull models

Linux `systemd` managed coordinator option (Debian/Ubuntu). The commands run from a checkout of the
repository, so clone it first:

```bash
git clone https://github.com/<your-org>/Edgecoder.git && cd Edgecoder
```

Either build and install the unit yourself:

```bash
npm install
npm run build
sudo bash scripts/linux/systemd/install-systemd.sh coordinator "$(pwd)"
```

or let the host bootstrap install Node.js, clone into `/opt/edgecoder/app`, build and install the unit:

```bash
sudo bash deploy/linux/bootstrap-host.sh coordinator https://github.com/<your-org>/Edgecoder.git main /opt/edgecoder/app
```

The installer copies `scripts/linux/systemd/coordinator.env.example` to `/etc/edgecoder/coordinator.env`
and enables the unit. When it has just created that file from the template it does not start the
service: the template's placeholders cannot run. Before the first start, set up:

1. **A database.** A production coordinator needs its own Postgres (`DATABASE_URL`). On the same host:

   ```bash
   sudo apt-get install -y postgresql
   sudo -u postgres psql -c "CREATE ROLE edgecoder LOGIN PASSWORD '<random>';" -c "CREATE DATABASE edgecoder OWNER edgecoder;"
   # DATABASE_URL=postgres://edgecoder:<random>@127.0.0.1:5432/edgecoder
   ```

   The schema is created on first start. Set `BITCOIN_NETWORK` before that first start: the coordinator
   records the ledger's network in the database and refuses to start later with a different one.

2. **HTTPS.** The coordinator listens on `127.0.0.1:4301` (set `HOST` to change it) and has no TLS of
   its own; agents and peers need `https://`. Put a reverse proxy in front, for example Caddy, which
   gets a Let's Encrypt certificate by itself once ports 80 and 443 reach the host:

   ```bash
   sudo apt-get install -y caddy
   printf '%s {\n\treverse_proxy 127.0.0.1:4301\n}\n' <your-coordinator-hostname> | sudo tee /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```

   Set `COORDINATOR_TRUST_PROXY=127.0.0.1` (the proxy's address) in the env file, so the coordinator
   logs and geolocates the client's address instead of the proxy's. A request that comes through
   the proxy is never treated as a local caller, with or without this setting: the proxy adds
   forwarding headers, and any of them rules loopback out.

3. **The env file** (`sudo nano /etc/edgecoder/coordinator.env`): every value the template lists,
   `NODE_ENV=production`, and a stable identity key. Without `COORDINATOR_PRIVATE_KEY_PEM` the
   coordinator makes a new key on every restart. Generate one with
   `openssl genpkey -algorithm ed25519` and put it in the env file as one double-quoted value over
   several lines (`COORDINATOR_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----` ... `-----END PRIVATE KEY-----"`);
   systemd reads multi-line quoted values. Keep the file `chmod 600`, owned by `edgecoder`.

Then start it:

```bash
sudo systemctl restart io.edgecoder.coordinator.service
```

Useful checks:

```bash
sudo systemctl status io.edgecoder.coordinator.service
sudo journalctl -u io.edgecoder.coordinator.service -f
curl -s https://<your-coordinator-hostname>/identity     # public: peerId, fingerprint, trustEntry
```

The `coordinator` role runs the coordinator only (`dist/swarm/coordinator.js`). The control plane,
with `/network/coordinators` and the approval routes, runs in the all-in-one runtime (role `seed`,
`EDGE_RUNTIME_MODE=all-in-one`); a `coordinator`-role host doesn't serve them.

An agent on the coordinator's own machine is not admitted by its address in production. Enroll it
in the portal and give it `AGENT_REGISTRATION_TOKEN` like any other agent, or set
`COORDINATOR_LOOPBACK_SELF_REGISTRATION=true` in `coordinator.env` to let agents that connect
directly to `127.0.0.1:4301` (not through the proxy) register without a portal enrollment. Only
the all-in-one runtime's own embedded worker registers without either.

Your agents should set `COORDINATOR_URL` to your coordinator. Steering and portal discovery respect
it: an agent whose `COORDINATOR_URL` is anything other than `https://coordinator.edgecoder.io` keeps
that coordinator while it answers `/identity` and is trusted (listed in the signed registry with
that key, or accepted by the agent's own trust settings, such as `TRUSTED_COORDINATOR_KEYS`). Its log
says `steering: keeping configured coordinator <url>`. Only while your coordinator is unreachable or
not trusted does the agent steer to the nearest healthy platform coordinator (`configured coordinator
<url> unreachable; steering to <other>`), and it comes back on a later steering round. With
`PORTAL_URL` set, the portal's coordinator suggestion is ignored for such an agent. You no longer
need `EDGECODER_STEERING=off` to keep agents on your coordinator.

An agent on a Linux host without Docker takes no work with the default `SANDBOX_MODE=docker`
(its log says `pull skipped: sandbox_down`). To serve model calls only, set `SANDBOX_MODE=none` and
`AGENT_INFERENCE_ONLY=1` in `/etc/edgecoder/agent.env`.

### 3) Approval

The coordinator stays inactive until an operator of the mesh approves it through the control-plane
admin API, as for agents: `POST /coordinators/<node ID>/approval` with `{"approved": true}` and the
approving coordinator's `ADMIN_API_TOKEN`. In the all-in-one runtime the control plane listens on port
4303 on localhost only, so on Fly the call is made from inside that coordinator's machine (`fly ssh console`).

### Current limits for coordinators run by other operators

- Peering without the network's `MESH_AUTH_TOKEN`: every coordinator signs its peer requests with its own
  key. A coordinator that sets `MESH_TOKEN_REQUIRED_FOR_PEERS=false` admits a peer whose key is on its
  `MESH_PEER_ALLOWLIST` without the token. Coordinators still send their token to every peer unless
  `MESH_TOKEN_PEER_URLS` lists the peers that may receive it, so the mesh operator sets that (to its own
  coordinators' URLs) on each of its coordinators before allowlisting one run by another operator.
- Credits live in each coordinator's own database. A coordinator with its own `DATABASE_URL` does not see
  balances held on the network's ledger, so a network-billed call it starts itself is refused with
  `insufficient_credits`. Calls a user runs on their own machines (`target: "mine"`) are not billed and work.
- Portal access is per coordinator: it signs its `/internal` calls with its own key, and the portal trusts
  that key once the coordinator's first call carries its registration token (or the signed registry lists
  it). Scopes: validating agents that register to it, looking up the nodes it validated, and network
  counts. An admin can revoke it; a registry suspension stops it at once. The shared
  `PORTAL_COORDINATOR_TOKEN` is deprecated and still accepted while `PORTAL_COORDINATOR_TOKEN_ACCEPTED` is on.

### 4) Verify mesh joining

Check the discovery feed. It is served by the control plane (port 4303, localhost only in the
all-in-one runtime); on the public port it needs the mesh token like the other coordinator routes:

```bash
curl -s http://127.0.0.1:4303/network/coordinators          # from inside the coordinator host
```

Check that each existing coordinator's public `GET /identity` matches the entries in your
`MESH_PEER_ALLOWLIST`, and that your coordinator's log shows `mesh_bootstrap_registered` with
`registerStatus` 200 (401 means the mesh token or the peer's allowlist does not accept you yet).

Check peer view from an existing coordinator (mesh token required):

```bash
curl -s -H "x-mesh-token: <MESH_AUTH_TOKEN>" https://<your-coordinator>/mesh/peers
```

## Troubleshooting

- `node_not_activated` on register:
  - verify email in portal
  - confirm the node was approved
  - verify registration token matches enrolled node ID
- `mesh_unauthorized`:
  - missing/incorrect `MESH_AUTH_TOKEN`
  - note: managed enrollment can auto-provision token on register; if disabled in your environment, set manually
- coordinator doesn’t discover peers:
  - check `CONTROL_PLANE_URL`, `COORDINATOR_PUBLIC_URL`, `COORDINATOR_BOOTSTRAP_URLS`
  - ensure DNS/TLS for coordinator hostname is valid

## First 10 nodes rollout (copy/paste plan)

Use this for the first production wave without manual drift.

1. Prepare one install baseline:
   - decide naming scheme (`agent-001` to `agent-010`)
   - validate `MESH_AUTH_TOKEN`
   - verify coordinator URL is reachable from target network
2. In portal, enroll 10 agent nodes and export a mapping list:
   - `agent-001 -> <registrationToken-1>`
   - `agent-002 -> <registrationToken-2>`
   - ...
3. Install runtime on each host (macOS pkg or Linux systemd kit).
4. Set unique `AGENT_ID` + matching `AGENT_REGISTRATION_TOKEN` per host.
5. Start/restart service on each host.
6. Have the coordinator operator approve them in batches (first 3, verify stable, then the rest).
7. Validate all 10:
   - present in `GET /agents/catalog`
   - no `node_not_activated` registration errors
   - expected `ownerEmail`, `sourceIp`, `vpnDetected`, `countryCode` fields visible in UI
