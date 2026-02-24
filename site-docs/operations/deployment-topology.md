# Deployment Topology

This page documents the deployment model, service boundaries, and installation options for EdgeCoder.

## Unified Agent Model

The primary deployment unit is the **unified agent** -- a single process that runs coordinator, inference, and control-plane together. This is the default for both local development and single-node production deployments. In `docker-compose.yml` this process is the `seed-node` service, started with `EDGE_RUNTIME_MODE=all-in-one`.

### Ports within a unified agent node

| Port | Subsystem | Description |
|---|---|---|
| 4301 | Coordinator | Mesh scheduler, peer-direct orchestration, rollout management |
| 4302 | Inference | Task decomposition and model inference |
| 4303 | Control Plane | Operator APIs for network/security/rollout governance |

### Standalone services

These run as their own processes, outside the unified agent:

| Service | Default Port | Description |
|---|---|---|
| **IDE Provider** | 4304 | Local IDE inference API for dev-machine agents |
| **Portal** | 4310 | User identity, node enrollment, wallet/credits, download page |
| **Anchor Proxy** | 4311 | Edge-network ingress proxy |

## Standard Local Setup (docker-compose)

The `docker-compose.yml` at the repository root starts three services:

| Service | Image / Build | Role |
|---|---|---|
| `postgres` | `postgres:16` | Persistent data store |
| `seed-node` | Local build (`EDGE_RUNTIME_MODE=all-in-one`) | Unified agent -- coordinator + inference + control-plane on ports 4301-4303 |
| `ide-provider` | Local build | IDE inference provider on port 4304, depends on seed-node health |

```bash
# Bring up the standard local stack
docker compose up --build

# Or start individual services
docker compose up postgres seed-node
docker compose up ide-provider
```

## EDGE_RUNTIME_MODE values

| Value | Process |
|---|---|
| `all-in-one` | **Unified agent** -- coordinator + inference + control-plane in one process (default) |
| `coordinator` | Coordinator subsystem only |
| `inference` | Inference subsystem only |
| `control-plane` | Control-plane subsystem only |
| `ide-provider` | IDE inference provider API on port 4304 |

## Node Types

### macOS agent

- **Package**: `.pkg` installer (`EdgeCoder-{version}-macos-installer.pkg`)
- **Service manager**: LaunchDaemon (`io.edgecoder.runtime`)
- **Config**: `/etc/edgecoder/edgecoder.env`
- **Logs**: `/var/log/edgecoder/runtime.log`
- **Restart**: `sudo launchctl kickstart -k system/io.edgecoder.runtime`
- **Arch**: Apple Silicon (arm64) + Intel (x86_64)
- **Requires**: Node.js 20+

### Linux agent (Debian/Ubuntu)

- **Package**: `.deb` installer (`EdgeCoder-{version}-linux-amd64.deb`)
- **Service manager**: systemd (`edgecoder.service`)
- **Config**: `/etc/edgecoder/edgecoder.env`
- **Logs**: `journalctl -u edgecoder -f`
- **Restart**: `sudo systemctl restart edgecoder`
- **Arch**: amd64
- **Requires**: Node.js 20+

### iOS agent

- **Distribution**: App Store / TestFlight
- **Background**: `BGProcessingTask` + `BGAppRefreshTask` (always-on)
- **Modes**: Off / On (internet swarm) / Bluetooth Local (no internet)
- **BLE**: CBPeripheralManager -- advertises EdgeCoder service UUID
- **Auto-fallback**: Switches to Bluetooth Local when internet drops
- **Rewards**: On mode only; Bluetooth Local mode earns no credits

### Docker

- **Image**: `ghcr.io/codyrs82/Edgecoder:latest`
- **Default mode**: `all-in-one` (unified agent)
- **Includes**: Node.js 20, Ollama support

## Scaled Deployment (Multi-Coordinator Federation)

For production workloads that exceed a single node, EdgeCoder supports federation across multiple coordinators. In this topology each subsystem can be deployed independently and scaled on its own:

- Deploy coordinator, inference, and control-plane as separate processes or containers, each with its own `EDGE_RUNTIME_MODE`.
- Run multiple coordinator instances behind a load balancer for horizontal scale.
- Portal and Anchor Proxy remain standalone services at their own domains.

### Typical Production Domains (Fly.io)

| App | URL |
|---|---|
| Portal | `https://portal.edgecoder.io` |
| Control Plane | `https://control.edgecoder.io` |
| Coordinator | `https://coordinator.edgecoder.io` |

### Fly-Oriented Topology Pattern

- Deploy each subsystem as an independent Fly app only when you need independent scaling.
- Use environment controls for service URLs and auth tokens.
- Apply rolling updates with health checks per app (`fly deploy --strategy rolling`).

## Local Development

```bash
# Start all services locally (unified agent)
npm run dev              # all-in-one on ports 4301-4303
npm run dev:ide          # IDE provider on port 4304
npm run dev:portal       # Portal on port 4310
```

## Networking and Security Considerations

- Coordinator routes must remain mesh-authenticated (`x-mesh-token` header).
- Inference routes can be token-gated.
- Keep model daemons bound to local/private interfaces when applicable.
- Keep secrets out of static config; use secret stores in production.
- iOS agents communicate with coordinator over HTTPS only; `NSAllowsArbitraryLoads` is `false`.

## Build and Release

```bash
# macOS installer
npm run build:macos-installer

# Linux .deb
npm run build:linux-deb

# GitHub Actions release (triggered by v*.*.* tag push)
git tag v1.0.1 && git push origin v1.0.1
```

Release artifacts are published to GitHub Releases at:
`https://github.com/codyrs82/Edgecoder/releases`

## Cross-links

- [Environment Variables](/reference/environment-variables)
- [Role-based Runbooks](/operations/role-based-runbooks)
- [iOS Background Execution](/operations/ios-power-scheduling)
