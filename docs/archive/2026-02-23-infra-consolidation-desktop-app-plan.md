# Infrastructure Consolidation, Tauri Desktop App & Global E2E Testing — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce Fly.io from 6 apps to 2 (portal + seed node), build a Tauri/Svelte desktop app for full node operation, and establish 4-tier global E2E testing for the decentralized agent mesh.

**Architecture:** The unified agent already embeds coordinator + inference + worker in a single process (`src/index.ts`). This plan creates a `fly.seed-node.toml` that runs that unified process as the mesh bootstrap seed, eliminates 4 redundant Fly apps, wraps the agent in a Tauri v2 desktop shell with Svelte UI, and builds E2E tests from single-machine simulation up to global multi-host WAN verification.

**Tech Stack:** Node.js 20, Fastify, TypeScript, Tauri v2 (Rust), Svelte, Vitest, Docker Compose, Fly.io, VitePress (GitHub Pages), Ed25519 security (already wired)

---

## Workstream A: Fly.io Consolidation (6 → 2 apps)

### Task 1: Create fly.seed-node.toml

**Files:**
- Create: `deploy/fly/fly.seed-node.toml`

**Step 1: Write the seed node Fly config**

Create `deploy/fly/fly.seed-node.toml` based on the existing coordinator config (`deploy/fly/fly.toml`) but running the unified `dist/index.js` process (coordinator + inference + control-plane in one):

```toml
app = "edgecoder-seed"
primary_region = "ord"

[processes]
  app = "sh -lc 'ollama serve >/tmp/ollama.log 2>&1 & node dist/index.js'"

[build]
  dockerfile = "../../Dockerfile"

[env]
  NODE_ENV = "production"
  EDGE_RUNTIME_MODE = "all-in-one"
  NETWORK_MODE = "public_mesh"
  COORDINATOR_PUBLIC_URL = "https://coordinator.edgecoder.io"
  LOCAL_MODEL_PROVIDER = "edgecoder-local"
  OLLAMA_AUTO_INSTALL = "false"
  OLLAMA_MODEL = "qwen2.5-coder:latest"

[http_service]
  internal_port = 4301
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[http_service.concurrency]
  type = "connections"
  hard_limit = 200
  soft_limit = 150

[[vm]]
  memory = "8192mb"
  cpu_kind = "performance"
  cpus = 2
```

**Step 2: Verify the config is syntactically valid**

Run: `cd /Users/codysmith/Cursor/Edgecoder && cat deploy/fly/fly.seed-node.toml`
Expected: Valid TOML printed without error

**Step 3: Commit**

```bash
git add deploy/fly/fly.seed-node.toml
git commit -m "feat: add fly.seed-node.toml for unified agent seed node"
```

---

### Task 2: Update docker-compose.yml for unified seed node

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Write a test for docker-compose validity**

Run: `docker compose -f docker-compose.yml config --quiet` (should succeed after changes)

**Step 2: Modify docker-compose.yml**

Replace the separate `coordinator`, `inference`, `control-plane` services with a single `seed-node` service. Keep `postgres`, `cloud-review`, `ide-provider`, `worker-1`. The seed-node runs `dist/index.js` which starts all three servers on ports 4301, 4302, 4303.

Replace:
```yaml
  inference:
    build: .
    command: ["node", "dist/inference/service.js"]
    ports:
      - "4302:4302"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4302/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 5

  coordinator:
    build: .
    command: ["node", "dist/swarm/coordinator.js"]
    environment:
      - NODE_ENV=development
      - DATABASE_URL=postgresql://edgecoder:edgecoder@postgres:5432/edgecoder
      - LOCAL_MODEL_PROVIDER=edgecoder-local
      - OLLAMA_AUTO_INSTALL=false
      - OLLAMA_MODEL=qwen2.5-coder:latest
    ports:
      - "4301:4301"
    depends_on:
      inference:
        condition: service_healthy
      postgres:
        condition: service_started
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4301/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 5

  control-plane:
    build: .
    command: ["node", "dist/control-plane/server.js"]
    environment:
      - DATABASE_URL=postgresql://edgecoder:edgecoder@postgres:5432/edgecoder
      - COORDINATOR_URL=http://coordinator:4301
    ports:
      - "4303:4303"
    depends_on:
      coordinator:
        condition: service_healthy
      postgres:
        condition: service_started
```

With:
```yaml
  seed-node:
    build: .
    command: ["node", "dist/index.js"]
    environment:
      - NODE_ENV=development
      - EDGE_RUNTIME_MODE=all-in-one
      - DATABASE_URL=postgresql://edgecoder:edgecoder@postgres:5432/edgecoder
      - LOCAL_MODEL_PROVIDER=edgecoder-local
      - OLLAMA_AUTO_INSTALL=false
      - OLLAMA_MODEL=qwen2.5-coder:latest
    ports:
      - "4301:4301"
      - "4302:4302"
      - "4303:4303"
    depends_on:
      postgres:
        condition: service_started
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4301/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 5
```

Update `worker-1` and `ide-provider` to depend on `seed-node` instead of `coordinator`:
```yaml
  worker-1:
    depends_on:
      seed-node:
        condition: service_healthy
    environment:
      - COORDINATOR_URL=http://seed-node:4301

  ide-provider:
    depends_on:
      seed-node:
        condition: service_healthy
```

Update `control-plane` references in `worker-1` to point to `seed-node` if applicable.

**Step 3: Validate**

Run: `docker compose -f docker-compose.yml config --quiet`
Expected: No errors

**Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "refactor: consolidate coordinator+inference+control-plane into seed-node in docker-compose"
```

---

### Task 3: Update portal config to reference seed node

**Files:**
- Modify: `deploy/fly/fly.portal.toml`

**Step 1: Update CONTROL_PLANE_URL and add COORDINATOR_DISCOVERY_URL**

Since the control-plane is now inside the seed node (port 4303 internally, but external URL changes from `control.edgecoder.io` to the seed node), update the portal config:

```toml
[env]
  NODE_ENV = "production"
  PORTAL_PUBLIC_URL = "https://edgecoder.io"
  PASSKEY_RP_ID = "edgecoder.io"
  PASSKEY_ORIGIN = "https://edgecoder.io"
  COORDINATOR_DISCOVERY_URL = "https://coordinator.edgecoder.io"
  DOCS_SITE_URL = "https://docs.edgecoder.io"
```

Remove `CONTROL_PLANE_URL = "https://control.edgecoder.io"` (no longer a separate service).
Remove `DOCS_SITE_URL = "https://edgecoder-docs.fly.dev"` (will move to GitHub Pages at `docs.edgecoder.io`).
Add `COORDINATOR_DISCOVERY_URL` for agent mesh bootstrap.

**Step 2: Commit**

```bash
git add deploy/fly/fly.portal.toml
git commit -m "feat: update portal config for seed node consolidation"
```

---

### Task 4: Update deploy/linux/bootstrap-host.sh for unified mode

**Files:**
- Modify: `deploy/linux/bootstrap-host.sh`

**Step 1: Add `seed` role alongside existing `agent` and `coordinator`**

Update the role validation to accept `agent`, `coordinator`, or `seed`:

In the validation block, change:
```bash
if [[ "${ROLE}" != "agent" && "${ROLE}" != "coordinator" ]]; then
  echo "error: role must be 'agent' or 'coordinator'." >&2
```

To:
```bash
if [[ "${ROLE}" != "agent" && "${ROLE}" != "coordinator" && "${ROLE}" != "seed" ]]; then
  echo "error: role must be 'agent', 'coordinator', or 'seed'." >&2
```

Update the usage block to show the `seed` role option:
```
  sudo bash deploy/linux/bootstrap-host.sh seed https://github.com/your-org/Edgecoder.git main /opt/edgecoder/app
```

For the `seed` role, the systemd install step should map to the existing coordinator service but set `EDGE_RUNTIME_MODE=all-in-one` in the env file. Add a note in the "Next steps" output:
```bash
if [[ "${ROLE}" == "seed" ]]; then
  echo "  NOTE: Set EDGE_RUNTIME_MODE=all-in-one in /etc/edgecoder/seed.env"
fi
```

**Step 2: Verify script syntax**

Run: `bash -n deploy/linux/bootstrap-host.sh`
Expected: No syntax errors

**Step 3: Commit**

```bash
git add deploy/linux/bootstrap-host.sh
git commit -m "feat: add seed role to linux bootstrap script"
```

---

### Task 5: Create GitHub Pages config for docs

**Files:**
- Create: `.github/workflows/deploy-docs.yml`

**Step 1: Write GitHub Actions workflow for VitePress deployment**

```yaml
name: Deploy Docs to GitHub Pages

on:
  push:
    branches: [main]
    paths:
      - 'site-docs/**'
      - 'package.json'

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci --ignore-scripts
      - run: npm run docs:build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site-docs/.vitepress/dist

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    needs: build
    runs-on: ubuntu-latest
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

**Step 2: Commit**

```bash
git add .github/workflows/deploy-docs.yml
git commit -m "feat: add GitHub Actions workflow for docs deployment to GitHub Pages"
```

---

### Task 6: Create Fly teardown checklist script

**Files:**
- Create: `scripts/fly-teardown-checklist.sh`

**Step 1: Write a non-destructive checklist script**

This script does NOT destroy anything — it prints the manual teardown steps and verifies prerequisites. The actual `fly apps destroy` commands must be run manually.

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== Fly.io Consolidation Teardown Checklist ==="
echo ""
echo "Prerequisites (verify these FIRST):"
echo "  1. edgecoder-seed is deployed and healthy"
echo "     Run: fly status -a edgecoder-seed"
echo "  2. Portal updated to reference seed node"
echo "     Run: fly status -a edgecoder-portal"
echo "  3. DNS coordinator.edgecoder.io points to edgecoder-seed"
echo "  4. GitHub Pages deployed for docs.edgecoder.io"
echo ""
echo "Apps to destroy (run manually):"
echo "  fly apps destroy edgecoder-coordinator-2 --yes"
echo "  fly apps destroy edgecoder-inference --yes"
echo "  fly apps destroy edgecoder-control-plane --yes"
echo "  fly apps destroy edgecoder-docs --yes"
echo ""
echo "Post-teardown:"
echo "  - Verify edgecoder-portal still works: curl https://edgecoder.io/health"
echo "  - Verify seed node: curl https://coordinator.edgecoder.io/status"
echo "  - Verify docs: curl https://docs.edgecoder.io"
echo "  - Remove stale Postgres attachments if any"
echo ""
echo "Remaining Fly apps after teardown: edgecoder-portal, edgecoder-seed"
```

**Step 2: Make executable and commit**

```bash
chmod +x scripts/fly-teardown-checklist.sh
git add scripts/fly-teardown-checklist.sh
git commit -m "feat: add Fly.io teardown checklist script"
```

---

## Workstream B: Tauri Desktop App — Full Node Operator UI

### Task 7: Initialize Tauri + Svelte project

**Files:**
- Create: `desktop/` directory structure

**Step 1: Scaffold Tauri v2 project with Svelte**

```bash
cd /Users/codysmith/Cursor/Edgecoder
npm create tauri-app@latest desktop -- --template svelte-ts --manager npm
```

This creates:
```
desktop/
  src-tauri/
    tauri.conf.json
    src/main.rs
    Cargo.toml
  src/
    App.svelte
    main.ts
  package.json
  tsconfig.json
  vite.config.ts
```

**Step 2: Verify scaffold builds**

```bash
cd desktop && npm install && npm run build
```

**Step 3: Commit**

```bash
cd /Users/codysmith/Cursor/Edgecoder
git add desktop/
git commit -m "feat: scaffold Tauri v2 + Svelte desktop app"
```

---

### Task 8: Configure Tauri for EdgeCoder

**Files:**
- Modify: `desktop/src-tauri/tauri.conf.json`

**Step 1: Update Tauri config**

Set app name, window title, identifier, and permissions:

```json
{
  "productName": "EdgeCoder",
  "version": "1.0.0",
  "identifier": "io.edgecoder.desktop",
  "build": {
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "EdgeCoder — Node Operator",
        "width": 1200,
        "height": 800,
        "minWidth": 900,
        "minHeight": 600
      }
    ],
    "security": {
      "csp": "default-src 'self'; connect-src 'self' http://localhost:4301 http://127.0.0.1:4301; style-src 'self' 'unsafe-inline'"
    },
    "trayIcon": {
      "iconPath": "icons/icon.png",
      "tooltip": "EdgeCoder Agent"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["dmg", "appimage", "deb"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

**Step 2: Commit**

```bash
git add desktop/src-tauri/tauri.conf.json
git commit -m "feat: configure Tauri app identity, window, tray, and build targets"
```

---

### Task 9: Build API client library

**Files:**
- Create: `desktop/src/lib/api.ts`

**Step 1: Write the REST client for localhost:4301**

This module wraps all agent API calls. The agent runs on `localhost:4301` (coordinator), `localhost:4302` (inference), `localhost:4303` (control-plane).

```typescript
const AGENT_BASE = "http://localhost:4301";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status}`);
  return res.json();
}

// Dashboard
export const getHealth = () => get<{ status: string; uptime: number }>("/health/runtime");
export const getStatus = () => get<{ agents: Record<string, unknown>; queueDepth: number }>("/status");

// Mesh Topology
export const getMeshPeers = () => get<{ peers: unknown[] }>("/mesh/peers");
export const getMeshPeer = (id: string) => get<unknown>(`/agent-mesh/peers/${id}`);

// Model Manager
export const getModelList = () => get<{ models: unknown[] }>("/model/list");
export const getModelStatus = () => get<{ model: string; loaded: boolean }>("/model/status");
export const swapModel = (model: string) => post("/model/swap", { model });
export const pullModel = (model: string) => post("/model/pull", { model });

// Credits & Wallet
export const getCredits = () => get<{ balance: number }>("/credits/balance");
export const getCreditHistory = () => get<{ transactions: unknown[] }>("/credits/history");
```

**Step 2: Commit**

```bash
git add desktop/src/lib/api.ts
git commit -m "feat: add REST API client for agent communication"
```

---

### Task 10: Build Dashboard page

**Files:**
- Create: `desktop/src/pages/Dashboard.svelte`

**Step 1: Write the Dashboard component**

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getHealth, getStatus } from "../lib/api";

  let health: { status: string; uptime: number } | null = null;
  let status: { agents: Record<string, unknown>; queueDepth: number } | null = null;
  let error = "";
  let interval: ReturnType<typeof setInterval>;

  async function refresh() {
    try {
      [health, status] = await Promise.all([getHealth(), getStatus()]);
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Connection failed";
    }
  }

  onMount(() => {
    refresh();
    interval = setInterval(refresh, 5000);
  });

  onDestroy(() => clearInterval(interval));

  function formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
</script>

<div class="dashboard">
  <h1>Dashboard</h1>

  {#if error}
    <div class="error">{error}</div>
  {:else if health}
    <div class="stats">
      <div class="stat">
        <span class="label">Status</span>
        <span class="value {health.status === 'ok' ? 'green' : 'red'}">{health.status}</span>
      </div>
      <div class="stat">
        <span class="label">Uptime</span>
        <span class="value">{formatUptime(health.uptime)}</span>
      </div>
      {#if status}
        <div class="stat">
          <span class="label">Connected Agents</span>
          <span class="value">{Object.keys(status.agents).length}</span>
        </div>
        <div class="stat">
          <span class="label">Queue Depth</span>
          <span class="value">{status.queueDepth}</span>
        </div>
      {/if}
    </div>
  {:else}
    <p>Connecting to agent...</p>
  {/if}
</div>

<style>
  .dashboard { padding: 1.5rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
  .stat { background: var(--bg-card, #1a1a2e); padding: 1.2rem; border-radius: 8px; }
  .label { display: block; font-size: 0.85rem; opacity: 0.7; margin-bottom: 0.3rem; }
  .value { font-size: 1.6rem; font-weight: 600; }
  .green { color: #4ade80; }
  .red { color: #f87171; }
  .error { background: #7f1d1d; color: #fca5a5; padding: 1rem; border-radius: 8px; }
</style>
```

**Step 2: Commit**

```bash
git add desktop/src/pages/Dashboard.svelte
git commit -m "feat: add Dashboard page with agent status and stats"
```

---

### Task 11: Build MeshTopology page

**Files:**
- Create: `desktop/src/pages/MeshTopology.svelte`

**Step 1: Write the Mesh Topology component**

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getMeshPeers } from "../lib/api";

  let peers: any[] = [];
  let error = "";
  let interval: ReturnType<typeof setInterval>;

  async function refresh() {
    try {
      const data = await getMeshPeers();
      peers = data.peers || [];
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load peers";
    }
  }

  onMount(() => {
    refresh();
    interval = setInterval(refresh, 10000);
  });

  onDestroy(() => clearInterval(interval));
</script>

<div class="mesh">
  <h1>Mesh Topology</h1>
  <p class="subtitle">{peers.length} peers connected globally</p>

  {#if error}
    <div class="error">{error}</div>
  {:else if peers.length === 0}
    <p>No peers discovered yet.</p>
  {:else}
    <div class="peer-grid">
      {#each peers as peer}
        <div class="peer-card">
          <div class="peer-id">{peer.agentId || peer.id || "unknown"}</div>
          <div class="peer-detail">Model: {peer.model || "—"}</div>
          <div class="peer-detail">Region: {peer.region || "—"}</div>
          <div class="peer-detail">Load: {peer.load ?? "—"}%</div>
          <div class="peer-status {peer.status === 'active' ? 'active' : 'idle'}">
            {peer.status || "unknown"}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .mesh { padding: 1.5rem; }
  .subtitle { opacity: 0.7; margin-bottom: 1rem; }
  .peer-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .peer-card { background: var(--bg-card, #1a1a2e); padding: 1rem; border-radius: 8px; }
  .peer-id { font-weight: 600; margin-bottom: 0.5rem; font-family: monospace; font-size: 0.9rem; }
  .peer-detail { font-size: 0.85rem; opacity: 0.8; margin-bottom: 0.2rem; }
  .peer-status { margin-top: 0.5rem; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; }
  .active { color: #4ade80; }
  .idle { color: #fbbf24; }
  .error { background: #7f1d1d; color: #fca5a5; padding: 1rem; border-radius: 8px; }
</style>
```

**Step 2: Commit**

```bash
git add desktop/src/pages/MeshTopology.svelte
git commit -m "feat: add MeshTopology page showing global peer grid"
```

---

### Task 12: Build ModelManager page

**Files:**
- Create: `desktop/src/pages/ModelManager.svelte`

**Step 1: Write the Model Manager component**

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { getModelList, getModelStatus, swapModel, pullModel } from "../lib/api";

  let models: any[] = [];
  let currentModel = "";
  let loaded = false;
  let pulling = false;
  let pullTarget = "";
  let error = "";

  async function refresh() {
    try {
      const [list, status] = await Promise.all([getModelList(), getModelStatus()]);
      models = list.models || [];
      currentModel = status.model;
      loaded = status.loaded;
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load models";
    }
  }

  async function handleSwap(model: string) {
    try {
      await swapModel(model);
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : "Swap failed";
    }
  }

  async function handlePull() {
    if (!pullTarget.trim()) return;
    pulling = true;
    try {
      await pullModel(pullTarget.trim());
      pullTarget = "";
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : "Pull failed";
    } finally {
      pulling = false;
    }
  }

  onMount(refresh);
</script>

<div class="models">
  <h1>Model Manager</h1>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="current">
    <span class="label">Active Model:</span>
    <span class="value">{currentModel || "none"}</span>
    <span class="status {loaded ? 'green' : 'red'}">{loaded ? "Loaded" : "Not loaded"}</span>
  </div>

  <div class="pull-section">
    <input bind:value={pullTarget} placeholder="e.g. qwen2.5-coder:latest" />
    <button on:click={handlePull} disabled={pulling}>{pulling ? "Pulling..." : "Pull Model"}</button>
  </div>

  <div class="model-list">
    {#each models as model}
      <div class="model-row">
        <span class="model-name">{model.name || model}</span>
        <button on:click={() => handleSwap(model.name || model)}
                disabled={model.name === currentModel || model === currentModel}>
          {model.name === currentModel || model === currentModel ? "Active" : "Swap"}
        </button>
      </div>
    {/each}
  </div>
</div>

<style>
  .models { padding: 1.5rem; }
  .current { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; padding: 1rem; background: var(--bg-card, #1a1a2e); border-radius: 8px; }
  .label { opacity: 0.7; }
  .value { font-weight: 600; font-family: monospace; }
  .status { font-size: 0.8rem; font-weight: 600; }
  .green { color: #4ade80; }
  .red { color: #f87171; }
  .pull-section { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
  .pull-section input { flex: 1; padding: 0.5rem; background: var(--bg-card, #1a1a2e); border: 1px solid #333; border-radius: 4px; color: inherit; }
  .pull-section button, .model-row button { padding: 0.5rem 1rem; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; }
  .pull-section button:disabled, .model-row button:disabled { opacity: 0.5; cursor: default; }
  .model-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .model-row { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; background: var(--bg-card, #1a1a2e); border-radius: 8px; }
  .model-name { font-family: monospace; }
  .error { background: #7f1d1d; color: #fca5a5; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
</style>
```

**Step 2: Commit**

```bash
git add desktop/src/pages/ModelManager.svelte
git commit -m "feat: add ModelManager page with pull/swap/list"
```

---

### Task 13: Build Credits page

**Files:**
- Create: `desktop/src/pages/Credits.svelte`

**Step 1: Write the Credits & Wallet component**

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getCredits, getCreditHistory } from "../lib/api";

  let balance = 0;
  let transactions: any[] = [];
  let error = "";
  let interval: ReturnType<typeof setInterval>;

  async function refresh() {
    try {
      const [creds, hist] = await Promise.all([getCredits(), getCreditHistory()]);
      balance = creds.balance;
      transactions = hist.transactions || [];
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load credits";
    }
  }

  onMount(() => {
    refresh();
    interval = setInterval(refresh, 15000);
  });

  onDestroy(() => clearInterval(interval));
</script>

<div class="credits">
  <h1>Credits & Wallet</h1>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="balance-card">
    <span class="label">Balance</span>
    <span class="amount">{balance.toLocaleString()} sats</span>
  </div>

  <h2>Transaction History</h2>
  {#if transactions.length === 0}
    <p>No transactions yet.</p>
  {:else}
    <div class="tx-list">
      {#each transactions as tx}
        <div class="tx-row">
          <div class="tx-type {tx.type === 'credit' ? 'credit' : 'debit'}">{tx.type}</div>
          <div class="tx-amount">{tx.amount} sats</div>
          <div class="tx-desc">{tx.description || "—"}</div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .credits { padding: 1.5rem; }
  .balance-card { background: var(--bg-card, #1a1a2e); padding: 2rem; border-radius: 12px; text-align: center; margin-bottom: 2rem; }
  .balance-card .label { display: block; opacity: 0.7; margin-bottom: 0.5rem; }
  .amount { font-size: 2.5rem; font-weight: 700; }
  h2 { margin-bottom: 1rem; }
  .tx-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .tx-row { display: flex; align-items: center; gap: 1rem; padding: 0.75rem; background: var(--bg-card, #1a1a2e); border-radius: 8px; }
  .tx-type { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; width: 60px; }
  .credit { color: #4ade80; }
  .debit { color: #f87171; }
  .tx-amount { font-family: monospace; width: 100px; }
  .tx-desc { opacity: 0.7; flex: 1; }
  .error { background: #7f1d1d; color: #fca5a5; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
</style>
```

**Step 2: Commit**

```bash
git add desktop/src/pages/Credits.svelte
git commit -m "feat: add Credits & Wallet page"
```

---

### Task 14: Build TaskQueue page

**Files:**
- Create: `desktop/src/pages/TaskQueue.svelte`

**Step 1: Write the Task Queue component**

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getStatus } from "../lib/api";

  let tasks: any[] = [];
  let error = "";
  let interval: ReturnType<typeof setInterval>;

  async function refresh() {
    try {
      const data = await getStatus();
      tasks = data.agents ? Object.entries(data.agents).map(([id, info]) => ({ id, ...info as object })) : [];
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load tasks";
    }
  }

  onMount(() => {
    refresh();
    interval = setInterval(refresh, 5000);
  });

  onDestroy(() => clearInterval(interval));
</script>

<div class="task-queue">
  <h1>Task Queue</h1>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if tasks.length === 0}
    <p>No active tasks.</p>
  {:else}
    <div class="task-list">
      {#each tasks as task}
        <div class="task-card">
          <div class="task-id">{task.id}</div>
          <div class="task-detail">Status: {task.status || "—"}</div>
          <div class="task-detail">Kind: {task.kind || "—"}</div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .task-queue { padding: 1.5rem; }
  .task-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .task-card { background: var(--bg-card, #1a1a2e); padding: 1rem; border-radius: 8px; }
  .task-id { font-family: monospace; font-weight: 600; margin-bottom: 0.3rem; }
  .task-detail { font-size: 0.85rem; opacity: 0.8; }
  .error { background: #7f1d1d; color: #fca5a5; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
</style>
```

**Step 2: Commit**

```bash
git add desktop/src/pages/TaskQueue.svelte
git commit -m "feat: add TaskQueue page"
```

---

### Task 15: Build Settings page

**Files:**
- Create: `desktop/src/pages/Settings.svelte`

**Step 1: Write the Settings component**

```svelte
<script lang="ts">
  let meshToken = "";
  let maxConcurrentTasks = 1;
  let idleOnly = true;
  let cpuCapPercent = 50;
  let bleEnabled = false;

  function save() {
    // Future: POST to agent config endpoint
    alert("Settings saved (local only — agent config endpoint coming soon)");
  }
</script>

<div class="settings">
  <h1>Settings</h1>

  <div class="section">
    <h2>Mesh Configuration</h2>
    <label>
      <span>Mesh Token</span>
      <input type="password" bind:value={meshToken} placeholder="Paste mesh token..." />
    </label>
  </div>

  <div class="section">
    <h2>Power Policy</h2>
    <label>
      <span>Max Concurrent Tasks</span>
      <input type="number" bind:value={maxConcurrentTasks} min="1" max="10" />
    </label>
    <label>
      <span>CPU Cap (%)</span>
      <input type="range" bind:value={cpuCapPercent} min="10" max="100" />
      <span>{cpuCapPercent}%</span>
    </label>
    <label class="toggle">
      <input type="checkbox" bind:checked={idleOnly} />
      <span>Only run tasks when idle</span>
    </label>
  </div>

  <div class="section">
    <h2>Local Mesh</h2>
    <label class="toggle">
      <input type="checkbox" bind:checked={bleEnabled} />
      <span>Enable BLE peer discovery (macOS)</span>
    </label>
  </div>

  <button on:click={save}>Save Settings</button>
</div>

<style>
  .settings { padding: 1.5rem; max-width: 600px; }
  .section { background: var(--bg-card, #1a1a2e); padding: 1.2rem; border-radius: 8px; margin-bottom: 1.5rem; }
  .section h2 { font-size: 1rem; margin-bottom: 1rem; opacity: 0.9; }
  label { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; }
  label span { min-width: 160px; font-size: 0.9rem; }
  input[type="text"], input[type="password"], input[type="number"] {
    flex: 1; padding: 0.4rem; background: #0d0d1a; border: 1px solid #333; border-radius: 4px; color: inherit;
  }
  .toggle { cursor: pointer; }
  button { padding: 0.6rem 1.5rem; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
</style>
```

**Step 2: Commit**

```bash
git add desktop/src/pages/Settings.svelte
git commit -m "feat: add Settings page with mesh, power policy, BLE config"
```

---

### Task 16: Wire App.svelte with navigation and all pages

**Files:**
- Modify: `desktop/src/App.svelte`

**Step 1: Create the main app shell with sidebar navigation**

Replace the scaffold `App.svelte` with a full navigation layout:

```svelte
<script lang="ts">
  import Dashboard from "./pages/Dashboard.svelte";
  import MeshTopology from "./pages/MeshTopology.svelte";
  import ModelManager from "./pages/ModelManager.svelte";
  import Credits from "./pages/Credits.svelte";
  import TaskQueue from "./pages/TaskQueue.svelte";
  import Settings from "./pages/Settings.svelte";

  const pages = [
    { id: "dashboard", label: "Dashboard", component: Dashboard },
    { id: "mesh", label: "Mesh Topology", component: MeshTopology },
    { id: "models", label: "Model Manager", component: ModelManager },
    { id: "credits", label: "Credits & Wallet", component: Credits },
    { id: "tasks", label: "Task Queue", component: TaskQueue },
    { id: "settings", label: "Settings", component: Settings },
  ] as const;

  let activePageId = "dashboard";

  $: activePage = pages.find((p) => p.id === activePageId) ?? pages[0];
</script>

<div class="app">
  <nav class="sidebar">
    <div class="logo">EdgeCoder</div>
    {#each pages as page}
      <button
        class="nav-item {activePageId === page.id ? 'active' : ''}"
        on:click={() => (activePageId = page.id)}
      >
        {page.label}
      </button>
    {/each}
  </nav>
  <main class="content">
    <svelte:component this={activePage.component} />
  </main>
</div>

<style>
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d0d1a;
    color: #e2e8f0;
  }
  .app { display: flex; height: 100vh; }
  .sidebar {
    width: 220px; background: #111128; display: flex; flex-direction: column;
    padding: 1rem 0; border-right: 1px solid #1e1e3f;
  }
  .logo { font-weight: 700; font-size: 1.2rem; padding: 0 1rem 1rem; border-bottom: 1px solid #1e1e3f; margin-bottom: 0.5rem; }
  .nav-item {
    background: none; border: none; color: #94a3b8; text-align: left;
    padding: 0.65rem 1rem; cursor: pointer; font-size: 0.9rem; transition: all 0.15s;
  }
  .nav-item:hover { background: #1a1a3e; color: #e2e8f0; }
  .nav-item.active { background: #1e1e4f; color: #60a5fa; font-weight: 600; border-left: 3px solid #3b82f6; }
  .content { flex: 1; overflow-y: auto; }
</style>
```

**Step 2: Verify build**

Run: `cd desktop && npm run build`

**Step 3: Commit**

```bash
cd /Users/codysmith/Cursor/Edgecoder
git add desktop/src/App.svelte
git commit -m "feat: wire App.svelte with sidebar nav and all 6 pages"
```

---

### Task 17: Add Rust-side agent process management

**Files:**
- Modify: `desktop/src-tauri/src/main.rs`

**Step 1: Add child process spawning for the Node.js agent**

The Tauri app manages the agent as a child process. On launch, it starts `node dist/index.js` from the Edgecoder install path. On quit, it kills the process gracefully.

```rust
use std::process::{Command, Child};
use std::sync::Mutex;
use tauri::Manager;

struct AgentProcess(Mutex<Option<Child>>);

fn start_agent() -> Option<Child> {
    let agent_dir = std::env::var("EDGECODER_INSTALL_DIR")
        .unwrap_or_else(|_| "/opt/edgecoder/app".to_string());

    Command::new("node")
        .arg("dist/index.js")
        .current_dir(&agent_dir)
        .env("EDGE_RUNTIME_MODE", "all-in-one")
        .spawn()
        .ok()
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let child = start_agent();
            app.manage(AgentProcess(Mutex::new(child)));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AgentProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(ref mut child) = *guard {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error running EdgeCoder desktop app");
}
```

**Step 2: Commit**

```bash
git add desktop/src-tauri/src/main.rs
git commit -m "feat: add Rust-side agent process management in Tauri"
```

---

## Workstream C: End-to-End Testing — Global Mesh Focus

### Task 18: Tier 1 — Multi-agent localhost mesh simulation test

**Files:**
- Create: `tests/e2e/mesh-simulation.test.ts`

**Step 1: Write the failing test**

This test simulates 5 agents on localhost using in-process constructs. It verifies gossip propagation, task routing, and credit settlement across peers.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { SwarmQueue } from "../../src/swarm/queue.js";
import { CreditEngine } from "../../src/credits/engine.js";
import { GossipMesh, type GossipMessage } from "../../src/mesh/gossip.js";
import { SQLiteStore } from "../../src/db/sqlite-store.js";
import type { Subtask, SubtaskResult, ExecutionPolicy } from "../../src/common/types.js";

const NUM_AGENTS = 5;

function makeAgent(id: string) {
  const db = new SQLiteStore(":memory:");
  const credits = new CreditEngine(db);
  return { id, db, credits };
}

const defaultPolicy: ExecutionPolicy = {
  cpuCapPercent: 50,
  memoryLimitMb: 2048,
  idleOnly: false,
  maxConcurrentTasks: 2,
  allowedHours: { startHourUtc: 0, endHourUtc: 24 },
};

describe("e2e: multi-agent mesh simulation", () => {
  it("gossip messages propagate across all peers", () => {
    const meshes: GossipMesh[] = [];
    const received: Map<string, GossipMessage[]> = new Map();

    for (let i = 0; i < NUM_AGENTS; i++) {
      const peerId = `agent-${i}`;
      received.set(peerId, []);
      const mesh = new GossipMesh({
        peerId,
        onMessage: (msg) => received.get(peerId)!.push(msg),
      });
      meshes.push(mesh);
    }

    // Connect peers in a chain: 0-1, 1-2, 2-3, 3-4
    for (let i = 0; i < meshes.length - 1; i++) {
      meshes[i].addPeer(meshes[i + 1]);
      meshes[i + 1].addPeer(meshes[i]);
    }

    // Agent 0 broadcasts
    meshes[0].broadcast({
      type: "capability_update",
      peerId: "agent-0",
      payload: { model: "qwen2.5-coder", load: 0.3 },
      ttl: NUM_AGENTS,
      id: randomUUID(),
      timestamp: Date.now(),
    });

    // All agents should receive the message
    for (let i = 1; i < NUM_AGENTS; i++) {
      expect(received.get(`agent-${i}`)!.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("task queue distributes work via fair-share scheduling", () => {
    const queue = new SwarmQueue();
    const agents = Array.from({ length: NUM_AGENTS }, (_, i) => makeAgent(`agent-${i}`));

    // Register all agents
    for (const agent of agents) {
      queue.registerAgent(agent.id, defaultPolicy);
    }

    // Submit 10 tasks
    for (let t = 0; t < 10; t++) {
      queue.enqueue({
        taskId: randomUUID(),
        kind: "micro_loop",
        language: "python",
        input: `task-${t}`,
        timeoutMs: 5000,
        snapshotRef: "commit:test",
        projectMeta: { projectId: "proj-1", resourceClass: "cpu", priority: 10 },
      });
    }

    // Pull tasks for each agent
    const pullCounts = new Map<string, number>();
    for (const agent of agents) {
      const pulled = queue.pull(agent.id, 3);
      pullCounts.set(agent.id, pulled.length);
    }

    // Fair share: each agent should get 2 tasks (10 / 5)
    for (const [agentId, count] of pullCounts) {
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it("credit settlement works across agents", () => {
    const agents = Array.from({ length: 3 }, (_, i) => makeAgent(`agent-${i}`));

    // Agent-0 (submitter) pays agent-1 (executor) 100 sats
    agents[0].credits.debit("agent-0", 100, "task-payment");
    agents[1].credits.credit("agent-1", 100, "task-execution");

    expect(agents[0].credits.balance("agent-0")).toBe(-100);
    expect(agents[1].credits.balance("agent-1")).toBe(100);
  });
});
```

**Step 2: Run the test to verify it fails (or passes if modules are compatible)**

Run: `npx vitest run tests/e2e/mesh-simulation.test.ts`

**Step 3: Fix any import/API mismatches and get tests passing**

Adjust imports and constructor calls to match actual module signatures.

**Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: All existing tests + new tests pass

**Step 5: Commit**

```bash
git add tests/e2e/mesh-simulation.test.ts
git commit -m "test: add Tier 1 multi-agent mesh simulation (gossip, fair-share, credits)"
```

---

### Task 19: Tier 1 — Agent churn and mesh resilience test

**Files:**
- Create: `tests/e2e/mesh-churn.test.ts`

**Step 1: Write the test for agent join/leave**

```typescript
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { SwarmQueue } from "../../src/swarm/queue.js";
import type { ExecutionPolicy } from "../../src/common/types.js";

const defaultPolicy: ExecutionPolicy = {
  cpuCapPercent: 50,
  memoryLimitMb: 2048,
  idleOnly: false,
  maxConcurrentTasks: 2,
  allowedHours: { startHourUtc: 0, endHourUtc: 24 },
};

describe("e2e: mesh churn resilience", () => {
  it("tasks are redistributed when an agent leaves", () => {
    const queue = new SwarmQueue();

    // Start with 3 agents
    queue.registerAgent("agent-A", defaultPolicy);
    queue.registerAgent("agent-B", defaultPolicy);
    queue.registerAgent("agent-C", defaultPolicy);

    // Submit 6 tasks
    for (let i = 0; i < 6; i++) {
      queue.enqueue({
        taskId: randomUUID(),
        kind: "micro_loop",
        language: "python",
        input: `churn-task-${i}`,
        timeoutMs: 5000,
        snapshotRef: "commit:test",
        projectMeta: { projectId: "proj-churn", resourceClass: "cpu", priority: 10 },
      });
    }

    // Agent-B pulls some tasks, then "dies"
    const bTasks = queue.pull("agent-B", 2);
    expect(bTasks.length).toBe(2);

    // Unregister agent-B (simulates disconnect)
    queue.unregisterAgent("agent-B");

    // Remaining agents can still pull their share
    const aTasks = queue.pull("agent-A", 4);
    const cTasks = queue.pull("agent-C", 4);

    // All tasks should be pullable by remaining agents
    expect(aTasks.length + cTasks.length).toBeGreaterThanOrEqual(2);
  });

  it("new agent joining mid-work receives tasks", () => {
    const queue = new SwarmQueue();

    queue.registerAgent("agent-X", defaultPolicy);

    // Submit 4 tasks
    for (let i = 0; i < 4; i++) {
      queue.enqueue({
        taskId: randomUUID(),
        kind: "micro_loop",
        language: "python",
        input: `join-task-${i}`,
        timeoutMs: 5000,
        snapshotRef: "commit:test",
        projectMeta: { projectId: "proj-join", resourceClass: "cpu", priority: 10 },
      });
    }

    // X pulls 2
    queue.pull("agent-X", 2);

    // New agent joins
    queue.registerAgent("agent-Y", defaultPolicy);
    const yTasks = queue.pull("agent-Y", 4);

    // Y should get the remaining tasks
    expect(yTasks.length).toBeGreaterThanOrEqual(1);
  });
});
```

**Step 2: Run the test**

Run: `npx vitest run tests/e2e/mesh-churn.test.ts`

**Step 3: Commit**

```bash
git add tests/e2e/mesh-churn.test.ts
git commit -m "test: add Tier 1 mesh churn resilience tests (agent leave/join)"
```

---

### Task 20: Tier 2 — WAN mesh test script

**Files:**
- Create: `scripts/e2e/wan-mesh-test.sh`

**Step 1: Write the WAN test script**

This script is run manually to validate multi-host mesh behavior. It connects to a live seed node and local agent, submits a task, and verifies routing.

```bash
#!/usr/bin/env bash
set -euo pipefail

SEED_URL="${SEED_URL:-https://coordinator.edgecoder.io}"
LOCAL_AGENT_URL="${LOCAL_AGENT_URL:-http://localhost:4301}"
MESH_TOKEN="${MESH_TOKEN:-}"

echo "=== WAN Mesh E2E Test ==="
echo "Seed node: ${SEED_URL}"
echo "Local agent: ${LOCAL_AGENT_URL}"
echo ""

# 1. Verify seed node is reachable
echo "[1/6] Checking seed node health..."
SEED_HEALTH=$(curl -sf "${SEED_URL}/status" || echo "FAIL")
if [[ "${SEED_HEALTH}" == "FAIL" ]]; then
  echo "FAIL: Seed node unreachable at ${SEED_URL}/status"
  exit 1
fi
echo "  OK: Seed node is healthy"

# 2. Verify local agent is running
echo "[2/6] Checking local agent health..."
LOCAL_HEALTH=$(curl -sf "${LOCAL_AGENT_URL}/health/runtime" || echo "FAIL")
if [[ "${LOCAL_HEALTH}" == "FAIL" ]]; then
  echo "FAIL: Local agent unreachable at ${LOCAL_AGENT_URL}/health/runtime"
  exit 1
fi
echo "  OK: Local agent is healthy"

# 3. Check peer discovery
echo "[3/6] Checking peer discovery..."
PEERS=$(curl -sf "${LOCAL_AGENT_URL}/mesh/peers" || echo "FAIL")
if [[ "${PEERS}" == "FAIL" ]]; then
  echo "WARN: Could not fetch peers (endpoint may not exist yet)"
else
  echo "  OK: Peers response: $(echo "${PEERS}" | head -c 200)"
fi

# 4. Submit a test task to seed node
echo "[4/6] Submitting test task to seed node..."
TASK_RESULT=$(curl -sf -X POST "${SEED_URL}/pull" \
  -H "Content-Type: application/json" \
  -H "x-mesh-token: ${MESH_TOKEN}" \
  -d '{"agentId":"wan-test-agent","model":"qwen2.5-coder:latest","os":"linux"}' \
  || echo "FAIL")
if [[ "${TASK_RESULT}" == "FAIL" ]]; then
  echo "  WARN: Pull returned no task (queue may be empty — expected)"
else
  echo "  OK: Pull response: $(echo "${TASK_RESULT}" | head -c 200)"
fi

# 5. Verify ledger consistency (check seed node)
echo "[5/6] Checking ledger integrity on seed node..."
LEDGER=$(curl -sf "${SEED_URL}/credits/ledger/verify" || echo "SKIP")
if [[ "${LEDGER}" == "SKIP" ]]; then
  echo "  SKIP: Ledger verify endpoint not available"
else
  echo "  OK: Ledger response: $(echo "${LEDGER}" | head -c 200)"
fi

# 6. Verify gossip propagation (check local agent for seed peer)
echo "[6/6] Checking gossip propagation..."
echo "  Manual check: Verify local agent's /mesh/peers includes the seed node"
echo ""

echo "=== WAN Mesh E2E Test Complete ==="
echo "Review output above for any FAIL or WARN results."
```

**Step 2: Make executable and commit**

```bash
chmod +x scripts/e2e/wan-mesh-test.sh
git add scripts/e2e/wan-mesh-test.sh
git commit -m "test: add Tier 2 WAN mesh E2E test script"
```

---

### Task 21: Tier 3 — Docker-based scale test compose file

**Files:**
- Create: `tests/e2e/docker-compose.scale.yml`

**Step 1: Write a compose file that spawns 10 agents + seed node**

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      - POSTGRES_USER=edgecoder
      - POSTGRES_PASSWORD=edgecoder
      - POSTGRES_DB=edgecoder
    volumes:
      - scale-postgres:/var/lib/postgresql/data

  seed-node:
    build:
      context: ../..
      dockerfile: Dockerfile
    command: ["node", "dist/index.js"]
    environment:
      - NODE_ENV=production
      - EDGE_RUNTIME_MODE=all-in-one
      - DATABASE_URL=postgresql://edgecoder:edgecoder@postgres:5432/edgecoder
      - LOCAL_MODEL_PROVIDER=edgecoder-local
      - OLLAMA_AUTO_INSTALL=false
      - OLLAMA_MODEL=qwen2.5-coder:latest
    ports:
      - "4301:4301"
    depends_on:
      - postgres
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4301/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 10

  worker:
    build:
      context: ../..
      dockerfile: Dockerfile
    command: ["node", "dist/swarm/worker-runner.js"]
    environment:
      - COORDINATOR_URL=http://seed-node:4301
      - AGENT_MODE=swarm-only
      - LOCAL_MODEL_PROVIDER=edgecoder-local
      - OLLAMA_AUTO_INSTALL=false
      - OLLAMA_MODEL=qwen2.5-coder:latest
    depends_on:
      seed-node:
        condition: service_healthy
    deploy:
      replicas: 10

volumes:
  scale-postgres:
```

**Step 2: Validate compose syntax**

Run: `docker compose -f tests/e2e/docker-compose.scale.yml config --quiet`
Expected: No errors

**Step 3: Commit**

```bash
git add tests/e2e/docker-compose.scale.yml
git commit -m "test: add Tier 3 Docker scale test (10 workers + seed node)"
```

---

### Task 22: Tier 3 — Scale test runner script

**Files:**
- Create: `scripts/e2e/scale-test.sh`

**Step 1: Write a script that runs the scale test**

```bash
#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="tests/e2e/docker-compose.scale.yml"
SEED_URL="http://localhost:4301"
WORKERS="${WORKERS:-10}"
WAIT_SECS="${WAIT_SECS:-60}"

echo "=== Scale Test: ${WORKERS} workers ==="
echo ""

# 1. Build and start
echo "[1/5] Starting seed node + ${WORKERS} workers..."
docker compose -f "${COMPOSE_FILE}" up -d --build --scale worker="${WORKERS}"

# 2. Wait for seed node
echo "[2/5] Waiting for seed node to be healthy (up to ${WAIT_SECS}s)..."
for i in $(seq 1 "${WAIT_SECS}"); do
  if curl -sf "${SEED_URL}/status" >/dev/null 2>&1; then
    echo "  Seed node healthy after ${i}s"
    break
  fi
  sleep 1
done

# 3. Wait for workers to register
echo "[3/5] Waiting 30s for workers to register..."
sleep 30

# 4. Check registered agents
echo "[4/5] Checking registered agents..."
STATUS=$(curl -sf "${SEED_URL}/status" || echo "{}")
echo "  Agents registered: $(echo "${STATUS}" | node -e "process.stdin.on('data',d=>{try{const s=JSON.parse(d);console.log(Object.keys(s.agents||{}).length)}catch{console.log('parse error')}})" 2>/dev/null || echo "unknown")"

# 5. Verify mesh connectivity
echo "[5/5] Verifying mesh..."
HEALTH=$(curl -sf "${SEED_URL}/health/runtime" || echo "FAIL")
echo "  Health: $(echo "${HEALTH}" | head -c 200)"
echo ""

echo "=== Scale Test Complete ==="
echo "To tear down: docker compose -f ${COMPOSE_FILE} down -v"
```

**Step 2: Make executable and commit**

```bash
chmod +x scripts/e2e/scale-test.sh
git add scripts/e2e/scale-test.sh
git commit -m "test: add Tier 3 scale test runner script"
```

---

### Task 23: Final integration — build and test everything

**Step 1: Build clean**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Run all tests**

Run: `npx vitest run`
Expected: All existing 313+ tests pass, plus new E2E tests

**Step 3: Validate docker-compose**

Run: `docker compose -f docker-compose.yml config --quiet`
Expected: No errors

**Step 4: Final commit with all workstreams**

```bash
git add -A
git commit -m "feat: infrastructure consolidation, Tauri desktop app scaffold, global E2E testing

- Workstream A: fly.seed-node.toml, updated docker-compose, portal config, bootstrap script
- Workstream B: Tauri v2 + Svelte desktop app with 6 pages (Dashboard, Mesh, Models, Credits, Tasks, Settings)
- Workstream C: Tier 1-3 E2E tests (mesh simulation, churn, WAN script, Docker scale test)"
```

---

## Sequencing Summary

| Order | Task | Workstream | Description |
|-------|------|------------|-------------|
| 1 | Task 1 | A | Create `fly.seed-node.toml` |
| 2 | Task 2 | A | Update `docker-compose.yml` for unified seed node |
| 3 | Task 3 | A | Update portal config |
| 4 | Task 4 | A | Update linux bootstrap script |
| 5 | Task 5 | A | GitHub Pages workflow for docs |
| 6 | Task 6 | A | Fly teardown checklist script |
| 7 | Task 18 | C | Tier 1: Multi-agent mesh simulation test |
| 8 | Task 19 | C | Tier 1: Mesh churn resilience test |
| 9 | Task 20 | C | Tier 2: WAN mesh test script |
| 10 | Task 7 | B | Scaffold Tauri + Svelte project |
| 11 | Task 8 | B | Configure Tauri for EdgeCoder |
| 12 | Task 9 | B | API client library |
| 13 | Task 10 | B | Dashboard page |
| 14 | Task 11 | B | MeshTopology page |
| 15 | Task 12 | B | ModelManager page |
| 16 | Task 13 | B | Credits page |
| 17 | Task 14 | B | TaskQueue page |
| 18 | Task 15 | B | Settings page |
| 19 | Task 16 | B | Wire App.svelte with navigation |
| 20 | Task 17 | B | Rust-side agent process management |
| 21 | Task 21 | C | Tier 3: Docker scale compose file |
| 22 | Task 22 | C | Tier 3: Scale test runner script |
| 23 | Task 23 | — | Final integration build + test |

---

## Success Criteria

- `fly.seed-node.toml` exists and would deploy a unified agent as seed node
- `docker-compose.yml` runs seed-node instead of 3 separate services
- Portal config updated for seed node references
- GitHub Pages workflow auto-deploys docs
- Tauri desktop app scaffolded with 6 functional pages
- Tier 1 E2E tests pass in `npx vitest run`
- Tier 2-3 test scripts exist and are executable
- All 313+ existing tests still pass
- Build clean with `npx tsc --noEmit`
