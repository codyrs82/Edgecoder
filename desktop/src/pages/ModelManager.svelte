<script lang="ts">
  import {
    getModelList,
    getOllamaTags,
    getOllamaPs,
    pullModelStream,
    deleteOllamaModel,
    swapModel,
    backendReady,
    isRemoteMode,
  } from "../lib/api";
  import { formatBytes, formatParamSize } from "../lib/format";
  import type { ModelInfo, OllamaModel, OllamaRunningModel } from "../lib/types";
  import ErrorBanner from "../components/ErrorBanner.svelte";
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
  let ollamaTags = $state<OllamaModel[]>([]);
  let runningModels = $state<OllamaRunningModel[]>([]);

  // ---- Pull state ----
  let pullTarget = $state("");
  let pulling = $state(false);
  let pullStatus = $state("");
  let pullCompleted = $state(0);
  let pullTotal = $state(0);

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

  let pullPercent = $derived(
    pullTotal > 0 ? Math.round((pullCompleted / pullTotal) * 100) : 0,
  );

  let noLocalAgent = $state(false);

  // ---- Data fetching ----
  async function refresh() {
    await backendReady;
    if (isRemoteMode()) {
      noLocalAgent = true;
      loading = false;
      return;
    }
    noLocalAgent = false;
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
      error = e instanceof Error ? e.message : "Failed to load model data";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    refresh();
  });

  // ---- Pull with streaming progress ----
  async function handlePull() {
    const name = pullTarget.trim();
    if (!name) return;

    pulling = true;
    pullStatus = "Starting pull...";
    pullCompleted = 0;
    pullTotal = 0;
    error = null;

    try {
      const stream = await pullModelStream(name);
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
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
          try {
            const msg = JSON.parse(line);
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
          } catch {
            // Ignore malformed NDJSON lines
          }
        }
      }

      pullTarget = "";
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : "Pull failed";
    } finally {
      pulling = false;
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

  {#if noLocalAgent}
    <div class="info-banner">No local agent running. Install and start the EdgeCoder agent to manage models.</div>
  {:else if error}
    <ErrorBanner message={error} onRetry={refresh} />
  {/if}

  <!-- Pull model section -->
  <section class="pull-section">
    <h2 class="section-title">Pull Model</h2>
    <div class="pull-row">
      <input
        class="pull-input"
        type="text"
        bind:value={pullTarget}
        placeholder="e.g. qwen2.5:7b"
        disabled={pulling}
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === "Enter") handlePull();
        }}
      />
      <button class="btn btn-primary" onclick={handlePull} disabled={pulling || !pullTarget.trim()}>
        {pulling ? "Pulling..." : "Pull"}
      </button>
    </div>
    {#if pulling}
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
    {/if}
  </section>

  <!-- Model list -->
  <section class="models-section">
    <h2 class="section-title">Installed Models</h2>

    {#if loading}
      <div class="skeleton-container">
        <Skeleton lines={5} height="2.8rem" />
      </div>
    {:else if models.length === 0}
      <div class="empty-state">No models found. Pull a model to get started.</div>
    {:else}
      <div class="model-table">
        <div class="model-header">
          <span class="col-name">Model</span>
          <span class="col-params">Params</span>
          <span class="col-quant">Quantization</span>
          <span class="col-source">Source</span>
          <span class="col-disk">Disk</span>
          <span class="col-vram">VRAM</span>
          <span class="col-actions">Actions</span>
        </div>

        {#each models as model (model.modelId)}
          <div class="model-row" class:model-row-active={model.active} class:model-row-running={model.running}>
            <!-- Model ID -->
            <span class="col-name model-id">
              {model.modelId}
              {#if model.active}
                <span class="badge badge-active">active</span>
              {:else if model.running}
                <span class="badge badge-running">loaded</span>
              {/if}
            </span>

            <!-- Param size -->
            <span class="col-params">{formatParamSize(model.paramSize)}</span>

            <!-- Quantization -->
            <span class="col-quant">
              <span class="quant-tag">{model.quantization}</span>
            </span>

            <!-- Source -->
            <span class="col-source">{model.source}</span>

            <!-- Disk size -->
            <span class="col-disk">
              {model.diskSize !== null ? formatBytes(model.diskSize) : "—"}
            </span>

            <!-- VRAM -->
            <span class="col-vram">
              {#if model.running && model.vramSize !== null}
                <span class="vram-value">{formatBytes(model.vramSize)}</span>
              {:else}
                <span class="vram-empty">—</span>
              {/if}
            </span>

            <!-- Actions -->
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
    {/if}
  </section>
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
    color: var(--text-primary, #e2e8f0);
  }

  .section-title {
    font-size: 1rem;
    font-weight: 600;
    margin: 0 0 0.75rem 0;
    color: var(--text-secondary, #94a3b8);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.8rem;
  }

  /* ---- Pull section ---- */
  .pull-section {
    margin-bottom: 2rem;
    padding: 1rem;
    background: var(--bg-surface, #1a1a2e);
    border-radius: 10px;
    border: 1px solid var(--border-color, #2d2d5f);
  }

  .pull-row {
    display: flex;
    gap: 0.5rem;
  }

  .pull-input {
    flex: 1;
    padding: 0.55rem 0.75rem;
    background: var(--bg-input, #12122a);
    border: 1px solid var(--border-color, #2d2d5f);
    border-radius: 6px;
    color: var(--text-primary, #e2e8f0);
    font-family: inherit;
    font-size: 0.9rem;
    outline: none;
    transition: border-color 0.15s;
  }
  .pull-input:focus {
    border-color: var(--accent, #3b82f6);
  }
  .pull-input:disabled {
    opacity: 0.5;
  }

  /* ---- Progress bar ---- */
  .pull-progress {
    margin-top: 0.75rem;
  }

  .progress-bar-track {
    width: 100%;
    height: 8px;
    background: var(--bg-input, #12122a);
    border-radius: 4px;
    overflow: hidden;
  }

  .progress-bar-fill {
    height: 100%;
    background: var(--accent, #3b82f6);
    border-radius: 4px;
    transition: width 0.2s ease-out;
  }

  .progress-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.4rem;
    font-size: 0.8rem;
    color: var(--text-secondary, #94a3b8);
  }

  .progress-status {
    text-transform: capitalize;
  }

  .progress-pct {
    font-family: monospace;
    font-weight: 600;
    color: var(--text-primary, #e2e8f0);
  }

  .progress-bytes {
    font-weight: 400;
    opacity: 0.7;
  }

  /* ---- Model table ---- */
  .models-section {
    margin-bottom: 1rem;
  }

  .skeleton-container {
    padding: 1rem;
    background: var(--bg-surface, #1a1a2e);
    border-radius: 10px;
    border: 1px solid var(--border-color, #2d2d5f);
  }

  .empty-state {
    text-align: center;
    padding: 2rem;
    color: var(--text-secondary, #94a3b8);
    background: var(--bg-surface, #1a1a2e);
    border-radius: 10px;
    border: 1px solid var(--border-color, #2d2d5f);
  }

  .model-table {
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--bg-surface, #1a1a2e);
    border-radius: 10px;
    border: 1px solid var(--border-color, #2d2d5f);
    overflow: hidden;
  }

  .model-header,
  .model-row {
    display: grid;
    grid-template-columns: 2fr 0.7fr 0.9fr 0.8fr 0.8fr 0.8fr 1.2fr;
    align-items: center;
    padding: 0.6rem 1rem;
    gap: 0.5rem;
  }

  .model-header {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary, #94a3b8);
    background: var(--bg-header, #151530);
    font-weight: 600;
    border-bottom: 1px solid var(--border-color, #2d2d5f);
  }

  .model-row {
    font-size: 0.88rem;
    color: var(--text-primary, #e2e8f0);
    transition: background 0.15s;
  }
  .model-row:hover {
    background: rgba(255, 255, 255, 0.03);
  }

  .model-row-active {
    background: rgba(59, 130, 246, 0.08);
    border-left: 3px solid var(--accent, #3b82f6);
  }
  .model-row-active:hover {
    background: rgba(59, 130, 246, 0.12);
  }

  .model-row-running:not(.model-row-active) {
    background: rgba(34, 197, 94, 0.06);
  }

  /* ---- Cell styles ---- */
  .model-id {
    font-family: "SF Mono", "Fira Code", monospace;
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
    background: rgba(59, 130, 246, 0.2);
    color: #60a5fa;
  }

  .badge-running {
    background: rgba(34, 197, 94, 0.2);
    color: #4ade80;
  }

  .quant-tag {
    font-size: 0.78rem;
    background: var(--bg-tag, #2d2d5f);
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    font-family: monospace;
  }

  .col-disk,
  .col-vram,
  .col-params {
    font-family: monospace;
    font-size: 0.84rem;
  }

  .col-source {
    font-size: 0.82rem;
    color: var(--text-secondary, #94a3b8);
  }

  .vram-value {
    color: #4ade80;
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
    background: var(--accent, #3b82f6);
    color: #fff;
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover, #2563eb);
  }

  .btn-swap {
    background: var(--accent, #3b82f6);
    color: #fff;
  }
  .btn-swap:hover:not(:disabled) {
    background: var(--accent-hover, #2563eb);
  }

  .btn-active-indicator {
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    cursor: default;
  }

  .btn-delete {
    background: rgba(239, 68, 68, 0.15);
    color: #f87171;
  }
  .btn-delete:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.3);
  }

  .btn-confirm {
    background: #dc2626;
    color: #fff;
    animation: pulse-confirm 0.6s ease-in-out infinite alternate;
  }
  .btn-confirm:hover {
    background: #b91c1c;
  }

  @keyframes pulse-confirm {
    from { opacity: 0.85; }
    to { opacity: 1; }
  }
  .info-banner { display: flex; align-items: center; background: rgba(59,130,246,0.1); color: var(--accent-secondary, #4a90d9); padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.9rem; }
</style>
