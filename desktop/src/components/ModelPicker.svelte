<script lang="ts">
  import { getOllamaTags, getOllamaPs, getAvailableModels } from "../lib/api";
  import type { OllamaModel, OllamaRunningModel } from "../lib/types";
  import type { SwarmModelInfo } from "../lib/api";

  interface Props {
    selectedModel?: string;
    onSelect: (model: string | undefined) => void;
  }
  let { selectedModel, onSelect }: Props = $props();

  let open = $state(false);
  let ollamaModels: OllamaModel[] = $state([]);
  let runningModels: OllamaRunningModel[] = $state([]);
  let swarmModels: SwarmModelInfo[] = $state([]);

  function displayLabel(model?: string): string {
    if (!model) return "Auto";
    const parts = model.split(":");
    const name = parts[0];
    const tag = parts[1]?.split("-")[0] ?? "";
    return tag ? `${name}:${tag}` : name;
  }

  async function refresh() {
    try {
      const [tags, ps, swarm] = await Promise.all([
        getOllamaTags(),
        getOllamaPs(),
        getAvailableModels().catch(() => []),
      ]);
      ollamaModels = tags.models ?? [];
      runningModels = ps.models ?? [];
      swarmModels = swarm;
    } catch {
      // Silent
    }
  }

  function selectModel(model: string | undefined) {
    onSelect(model);
    open = false;
  }

  function isRunning(name: string): boolean {
    return runningModels.some(m => m.name === name || m.model === name);
  }
</script>

<div class="model-picker">
  <button class="picker-trigger" onclick={() => { open = !open; if (open) refresh(); }}>
    <span class="picker-label">{displayLabel(selectedModel)}</span>
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="picker-backdrop" onclick={() => { open = false; }}></div>
    <div class="picker-dropdown">
      <button class="picker-option" class:active={!selectedModel} onclick={() => selectModel(undefined)}>
        <span class="option-name">Auto</span>
        <span class="option-meta">Best available route</span>
      </button>

      {#if ollamaModels.length > 0}
        <div class="picker-section-label">Local Models</div>
        {#each ollamaModels as model}
          <button
            class="picker-option"
            class:active={selectedModel === model.name}
            onclick={() => selectModel(model.name)}
          >
            <span class="option-name">
              {displayLabel(model.name)}
              {#if isRunning(model.name)}
                <span class="running-dot"></span>
              {/if}
            </span>
            <span class="option-meta">
              {model.details.parameter_size} · Free
            </span>
          </button>
        {/each}
      {/if}

      {#if swarmModels.length > 0}
        <div class="picker-section-label">Swarm Network</div>
        {#each swarmModels as model}
          {@const cost = Math.max(0.5, model.paramSize)}
          <button
            class="picker-option"
            class:active={selectedModel === model.model}
            class:disabled={model.agentCount === 0}
            disabled={model.agentCount === 0}
            onclick={() => selectModel(model.model)}
          >
            <span class="option-name">{displayLabel(model.model)}</span>
            <span class="option-meta">
              {model.paramSize}B · {cost.toFixed(1)} credits · {model.agentCount} agent{model.agentCount === 1 ? '' : 's'}
            </span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .model-picker {
    position: relative;
  }
  .picker-trigger {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border: 0.5px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .picker-trigger:hover {
    border-color: var(--accent);
    color: var(--text-primary);
  }
  .picker-label {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .picker-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }
  .picker-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 240px;
    max-height: 360px;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 100;
    padding: 4px;
  }
  .picker-section-label {
    padding: 8px 10px 4px;
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .picker-option {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    background: none;
    color: var(--text-primary);
    cursor: pointer;
    border-radius: var(--radius-sm);
    text-align: left;
    transition: background 0.1s;
  }
  .picker-option:hover:not(:disabled) {
    background: var(--bg-surface);
  }
  .picker-option.active {
    border-left: 2px solid var(--accent);
    padding-left: 8px;
  }
  .picker-option.disabled {
    opacity: 0.4;
    cursor: default;
  }
  .option-name {
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .option-meta {
    font-size: 11px;
    color: var(--text-muted);
  }
  .running-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
</style>
