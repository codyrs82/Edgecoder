# Agent and Coordinator Installation Guide

This guide covers how to install your own EdgeCoder agents and how to add additional coordinators to the mesh.

## Current production endpoints

- Portal: `https://portal.edgecoder.io/portal`
- Coordinator operations: `https://portal.edgecoder.io/portal/coordinator-ops`
- Coordinator bootstrap: `https://coordinator.edgecoder.io`

## Prerequisites

- Node.js 20+
- Valid portal account with verified email
- Access to control-plane admin token for approval workflows
- Mesh token (`MESH_AUTH_TOKEN`) for coordinator/agent runtime auth

## Enrollment and activation model (required)

Every agent/coordinator node follows this flow:

1. Sign in to portal.
2. Enroll node and get one-time `registrationToken`.
3. Configure node runtime with registration token.
4. Start node runtime.
5. Approve node in control plane:
   - agent: `POST /agents/:agentId/approval`
   - coordinator: `POST /coordinators/:coordinatorId/approval`
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
COORDINATOR_URL=https://coordinator.edgecoder.io
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
COORDINATOR_URL=https://coordinator.edgecoder.io \
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
COORDINATOR_URL=https://coordinator.edgecoder.io
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

### Approve enrolled agent

```bash
curl -X POST \
  -H "Authorization: Bearer <ADMIN_API_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"approved":true}' \
  https://control.edgecoder.io/agents/<AGENT_ID>/approval
```

## Install additional coordinators

Use this for horizontal scale or regional redundancy.

### 1) Enroll coordinator node in portal

- Sign in to portal
- Enroll node with `nodeKind=coordinator`
- Capture returned `registrationToken`

### 2) Deploy coordinator runtime

If using Fly, create a new coordinator app and deploy the same build. Any node in the gossip mesh can act as a coordinator — there is no fixed "coordinator-2" role.

Minimum runtime env:

```dotenv
MESH_AUTH_TOKEN=<mesh-token>
COORDINATOR_PUBLIC_URL=https://<your-coordinator>.fly.dev
CONTROL_PLANE_URL=https://control.edgecoder.io
COORDINATOR_BOOTSTRAP_URLS=https://coordinator.edgecoder.io
COORDINATOR_REGISTRATION_TOKEN=<token-from-portal-node-enrollment>
```

Recommended:

- keep coordinator sizing near `performance-2x / 8GB` for Ollama-local workloads
- set `OLLAMA_AUTO_INSTALL=false` and pre-pull models

Linux `systemd` managed coordinator option:

```bash
npm install
npm run build
sudo bash scripts/linux/systemd/install-systemd.sh coordinator "$(pwd)"
sudo nano /etc/edgecoder/coordinator.env
sudo systemctl restart io.edgecoder.coordinator.service
```

Useful checks:

```bash
sudo systemctl status io.edgecoder.coordinator.service
sudo journalctl -u io.edgecoder.coordinator.service -f
```

Coordinator host bootstrap:

```bash
sudo bash deploy/linux/bootstrap-host.sh coordinator https://github.com/<your-org>/Edgecoder.git main /opt/edgecoder/app
sudo systemctl restart io.edgecoder.coordinator.service
```

### 3) Approve enrolled coordinator

```bash
curl -X POST \
  -H "Authorization: Bearer <ADMIN_API_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"approved":true}' \
  https://control.edgecoder.io/coordinators/<COORDINATOR_ID>/approval
```

### 4) Verify mesh joining

Check control-plane discovery feed:

```bash
curl -s https://control.edgecoder.io/network/coordinators
```

Check peer view from an existing coordinator (mesh token required):

```bash
curl -s -H "x-mesh-token: <MESH_AUTH_TOKEN>" https://coordinator.edgecoder.io/mesh/peers
```

## Troubleshooting

- `node_not_activated` on register:
  - verify email in portal
  - verify approval API call succeeded
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
6. Approve in batches from control plane:
   - approve first 3, verify stable
   - approve next 7
7. Validate all 10:
   - present in `GET /agents/catalog`
   - no `node_not_activated` registration errors
   - expected `ownerEmail`, `sourceIp`, `vpnDetected`, `countryCode` fields visible in UI

Batch approval loop example:

```bash
for id in agent-001 agent-002 agent-003 agent-004 agent-005 agent-006 agent-007 agent-008 agent-009 agent-010; do
  curl -sS -X POST \
    -H "Authorization: Bearer <ADMIN_API_TOKEN>" \
    -H "content-type: application/json" \
    -d '{"approved":true}' \
    "https://control.edgecoder.io/agents/${id}/approval"
  echo
done
```

Quick verification:

```bash
curl -s -H "Authorization: Bearer <ADMIN_API_TOKEN>" https://control.edgecoder.io/agents/catalog
```
