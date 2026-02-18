# Deployment Topology

This page documents production deployment shape, service boundaries, and installation options for all EdgeCoder node types.

## Standard Service Split

| Service | Role | Default Port |
|---|---|---|
| **Portal** | User identity, node enrollment, wallet/credits, download page | 4310 |
| **Control Plane** | Operator APIs for network/security/rollout governance | 4303 |
| **Coordinator** | Mesh scheduler, peer-direct orchestration, rollout management | 4301 |
| **Inference** | Task decomposition and model inference service | 4302 |
| **IDE Provider** | Local IDE inference API for dev-machine agents | 4304 |

## Typical Production Domains (Fly.io)

| App | URL |
|---|---|
| Portal | `https://portal.edgecoder.io` |
| Control Plane | `https://control.edgecoder.io` |
| Coordinator | `https://coordinator.edgecoder.io` |

## Node Types

### macOS agent (worker)
- **Package**: `.pkg` installer (`EdgeCoder-{version}-macos-installer.pkg`)
- **Service manager**: LaunchDaemon (`io.edgecoder.runtime`)
- **Config**: `/etc/edgecoder/edgecoder.env`
- **Logs**: `/var/log/edgecoder/runtime.log`
- **Restart**: `sudo launchctl kickstart -k system/io.edgecoder.runtime`
- **Arch**: Apple Silicon (arm64) + Intel (x86_64)
- **Requires**: Node.js 20+

### Linux agent / coordinator (Debian/Ubuntu)
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
- **BLE**: CBPeripheralManager — advertises EdgeCoder service UUID
- **Auto-fallback**: Switches to Bluetooth Local when internet drops
- **Rewards**: On mode only; Bluetooth Local mode earns no credits

### Docker
- **Image**: `ghcr.io/edgecoder-io/edgecoder:latest`
- **Mode**: Set `EDGE_RUNTIME_MODE=worker` or `coordinator`
- **Includes**: Node.js 20, Ollama support

## Fly-Oriented Topology Pattern

- Deploy each service as an independent Fly app.
- Keep process-level boundaries explicit — do not co-locate coordinator and portal on the same machine in production.
- Use environment controls for service URLs and auth tokens.
- Apply rolling updates with health checks per app (`fly deploy --strategy rolling`).

## EDGE_RUNTIME_MODE values

| Value | Process |
|---|---|
| `worker` | Swarm agent — joins coordinator and executes tasks |
| `coordinator` | Mesh coordinator — schedules tasks, manages rollouts |
| `ide-provider` | IDE inference provider API on port 4304 |
| `control-plane` | Admin / operator control plane API |
| `inference` | Standalone inference service |
| `all-in-one` | Dev stack: coordinator + inference + control-plane in one process |

## Local Development Ports

| Service | Port |
|---|---|
| Coordinator | 4301 |
| Inference | 4302 |
| Control Plane | 4303 |
| IDE Provider | 4304 |
| Portal | 4310 |

```bash
# Start all services locally
npm run dev              # all-in-one
npm run dev:coordinator  # coordinator only
npm run dev:worker       # worker agent only
npm run dev:portal       # portal only
npm run dev:ide          # IDE provider only
```

## Networking and Security Considerations

- Coordinator routes must remain mesh-authenticated (`x-mesh-token` header).
- Inference routes can be token-gated.
- Keep model daemons bound to local/private interfaces when applicable.
- Keep secrets out of static config; use secret stores in production.
- iOS agents communicate with coordinator over HTTPS only; `NSAllowsArbitraryLoads` is `false`.

## Build and release

```bash
# macOS installer
npm run build:macos-installer

# Linux .deb
npm run build:linux-deb

# GitHub Actions release (triggered by v*.*.* tag push)
git tag v1.0.1 && git push origin v1.0.1
```

Release artifacts are published to GitHub Releases at:
`https://github.com/edgecoder-io/edgecoder/releases`

## Cross-links

- [Environment Variables](/reference/environment-variables)
- [Role-based Runbooks](/operations/role-based-runbooks)
- [iOS Background Execution](/operations/ios-power-scheduling)
