<script lang="ts">
  import { setBusy as setRestartBusy, clearBusy as clearRestartBusy } from "../lib/auto-restart";
  import {
    getModelList,
    getModelCatalog,
    getOllamaTags,
    getOllamaPs,
    pullModelStream,
    deleteOllamaModel,
    swapModel,
    backendReady,
    isRemoteMode,
  } from "../lib/api";
  import { formatBytes, formatParamSize } from "../lib/format";
  import { scrollRegion } from "../lib/scroll-region";
  import { MODEL_CATALOG, CATEGORY_LABELS, type CatalogModel } from "../lib/models";
  import type { ModelInfo, OllamaModel, OllamaRunningModel } from "../lib/types";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import ServiceNotice from "../components/ServiceNotice.svelte";
  import { inDesktopShell, onServiceReady, serviceStatus } from "../lib/service-status";
  import MemoryNotice from "../components/MemoryNotice.svelte";
  import Skeleton from "../components/Skeleton.svelte";

  interface Props {
    /** Optional callback fired after a model swap completes */
    onModelSwapped?: (modelId: string) => void;
  }
  let { onModelSwapped }: Props = $props();

  // ---- Merged model row type ----
  interface MergedModel {
    modelId: string;
    paramSize: number;
    quantization: string;
    source: string;
    installed: boolean;
    active: boolean;
    diskSize: number | null;
    vramSize: number | null;
    running: boolean;
  }

  // ---- Core state ----
  let loading = $state(true);
  let error = $state<string | null>(null);

  let modelList = $state<ModelInfo[]>([]);
  // Served catalog (GET /model/catalog) when the inference service answers, else the bundled copy.
  let catalog = $state<CatalogModel[]>(MODEL_CATALOG);
  let ollamaTags = $state<OllamaModel[]>([]);
  let runningModels = $state<OllamaRunningModel[]>([]);

  // ---- Pull state ----
  let pullTarget = $state("");
  let pulling = $state(false);
  const restartKey = `model-manager:${Math.random().toString(36).slice(2)}`;
  $effect(() => {
    setRestartBusy(restartKey, pulling && "model-pull");
    return () => clearRestartBusy(restartKey);
  });
  let pullingModelId = $state<string | null>(null);
  let pullStatus = $state("");
  let pullCompleted = $state(0);
  let pullTotal = $state(0);
  /** Last failed pull, shown under that model's Install button as well as at the top. */
  let pullError = $state<{ modelId: string; message: string } | null>(null);

  // ---- Delete confirmation state ----
  let confirmDeleteId = $state<string | null>(null);

  // ---- Swap in-flight ----
  let swappingId = $state<string | null>(null);

  // ---- Derived: merge model data ----
  let models: MergedModel[] = $derived.by(() => {
    const tagMap = new Map<string, OllamaModel>();
    for (const tag of ollamaTags) {
      tagMap.set(tag.name, tag);
    }

    const runningMap = new Map<string, OllamaRunningModel>();
    for (const r of runningModels) {
      runningMap.set(r.name, r);
    }

    return modelList.map((m): MergedModel => {
      const tag = tagMap.get(m.modelId);
      const running = runningMap.get(m.modelId);
      return {
        modelId: m.modelId,
        paramSize: m.paramSize,
        quantization: m.quantization,
        source: m.source,
        installed: m.installed,
        active: m.active,
        diskSize: tag?.size ?? null,
        vramSize: running?.size_vram ?? null,
        running: !!running,
      };
    });
  });

  // ---- Catalog state ----
  interface CatalogEntry extends CatalogModel {
    installed: boolean;
    active: boolean;
    running: boolean;
  }

  /** Get the base name before the colon (e.g. "qwen2.5-coder" from "qwen2.5-coder:7b") */
  function modelBase(id: string): string {
    return id.split(":")[0];
  }

  /** Check if an Ollama tag matches a catalog model ID.
   *  Exact match, or treat ":latest" as matching any variant of the same base. */
  function tagMatchesCatalog(tagName: string, catalogId: string): boolean {
    if (tagName === catalogId) return true;
    // "qwen2.5-coder:latest" matches catalog "qwen2.5-coder:7b" (latest = default size)
    const tagSuffix = tagName.split(":")[1] ?? "";
    const catSuffix = catalogId.split(":")[1] ?? "";
    if (modelBase(tagName) === modelBase(catalogId) && (tagSuffix === "latest" || catSuffix === "latest")) {
      return true;
    }
    // Exact size match with different base won't happen, but be safe
    return false;
  }

  let catalogModels: CatalogEntry[] = $derived.by(() => {
    const activeModel = modelList.find((m) => m.active)?.modelId ?? "";
    const runningNames = runningModels.map((r) => r.name);
    const tagNames = ollamaTags.map((t) => t.name);
    return catalog.map((cm) => ({
      ...cm,
      installed: tagNames.some((t) => tagMatchesCatalog(t, cm.modelId)),
      active: activeModel ? tagMatchesCatalog(activeModel, cm.modelId) : false,
      running: runningNames.some((r) => tagMatchesCatalog(r, cm.modelId)),
    }));
  });

  let selectedCategory = $state<string>("all");
  let filteredCatalog = $derived(
    selectedCategory === "all"
      ? catalogModels
      : catalogModels.filter((m) => m.category === selectedCategory)
  );

  // ---- Non-catalog installed models (shown in separate table) ----
  let nonCatalogModels = $derived(
    models.filter((m) => !catalog.some((cm) => tagMatchesCatalog(m.modelId, cm.modelId)))
  );

  let pullPercent = $derived(
    pullTotal > 0 ? Math.round((pullCompleted / pullTotal) * 100) : 0,
  );

  let noLocalAgent = $state(false);

  // ---- Data fetching ----
  async function refresh() {
    await backendReady;

    // Double-check agent availability — it may have started after initial detection
    if (isRemoteMode()) {
      try {
        const res = await fetch("http://127.0.0.1:4301/health/runtime", {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) {
          noLocalAgent = true;
          loading = false;
          return;
        }
        // Agent came online after initial detection — proceed
      } catch {
        noLocalAgent = true;
        loading = false;
        return;
      }
    }

    noLocalAgent = false;
    // Catalog refresh is best-effort: an older inference service without /model/catalog, or a
    // network error, leaves the bundled list in place.
    getModelCatalog()
      .then((served) => {
        if (Array.isArray(served?.models) && served.models.length > 0) catalog = served.models;
      })
      .catch(() => undefined);
    try {
      const [list, tags, ps] = await Promise.all([
        getModelList(),
        getOllamaTags(),
        getOllamaPs(),
      ]);
      modelList = list;
      ollamaTags = tags.models;
      runningModels = ps.models;
      error = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load model data";
      // On 401, the token may not have loaded yet — retry once
      if (msg.includes("401")) {
        try {
          await new Promise((r) => setTimeout(r, 1000));
          const [list, tags, ps] = await Promise.all([
            getModelList(),
            getOllamaTags(),
            getOllamaPs(),
          ]);
          modelList = list;
          ollamaTags = tags.models;
          runningModels = ps.models;
          error = null;
          return;
        } catch (retryErr) {
          error = retryErr instanceof Error ? retryErr.message : msg;
        }
      } else {
        error = msg;
      }
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    refresh();
    // Load again once EdgeCoder's local service is up (after a start or a restart).
    return onServiceReady(() => void refresh());
  });

  // ---- Pull with streaming progress ----
  async function handlePull() {
    const name = pullTarget.trim();
    if (!name) return;

    pulling = true;
    pullingModelId = name;
    pullStatus = "Starting pull...";
    pullCompleted = 0;
    pullTotal = 0;
    error = null;
    pullError = null;

    try {
      const stream = await pullModelStream(name);
      // TS's lib types TextDecoderStream's input as BufferSource, which is not assignable to the stream's Uint8Array chunks.
      const reader = stream.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += value;
        const lines = buffer.split("\n");
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: { status?: string; completed?: number; total?: number; error?: string };
          try {
            msg = JSON.parse(line);
          } catch {
            continue; // Ignore malformed NDJSON lines
          }
          // Ollama reports a refused pull (unknown model, Ollama too old for it) inside the stream.
          if (msg.error) throw new Error(`Ollama: ${msg.error}`);
          {
            pullStatus = msg.status ?? "";

            if (
              msg.status === "downloading" &&
              typeof msg.completed === "number" &&
              typeof msg.total === "number"
            ) {
              pullCompleted = msg.completed;
              pullTotal = msg.total;
            }

            if (msg.status === "success") {
              pullStatus = "success";
            }
          }
        }
      }

      pullTarget = "";
      await refresh();
    } catch (e) {
      // fetch() rejects with a TypeError when nothing answers on the Ollama port.
      error = e instanceof TypeError
        ? "Couldn't reach Ollama on this computer. EdgeCoder starts it when the app opens; restart EdgeCoder (details in ~/.edgecoder/ollama.log), then try again."
        : e instanceof Error ? e.message : "Pull failed";
      pullError = { modelId: name, message: error };
    } finally {
      pulling = false;
      pullingModelId = null;
      pullStatus = "";
      pullCompleted = 0;
      pullTotal = 0;
    }
  }

  // ---- Delete ----
  async function handleDelete(name: string) {
    if (confirmDeleteId !== name) {
      confirmDeleteId = name;
      return;
    }

    confirmDeleteId = null;
    try {
      await deleteOllamaModel(name);
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : "Delete failed";
    }
  }

  function cancelDelete() {
    confirmDeleteId = null;
  }

  // ---- Swap ----
  async function handleSwap(modelId: string) {
    swappingId = modelId;
    error = null;
    try {
      await swapModel(modelId);
      await refresh();
      onModelSwapped?.(modelId);
    } catch (e) {
      error = e instanceof Error ? e.message : "Swap failed";
    } finally {
      swappingId = null;
    }
  }
</script>

<div class="model-manager">
  <h1 class="page-title">Model Manager</h1>

  {#if $serviceStatus.phase !== "ready" || (noLocalAgent && inDesktopShell())}
    <!-- The desktop app starts (and restarts) its own local service: never ask whether it runs. -->
    <ServiceNotice starting={noLocalAgent} />
  {:else if noLocalAgent}
    <div class="info-banner">Models are managed by EdgeCoder on your computer. Open this page in the EdgeCoder desktop app.</div>
  {/if}
  {#if !noLocalAgent}<MemoryNotice showServing />{/if}
  {#if error}
    <ErrorBanner message={error} onRetry={refresh} />
  {/if}

  {#if loading}
    <div class="skeleton-container">
      <Skeleton lines={5} height="2.8rem" />
    </div>
  {:else if !noLocalAgent}
    <!-- Pull progress (shown when pulling, above catalog) -->
    {#if pulling}
      <section class="pull-progress-section">
        <div class="pull-progress">
          <div class="progress-bar-track">
            <div class="progress-bar-fill" style="width: {pullPercent}%"></div>
          </div>
          <div class="progress-info">
            <span class="progress-status">{pullStatus}</span>
            {#if pullTotal > 0}
              <span class="progress-pct">
                {pullPercent}%
                <span class="progress-bytes">({formatBytes(pullCompleted)} / {formatBytes(pullTotal)})</span>
              </span>
            {/if}
          </div>
        </div>
      </section>
    {/if}

    <!-- Category filter tabs -->
    <section class="catalog-section">
      <h2 class="section-title">Model Catalog</h2>
      <div class="category-tabs">
        <button
          class="tab"
          class:active={selectedCategory === "all"}
          onclick={() => (selectedCategory = "all")}
        >All</button>
        {#each Object.entries(CATEGORY_LABELS) as [key, label]}
          <button
            class="tab"
            class:active={selectedCategory === key}
            onclick={() => (selectedCategory = key)}
          >{label}</button>
        {/each}
      </div>

      <!-- Catalog grid -->
      <div class="catalog-grid">
        {#each filteredCatalog as model (model.modelId)}
          <div class="catalog-card" class:installed={model.installed} class:active-model={model.active}>
            <div class="card-header">
              <span class="card-name">{model.name}</span>
              {#if model.active}
                <span class="badge-status badge-active-status">Active</span>
              {:else if model.installed}
                <span class="badge-status badge-installed-status">Installed</span>
              {/if}
              {#if model.recommended}
                <span class="badge-rec">Recommended</span>
              {/if}
            </div>
            <p class="card-desc">{model.description}</p>
            <div class="card-meta">
              <span>{model.paramSize} params</span>
              <span class="meta-sep">&middot;</span>
              <span>{model.diskSize}</span>
            </div>
            <div class="card-actions">
              {#if model.active}
                <button class="btn btn-active-indicator" disabled>Active</button>
              {:else if model.installed}
                <button
                  class="btn btn-swap"
                  onclick={() => handleSwap(model.modelId)}
                  disabled={swappingId !== null}
                >
                  {swappingId === model.modelId ? "Switching..." : "Use Model"}
                </button>
              {:else}
                <button
                  class="btn btn-install"
                  onclick={() => { pullTarget = model.modelId; handlePull(); }}
                  disabled={pulling}
                >
                  {pullingModelId === model.modelId ? "Installing..." : "Install"}
                </button>
                {#if pullingModelId === model.modelId}
                  <span class="row-pull-status">{pullStatus}{pullTotal > 0 ? ` ${pullPercent}%` : ""}</span>
                {:else if pullError?.modelId === model.modelId}
                  <span class="row-pull-error">{pullError.message}</span>
                {/if}
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </section>

    <!-- Installed models not in catalog -->
    {#if nonCatalogModels.length > 0}
      <section class="models-section">
        <h2 class="section-title">Other Installed Models</h2>
        <div class="model-table" role="group" aria-label="Other installed models" use:scrollRegion>
          <div class="model-header">
            <span class="col-name">Model</span>
            <span class="col-params">Params</span>
            <span class="col-quant">Quantization</span>
            <span class="col-source">Source</span>
            <span class="col-disk">Disk</span>
            <span class="col-vram">VRAM</span>
            <span class="col-actions">Actions</span>
          </div>

          {#each nonCatalogModels as model (model.modelId)}
            <div class="model-row" class:model-row-active={model.active} class:model-row-running={model.running}>
              <span class="col-name model-id">
                {model.modelId}
                {#if model.active}
                  <span class="badge badge-active">active</span>
                {:else if model.running}
                  <span class="badge badge-running">loaded</span>
                {/if}
              </span>
              <span class="col-params">{formatParamSize(model.paramSize)}</span>
              <span class="col-quant">
                <span class="quant-tag">{model.quantization}</span>
              </span>
              <span class="col-source">{model.source}</span>
              <span class="col-disk">
                {model.diskSize !== null ? formatBytes(model.diskSize) : "\u2014"}
              </span>
              <span class="col-vram">
                {#if model.running && model.vramSize !== null}
                  <span class="vram-value">{formatBytes(model.vramSize)}</span>
                {:else}
                  <span class="vram-empty">—</span>
                {/if}
              </span>
              <span class="col-actions">
                {#if !model.active}
                  <button
                    class="btn btn-swap"
                    onclick={() => handleSwap(model.modelId)}
                    disabled={swappingId !== null}
                  >
                    {swappingId === model.modelId ? "Swapping..." : "Swap"}
                  </button>
                {:else}
                  <button class="btn btn-active-indicator" disabled>Active</button>
                {/if}
                {#if !model.active}
                  <button
                    class="btn btn-delete"
                    class:btn-confirm={confirmDeleteId === model.modelId}
                    onclick={() => handleDelete(model.modelId)}
                    onblur={cancelDelete}
                  >
                    {confirmDeleteId === model.modelId ? "Confirm?" : "Delete"}
                  </button>
                {/if}
              </span>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Advanced pull (collapsible) -->
    <details class="advanced-pull">
      <summary>Advanced: Pull model by name</summary>
      <div class="pull-row">
        <input
          class="pull-input"
          type="text"
          bind:value={pullTarget}
          placeholder="e.g. qwen3.5:9b"
          disabled={pulling}
          onkeydown={(e: KeyboardEvent) => {
            if (e.key === "Enter") handlePull();
          }}
        />
        <button class="btn btn-primary" onclick={handlePull} disabled={pulling || !pullTarget.trim()}>
          {pulling ? "Pulling..." : "Pull"}
        </button>
      </div>
    </details>
  {/if}
</div>

<style>
  /* ---- Layout ---- */
  .model-manager {
    padding: 1.5rem;
    max-width: 960px;
    margin: 0 auto;
  }

  .page-title {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 0 0 1.25rem 0;
    color: var(--text-primary);
  }

  .section-title {
    font-size: 1rem;
    font-weight: 600;
    margin: 0 0 0.75rem 0;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.8rem;
  }

  /* ---- Category tabs ---- */
  .catalog-section {
    margin-bottom: 2rem;
  }

  .category-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-bottom: 1rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
  }

  .tab {
    padding: 0.5rem 1rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
    margin-bottom: -1px;
  }
  .tab:hover {
    color: var(--text-primary);
  }
  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }

  /* ---- Catalog grid ---- */
  .catalog-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 0.75rem;
  }

  .catalog-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .catalog-card:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-sm);
  }
  .catalog-card.installed {
    border-left: 3px solid color-mix(in srgb, var(--green) 50%, transparent);
  }
  .catalog-card.active-model {
    border-left: 3px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .card-name {
    font-weight: 600;
    font-size: 0.95rem;
    color: var(--text-primary);
  }

  .badge-status {
    font-size: 0.6rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  /* Tint and text share a hue: blue text on the accent's tint falls short of 4.5:1 in light. */
  .badge-active-status {
    background: color-mix(in srgb, var(--accent-secondary) 10%, transparent);
    color: var(--accent-secondary);
  }

  .badge-installed-status {
    background: color-mix(in srgb, var(--green) 10%, transparent);
    color: var(--green);
  }

  .badge-rec {
    font-size: 0.6rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: color-mix(in srgb, var(--yellow) 12%, transparent);
    color: var(--yellow);
    flex-shrink: 0;
  }

  .card-desc {
    font-size: 0.82rem;
    color: var(--text-secondary);
    line-height: 1.4;
    margin: 0;
    flex: 1;
  }

  .card-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .meta-sep {
    color: var(--text-muted);
  }

  .card-actions {
    margin-top: 0.25rem;
    display: flex;
    gap: 0.4rem;
  }

  /* ---- Pull progress section ---- */
  .pull-progress-section {
    margin-bottom: 1rem;
    padding: 0.75rem 1rem;
    background: var(--bg-surface);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
  }

  .pull-progress {
    margin-top: 0;
  }

  .progress-bar-track {
    width: 100%;
    height: 8px;
    background: var(--bg-input);
    border-radius: 4px;
    overflow: hidden;
  }

  .progress-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
    transition: width 0.2s ease-out;
  }

  .progress-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.4rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .progress-status {
    text-transform: capitalize;
  }

  .progress-pct {
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-primary);
  }

  .progress-bytes {
    font-weight: 400;
    color: var(--text-secondary);
  }

  /* ---- Advanced pull (collapsible) ---- */
  .advanced-pull {
    margin-top: 1.5rem;
    padding: 0.75rem 1rem;
    background: var(--bg-surface);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
  }

  .advanced-pull summary {
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 0.85rem;
    font-weight: 500;
    user-select: none;
    padding: 0.25rem 0;
  }
  .advanced-pull summary:hover {
    color: var(--text-primary);
  }

  .advanced-pull .pull-row {
    margin-top: 0.75rem;
  }

  .pull-row {
    display: flex;
    gap: 0.5rem;
  }

  .pull-input {
    flex: 1;
    padding: 0.55rem 0.75rem;
    background: var(--bg-input);
    border: 1px solid var(--border-control);
    border-radius: 6px;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.9rem;
    outline: none;
    transition: border-color 0.15s;
  }
  .pull-input:focus {
    border-color: var(--accent);
  }
  .pull-input:disabled {
    opacity: 0.5;
  }

  /* ---- Model table ---- */
  .models-section {
    margin-bottom: 1rem;
    margin-top: 1.5rem;
  }

  .skeleton-container {
    padding: 1rem;
    background: var(--bg-surface);
    border-radius: 10px;
    border: 1px solid var(--border);
  }

  .model-table {
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--bg-surface);
    border-radius: 10px;
    border: 1px solid var(--border);
    overflow-x: auto;
  }

  .model-header,
  .model-row {
    display: grid;
    grid-template-columns: 2fr 0.7fr 0.9fr 0.8fr 0.8fr 0.8fr 1.2fr;
    align-items: center;
    padding: 0.6rem 1rem;
    gap: 0.5rem;
    /* Seven columns need this much; in a narrower window the table scrolls sideways. */
    min-width: 640px;
  }

  .model-header {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    background: var(--bg-surface);
    font-weight: 600;
    border-bottom: 1px solid var(--border);
  }

  .model-row {
    font-size: 0.88rem;
    color: var(--text-primary);
    transition: background 0.15s;
  }
  .model-row:hover {
    background: color-mix(in srgb, var(--text-primary) 3%, transparent);
  }

  .model-row-active {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-left: 3px solid var(--accent);
  }
  .model-row-active:hover {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }

  .model-row-running:not(.model-row-active) {
    background: color-mix(in srgb, var(--green) 6%, transparent);
  }

  /* ---- Cell styles ---- */
  .model-id {
    font-family: var(--font-mono);
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .badge {
    font-size: 0.65rem;
    font-weight: 600;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .badge-active {
    background: color-mix(in srgb, var(--accent-secondary) 10%, transparent);
    color: var(--accent-secondary);
  }

  .badge-running {
    background: color-mix(in srgb, var(--green) 10%, transparent);
    color: var(--green);
  }

  .quant-tag {
    font-size: 0.78rem;
    background: var(--bg-elevated);
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    font-family: var(--font-mono);
  }

  .col-disk,
  .col-vram,
  .col-params {
    font-family: var(--font-mono);
    font-size: 0.84rem;
  }

  .col-source {
    font-size: 0.82rem;
    color: var(--text-secondary);
  }

  .vram-value {
    color: var(--green);
    font-weight: 600;
  }

  .vram-empty {
    opacity: 0.3;
  }

  .col-actions {
    display: flex;
    gap: 0.4rem;
    justify-content: flex-end;
  }

  /* ---- Buttons ---- */
  .btn {
    padding: 0.35rem 0.75rem;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 500;
    transition: background 0.15s, opacity 0.15s;
    white-space: nowrap;
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .btn-primary {
    background: var(--accent);
    color: var(--on-accent);
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-swap {
    background: var(--accent);
    color: var(--on-accent);
  }
  .btn-swap:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-install {
    background: color-mix(in srgb, var(--green) 8%, transparent);
    color: var(--green);
    border: 1px solid color-mix(in srgb, var(--green) 30%, transparent);
  }
  .btn-install:hover:not(:disabled) {
    background: color-mix(in srgb, var(--green) 12%, transparent);
  }

  .btn-active-indicator {
    background: color-mix(in srgb, var(--accent-secondary) 10%, transparent);
    color: var(--accent-secondary);
    cursor: default;
  }

  .btn-delete {
    background: color-mix(in srgb, var(--red) 10%, transparent);
    color: var(--red-strong);
  }
  .btn-delete:hover:not(:disabled) {
    background: color-mix(in srgb, var(--red) 15%, transparent);
  }

  .btn-confirm {
    background: var(--red);
    color: var(--on-accent);
    animation: pulse-confirm 0.6s ease-in-out infinite alternate;
  }
  .btn-confirm:hover {
    filter: brightness(0.9);
  }

  @keyframes pulse-confirm {
    from { opacity: 0.85; }
    to { opacity: 1; }
  }

  .info-banner {
    display: flex;
    align-items: center;
    background: color-mix(in srgb, var(--accent-secondary) 10%, transparent);
    color: var(--accent-secondary);
    padding: 0.75rem 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
    font-size: 0.9rem;
  }
  .row-pull-status {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .row-pull-error {
    font-size: 0.8rem;
    color: var(--danger);
    max-width: 28rem;
  }
</style>
