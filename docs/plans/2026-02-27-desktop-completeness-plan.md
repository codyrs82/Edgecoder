# Desktop App Completeness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the desktop DMG self-contained (bundles agent runtime), add a curated model catalog, and wire the wallet page to real portal API endpoints.

**Architecture:** The Tauri app bundles the compiled Node.js agent in its resource directory and spawns it on launch. The model page shows a hardcoded catalog of recommended models merged with Ollama's installed list. The wallet page calls portal server endpoints over HTTPS with session cookies.

**Tech Stack:** Tauri 2 (Rust), SvelteKit 5, Node.js agent, Ollama, Fastify portal API, Vitest

---

## Task 1: Create Model Catalog Data

**Files:**
- Create: `desktop/src/lib/models.ts`

**Step 1: Create the catalog file with model metadata**

```ts
// desktop/src/lib/models.ts

export interface CatalogModel {
  modelId: string;
  name: string;
  paramSize: string;
  diskSize: string;
  description: string;
  category: "coding" | "general" | "small";
  recommended?: boolean;
}

export const MODEL_CATALOG: CatalogModel[] = [
  // --- Coding ---
  {
    modelId: "qwen2.5-coder:7b",
    name: "Qwen 2.5 Coder",
    paramSize: "7B",
    diskSize: "4.7 GB",
    description: "Strong coding model with excellent instruction following",
    category: "coding",
    recommended: true,
  },
  {
    modelId: "deepseek-coder-v2:16b",
    name: "DeepSeek Coder V2",
    paramSize: "16B",
    diskSize: "8.9 GB",
    description: "High-quality code generation and completion",
    category: "coding",
  },
  {
    modelId: "codellama:7b",
    name: "Code Llama",
    paramSize: "7B",
    diskSize: "3.8 GB",
    description: "Meta's code-specialized Llama model",
    category: "coding",
  },
  // --- General ---
  {
    modelId: "llama3.1:8b",
    name: "Llama 3.1",
    paramSize: "8B",
    diskSize: "4.7 GB",
    description: "Meta's latest general-purpose model, strong reasoning",
    category: "general",
    recommended: true,
  },
  {
    modelId: "mistral:7b",
    name: "Mistral",
    paramSize: "7B",
    diskSize: "4.1 GB",
    description: "Fast general-purpose model with good quality",
    category: "general",
  },
  {
    modelId: "gemma2:9b",
    name: "Gemma 2",
    paramSize: "9B",
    diskSize: "5.4 GB",
    description: "Google's efficient open model",
    category: "general",
  },
  // --- Small & Fast ---
  {
    modelId: "qwen2.5:0.5b",
    name: "Qwen 2.5 Tiny",
    paramSize: "0.5B",
    diskSize: "397 MB",
    description: "Ultra-fast responses, good for simple tasks",
    category: "small",
    recommended: true,
  },
  {
    modelId: "phi3:mini",
    name: "Phi-3 Mini",
    paramSize: "3.8B",
    diskSize: "2.3 GB",
    description: "Microsoft's compact model, strong for its size",
    category: "small",
  },
  {
    modelId: "llama3.2:3b",
    name: "Llama 3.2",
    paramSize: "3B",
    diskSize: "2.0 GB",
    description: "Smallest Llama, fast inference on any hardware",
    category: "small",
  },
];

export const CATEGORY_LABELS: Record<string, string> = {
  coding: "Coding",
  general: "General Purpose",
  small: "Small & Fast",
};
```

**Step 2: Commit**

```bash
git add desktop/src/lib/models.ts
git commit -m "feat: add curated model catalog data"
```

---

## Task 2: Rewrite ModelManager with Catalog UI

**Files:**
- Modify: `desktop/src/pages/ModelManager.svelte`

**Step 1: Update the script section**

Replace the imports and add catalog merging. Key changes:
- Import `MODEL_CATALOG`, `CATEGORY_LABELS`, `CatalogModel` from `../lib/models`
- Import `backendReady`, `isRemoteMode` from `../lib/api`
- Add derived state `catalogModels` that merges `MODEL_CATALOG` with `ollamaTags` to show install status
- Keep existing pull/swap/delete logic

In the script block, after the existing `models` derived state (~line 82), add:

```ts
interface CatalogEntry extends CatalogModel {
  installed: boolean;
  active: boolean;
  running: boolean;
}

let catalogModels: CatalogEntry[] = $derived.by(() => {
  const tagSet = new Set(ollamaTags.map((t) => t.name));
  const activeModel = modelList.find((m) => m.active)?.modelId ?? "";
  const runningSet = new Set(runningModels.map((r) => r.name));
  return MODEL_CATALOG.map((cm) => ({
    ...cm,
    installed: tagSet.has(cm.modelId),
    active: cm.modelId === activeModel,
    running: runningSet.has(cm.modelId),
  }));
});

let selectedCategory = $state<string>("all");
let filteredCatalog = $derived(
  selectedCategory === "all"
    ? catalogModels
    : catalogModels.filter((m) => m.category === selectedCategory)
);
```

**Step 2: Replace the template**

Replace the pull section and model list with:

1. **Category tabs** at the top: All / Coding / General / Small & Fast
2. **Catalog grid**: Each model as a card showing name, param size, disk size, description, and Install/Installed/Active badge
3. **Installed models table**: Keep existing table for already-installed models (below catalog)
4. **Advanced pull** input: Move to bottom in a collapsible "Advanced" section

Template structure:

```svelte
<!-- Category filter tabs -->
<div class="category-tabs">
  <button class="tab" class:active={selectedCategory === "all"} onclick={() => selectedCategory = "all"}>All</button>
  {#each Object.entries(CATEGORY_LABELS) as [key, label]}
    <button class="tab" class:active={selectedCategory === key} onclick={() => selectedCategory = key}>{label}</button>
  {/each}
</div>

<!-- Catalog grid -->
<div class="catalog-grid">
  {#each filteredCatalog as model}
    <div class="catalog-card" class:installed={model.installed}>
      <div class="card-header">
        <span class="model-name">{model.name}</span>
        {#if model.recommended}
          <span class="badge badge-rec">Recommended</span>
        {/if}
      </div>
      <p class="model-desc">{model.description}</p>
      <div class="card-meta">
        <span>{model.paramSize}</span>
        <span>{model.diskSize}</span>
      </div>
      <div class="card-actions">
        {#if model.active}
          <span class="badge badge-active">Active</span>
        {:else if model.installed}
          <button class="btn btn-sm" onclick={() => { swappingId = model.modelId; swapModel(model.modelId).then(refresh).finally(() => swappingId = null); }} disabled={swappingId === model.modelId}>
            {swappingId === model.modelId ? "Swapping..." : "Use Model"}
          </button>
        {:else}
          <button class="btn btn-primary btn-sm" onclick={() => { pullTarget = model.modelId; handlePull(); }} disabled={pulling}>
            Install
          </button>
        {/if}
      </div>
    </div>
  {/each}
</div>

<!-- Pull progress (shows when pulling) -->
{#if pulling}
  <!-- existing pull progress bar -->
{/if}

<!-- Advanced: custom pull (collapsed) -->
<details class="advanced-pull">
  <summary>Advanced: Pull custom model</summary>
  <!-- existing pull input row -->
</details>
```

**Step 3: Add catalog styles**

Add CSS for `.category-tabs`, `.catalog-grid`, `.catalog-card`, `.card-header`, `.card-meta`, `.card-actions`, `.badge-rec`.

Grid: 3 columns on wide screens, 2 on medium, 1 on narrow. Cards with border, hover effect, installed state with subtle green border.

**Step 4: Test manually — build and verify**

```bash
cd desktop && npm run build
```

Verify no TypeScript/Svelte errors.

**Step 5: Commit**

```bash
git add desktop/src/pages/ModelManager.svelte
git commit -m "feat: add curated model catalog to Models page"
```

---

## Task 3: Bundle Agent Into Tauri Resources

**Files:**
- Create: `scripts/bundle-agent-resources.sh`
- Modify: `desktop/src-tauri/tauri.conf.json`

**Step 1: Create the bundle script**

```bash
#!/usr/bin/env bash
# scripts/bundle-agent-resources.sh
# Copies the compiled agent runtime into Tauri's resource directory
# so the .app bundle is self-contained.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCE_DIR="$ROOT_DIR/desktop/src-tauri/resources/agent"

echo "=== Bundling agent into Tauri resources ==="

# Clean previous bundle
rm -rf "$RESOURCE_DIR"
mkdir -p "$RESOURCE_DIR"

# Build the TypeScript project
echo "Building TypeScript..."
npm run build --prefix "$ROOT_DIR"

# Copy compiled output
cp -R "$ROOT_DIR/dist" "$RESOURCE_DIR/dist"
cp "$ROOT_DIR/package.json" "$RESOURCE_DIR/package.json"
cp "$ROOT_DIR/package-lock.json" "$RESOURCE_DIR/package-lock.json"

# Install production dependencies only
echo "Installing production dependencies..."
npm ci --omit=dev --prefix "$RESOURCE_DIR"

echo "Agent bundled to: $RESOURCE_DIR"
du -sh "$RESOURCE_DIR"
```

**Step 2: Update tauri.conf.json to include resources**

Add `"resources"` to the `"bundle"` section:

```json
{
  "bundle": {
    "active": true,
    "resources": {
      "resources/agent": "agent"
    },
    "targets": ["dmg", "appimage", "deb"],
    ...
  }
}
```

**Step 3: Commit**

```bash
git add scripts/bundle-agent-resources.sh desktop/src-tauri/tauri.conf.json
git commit -m "feat: add agent bundling script and Tauri resource config"
```

---

## Task 4: Update main.rs to Spawn Bundled Agent

**Files:**
- Modify: `desktop/src-tauri/src/main.rs`

**Step 1: Update start_agent to use resource directory**

Replace the `start_agent` function to resolve the agent from Tauri's resource
directory, falling back to `/opt/edgecoder/app` for .pkg installs:

```rust
fn start_agent(app: &tauri::App) -> Option<Child> {
    if agent_already_running() {
        eprintln!("EdgeCoder agent already running on :4301 — skipping spawn");
        return None;
    }

    // Try bundled agent in Tauri resource directory first
    let agent_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.join("agent"))
        .filter(|p| p.join("dist/index.js").exists())
        // Fall back to system install path
        .unwrap_or_else(|| {
            std::env::var("EDGECODER_INSTALL_DIR")
                .unwrap_or_else(|_| "/opt/edgecoder/app".to_string())
                .into()
        });

    eprintln!("Starting agent from: {:?}", agent_dir);

    if !agent_dir.join("dist/index.js").exists() {
        eprintln!("Agent not found at {:?} — skipping", agent_dir);
        return None;
    }

    Command::new("node")
        .arg("dist/index.js")
        .current_dir(&agent_dir)
        .env("EDGE_RUNTIME_MODE", "all-in-one")
        .spawn()
        .ok()
}
```

**Step 2: Update setup closure to pass app reference**

In `main()`, change `start_agent()` to `start_agent(app)`:

```rust
.setup(|app| {
    let child = start_agent(app);
    app.manage(AgentProcess(Mutex::new(child)));
    // ... rest unchanged
})
```

**Step 3: Commit**

```bash
git add desktop/src-tauri/src/main.rs
git commit -m "feat: spawn bundled agent from Tauri resource dir"
```

---

## Task 5: Add Ollama Detection and Setup Prompt

**Files:**
- Create: `desktop/src/components/OllamaSetup.svelte`
- Modify: `desktop/src/lib/api.ts` (add `checkOllamaAvailable`)
- Modify: `desktop/src/App.svelte` (show setup prompt)

**Step 1: Add Ollama detection to api.ts**

After the existing `OLLAMA_BASE` line (~line 45):

```ts
export async function checkOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

**Step 2: Create OllamaSetup component**

```svelte
<!-- desktop/src/components/OllamaSetup.svelte -->
<script lang="ts">
  import { open } from "@tauri-apps/plugin-shell";
  import { checkOllamaAvailable } from "../lib/api";

  interface Props { onDismiss: () => void; }
  let { onDismiss }: Props = $props();

  let checking = $state(false);

  async function handleDownload() {
    await open("https://ollama.com/download");
  }

  async function handleRetry() {
    checking = true;
    const ok = await checkOllamaAvailable();
    checking = false;
    if (ok) onDismiss();
  }
</script>

<div class="setup-overlay">
  <div class="setup-card">
    <h2>Ollama Required</h2>
    <p>EdgeCoder needs Ollama to run AI models locally. It's a free, one-time install.</p>
    <div class="setup-actions">
      <button class="btn-primary" onclick={handleDownload}>Download Ollama</button>
      <button class="btn-secondary" onclick={handleRetry} disabled={checking}>
        {checking ? "Checking..." : "I've installed it"}
      </button>
      <button class="btn-link" onclick={onDismiss}>Skip for now</button>
    </div>
  </div>
</div>

<style>
  .setup-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 200; }
  .setup-card { background: var(--bg-surface); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); padding: 32px; max-width: 420px; text-align: center; }
  .setup-card h2 { margin: 0 0 12px; font-size: 1.2rem; }
  .setup-card p { color: var(--text-secondary); font-size: 0.9rem; margin: 0 0 24px; }
  .setup-actions { display: flex; flex-direction: column; gap: 10px; }
  .btn-primary { padding: 12px; background: var(--accent); color: white; border: none; border-radius: var(--radius-sm); font-weight: 600; cursor: pointer; }
  .btn-secondary { padding: 10px; background: var(--bg-elevated); color: var(--text-primary); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); cursor: pointer; }
  .btn-secondary:disabled { opacity: 0.5; }
  .btn-link { background: none; border: none; color: var(--text-muted); font-size: 0.85rem; cursor: pointer; }
</style>
```

**Step 3: Wire into App.svelte**

After the user is authenticated (inside the `{:else}` branch at ~line 85), add
Ollama check:

```ts
import OllamaSetup from "./components/OllamaSetup.svelte";
import { checkOllamaAvailable } from "./lib/api";

let showOllamaSetup = $state(false);

// Check Ollama when user is authenticated
$effect(() => {
  if (user && !import.meta.env.DEV) {
    checkOllamaAvailable().then((ok) => {
      if (!ok) showOllamaSetup = true;
    });
  }
});
```

In template, after `SettingsOverlay`:

```svelte
{#if showOllamaSetup}
  <OllamaSetup onDismiss={() => showOllamaSetup = false} />
{/if}
```

**Step 4: Commit**

```bash
git add desktop/src/components/OllamaSetup.svelte desktop/src/lib/api.ts desktop/src/App.svelte
git commit -m "feat: add Ollama detection and setup prompt on first launch"
```

---

## Task 6: Add Wallet API Functions

**Files:**
- Modify: `desktop/src/lib/api.ts`

**Step 1: Add wallet types and API functions**

Add after the OAuth section (~line 433):

```ts
// ---------------------------------------------------------------------------
// Wallet API (portal)
// ---------------------------------------------------------------------------

export interface WalletOnboarding {
  accountId: string;
  network: string;
  derivedAddress: string | null;
  createdAtMs: number;
  acknowledgedAtMs: number | null;
}

export interface WalletSeedSetup {
  ok: boolean;
  accountId: string;
  network: string;
  seedPhrase: string;
  derivedAddress: string | null;
  guidance: { title: string; steps: string[] };
}

export interface WalletSendRequest {
  requestId: string;
  destination: string;
  amountSats: number;
  note: string | null;
  status: string;
  createdAtMs: number;
}

export async function getWalletOnboarding(): Promise<WalletOnboarding | null> {
  try {
    const res = await fetch(`${portalBase()}/wallet/onboarding`, {
      credentials: "include",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Wallet status: ${res.status}`);
    return res.json();
  } catch {
    return null;
  }
}

export async function setupWalletSeed(): Promise<WalletSeedSetup> {
  const res = await fetch(`${portalBase()}/wallet/onboarding/setup-seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error("Failed to generate seed phrase");
  return res.json();
}

export async function acknowledgeWalletSeed(): Promise<void> {
  const res = await fetch(`${portalBase()}/wallet/onboarding/acknowledge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error("Failed to acknowledge seed backup");
}

export async function getWalletSendRequests(): Promise<WalletSendRequest[]> {
  const res = await fetch(`${portalBase()}/wallet/send/requests`, {
    credentials: "include",
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.requests ?? [];
}
```

**Step 2: Commit**

```bash
git add desktop/src/lib/api.ts
git commit -m "feat: add wallet API functions for portal endpoints"
```

---

## Task 7: Create Seed Phrase Modal

**Files:**
- Create: `desktop/src/components/SeedPhraseModal.svelte`

**Step 1: Build the secure seed phrase display modal**

```svelte
<script lang="ts">
  import { acknowledgeWalletSeed } from "../lib/api";

  interface Props {
    seedPhrase: string;
    derivedAddress: string | null;
    guidance: { title: string; steps: string[] };
    onDone: () => void;
  }
  let { seedPhrase, derivedAddress, guidance, onDone }: Props = $props();

  let secondsLeft = $state(120);
  let expired = $state(false);
  let confirming = $state(false);
  let displayPhrase = $state(seedPhrase);

  // Countdown timer — auto-clear seed from DOM
  $effect(() => {
    const timer = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        clearInterval(timer);
        displayPhrase = "";
        expired = true;
      }
    }, 1000);
    return () => clearInterval(timer);
  });

  async function handleConfirm() {
    confirming = true;
    try {
      await acknowledgeWalletSeed();
      displayPhrase = "";
      onDone();
    } catch {
      confirming = false;
    }
  }

  function handleClose() {
    displayPhrase = "";
    onDone();
  }
</script>

<div class="modal-backdrop">
  <div class="modal">
    <h2>Your Recovery Seed Phrase</h2>

    {#if expired}
      <p class="warning">Seed phrase cleared for security. Generate a new one if you didn't write it down.</p>
    {:else}
      <p class="timer">Auto-clears in {secondsLeft}s</p>
      <div class="seed-grid">
        {#each displayPhrase.split(" ") as word, i}
          <div class="seed-word"><span class="word-num">{i + 1}</span>{word}</div>
        {/each}
      </div>

      {#if derivedAddress}
        <div class="address">
          <span class="address-label">Bitcoin Address</span>
          <code>{derivedAddress}</code>
        </div>
      {/if}

      <div class="guidance">
        <strong>{guidance.title}</strong>
        <ol>
          {#each guidance.steps as step}
            <li>{step}</li>
          {/each}
        </ol>
      </div>
    {/if}

    <div class="modal-actions">
      {#if !expired}
        <button class="btn-confirm" onclick={handleConfirm} disabled={confirming}>
          {confirming ? "Confirming..." : "I wrote this down"}
        </button>
      {/if}
      <button class="btn-close" onclick={handleClose}>Close</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 300; }
  .modal { background: var(--bg-surface); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); padding: 32px; max-width: 520px; width: 90%; max-height: 85vh; overflow-y: auto; }
  .modal h2 { margin: 0 0 8px; font-size: 1.1rem; }
  .timer { color: var(--red); font-size: 0.85rem; margin: 0 0 16px; }
  .warning { color: var(--yellow); font-size: 0.9rem; }
  .seed-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
  .seed-word { background: var(--bg-deep, #1a1a18); padding: 8px 10px; border-radius: 6px; font-family: var(--font-mono); font-size: 0.85rem; }
  .word-num { color: var(--text-muted); font-size: 0.7rem; margin-right: 6px; }
  .address { margin-bottom: 16px; }
  .address-label { display: block; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 4px; }
  .address code { font-size: 0.82rem; color: var(--accent-secondary); word-break: break-all; }
  .guidance { font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 20px; }
  .guidance ol { padding-left: 18px; margin: 8px 0 0; }
  .guidance li { margin-bottom: 4px; }
  .modal-actions { display: flex; gap: 10px; }
  .btn-confirm { flex: 1; padding: 12px; background: var(--accent); color: white; border: none; border-radius: var(--radius-sm); font-weight: 600; cursor: pointer; }
  .btn-confirm:disabled { opacity: 0.5; }
  .btn-close { padding: 12px 20px; background: var(--bg-elevated); color: var(--text-secondary); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); cursor: pointer; }
</style>
```

**Step 2: Commit**

```bash
git add desktop/src/components/SeedPhraseModal.svelte
git commit -m "feat: add secure seed phrase display modal with auto-clear"
```

---

## Task 8: Rewrite Credits.svelte with Real Wallet API

**Files:**
- Modify: `desktop/src/pages/Credits.svelte`

**Step 1: Replace mock data with real API calls**

Rewrite the script block:

```ts
import ErrorBanner from "../components/ErrorBanner.svelte";
import SeedPhraseModal from "../components/SeedPhraseModal.svelte";
import {
  getWalletOnboarding,
  setupWalletSeed,
  getWalletSendRequests,
  type WalletOnboarding,
  type WalletSeedSetup,
  type WalletSendRequest,
} from "../lib/api";

let onboarding = $state<WalletOnboarding | null>(null);
let sendRequests = $state<WalletSendRequest[]>([]);
let loading = $state(true);
let error = $state("");

// Seed phrase modal state
let seedSetup = $state<WalletSeedSetup | null>(null);
let showSeedModal = $state(false);
let settingUpSeed = $state(false);

async function loadWallet() {
  error = "";
  try {
    const [ob, reqs] = await Promise.all([
      getWalletOnboarding(),
      getWalletSendRequests(),
    ]);
    onboarding = ob;
    sendRequests = reqs;
  } catch (e) {
    error = (e as Error).message;
  } finally {
    loading = false;
  }
}

async function handleSetupSeed() {
  settingUpSeed = true;
  error = "";
  try {
    const setup = await setupWalletSeed();
    seedSetup = setup;
    showSeedModal = true;
    await loadWallet(); // refresh onboarding state
  } catch (e) {
    error = (e as Error).message;
  } finally {
    settingUpSeed = false;
  }
}

function handleSeedDone() {
  showSeedModal = false;
  seedSetup = null;
  loadWallet();
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

$effect(() => { loadWallet(); });
```

**Step 2: Replace the template**

```svelte
<div class="wallet">
  <h1>Wallet</h1>

  {#if error}
    <ErrorBanner message={error} />
  {/if}

  {#if loading}
    <p class="muted">Loading wallet...</p>
  {:else if !onboarding}
    <!-- No wallet set up yet -->
    <div class="setup-section">
      <h2>Set Up Your Wallet</h2>
      <p>Generate a recovery seed phrase to receive credits for contributing compute to the mesh.</p>
      <button class="btn-primary" onclick={handleSetupSeed} disabled={settingUpSeed}>
        {settingUpSeed ? "Generating..." : "Set up recovery seed phrase"}
      </button>
    </div>
  {:else}
    <!-- Wallet overview -->
    <div class="section">
      <h2>Account</h2>
      <div class="info-grid">
        <span class="info-label">Account ID</span>
        <span class="info-value mono">{onboarding.accountId}</span>
        <span class="info-label">Network</span>
        <span class="info-value">{onboarding.network}</span>
        {#if onboarding.derivedAddress}
          <span class="info-label">Address</span>
          <span class="info-value mono">{onboarding.derivedAddress}</span>
        {/if}
        <span class="info-label">Seed Backup</span>
        <span class="info-value">
          {#if onboarding.acknowledgedAtMs}
            <span class="badge-ok">Confirmed</span>
          {:else}
            <span class="badge-warn">Not confirmed</span>
            <button class="btn-sm" onclick={handleSetupSeed} disabled={settingUpSeed}>
              {settingUpSeed ? "..." : "Generate new seed"}
            </button>
          {/if}
        </span>
      </div>
    </div>

    <!-- Transaction history -->
    <div class="section">
      <h2>Send Requests</h2>
      {#if sendRequests.length === 0}
        <p class="muted">No send requests yet.</p>
      {:else}
        <div class="tx-list">
          {#each sendRequests as req}
            <div class="tx-row">
              <div class="tx-info">
                <span class="tx-dest mono">{req.destination.slice(0, 16)}...</span>
                <span class="tx-note">{req.note ?? ""}</span>
              </div>
              <div class="tx-meta">
                <span class="tx-amount">{req.amountSats.toLocaleString()} sats</span>
                <span class="tx-status badge-{req.status}">{req.status}</span>
                <span class="tx-time">{timeAgo(req.createdAtMs)}</span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if showSeedModal && seedSetup}
    <SeedPhraseModal
      seedPhrase={seedSetup.seedPhrase}
      derivedAddress={seedSetup.derivedAddress}
      guidance={seedSetup.guidance}
      onDone={handleSeedDone}
    />
  {/if}
</div>
```

**Step 3: Update styles** to match the existing app design patterns (info-grid layout, section cards, badges).

**Step 4: Build and verify**

```bash
cd desktop && npm run build
```

**Step 5: Commit**

```bash
git add desktop/src/pages/Credits.svelte
git commit -m "feat: wire wallet page to real portal API endpoints"
```

---

## Task 9: Update Build Pipeline

**Files:**
- Modify: `desktop/package.json` — add `prebuild:tauri` script
- Modify: `.github/workflows/release.yml` — run bundle script before Tauri build

**Step 1: Add build script to desktop package.json**

```json
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "preview": "vite preview",
  "tauri": "tauri",
  "bundle-agent": "bash ../scripts/bundle-agent-resources.sh"
}
```

**Step 2: Update the Tauri build command to bundle agent first**

In `tauri.conf.json`, update `beforeBuildCommand`:

```json
"beforeBuildCommand": "npm run bundle-agent && npm run build"
```

**Step 3: Commit**

```bash
git add desktop/package.json desktop/src-tauri/tauri.conf.json
git commit -m "feat: integrate agent bundling into Tauri build pipeline"
```

---

## Task 10: Full Integration Test

**Step 1: Run backend tests**

```bash
cd "/Users/codysmith/Claude Code/EdgeCoder" && npx vitest run
```

Expected: All 1218+ tests pass.

**Step 2: Build desktop app**

```bash
cd desktop && npm run tauri build
```

Expected: Successful build, DMG created.

**Step 3: Upload and test**

```bash
gh release upload v1.2.0 desktop/src-tauri/target/release/bundle/dmg/EdgeCoder_1.0.0_aarch64.dmg --clobber
```

Open DMG, drag to Applications, launch. Verify:
- Agent starts automatically (check Activity Monitor for `node dist/index.js`)
- If Ollama not installed: setup prompt appears
- Models page shows catalog with install buttons
- Wallet page shows setup flow or account info
- Settings pages show data (not error banners) when agent is running

**Step 4: Commit any fixes and push**

```bash
git push origin main
```
