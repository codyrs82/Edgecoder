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
