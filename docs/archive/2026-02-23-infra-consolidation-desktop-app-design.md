# Infrastructure Consolidation, Tauri Desktop App & Global E2E Testing — Design

## Goal

Reduce Fly.io hosting costs by eliminating redundant services (coordinator-2, standalone inference, control-plane, docs), build a Tauri-based full node operator desktop app, and establish end-to-end testing for the global decentralized agent mesh.

## Architecture

EdgeCoder is moving to a BitTorrent-style fully decentralized model where every node is both agent and coordinator. The unified agent embeds inference, coordination, and task execution in a single process. Fly.io retains only the portal (enrollment, auth, bitcoin) and one seed node (bootstrap peer for mesh discovery).

## Workstream A: Fly.io Consolidation

### Current State (6 Fly apps)

| App | VM Spec | Monthly Cost Driver | Status |
|-----|---------|-------------------|--------|
| edgecoder-coordinator | 2 CPU, 8GB | Primary coordinator | **Keep as seed node** |
| edgecoder-coordinator-2 | 2 CPU, 8GB | Redundant coordinator | **Eliminate** |
| edgecoder-inference | 1 CPU, 1GB | Standalone inference | **Eliminate** (merged into agent) |
| edgecoder-control-plane | 1 CPU, 1GB | Admin dashboard | **Eliminate** (moves to Tauri app) |
| edgecoder-portal | 1 CPU, 1GB | Auth, enrollment, bitcoin | **Keep** |
| edgecoder-docs | 1 CPU, 512MB | Documentation site | **Eliminate** (move to GitHub Pages) |

### Target State (2 Fly apps)

| App | Purpose | Config |
|-----|---------|--------|
| edgecoder-portal | User enrollment, passkey auth, bitcoin transactions, node activation | Existing `fly.portal.toml` unchanged |
| edgecoder-seed | Bootstrap seed node — runs unified agent (coordinator + inference + worker) with Ollama model, contributes compute to the mesh | New `fly.seed-node.toml`, 2 CPU 8GB, runs `EDGE_RUNTIME_MODE=all-in-one` |

### Migration Steps

1. Create `deploy/fly/fly.seed-node.toml` — based on coordinator config but runs unified agent mode
2. Deploy seed node, verify it coordinates + serves inference + executes tasks
3. Update `COORDINATOR_DISCOVERY_URL` in portal to point at seed node
4. Tear down: coordinator-2, inference, control-plane, docs
5. Move docs to GitHub Pages (free, auto-deploy from `docs/` branch)
6. Update DNS: `coordinator.edgecoder.io` points to seed node
7. Remove stale Fly Postgres attachment for control-plane (portal keeps its own DB)

### Databases

- `edgecoder-postgres` — attached to seed node (was coordinator)
- `edgecoder-portal-postgres` — attached to portal (unchanged)

---

## Workstream B: Tauri Desktop App — Full Node Operator UI

### Architecture

- **Shell:** Tauri v2 (Rust-based, native webview, ~5MB binary)
- **Frontend:** Svelte SPA inside Tauri webview
- **Backend:** The existing Node.js unified agent process running on `localhost:4301`
- **Communication:** Frontend calls local agent REST API (`http://localhost:4301/*`)
- **System tray:** Tray icon with quick status; click opens full UI window

### UI Panels

| Panel | Purpose | API Source |
|-------|---------|-----------|
| **Dashboard** | Agent status, model loaded, uptime, tasks completed, earnings | `/health/runtime`, `/status` |
| **Mesh Topology** | Connected peers globally, their models, regions, load status | `/mesh/peers`, `/agent-mesh/peers/:id`, gossip data |
| **Model Manager** | Pull/swap/remove Ollama models, set active model | `/model/list`, `/model/swap`, `/model/status`, `/model/pull` |
| **Credits & Wallet** | Balance, transaction history, Lightning withdrawals | `/credits/*`, portal wallet endpoints |
| **Task Queue** | Active/completed/failed tasks, delegation history | `/status`, local SQLite task history |
| **Settings** | Mesh token, power policy, concurrent tasks, BLE toggle, coordinator role | Agent env config, `/orchestration/*` |

### Project Structure

```
desktop/
  src-tauri/         # Rust: Tauri config, system tray, process management
    tauri.conf.json
    src/main.rs
  src/               # Svelte frontend
    App.svelte
    pages/
      Dashboard.svelte
      MeshTopology.svelte
      ModelManager.svelte
      Credits.svelte
      TaskQueue.svelte
      Settings.svelte
    lib/
      api.ts         # REST client for localhost:4301
  package.json
```

### Build Targets

- macOS: `.dmg` (x86_64 + aarch64 universal)
- Linux: `.AppImage`, `.deb`
- Windows: `.msi` (future)

### Agent Process Management

Tauri app manages the Node.js agent as a child process:
- On launch: start `node dist/index.js` with `EDGE_RUNTIME_MODE=all-in-one`
- On quit: gracefully stop agent process
- Health check: poll `/health/runtime` every 5s, show status in tray
- If agent dies: auto-restart with backoff

---

## Workstream C: End-to-End Testing — Global Mesh Focus

### Tier 1: Single-Machine Simulation

Spin up 5+ agent processes with unique peer IDs on localhost. Verify:
- Gossip message propagation across all peers
- Task submission routed to best available agent
- Fair-share scheduling distributes work evenly
- Credit settlement flows correctly across multi-hop paths
- Agent joining/leaving mesh (churn) handled gracefully

**Tooling:** Extend existing `tests/e2e/task-distribution-harness.test.ts` with multi-agent mesh simulation.

### Tier 2: Multi-Host / WAN Testing

Deploy agents on 2-3 geographically separate hosts (Fly seed node + local machines on different networks). Verify:
- Peer discovery via coordinator discovery URL (`GET /network/coordinators`)
- Task submitted in one region routed to agent in another
- Gossip mesh messages propagate across WAN peers within TTL
- Credit/ledger consistency across the distributed network
- Ledger hash chain remains valid across all nodes
- Nonce replay protection works across network boundaries

**Tooling:** Manual test script (`scripts/e2e/wan-mesh-test.sh`) that deploys agents, submits tasks, and validates results.

### Tier 3: Scale Testing

Simulate 10-20+ agents (mix of Docker containers + real machines). Verify:
- Mesh handles high peer count without gossip storms
- Fair-share scheduling works under concurrent load from multiple submitters
- No single point of failure — seed node can go down, mesh continues via peer-to-peer
- Reconnection and re-sync when seed node comes back online

### Tier 4: Desktop Deployment Validation

Install Tauri app on real macOS and Linux workstations. Verify:
- App launches, starts agent, connects to live global mesh
- Dashboard shows real peers from Fly seed node and other agents
- Model pull/swap works through the UI
- Agent receives and executes tasks from the global mesh
- Credits accrue and appear in wallet panel
- BLE local peer discovery works alongside internet mesh (macOS only)

---

## Sequencing

1. **Workstream A first** — Consolidate Fly.io (reduce cost immediately, establish seed node)
2. **Workstream C Tier 1-2** — E2E testing of the unified agent on the consolidated infra
3. **Workstream B** — Build Tauri desktop app (depends on stable unified agent from A)
4. **Workstream C Tier 3-4** — Scale testing and desktop deployment validation

---

## Success Criteria

- Fly.io reduced from 6 apps to 2 (portal + seed node)
- Tauri desktop app builds and installs on macOS and Linux
- 5+ agents form a functioning global mesh, route tasks, settle credits
- Desktop app connects to mesh, shows live peers, manages models, displays earnings
- No regressions: all 313+ existing tests continue to pass
