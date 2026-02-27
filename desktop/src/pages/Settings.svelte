<script lang="ts">
  import { testMeshToken, getIdentity, getDashboardOverview, getModelList, backendReady, isRemoteMode } from "../lib/api";
  import { loadSettings, saveSetting } from "../lib/stores";
  import { checkForUpdate, onUpdateStatus, downloadAndInstall, type UpdateStatus } from "../lib/updater";
  import type { NodeIdentity } from "../lib/types";

  // App version
  let appVersion = $state("—");
  (async () => {
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      appVersion = await getVersion();
    } catch {
      appVersion = "dev";
    }
  })();

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

  // Local model info
  let activeModel = $state("—");
  let ollamaStatus = $state("Checking...");
  let installedModels = $state<string[]>([]);

  // --- Reactive state ---
  let meshToken = $state("");
  let seedNodeUrl = $state("");
  let maxConcurrentTasks = $state(1);
  let cpuCapPercent = $state(50);
  let idleOnly = $state(true);
  let bleEnabled = $state(false);

  // Token test state
  let tokenTestResult: "idle" | "testing" | "valid" | "invalid" = $state("idle");

  // Identity state
  let identity: NodeIdentity | null = $state(null);
  let identityError = $state("");

  // Save feedback
  let showSaved = $state(false);
  let savedTimeout: ReturnType<typeof setTimeout> | undefined = $state(undefined);

  // Clipboard feedback
  let copiedKey = $state(false);
  let copiedTimeout: ReturnType<typeof setTimeout> | undefined = $state(undefined);

  // Derived: truncated public key
  let truncatedKey = $derived.by(() => {
    const pem = identity?.publicKeyPem;
    if (!pem) return "";
    return pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "").slice(0, 40);
  });

  // Load settings + identity on mount
  $effect(() => {
    const s = loadSettings();
    meshToken = s.meshToken;
    seedNodeUrl = s.seedNodeUrl;
    maxConcurrentTasks = s.maxConcurrentTasks;
    cpuCapPercent = s.cpuCapPercent;
    idleOnly = s.idleOnly;

    backendReady.then(() => {
      if (isRemoteMode()) {
        identityError = "No local agent running — identity requires a running agent.";
        ollamaStatus = "No local agent";
        return;
      }
      getIdentity()
        .then((id) => {
          identity = id;
          identityError = "";
        })
        .catch((e) => {
          identityError = e instanceof Error ? e.message : "Failed to load identity";
        });
      getDashboardOverview()
        .then((o) => {
          activeModel = o.activeModel || "None";
          ollamaStatus = o.ollamaHealthy ? "Running" : "Not running";
        })
        .catch(() => {
          ollamaStatus = "Unreachable";
        });
      getModelList()
        .then((models) => {
          installedModels = models.filter((m: any) => m.installed).map((m: any) => m.modelId);
        })
        .catch(() => {});
    });
  });

  // Test mesh token
  async function handleTestToken() {
    if (!meshToken.trim()) return;
    tokenTestResult = "testing";
    const ok = await testMeshToken(meshToken);
    tokenTestResult = ok ? "valid" : "invalid";
  }

  // Copy public key to clipboard
  async function copyPublicKey() {
    if (!identity?.publicKeyPem) return;
    try {
      await navigator.clipboard.writeText(identity.publicKeyPem);
      copiedKey = true;
      if (copiedTimeout) clearTimeout(copiedTimeout);
      copiedTimeout = setTimeout(() => { copiedKey = false; }, 2000);
    } catch {
      // Clipboard API may not be available
    }
  }

  // Save all settings
  function save() {
    saveSetting("meshToken", meshToken);
    saveSetting("seedNodeUrl", seedNodeUrl);
    saveSetting("maxConcurrentTasks", String(maxConcurrentTasks));
    saveSetting("cpuCapPercent", String(cpuCapPercent));
    saveSetting("idleOnly", String(idleOnly));

    showSaved = true;
    if (savedTimeout) clearTimeout(savedTimeout);
    savedTimeout = setTimeout(() => { showSaved = false; }, 2000);
  }
</script>

<div class="settings">
  <h1>Settings</h1>

  <!-- Mesh Configuration -->
  <div class="section">
    <h2>Mesh Configuration</h2>

    <label>
      <span class="label-text">Mesh Token</span>
      <div class="input-row">
        <input type="password" bind:value={meshToken} placeholder="Paste mesh token..." />
        <button class="btn-sm" onclick={handleTestToken} disabled={tokenTestResult === "testing"}>
          {tokenTestResult === "testing" ? "Testing..." : "Test Connection"}
        </button>
        {#if tokenTestResult === "valid"}
          <span class="badge valid">Valid</span>
        {/if}
        {#if tokenTestResult === "invalid"}
          <span class="badge invalid">Invalid</span>
        {/if}
      </div>
    </label>

    <label>
      <span class="label-text">Seed Node URL</span>
      <input type="text" bind:value={seedNodeUrl} placeholder="https://edgecoder-seed.fly.dev" />
    </label>
  </div>

  <!-- Power Policy -->
  <div class="section">
    <h2>Power Policy</h2>

    <label>
      <span class="label-text">Max Concurrent Tasks</span>
      <input type="number" bind:value={maxConcurrentTasks} min="1" max="10" />
    </label>

    <label>
      <span class="label-text">CPU Cap</span>
      <div class="slider-row">
        <input type="range" bind:value={cpuCapPercent} min="10" max="100" />
        <span class="slider-value">{cpuCapPercent}%</span>
      </div>
    </label>

    <label class="toggle">
      <input type="checkbox" bind:checked={idleOnly} />
      <span>Only run tasks when idle</span>
    </label>
  </div>

  <!-- Local Mesh -->
  <div class="section">
    <h2>Local Mesh</h2>

    <label class="toggle">
      <input type="checkbox" bind:checked={bleEnabled} />
      <span>Enable BLE peer discovery (macOS)</span>
    </label>
  </div>

  <!-- Node Identity -->
  <div class="section">
    <h2>Node Identity</h2>

    {#if identityError}
      <p class="identity-error">{identityError}</p>
    {:else if identity}
      <div class="identity-grid">
        <span class="id-label">Peer ID</span>
        <span class="id-value mono">{identity.peerId}</span>

        <span class="id-label">Coordinator URL</span>
        <span class="id-value">{identity.coordinatorUrl}</span>

        <span class="id-label">Network Mode</span>
        <span class="id-value">
          <span class="network-badge">{identity.networkMode}</span>
        </span>

        <span class="id-label">Public Key</span>
        <span class="id-value mono">
          {truncatedKey}&hellip;
          <button class="btn-copy" onclick={copyPublicKey}>
            {copiedKey ? "Copied!" : "Copy"}
          </button>
        </span>
      </div>
    {:else}
      <p class="identity-loading">Loading identity...</p>
    {/if}
  </div>

  <!-- Save -->
  <div class="save-row">
    <button class="btn-save" onclick={save}>Save Settings</button>
    {#if showSaved}
      <span class="saved-toast">Saved!</span>
    {/if}
  </div>

  <!-- Local Model -->
  <div class="section">
    <h2>Local Model</h2>
    <div class="about-row">
      <span class="about-label">Active Model</span>
      <span class="about-value mono">{activeModel}</span>
    </div>
    <div class="about-row">
      <span class="about-label">Ollama</span>
      <span class="about-value" class:status-ok={ollamaStatus === "Running"} class:status-err={ollamaStatus !== "Running" && ollamaStatus !== "Checking..."}>{ollamaStatus}</span>
    </div>
    {#if installedModels.length > 0}
      <div class="about-row">
        <span class="about-label">Installed</span>
        <span class="about-value mono">{installedModels.join(", ")}</span>
      </div>
    {/if}
  </div>

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
    {#if updateStatus.state !== "checking" && updateStatus.state !== "downloading" && updateStatus.state !== "installing" && updateStatus.state !== "available"}
      <div class="about-row" style="margin-top: 0.5rem;">
        <span></span>
        <button class="btn-check-update" onclick={handleCheckUpdate}>
          {updateStatus.state === "error" ? "Retry" : "Check for Updates"}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .settings {
    padding: 1.5rem;
    max-width: 640px;
  }

  h1 {
    margin: 0 0 1.5rem;
    font-size: 1.4rem;
  }

  .section {
    background: var(--bg-surface, #1a1a2e);
    border: 1px solid var(--border, #1e1e3f);
    padding: 1.2rem 1.4rem;
    border-radius: 10px;
    margin-bottom: 1.2rem;
  }

  .section h2 {
    font-size: 0.92rem;
    margin: 0 0 1rem;
    color: var(--text-muted, #94a3b8);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }

  label {
    display: block;
    margin-bottom: 0.85rem;
  }

  .label-text {
    display: block;
    font-size: 0.85rem;
    color: var(--text-muted, #94a3b8);
    margin-bottom: 0.35rem;
  }

  input[type="text"],
  input[type="password"],
  input[type="number"] {
    width: 100%;
    padding: 0.45rem 0.6rem;
    background: #0d0d1a;
    border: 1px solid var(--border, #1e1e3f);
    border-radius: 5px;
    color: inherit;
    font-size: 0.88rem;
    box-sizing: border-box;
  }

  input[type="number"] {
    width: 100px;
  }

  .input-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .input-row input[type="password"] {
    flex: 1;
  }

  .btn-sm {
    padding: 0.4rem 0.75rem;
    background: var(--accent, #3b82f6);
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 600;
    white-space: nowrap;
    transition: opacity 0.15s;
  }

  .btn-sm:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .badge {
    font-size: 0.78rem;
    font-weight: 600;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    white-space: nowrap;
  }

  .badge.valid {
    color: var(--green, #4ade80);
    background: rgba(74, 222, 128, 0.12);
  }

  .badge.invalid {
    color: var(--red, #f87171);
    background: rgba(248, 113, 113, 0.12);
  }

  .slider-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .slider-row input[type="range"] {
    flex: 1;
    accent-color: var(--accent, #3b82f6);
  }

  .slider-value {
    font-size: 0.88rem;
    font-weight: 600;
    min-width: 3.5em;
    text-align: right;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    cursor: pointer;
    font-size: 0.88rem;
  }

  .toggle input {
    accent-color: var(--accent, #3b82f6);
  }

  /* Node Identity grid */
  .identity-grid {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 0.5rem 1rem;
    font-size: 0.85rem;
  }

  .id-label {
    color: var(--text-muted, #94a3b8);
    padding-top: 0.15rem;
  }

  .id-value {
    word-break: break-all;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .mono {
    font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 0.8rem;
  }

  .network-badge {
    display: inline-block;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background: rgba(59, 130, 246, 0.12);
    color: var(--accent, #3b82f6);
  }

  .btn-copy {
    padding: 0.15rem 0.45rem;
    font-size: 0.72rem;
    background: var(--border, #1e1e3f);
    color: var(--text-muted, #94a3b8);
    border: 1px solid var(--border, #1e1e3f);
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
    transition: color 0.15s;
  }

  .btn-copy:hover {
    color: var(--accent, #3b82f6);
  }

  .identity-loading,
  .identity-error {
    font-size: 0.85rem;
    margin: 0;
  }

  .identity-error {
    color: var(--red, #f87171);
  }

  .identity-loading {
    color: var(--text-muted, #94a3b8);
  }

  /* Save row */
  .save-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-top: 0.5rem;
  }

  .btn-save {
    padding: 0.6rem 1.8rem;
    background: var(--accent, #3b82f6);
    color: white;
    border: none;
    border-radius: 7px;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.92rem;
    transition: opacity 0.15s;
  }

  .btn-save:hover {
    opacity: 0.9;
  }

  .saved-toast {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--green, #4ade80);
    animation: fadeInOut 2s ease forwards;
  }

  @keyframes fadeInOut {
    0% { opacity: 0; transform: translateX(-4px); }
    15% { opacity: 1; transform: translateX(0); }
    80% { opacity: 1; }
    100% { opacity: 0; }
  }

  .about-section {
    margin-top: 1.5rem;
  }
  .about-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.85rem;
    margin-bottom: 0.4rem;
  }
  .about-row:last-child {
    margin-bottom: 0;
  }
  .about-label {
    color: var(--text-muted, #94a3b8);
  }
  .about-value {
    color: var(--text-primary, #e2e8f0);
    text-align: right;
    max-width: 60%;
    word-break: break-word;
  }
  .status-ok {
    color: var(--green, #4ade80);
  }
  .status-err {
    color: var(--red, #f87171);
  }
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
</style>
