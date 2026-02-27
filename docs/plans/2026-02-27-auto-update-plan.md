# Desktop Auto-Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automatic update checking and in-app installation to the EdgeCoder desktop app using `tauri-plugin-updater` with GitHub Releases.

**Architecture:** The Tauri v2 updater plugin checks a `latest.json` manifest hosted on GitHub Releases, compares versions, downloads the signed platform binary, and installs it. The Svelte frontend provides a notification banner and manual "Check for Updates" button in Settings. Agent runtime updates are bundled with the desktop app.

**Tech Stack:** Tauri v2, tauri-plugin-updater, tauri-plugin-process, @tauri-apps/plugin-updater, Svelte 5, GitHub Releases

---

### Task 1: Generate Tauri Signing Keypair

This creates the Ed25519 keypair that signs update bundles. The public key is embedded in the app; the private key is used at build time.

**Files:**
- Create: `desktop/src-tauri/updater-key.pub` (public key reference — NOT committed, just for local docs)

**Step 1: Generate the keypair**

Run from the repo root:
```bash
cd desktop && npx tauri signer generate -w ~/.tauri/edgecoder.key
```

This will prompt for a password (can be empty for now). It outputs:
- Private key saved to `~/.tauri/edgecoder.key`
- Public key printed to stdout

**Step 2: Save the public key**

Copy the public key string from stdout. It looks like:
```
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIH...
```

Save it — you'll paste it into `tauri.conf.json` in Task 3.

**Step 3: Set env var for builds**

Add to your shell profile or CI:
```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/edgecoder.key)"
# If you set a password:
# export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your-password"
```

**Step 4: Commit**

Nothing to commit yet — the private key stays out of the repo. The public key goes into `tauri.conf.json` in Task 3.

---

### Task 2: Install Updater and Process Plugin Dependencies

**Files:**
- Modify: `desktop/src-tauri/Cargo.toml`
- Modify: `desktop/package.json`

**Step 1: Add Rust dependencies**

In `desktop/src-tauri/Cargo.toml`, add these two lines to `[dependencies]`:

```toml
tauri-plugin-updater = { version = "2", features = [] }
tauri-plugin-process = "2"
```

The `tauri-plugin-process` is needed for the `relaunch()` call after installing an update.

**Step 2: Install npm packages**

```bash
cd desktop && npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

**Step 3: Verify it compiles**

```bash
cd desktop && cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: no errors (warnings are fine).

**Step 4: Commit**

```bash
git add desktop/src-tauri/Cargo.toml desktop/package.json desktop/package-lock.json
git commit -m "chore: add tauri-plugin-updater and tauri-plugin-process deps"
```

---

### Task 3: Configure Tauri Updater Plugin

**Files:**
- Modify: `desktop/src-tauri/tauri.conf.json`
- Modify: `desktop/src-tauri/capabilities/default.json`

**Step 1: Add updater config to tauri.conf.json**

In `desktop/src-tauri/tauri.conf.json`, add `createUpdaterArtifacts` to the `bundle` section, and add the `updater` plugin config:

```json
{
  "bundle": {
    "active": true,
    "createUpdaterArtifacts": true,
    "targets": ["dmg", "appimage", "deb"],
    ...
  },
  "plugins": {
    "deep-link": { ... },
    "updater": {
      "pubkey": "PASTE_YOUR_PUBLIC_KEY_HERE",
      "endpoints": [
        "https://github.com/codyrs82/Edgecoder/releases/latest/download/latest.json"
      ]
    }
  }
}
```

Replace `PASTE_YOUR_PUBLIC_KEY_HERE` with the public key from Task 1 Step 2.

**Step 2: Add permissions to capabilities**

In `desktop/src-tauri/capabilities/default.json`, add updater and process permissions:

```json
{
  "identifier": "default",
  "description": "Default capabilities for EdgeCoder desktop",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:app:default",
    "shell:allow-open",
    "deep-link:default",
    "updater:default",
    "process:default"
  ]
}
```

**Step 3: Verify config is valid**

```bash
cd desktop && cargo check --manifest-path src-tauri/Cargo.toml
```

**Step 4: Commit**

```bash
git add desktop/src-tauri/tauri.conf.json desktop/src-tauri/capabilities/default.json
git commit -m "feat: configure tauri updater plugin with GitHub Releases endpoint"
```

---

### Task 4: Register Updater and Process Plugins in Rust

**Files:**
- Modify: `desktop/src-tauri/src/main.rs:94-133`

**Step 1: Add plugin registrations**

In `main.rs`, add the updater and process plugins to the builder chain. The updater must be registered inside `.setup()` with a `#[cfg(desktop)]` guard (it's desktop-only). The process plugin is registered as a normal plugin.

Replace the current `fn main()` (lines 94-134) with:

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![get_system_metrics])
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            let child = start_agent(app);
            app.manage(AgentProcess(Mutex::new(child)));

            // Listen for deep link events (edgecoder://oauth-callback?...)
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                if let Some(url) = urls.first() {
                    let url_str = url.to_string();
                    eprintln!("[deep-link] received: {}", url_str);
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.eval(&format!(
                            "window.__handleDeepLink({})",
                            serde_json::to_string(&url_str).unwrap_or_default()
                        ));
                    }
                }
            });

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

**Step 2: Verify it compiles**

```bash
cd desktop && cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: no errors.

**Step 3: Commit**

```bash
git add desktop/src-tauri/src/main.rs
git commit -m "feat: register updater and process plugins in Tauri main"
```

---

### Task 5: Create Update Checker Module (Svelte)

**Files:**
- Create: `desktop/src/lib/updater.ts`

**Step 1: Write the updater module**

Create `desktop/src/lib/updater.ts`:

```typescript
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date" }
  | { state: "available"; update: Update }
  | { state: "downloading"; progress: number }
  | { state: "installing" }
  | { state: "error"; message: string };

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let statusListeners: Array<(s: UpdateStatus) => void> = [];
let currentStatus: UpdateStatus = { state: "idle" };
let intervalId: ReturnType<typeof setInterval> | null = null;
let cachedUpdate: Update | null = null;

function setStatus(s: UpdateStatus) {
  currentStatus = s;
  for (const fn of statusListeners) fn(s);
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus;
}

export function onUpdateStatus(fn: (s: UpdateStatus) => void): () => void {
  statusListeners.push(fn);
  fn(currentStatus);
  return () => {
    statusListeners = statusListeners.filter((f) => f !== fn);
  };
}

export async function checkForUpdate(): Promise<void> {
  if (currentStatus.state === "checking" || currentStatus.state === "downloading" || currentStatus.state === "installing") {
    return; // Already in progress
  }

  setStatus({ state: "checking" });
  try {
    const update = await check();
    if (update) {
      cachedUpdate = update;
      setStatus({ state: "available", update });
    } else {
      cachedUpdate = null;
      setStatus({ state: "up-to-date" });
    }
  } catch (err) {
    setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

export async function downloadAndInstall(): Promise<void> {
  const update = cachedUpdate;
  if (!update) return;

  setStatus({ state: "downloading", progress: 0 });
  try {
    let totalBytes = 0;
    let downloadedBytes = 0;
    await update.downloadAndInstall((event) => {
      if ("contentLength" in event && typeof event.contentLength === "number") {
        totalBytes = event.contentLength;
      }
      if ("chunkLength" in event && typeof event.chunkLength === "number") {
        downloadedBytes += event.chunkLength;
        const progress = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
        setStatus({ state: "downloading", progress });
      }
    });

    setStatus({ state: "installing" });
    await relaunch();
  } catch (err) {
    setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

export function startPeriodicCheck(): void {
  if (intervalId) return;
  // Initial check after a short delay (don't block app startup)
  setTimeout(() => checkForUpdate(), 5_000);
  intervalId = setInterval(() => checkForUpdate(), CHECK_INTERVAL_MS);
}

export function stopPeriodicCheck(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
```

**Step 2: Verify TypeScript compiles**

```bash
cd desktop && npx tsc --noEmit
```

Expected: no errors in updater.ts (other pre-existing warnings are fine).

**Step 3: Commit**

```bash
git add desktop/src/lib/updater.ts
git commit -m "feat: add updater module with periodic check and download/install"
```

---

### Task 6: Add Update Banner to App Shell

**Files:**
- Create: `desktop/src/components/UpdateBanner.svelte`
- Modify: `desktop/src/App.svelte:1-11,95-97`

**Step 1: Create UpdateBanner component**

Create `desktop/src/components/UpdateBanner.svelte`:

```svelte
<script lang="ts">
  import { onUpdateStatus, downloadAndInstall, checkForUpdate, type UpdateStatus } from "../lib/updater";

  let status: UpdateStatus = $state({ state: "idle" });
  let dismissed = $state(false);

  $effect(() => {
    return onUpdateStatus((s) => {
      status = s;
      // Un-dismiss when a new update becomes available
      if (s.state === "available") dismissed = false;
    });
  });

  function handleUpdate() {
    downloadAndInstall();
  }

  function handleDismiss() {
    dismissed = true;
  }

  let visible = $derived(
    !dismissed && (status.state === "available" || status.state === "downloading" || status.state === "installing")
  );

  let version = $derived(status.state === "available" ? status.update.version : "");
  let progressPct = $derived(status.state === "downloading" ? status.progress : 0);
</script>

{#if visible}
  <div class="update-banner">
    {#if status.state === "available"}
      <span class="update-text">EdgeCoder v{version} is available.</span>
      <button class="update-btn" onclick={handleUpdate}>Update Now</button>
      <button class="dismiss-btn" onclick={handleDismiss} title="Dismiss">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
    {:else if status.state === "downloading"}
      <span class="update-text">Downloading update... {progressPct}%</span>
      <div class="progress-bar">
        <div class="progress-fill" style="width: {progressPct}%"></div>
      </div>
    {:else if status.state === "installing"}
      <span class="update-text">Installing update... Restarting shortly.</span>
    {/if}
  </div>
{/if}

<style>
  .update-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 16px;
    background: rgba(74, 144, 217, 0.12);
    border-bottom: 1px solid rgba(74, 144, 217, 0.25);
    font-size: 0.82rem;
    flex-shrink: 0;
  }

  .update-text {
    color: var(--text-primary);
    flex: 1;
  }

  .update-btn {
    padding: 3px 12px;
    background: var(--accent-secondary, #4a90d9);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .update-btn:hover {
    opacity: 0.9;
  }

  .dismiss-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
  }

  .dismiss-btn:hover {
    color: var(--text-primary);
  }

  .progress-bar {
    width: 120px;
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent-secondary, #4a90d9);
    transition: width 0.3s ease;
  }
</style>
```

**Step 2: Wire UpdateBanner and periodic check into App.svelte**

In `desktop/src/App.svelte`, add the import at the top of the `<script>` block (after the existing imports around line 10):

```typescript
import UpdateBanner from "./components/UpdateBanner.svelte";
import { startPeriodicCheck } from "./lib/updater";
```

Add the periodic check start inside the existing auth effect. After `authChecked = true;` on line 38, add:

```typescript
.finally(() => { authChecked = true; startPeriodicCheck(); });
```

And for dev mode (around line 32), add after `authChecked = true;`:

```typescript
authChecked = true;
startPeriodicCheck();
```

Then add the `<UpdateBanner />` component just inside the `.app-shell` div, before the header (line 97):

```svelte
<div class="app-shell">
    <UpdateBanner />
    <!-- Header / Title Bar -->
    <header class="header" data-tauri-drag-region>
```

**Step 3: Verify it renders**

```bash
cd desktop && npm run dev
```

The banner should be invisible (no update available in dev). Confirm no console errors.

**Step 4: Commit**

```bash
git add desktop/src/components/UpdateBanner.svelte desktop/src/App.svelte
git commit -m "feat: add update notification banner to app shell"
```

---

### Task 7: Add "Check for Updates" to Settings Page

**Files:**
- Modify: `desktop/src/pages/Settings.svelte:1-15,247-254`

**Step 1: Add update state and import**

At the top of the `<script>` block in `desktop/src/pages/Settings.svelte`, add the imports (after the existing imports around line 2):

```typescript
import { checkForUpdate, onUpdateStatus, downloadAndInstall, type UpdateStatus } from "../lib/updater";
```

Add update state variables after `let appVersion` (around line 7):

```typescript
// Update state
let updateStatus: UpdateStatus = $state({ state: "idle" });

$effect(() => {
  return onUpdateStatus((s) => { updateStatus = s; });
});

function handleCheckUpdate() {
  checkForUpdate();
}

function handleInstallUpdate() {
  downloadAndInstall();
}
```

**Step 2: Enhance the About section**

Replace the About section in the template (lines 247-254) with:

```svelte
<!-- About -->
<div class="section about-section">
  <h2>About</h2>
  <div class="about-row">
    <span class="about-label">App Version</span>
    <span class="about-value mono">{appVersion}</span>
  </div>
  <div class="about-row">
    <span class="about-label">Updates</span>
    <span class="about-value">
      {#if updateStatus.state === "checking"}
        <span class="update-checking">Checking...</span>
      {:else if updateStatus.state === "up-to-date"}
        <span class="update-ok">Up to date</span>
      {:else if updateStatus.state === "available"}
        <span class="update-available">v{updateStatus.update.version} available</span>
        <button class="btn-sm" onclick={handleInstallUpdate}>Update Now</button>
      {:else if updateStatus.state === "downloading"}
        <span class="update-checking">Downloading... {updateStatus.progress}%</span>
      {:else if updateStatus.state === "installing"}
        <span class="update-checking">Installing...</span>
      {:else if updateStatus.state === "error"}
        <span class="update-error">{updateStatus.message}</span>
      {:else}
        <button class="btn-sm" onclick={handleCheckUpdate}>Check for Updates</button>
      {/if}
    </span>
  </div>
  {#if updateStatus.state !== "checking" && updateStatus.state !== "downloading" && updateStatus.state !== "installing"}
    <div class="about-row" style="margin-top: 0.5rem;">
      <span></span>
      <button class="btn-check-update" onclick={handleCheckUpdate}>
        {updateStatus.state === "error" ? "Retry" : "Check for Updates"}
      </button>
    </div>
  {/if}
</div>
```

**Step 3: Add styles**

Add these styles to the existing `<style>` block at the bottom of Settings.svelte:

```css
.update-ok {
  color: var(--green, #4ade80);
  font-weight: 600;
}
.update-available {
  color: var(--accent-secondary, #4a90d9);
  font-weight: 600;
}
.update-checking {
  color: var(--text-muted, #94a3b8);
}
.update-error {
  color: var(--red, #f87171);
  font-size: 0.8rem;
}
.btn-check-update {
  padding: 0.35rem 0.75rem;
  background: var(--bg-elevated, #454542);
  color: var(--text-secondary, #b8b0a4);
  border: 1px solid var(--border, rgba(214, 204, 194, 0.08));
  border-radius: 5px;
  cursor: pointer;
  font-size: 0.78rem;
  font-weight: 600;
  transition: all 0.15s;
}
.btn-check-update:hover {
  background: var(--bg-surface, #3a3a37);
  color: var(--text-primary, #f7f5f0);
}
```

**Step 4: Verify**

```bash
cd desktop && npm run dev
```

Open Settings. The About section should show "App Version: 1.2.1" and a "Check for Updates" button. Clicking it will show "Checking..." then either "Up to date" or an error (since no GitHub Release exists yet).

**Step 5: Commit**

```bash
git add desktop/src/pages/Settings.svelte
git commit -m "feat: add 'Check for Updates' button and update status to Settings"
```

---

### Task 8: Test Full Build with Updater Artifacts

This verifies that the build pipeline produces the update artifacts (signed installer + `latest.json`).

**Files:**
- No file changes — build verification only

**Step 1: Ensure signing key is set**

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/edgecoder.key)"
```

**Step 2: Build for current platform**

```bash
cd desktop && npm run tauri build
```

**Step 3: Verify artifacts**

After build completes, check the output directory:

```bash
ls desktop/src-tauri/target/release/bundle/
```

You should see:
- The normal installer (`.dmg` on macOS, `.AppImage`/`.deb` on Linux)
- A `.tar.gz` + `.tar.gz.sig` file (the update bundle + signature)

**Step 4: Verify the build is signed**

The `.sig` file should exist alongside the update bundle. This is what the updater plugin verifies on the client side.

**Step 5: Commit**

Nothing to commit — this is a build verification step.

---

### Task 9: Create First GitHub Release (Manual)

This publishes the first release so the updater has something to check against. This is a manual process.

**Step 1: Bump version in tauri.conf.json**

When ready to release, update the version in `desktop/src-tauri/tauri.conf.json`:

```json
"version": "1.3.0"
```

**Step 2: Build**

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/edgecoder.key)"
cd desktop && npm run tauri build
```

**Step 3: Create latest.json**

Create a `latest.json` file with the platform URLs pointing to the GitHub Release assets. Example:

```json
{
  "version": "1.3.0",
  "notes": "Auto-update support, security fixes",
  "pub_date": "2026-02-27T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "CONTENT_OF_SIG_FILE",
      "url": "https://github.com/codyrs82/Edgecoder/releases/download/v1.3.0/EdgeCoder.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "CONTENT_OF_SIG_FILE",
      "url": "https://github.com/codyrs82/Edgecoder/releases/download/v1.3.0/EdgeCoder.app.tar.gz"
    },
    "linux-x86_64": {
      "signature": "CONTENT_OF_SIG_FILE",
      "url": "https://github.com/codyrs82/Edgecoder/releases/download/v1.3.0/EdgeCoder.AppImage"
    }
  }
}
```

Read the `.sig` file contents and paste them as the `signature` value for each platform.

**Step 4: Create GitHub Release**

```bash
gh release create v1.3.0 \
  --title "v1.3.0" \
  --notes "Auto-update support, security fixes" \
  desktop/src-tauri/target/release/bundle/macos/EdgeCoder.app.tar.gz \
  desktop/src-tauri/target/release/bundle/macos/EdgeCoder.app.tar.gz.sig \
  latest.json
```

(Adjust paths based on actual build output. Add Linux artifacts if cross-compiling.)

**Step 5: Verify**

```bash
curl -sL https://github.com/codyrs82/Edgecoder/releases/latest/download/latest.json | jq .
```

Should return the JSON with version and platform entries.

---

## Verification Checklist

After all tasks:

1. **Build compiles**: `cd desktop && cargo check --manifest-path src-tauri/Cargo.toml`
2. **Frontend compiles**: `cd desktop && npx tsc --noEmit`
3. **Dev mode works**: `cd desktop && npm run tauri dev` — app launches, no console errors
4. **Settings shows update button**: Open Settings → About section has "Check for Updates"
5. **Banner is hidden**: No update banner visible (no release to compare against yet)
6. **Clicking Check for Updates**: Shows "Checking..." then "Up to date" or error
7. **Full build produces artifacts**: `npm run tauri build` generates `.tar.gz` + `.sig` files
8. **After GitHub Release**: Older version of app detects the new release and shows the banner
