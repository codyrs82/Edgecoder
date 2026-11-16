<script lang="ts">
  // This machine's memory guard (the agent's src/swarm/memory-manager.ts): "Paused: this Mac is low
  // on memory" while it takes no network work, and (showServing) the models it serves on the network.
  import { computeOverview, isRemoteMode, type MemoryOverview } from "../lib/api";
  import { budgetLine, localOnlyLine, memoryPausedDetail, memoryPausedTitle, servingLine } from "../lib/memory-status";

  let { showServing = false, memory: given }: { showServing?: boolean; memory?: MemoryOverview } = $props();
  let fetched = $state<MemoryOverview | undefined>(undefined);
  let memory = $derived(given ?? fetched);
  let title = $derived(memoryPausedTitle(memory));

  $effect(() => {
    if (given || isRemoteMode()) return;
    let stop = false;
    const load = () =>
      computeOverview()
        .then((o) => {
          if (!stop) fetched = o.memory;
        })
        .catch(() => undefined);
    load();
    const t = setInterval(load, 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  });
</script>

{#if memory}
  {#if title}
    <div class="sp-card memory-paused" class:critical={memory.pressure === "critical"} role="status" data-testid="memory-paused">
      <span class="sp-title">{title}</span>
      <span class="sp-desc">{memoryPausedDetail(memory)}</span>
    </div>
  {/if}
  {#if showServing}
    <div class="memory-serving" data-testid="memory-serving">
      <span class="serving">{servingLine(memory)}</span>
      <span class="sp-desc">{budgetLine(memory)}</span>
      {#if localOnlyLine(memory)}<span class="sp-desc">{localOnlyLine(memory)}</span>{/if}
    </div>
  {/if}
{/if}

<style>
  .memory-paused { display: flex; flex-direction: column; gap: 4px; border-left: 3px solid var(--yellow); margin-bottom: 12px; }
  .memory-paused.critical { border-left-color: var(--danger); }
  .memory-serving { display: flex; flex-direction: column; gap: 2px; margin: 0 0 12px; }
  .serving { font-weight: 600; }
</style>
