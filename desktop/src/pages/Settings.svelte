<script lang="ts">
  import { computeOverview, getIdentity, getDashboardOverview, getModelList, backendReady, isRemoteMode, getProjectsFolder, setProjectsFolder, type ProjectsFolder } from "../lib/api";
  import { loadSettings, saveSetting } from "../lib/stores";
  import { coordinatorUrl as currentCoordinatorUrl, portalUrl as currentPortalUrl, setEndpoint, resetEndpoints, syncEndpointsToShell, testEndpoint, validateEndpointUrl, defaultEndpoints, type EndpointKind } from "../lib/endpoints";
  import { checkForUpdate, onUpdateStatus, downloadAndInstall, type UpdateStatus } from "../lib/updater";
  import type { NodeIdentity } from "../lib/types";
  import { getThemePreference, setTheme, type ThemePreference } from "../lib/theme";
  import Select from "../components/ui/Select.svelte";
  import { notify } from "../lib/toast";

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
  // #35: coordinator / portal endpoints (endpoints.ts), with Test connection and Reset.
  let coordinatorUrl = $state(currentCoordinatorUrl());
  let portalUrl = $state(currentPortalUrl());
  let endpointError = $state("");
  let endpointTest: Record<EndpointKind, "idle" | "testing" | "ok" | "fail"> = $state({ coordinator: "idle", portal: "idle" });
  const endpointDefaults = defaultEndpoints();
  // #138: the window's CSP only picks up a changed host after a restart (the shell adds it at launch).
  let endpointRestartNeeded = $state(false);
  async function applyEndpointsToShell() {
    try {
      endpointRestartNeeded = await syncEndpointsToShell();
    } catch (e) {
      endpointError = e instanceof Error ? e.message : String(e);
    }
  }
  async function restartForEndpoints() {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  }
  // Overrides saved before #138 reach the shell too.
  void applyEndpointsToShell();

  async function handleTestEndpoint(kind: EndpointKind) {
    endpointTest[kind] = "testing";
    endpointTest[kind] = (await testEndpoint(kind, kind === "coordinator" ? coordinatorUrl : portalUrl)) ? "ok" : "fail";
  }

  function handleResetEndpoints() {
    resetEndpoints();
    coordinatorUrl = currentCoordinatorUrl();
    portalUrl = currentPortalUrl();
    endpointError = "";
    endpointTest = { coordinator: "idle", portal: "idle" };
    void applyEndpointsToShell();
  }
  let maxConcurrentTasks = $state(1);
  let cpuCapPercent = $state(50);
  let idleOnly = $state(true);
  let bleEnabled = $state(true);
  let bleSaving = $state(false);
  let bleNote = $state("");

  // BLE peer discovery: the app keeps the choice and restarts its agent with it.
  $effect(() => {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<{ bleEnabled: boolean }>("get_agent_settings"))
      .then((s) => (bleEnabled = s.bleEnabled))
      .catch(() => (bleNote = "Only available in the desktop app."));
  });

  async function setBle(on: boolean) {
    bleSaving = true;
    bleNote = "";
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const s = await invoke<{ bleEnabled: boolean }>("set_agent_ble", { enabled: on });
      bleEnabled = s.bleEnabled;
      bleNote = on ? "Saved. The agent is restarting with Bluetooth on (macOS may ask to allow Bluetooth)." : "Saved. The agent is restarting with Bluetooth off.";
    } catch (e) {
      bleEnabled = !on;
      bleNote = `Couldn't save: ${(e as Error).message ?? e}`;
    } finally {
      bleSaving = false;
    }
  }

  // Token test state

  // Identity state
  let identity: NodeIdentity | null = $state(null);
  let identityError = $state("");

  // Save feedback

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

  // Which coordinator this computer is connected through: the agent's steering pick (signed registry,
  // lowest latency) when there is one, else the coordinator the account summary came from.
  type MeshStatus = { url: string; machines: number; agents: number; region: string | null; latencyMs: number | null; steered: boolean; fallbackReason: string | null };
  let meshStatus = $state<"loading" | MeshStatus | null>("loading");
  $effect(() => {
    computeOverview()
      .then((ov) => {
        const a = ov.account;
        const s = ov.steering ?? null;
        const url = s?.source === "registry" ? s.url : a?.coordinator?.url;
        meshStatus = url && a
          ? {
              url,
              machines: (a.machines ?? []).filter((m) => m.online).length,
              agents: a.networkAgents ?? 0,
              region: s?.source === "registry" ? s.region ?? null : null,
              latencyMs: s?.source === "registry" ? s.latencyMs ?? null : null,
              steered: s?.source === "registry",
              fallbackReason: s?.source === "fallback" ? s.reason : null,
            }
          : null;
      })
      .catch(() => (meshStatus = null));
  });

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
    endpointError = "";
    for (const [kind, value] of [["coordinator", coordinatorUrl], ["portal", portalUrl]] as const) {
      if (value.trim() && !validateEndpointUrl(value)) {
        endpointError = `Invalid ${kind} URL: use https:// (http:// only for 127.0.0.1 or localhost)`;
        return;
      }
    }
    setEndpoint("coordinator", coordinatorUrl === endpointDefaults.coordinator ? "" : coordinatorUrl);
    setEndpoint("portal", portalUrl === endpointDefaults.portal ? "" : portalUrl);
    void applyEndpointsToShell();
    saveSetting("maxConcurrentTasks", String(maxConcurrentTasks));
    saveSetting("cpuCapPercent", String(cpuCapPercent));
    saveSetting("idleOnly", String(idleOnly));

    notify("Settings saved", "success", "settings-saved");
  }
  let themePref = $state<ThemePreference>(getThemePreference());

  // Projects folder: where new projects and connected repositories go (default ~/EdgeCoder).
  let projectsFolder = $state<ProjectsFolder | null>(null);
  let projectsFolderDraft = $state("");
  let projectsFolderMsg = $state<{ ok: boolean; text: string } | null>(null);
  backendReady.then(() => getProjectsFolder()).then((f) => { projectsFolder = f; projectsFolderDraft = f.path; }).catch(() => {});
  async function saveProjectsFolder(path: string) {
    projectsFolderMsg = null;
    try {
      const f = await setProjectsFolder(path);
      projectsFolder = { ...projectsFolder, ...f };
      projectsFolderDraft = f.path;
      projectsFolderMsg = { ok: true, text: "Saved" };
    } catch (e) {
      projectsFolderMsg = { ok: false, text: (e as Error).message };
    }
  }
  async function chooseProjectsFolder() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, title: "Choose your projects folder", defaultPath: projectsFolder?.path });
      if (typeof picked === "string") await saveProjectsFolder(picked);
    } catch (e) {
      projectsFolderMsg = { ok: false, text: (e as Error).message };
    }
  }
</script>

<!-- Cursor-style: a title, then groups of rows in cards (title and one-line description on the
     left, the control on the right); styles in styles/settings-page.css. -->
<div class="sp general">
  <h1>General</h1>

  <section class="sp-group" aria-labelledby="gen-appearance">
    <h2 class="sp-group-title" id="gen-appearance">Appearance</h2>
    <div class="sp-card">
      <div class="sp-row">
        <div class="sp-text">
          <span class="sp-title">Theme</span>
          <span class="sp-desc">Light, dark, or follow the system setting.</span>
        </div>
        <div class="sp-controls">
          <Select
            ariaLabel="Theme"
            bind:value={themePref}
            onChange={(v) => setTheme(v)}
            options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
          />
        </div>
      </div>
    </div>
  </section>

  <section class="sp-group" aria-labelledby="gen-projects">
    <h2 class="sp-group-title" id="gen-projects">Projects</h2>
    <div class="sp-card">
      <div class="sp-row stack">
        <div class="sp-text">
          <span class="sp-title">Projects folder</span>
          <span class="sp-desc">
            {#if projectsFolderMsg && !projectsFolderMsg.ok}{projectsFolderMsg.text}
            {:else if projectsFolder?.source === "env"}Set by EDGECODER_PROJECTS_DIR on this machine.
            {:else}New projects and connected repositories go here, one folder per repository. Created when first used.{/if}
          </span>
        </div>
        <div class="sp-inline">
          <input type="text" class="grow" aria-label="Projects folder" bind:value={projectsFolderDraft} placeholder="~/EdgeCoder" disabled={projectsFolder?.source === "env"} onkeydown={(e) => { if (e.key === "Enter") void saveProjectsFolder(projectsFolderDraft); }} />
          {#if projectsFolderDraft.trim() && projectsFolderDraft !== projectsFolder?.path}
            <button class="primary" onclick={() => void saveProjectsFolder(projectsFolderDraft)}>Save</button>
          {/if}
          <button onclick={() => void chooseProjectsFolder()} disabled={projectsFolder?.source === "env"}>Choose…</button>
          {#if projectsFolderMsg}<span class={projectsFolderMsg.ok ? "sp-ok" : "sp-err"}>{projectsFolderMsg.ok ? projectsFolderMsg.text : "Not saved"}</span>{/if}
        </div>
      </div>
    </div>
  </section>

  <section class="sp-group" aria-labelledby="gen-network">
    <h2 class="sp-group-title" id="gen-network">Network</h2>
    <div class="sp-card">
      <div class="sp-row stack">
        <div class="sp-text">
          <span class="sp-title">Connected through</span>
          {#if meshStatus === "loading"}
            <span class="sp-desc">Checking…</span>
          {:else if meshStatus}
            <span class="sp-inline mesh-line">
              <code>{meshStatus.url}</code>
              {#if meshStatus.region}<span class="sp-pill" title="Coordinator region">{meshStatus.region}</span>{/if}
              {#if meshStatus.latencyMs !== null}<span class="sp-pill" title="Median /identity round trip">{meshStatus.latencyMs} ms</span>{/if}
              <span class="sp-ok"><span class="sp-dot on"></span> Joined</span>
            </span>
            <span class="sp-desc">
              {#if meshStatus.steered}
                Chosen as the fastest healthy coordinator in EdgeCoder's signed registry; its identity key matched the registry.
              {:else if meshStatus.fallbackReason}
                Using the default coordinator (the coordinator registry was not usable: {meshStatus.fallbackReason.split(":")[0].replaceAll("_", " ")}).
              {/if}
              This computer joined the network when you signed in; its mesh credentials are issued and renewed automatically. {meshStatus.machines} of your machine{meshStatus.machines === 1 ? "" : "s"} and {meshStatus.agents} machines in all are online.
            </span>
          {:else}
            <span class="sp-desc">Not connected yet. Sign in and keep EdgeCoder open; the agent joins the network on its own.</span>
          {/if}
        </div>
      </div>
      {#each [["coordinator", "Coordinator URL", "Advanced: the coordinator this computer talks to."], ["portal", "Portal URL", "Advanced: where sign-in, wallet and usage live."]] as const as [kind, label, desc]}
        <div class="sp-row stack">
          <div class="sp-text">
            <span class="sp-title">{label}</span>
            <span class="sp-desc">{desc}</span>
          </div>
          <div class="sp-inline">
            {#if kind === "coordinator"}
              <input type="text" class="grow" aria-label={label} bind:value={coordinatorUrl} placeholder={endpointDefaults.coordinator} />
            {:else}
              <input type="text" class="grow" aria-label={label} bind:value={portalUrl} placeholder={endpointDefaults.portal} />
            {/if}
            <button onclick={() => handleTestEndpoint(kind)} disabled={endpointTest[kind] === "testing"}>
              {endpointTest[kind] === "testing" ? "Testing…" : "Test connection"}
            </button>
            {#if endpointTest[kind] === "ok"}<span class="sp-ok">Reachable</span>{/if}
            {#if endpointTest[kind] === "fail"}<span class="sp-err">Unreachable</span>{/if}
          </div>
        </div>
      {/each}
      {#if endpointError || endpointRestartNeeded}
        <div class="sp-row stack">
          {#if endpointError}<p class="sp-err">{endpointError}</p>{/if}
          {#if endpointRestartNeeded}
            <p class="sp-desc" role="status">
              EdgeCoder needs a restart before it can reach a changed host (the app only connects to hosts it allowed at launch).
              <button class="small" onclick={restartForEndpoints}>Restart now</button>
            </p>
          {/if}
        </div>
      {/if}
      <div class="sp-row">
        <div class="sp-text">
          <span class="sp-title">Default endpoints</span>
          <span class="sp-desc">Go back to EdgeCoder's coordinator and portal.</span>
        </div>
        <div class="sp-controls"><button onclick={handleResetEndpoints}>Reset to defaults</button></div>
      </div>
    </div>
  </section>

  <section class="sp-group" aria-labelledby="gen-power">
    <h2 class="sp-group-title" id="gen-power">Power</h2>
    <div class="sp-card">
      <div class="sp-row">
        <div class="sp-text">
          <span class="sp-title">Max concurrent tasks</span>
          <span class="sp-desc">Jobs this computer runs at once: your own, and other people's once your account is an approved host (by request during early access).</span>
        </div>
        <div class="sp-controls"><input type="number" class="num" aria-label="Max concurrent tasks" bind:value={maxConcurrentTasks} min="1" max="10" /></div>
      </div>
      <div class="sp-row">
        <div class="sp-text">
          <span class="sp-title">CPU cap</span>
          <span class="sp-desc">The most CPU network jobs may use.</span>
        </div>
        <div class="sp-controls">
          <input type="range" aria-label="CPU cap" bind:value={cpuCapPercent} min="10" max="100" />
          <span class="slider-value">{cpuCapPercent}%</span>
        </div>
      </div>
      <div class="sp-row">
        <div class="sp-text">
          <span class="sp-title">Only run tasks when idle</span>
          <span class="sp-desc">Wait until you are away from the keyboard.</span>
        </div>
        <div class="sp-controls">
          <button class="sp-switch" role="switch" aria-checked={idleOnly} aria-label="Only run tasks when idle" onclick={() => (idleOnly = !idleOnly)}></button>
        </div>
      </div>
      <div class="sp-row">
        <div class="sp-text">
          <span class="sp-title">BLE peer discovery</span>
          <span class="sp-desc">{bleNote || "Find EdgeCoder machines nearby over Bluetooth (macOS)."}</span>
        </div>
        <div class="sp-controls">
          <button class="sp-switch" role="switch" aria-checked={bleEnabled} aria-label="Enable BLE peer discovery" disabled={bleSaving} onclick={() => setBle(!bleEnabled)}></button>
        </div>
      </div>
    </div>
    <div class="save-row">
      <button class="primary" onclick={save}>Save Settings</button>
    </div>
  </section>

  <section class="sp-group" aria-labelledby="gen-identity">
    <h2 class="sp-group-title" id="gen-identity">Node identity</h2>
    <div class="sp-card">
      {#if identityError}
        <div class="sp-row"><span class="sp-err">{identityError}</span></div>
      {:else if identity}
        <div class="sp-row">
          <div class="sp-text"><span class="sp-title">Peer ID</span></div>
          <code class="value">{identity.peerId}</code>
        </div>
        <div class="sp-row">
          <div class="sp-text"><span class="sp-title">Coordinator</span></div>
          <span class="value">{identity.coordinatorUrl}</span>
        </div>
        <div class="sp-row">
          <div class="sp-text"><span class="sp-title">Network mode</span></div>
          <span class="sp-pill">{identity.networkMode}</span>
        </div>
        <div class="sp-row">
          <div class="sp-text"><span class="sp-title">Public key</span></div>
          <div class="sp-controls">
            <code class="value">{truncatedKey}&hellip;</code>
            <button class="small" onclick={copyPublicKey}>{copiedKey ? "Copied" : "Copy"}</button>
          </div>
        </div>
      {:else}
        <div class="sp-row"><span class="sp-muted">Loading identity…</span></div>
      {/if}
    </div>
  </section>

  <section class="sp-group" aria-labelledby="gen-about">
    <h2 class="sp-group-title" id="gen-about">About</h2>
    <div class="sp-card">
      <div class="sp-row">
        <div class="sp-text"><span class="sp-title">Local model</span><span class="sp-desc">Ollama: <span class:sp-ok={ollamaStatus === "Running"} class:sp-err={ollamaStatus !== "Running" && ollamaStatus !== "Checking..."}>{ollamaStatus}</span>{#if installedModels.length > 0} · installed: {installedModels.join(", ")}{/if}</span></div>
        <code class="value">{activeModel}</code>
      </div>
      <div class="sp-row">
        <div class="sp-text"><span class="sp-title">App version</span></div>
        <code class="value">{appVersion}</code>
      </div>
      <div class="sp-row">
        <div class="sp-text">
          <span class="sp-title">Updates</span>
          <span class="sp-desc">
            {#if updateStatus.state === "checking"}Checking…
            {:else if updateStatus.state === "up-to-date"}<span class="sp-ok">Up to date</span>
            {:else if updateStatus.state === "available" || updateStatus.state === "ready"}<span class="sp-warn">v{updateStatus.update.version} {updateStatus.state === "ready" ? "ready" : "available"}</span>
            {:else if updateStatus.state === "downloading"}Downloading… {updateStatus.progress}%
            {:else if updateStatus.state === "installing"}Installing…
            {:else if updateStatus.state === "error"}<span class="sp-err">{updateStatus.message}</span>
            {:else}EdgeCoder checks for updates on its own.{/if}
          </span>
        </div>
        <div class="sp-controls">
          {#if updateStatus.state === "available" || updateStatus.state === "ready"}
            <button class="primary" onclick={handleInstallUpdate}>Restart to update</button>
          {:else if updateStatus.state !== "checking" && updateStatus.state !== "downloading" && updateStatus.state !== "installing"}
            <button onclick={handleCheckUpdate}>{updateStatus.state === "error" ? "Retry" : "Check for updates"}</button>
          {/if}
        </div>
      </div>
    </div>
  </section>
</div>

<style>
  .general .sp-inline { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
  .general .sp-inline input.grow { flex: 1 1 220px; min-width: 0; }
  .general .mesh-line { margin: 2px 0; font-size: var(--fs-sm); }
  .general .mesh-line code { overflow-wrap: anywhere; }
  .general input.num { width: 72px; }
  .general input[type="range"] { width: 140px; accent-color: var(--accent); }
  .general .slider-value { width: 40px; text-align: right; font-variant-numeric: tabular-nums; color: var(--text-secondary); font-size: var(--fs-sm); }
  .general .value { color: var(--text-secondary); font-size: var(--fs-xs); max-width: 60%; overflow-wrap: anywhere; text-align: right; }
  .general span.value { font-size: var(--fs-sm); }
  .general .save-row { display: flex; justify-content: flex-end; margin-top: 4px; }
  .general p { margin: 0; }
</style>
