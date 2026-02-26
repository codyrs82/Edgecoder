# EdgeCoder

Decentralized AI coding platform -- a peer-to-peer swarm of local LLMs that collaboratively write, test, and refine code.

EdgeCoder is a privacy-first coding assistant that runs on your own machines. It helps write and test code without sending your source to a cloud service. When a task exceeds local capacity it can be split across trusted peers or escalated to a larger model.

## Architecture

EdgeCoder is composed of five backend services, a desktop app, and an iOS app. Each service is independently deployable, or all can run in a single "all-in-one" process via `npm run dev`.

```
 User
  |
  v
Portal (4310)  <----->  Control Plane (4303)
  |                           |
  v                           v
Coordinator (4301) <--> Coordinator peers (mesh)
  |           \
  v            v
Workers     Inference (4302)
```

- **Portal** -- user-facing web app with passkey/SSO auth, chat, code reviews, wallet, and coordinator operations dashboard.
- **Coordinator** -- task queue, swarm orchestration, P2P gossip mesh, BLE local mesh, agent lifecycle, economy APIs.
- **Inference Service** -- LLM-powered task decomposition and escalation. Breaks large prompts into subtasks.
- **Control Plane** -- admin API for agent management, rollouts, network mode, credits, and economy operations.
- **Worker Runner** -- swarm agent that registers with a coordinator, pulls subtasks, executes code in a sandbox, and returns results.
- **Desktop App** -- Tauri + Svelte desktop client (`desktop/`).
- **iOS App** -- native Swift BLE proxy + WebView (`ios/`).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a detailed walkthrough of data flows, mesh networking, and the credit economy.

## Production URLs

| Service | URL |
|---------|-----|
| Portal | `https://portal.edgecoder.io/portal` |
| Control Plane | `https://control.edgecoder.io` |
| Coordinator | `https://coordinator.edgecoder.io` (mesh-auth required) |
| Docs | `https://docs.edgecoder.io` |

## Quick Start

### Prerequisites

- **Node.js 20+** and npm
- **Ollama** (optional; auto-installed when `OLLAMA_AUTO_INSTALL=true`)
- **Docker** (optional; required for Docker sandbox mode)

### Install and Run

```bash
npm install
npm run dev
```

This boots coordinator (`:4301`), inference (`:4302`), control plane (`:4303`), and an embedded worker in a single process.

If the default ports are in use, run on alternate ports:

```bash
npm run dev:alt
```

### Run Services Individually

```bash
npm run dev:inference     # :4302
npm run dev:coordinator   # :4301
npm run dev:control       # :4303
npm run dev:portal        # :4310
npm run dev:ide           # :4304
npm run dev:worker        # standalone worker
```

Start workers with explicit identity:

```bash
AGENT_ID=node-1 AGENT_OS=macos AGENT_REGISTRATION_TOKEN=<token> npm run dev:worker
AGENT_ID=iphone-1 AGENT_REGISTRATION_TOKEN=<token> npm run dev:worker:ios
```

### Local Endpoints

| Service | URL |
|---------|-----|
| Coordinator | `http://localhost:4301` |
| Inference | `http://localhost:4302` |
| Control Plane | `http://localhost:4303` |
| IDE Provider | `http://localhost:4304` |
| Portal | `http://localhost:4310` |
| Docs (VitePress) | `http://localhost:5173` (`npm run docs:dev`) |

### Full Local Stack with Docker

```bash
docker compose up --build   # starts postgres, seed-node, ide-provider
docker compose down         # tear down
```

### Configuration

Key environment variables (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full reference):

| Variable | Default | Description |
|----------|---------|-------------|
| `COORDINATOR_PORT` | `4301` | Coordinator listen port |
| `INFERENCE_PORT` | `4302` | Inference service listen port |
| `CONTROL_PLANE_PORT` | `4303` | Control plane listen port |
| `MESH_AUTH_TOKEN` | | Shared secret for coordinator mesh authentication |
| `LOCAL_MODEL_PROVIDER` | `edgecoder-local` | Model backend (`edgecoder-local` or `ollama-local`) |
| `OLLAMA_MODEL` | `qwen2.5-coder:latest` | Ollama model name |
| `OLLAMA_AUTO_INSTALL` | `false` | Auto-install Ollama if missing |
| `AGENT_ID` | `worker-1` | Unique agent identifier |
| `AGENT_MODE` | `swarm-only` | Agent mode (`swarm-only` or `ide-enabled`) |
| `AGENT_OS` | auto-detected | Operating system (`macos`, `linux`, `windows`, `ios`) |
| `SANDBOX_MODE` | `docker` | Sandbox mode (`docker`, `process`, `none`) |
| `DATABASE_URL` | | PostgreSQL connection string |
| `BITCOIN_NETWORK` | `testnet` | Bitcoin network (`bitcoin`, `testnet`, `signet`) |

## Components

### Portal (port 4310)

User-facing web application serving the signup/login flow, chat interface, code reviews, wallet management, and coordinator operations dashboard.

**Key features:**
- Email/password signup with email verification
- SSO via Google and Microsoft 365 (OAuth 2.0)
- Passkey (WebAuthn) enrollment and login
- Chat interface that submits tasks to the coordinator
- Code review queue with approve/reject decisions
- Human escalation handling for tasks that exceed swarm capacity
- Node enrollment and token issuance
- Credit wallet with BTC/Lightning purchase intents
- Wallet seed backup acknowledgement flow
- User-selectable themes (Midnight, Emerald, Light Pro)
- Coordinator operations dashboard (node approval, model rollouts, diagnostics)
- iOS dashboard with contribution and network aggregate views

### Coordinator (port 4301)

Central task queue and swarm orchestrator. Manages agent registration, task submission, decomposition via the inference service, subtask assignment, result collection, and the credit economy.

**Key features:**
- Agent registration with portal-based node approval
- Task submission, decomposition, and subtask pull/result cycle
- P2P gossip mesh with WebSocket and HTTP transports
- Peer exchange, capability announcement, and peer scoring
- BLE mesh for local device-to-device task routing
- Agent-mesh direct work offers for lightweight peer collaboration
- Credit economy: dynamic pricing, payment intents, Lightning settlement
- Issuance system: daily token pool, load-curve allocation, quorum voting
- Treasury policy management and Bitcoin anchoring
- Tamper-evident ordering chain (hash-chain ledger)
- Blacklist propagation and security audit log
- Power policy enforcement (iOS battery, desktop thermal)
- Robot queue for long-running automation tasks

### Inference Service (port 4302)

Handles LLM-powered task decomposition and escalation. When a coordinator receives a task, it calls the inference service to break it into subtasks. When a worker fails, the escalation endpoint generates improved code using a larger model context.

**Endpoints:**
- `POST /decompose` -- break a prompt into subtasks
- `POST /escalate` -- reflect on failed code and produce improved output
- `GET /health` -- health check
- `GET /metrics` -- request counters and latency

### Control Plane (port 4303)

Admin API and dashboard for operators. Provides agent management, network mode control, rollout orchestration, credit management, and economy APIs.

**Key features:**
- Agent catalog with mode, model, and approval management
- Canary/percentage/full rollout orchestration with promote/rollback
- Credit accounts, faucet, and balance queries
- Economy APIs: pricing, issuance, wallets, payment intents, treasury
- Network summary (capacity, jobs, pricing)
- Coordinator discovery and mesh peer listing
- Security blacklist management
- Admin auth via `ADMIN_API_TOKEN` and IP allowlist

### Worker Runner

Swarm agent process that registers with a coordinator, enters a poll loop, pulls subtasks, executes code in a sandbox, and posts results.

**Key features:**
- Coordinator discovery with failover and cache
- Concurrent task execution (configurable via `MAX_CONCURRENT_TASKS`)
- Sandbox enforcement: Docker, process-level (`sandbox-exec` on macOS, seccomp/namespaces on Linux), or none
- Offline resilience with exponential backoff and reconnect probes
- BLE mesh participation for local peer discovery
- Agent-mesh HTTP server for direct peer-to-peer work
- Power-aware scheduling (battery, thermal, AC power detection)
- Model swap via Ollama integration
- Request signing (Ed25519) and task envelope encryption (X25519 + AES-256-GCM)

### Desktop App

Tauri + Svelte desktop client in `desktop/`. Packages the portal UI as a native application.

### iOS App

Native Swift BLE proxy + WebView in `ios/`. Acts as a swarm worker with BLE mesh support for local device-to-device task offloading.

## Deployment

### Fly.io

Each service has a Fly.io configuration in `deploy/fly/`:

| Config | App | Internal Port |
|--------|-----|---------------|
| `fly.seed-node.toml` | `edgecoder-seed` | 4301 |
| `fly.seed-eu.toml` | EU seed node | 4301 |
| `fly.portal.toml` | `edgecoder-portal` | 4310 |
| `fly.control-plane.toml` | `edgecoder-control-plane` | 4303 |
| `fly.inference.toml` | `edgecoder-inference` | 4302 |
| `fly.toml` | `edgecoder-coordinator` | 4301 |

Deploy with:

```bash
fly deploy -c deploy/fly/fly.seed-node.toml
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for detailed Fly.io, Docker, systemd, and self-hosted instructions.

### Self-Hosted (Linux)

```bash
sudo bash deploy/linux/bootstrap-host.sh <agent|coordinator|seed> <repo_url> [branch] [install_dir]
```

This installs Node.js, clones the repo, builds, and installs a systemd service. Edit `/etc/edgecoder/<role>.env` and restart the service.

### Installers

- **macOS:** `npm run build:macos-installer` -- produces `build/EdgeCoder-<version>-macos-installer.pkg`
- **Linux:** `npm run build:linux-deb` -- produces a `.deb` package
- **Windows:** `npm run build:windows-msi` -- produces a `.msi` installer (requires WiX Toolset)

## Security

- **Passkey authentication** (WebAuthn) with challenge TTL and replay protection
- **OAuth 2.0 SSO** via Google and Microsoft with PKCE
- **Mesh authentication** via shared `MESH_AUTH_TOKEN` on all coordinator routes
- **Request signing** (Ed25519) on agent-to-coordinator communication with nonce and timestamp validation
- **Task envelope encryption** (X25519 ECDH + AES-256-GCM) for subtask payloads
- **Sandbox enforcement** -- Docker isolation (default for swarm workers), process-level sandboxing (`sandbox-exec` on macOS, seccomp/namespaces on Linux)
- **Blacklist propagation** with evidence hashing, reporter signature verification, and gossip broadcast
- **Tamper-evident audit ledger** (hash-chain) with Bitcoin anchoring for integrity verification
- **Rate limiting** per agent with configurable window
- **Admin access control** via API tokens and IP allowlists
- **Portal node approval** -- agents must be enrolled and approved before participating
- **IDE mode** requires a locally running authenticated agent (no direct public model access)

## Testing

```bash
npm test            # run all tests (vitest)
npm run test:watch  # watch mode
```

## Repository Structure

```
src/
  agent/          - interactive and worker agent loops
  executor/       - safe code execution (sandbox, Docker, AST validation)
  swarm/          - coordinator, queue, worker runner, power policy
  inference/      - decomposition and escalation service
  control-plane/  - admin APIs, rollouts, dashboard
  portal/         - user-facing auth, chat, reviews, wallet
  apps/ide/       - IDE provider endpoint (OpenAI-compatible)
  mesh/           - peer registration, gossip, BLE mesh
  mesh/ble/       - Bluetooth Low Energy transport and routing
  security/       - blacklist, envelope encryption, request signing, rate limiting
  credits/        - credit engine, pricing, store
  economy/        - dynamic pricing, issuance, Lightning, treasury, Bitcoin RPC
  ledger/         - hash-chain ordering, verification, quorum
  escalation/     - escalation resolver, human escalation store
  model/          - Ollama installer, model router, prompts, swap
  db/             - PostgreSQL and SQLite stores
  bootstrap/      - coordinator bootstrap and audit verification
  common/         - shared types, logger, platform detection
  handshake/      - cloud review handshake protocol
deploy/
  fly/            - Fly.io deployment configs
  linux/          - Linux host bootstrap script
scripts/
  macos/          - macOS .pkg installer and launchd wrapper
  linux/          - .deb builder and systemd units
  windows/        - .msi builder (WiX)
desktop/          - Tauri + Svelte desktop app
ios/              - native Swift iOS app
docs/             - operational docs and design plans
site-docs/        - VitePress documentation site
tests/            - test suites
```

## Docs

- **API reference:** [docs/API.md](docs/API.md)
- **Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Deployment:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- **Developer guide:** [README.dev.md](README.dev.md)
- **Product plan:** [EDGECODER_PLAN.md](EDGECODER_PLAN.md)
- **Public mesh operations:** [docs/public-mesh-operations.md](docs/public-mesh-operations.md)
- **Agent install runbook:** [docs/agent-and-coordinator-install.md](docs/agent-and-coordinator-install.md)
- **macOS deployment:** [docs/macos-installer.md](docs/macos-installer.md)
- **Fly.io bootstrap:** [docs/flyio-bootstrap.md](docs/flyio-bootstrap.md)
- **iOS release guide:** [docs/ios-app-store-release.md](docs/ios-app-store-release.md)
- **VitePress docs site:** `npm run docs:dev` (serves at `http://localhost:5173`)

## License

ISC
