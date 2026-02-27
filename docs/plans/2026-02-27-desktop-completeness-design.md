# Desktop App Completeness Design

Date: 2026-02-27

## Problem

The desktop macOS app (Tauri DMG) requires a separate .pkg install to get the
agent running. Without it, every settings page shows "No local agent running."
The Models page only has a free-text pull input (unusable for most users). The
Wallet page is entirely mock data.

## Decisions

- **Self-contained DMG** — bundle agent runtime inside the .app so drag-to-Applications just works
- **Curated model catalog** — show recommended models with one-click install instead of free-text input
- **Server-side wallet** — wire desktop Credits page to real portal wallet API, keeping server-side seed generation

---

## Part 1: Self-Contained Desktop App

### Current State

`main.rs:59-74` spawns `node dist/index.js` from `/opt/edgecoder/app`. This path
only exists if the .pkg installer was run separately. The Tauri app has no
bundled agent runtime.

### Design

**Bundle the compiled agent inside the Tauri resource directory:**

1. Build script copies `dist/`, production `node_modules/`, and `package.json`
   into `desktop/src-tauri/resources/agent/` before Tauri build.
2. `tauri.conf.json` gains a `resources` directive so Tauri includes the agent
   directory in the `.app` bundle.
3. `main.rs` resolves the agent path from `app.path().resource_dir()` instead of
   the hardcoded `/opt/edgecoder/app`.
4. On first launch, detect Ollama via `which ollama`. If missing, show a setup
   dialog with a download button linking to ollama.com/download.
5. Node.js runtime: detect system `node` first. If unavailable, bundle a
   standalone Node.js binary in resources as fallback.

### Files

- `desktop/src-tauri/src/main.rs` — resolve agent from resource dir
- `desktop/src-tauri/tauri.conf.json` — add resources config
- `desktop/src-tauri/build.rs` or new `scripts/bundle-agent.sh` — copy agent into resources
- New `desktop/src/components/OllamaSetup.svelte` — first-launch Ollama install prompt

### Trade-offs

- App bundle grows ~50-80MB (node_modules + dist)
- Ollama remains an external dependency (can't bundle a Go binary easily)
- Users on the .pkg path still work — agent detection in main.rs checks if port
  4301 is already occupied before spawning

---

## Part 2: Curated Model Catalog

### Current State

`ModelManager.svelte` shows only models already installed in Ollama (from
`getOllamaTags()`). If Ollama has no models, the page is empty with just a
free-text "pull" input. `getModelList()` on the inference service also only
returns installed models.

### Design

**Add a static model catalog in the desktop app:**

1. New `desktop/src/lib/models.ts` exports `MODEL_CATALOG`: a hardcoded array of
   recommended models with metadata:
   ```ts
   interface CatalogModel {
     modelId: string;        // e.g. "qwen2.5-coder:7b"
     name: string;           // e.g. "Qwen 2.5 Coder"
     paramSize: string;      // e.g. "7B"
     diskSize: string;       // e.g. "4.7 GB"
     description: string;    // one-line description
     category: "coding" | "general" | "small";
     recommended?: boolean;  // highlight as default
   }
   ```
2. Categories: **Coding** (Qwen 2.5 Coder, DeepSeek Coder V2, CodeLlama),
   **General** (Llama 3.1, Mistral, Gemma 2), **Small & Fast** (Phi-3 Mini, Qwen 2.5 0.5B).
3. `ModelManager.svelte` merges catalog with installed models:
   - Installed models show "Installed" badge + active/swap/delete actions
   - Uninstalled catalog models show "Install" button
   - Install button calls existing `pullModelStream()` with progress bar
4. Keep advanced pull input at bottom for power users.

### Files

- New `desktop/src/lib/models.ts` — catalog data
- `desktop/src/pages/ModelManager.svelte` — rewrite to merge catalog + installed

---

## Part 3: Wallet Integration

### Current State

`Credits.svelte` uses hardcoded mock data (setTimeout with fake transactions).
The real wallet API lives on the portal server with endpoints for onboarding,
seed generation, balance, transactions, and send requests. The web portal's
wallet page (`/portal/wallet`) is fully functional.

### Design

**Wire Credits.svelte to the portal wallet API:**

1. Add wallet API functions to `desktop/src/lib/api.ts`:
   - `getWalletStatus()` → `GET /wallet/onboarding/status`
   - `setupWalletSeed()` → `POST /wallet/onboarding/setup-seed`
   - `acknowledgeWalletSeed()` → `POST /wallet/onboarding/acknowledge`
   - `getWalletBalance()` → `GET /portal/api/wallet/balance`
   - `getWalletTransactions()` → `GET /portal/api/wallet/transactions`
2. All calls go through `portalBase()` with `credentials: "include"`.
3. Seed phrase display: show in a modal overlay with:
   - 60-second countdown timer (auto-clears seed from DOM)
   - Prominent "I wrote this down" confirmation button
   - Warning text about one-time display
4. Replace mock balance/transactions with real data.
5. Send flow: call existing MFA-protected portal endpoints.

### Security

- Seed phrase is displayed once, auto-cleared after 60 seconds
- DOM element cleared on dismiss (not just hidden)
- No client-side storage of seed (no localStorage, no IndexedDB)
- All wallet calls use HTTPS to remote portal
- Send requests require server-side MFA (email code + passkey)

### Files

- `desktop/src/lib/api.ts` — add wallet API functions
- `desktop/src/pages/Credits.svelte` — rewrite with real API integration
- New `desktop/src/components/SeedPhraseModal.svelte` — secure seed display

---

## Implementation Order

1. **Model catalog** (smallest scope, unblocks Models page immediately)
2. **Self-contained app** (build pipeline change, requires testing)
3. **Wallet integration** (API wiring + security-sensitive UI)
