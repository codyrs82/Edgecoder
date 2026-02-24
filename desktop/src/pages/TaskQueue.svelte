<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getStatus } from "../lib/api";

  let tasks: any[] = [];
  let error = "";
  let interval: ReturnType<typeof setInterval>;

  async function refresh() {
    try {
      const data = await getStatus();
      tasks = data.agents ? Object.entries(data.agents).map(([id, info]) => ({ id, ...info as object })) : [];
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load tasks";
    }
  }

  onMount(() => {
    refresh();
    interval = setInterval(refresh, 5000);
  });

  onDestroy(() => clearInterval(interval));
</script>

<div class="task-queue">
  <h1>Task Queue</h1>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if tasks.length === 0}
    <p>No active tasks.</p>
  {:else}
    <div class="task-list">
      {#each tasks as task}
        <div class="task-card">
          <div class="task-id">{task.id}</div>
          <div class="task-detail">Status: {task.status || "—"}</div>
          <div class="task-detail">Kind: {task.kind || "—"}</div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .task-queue { padding: 1.5rem; }
  .task-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .task-card { background: var(--bg-card, #1a1a2e); padding: 1rem; border-radius: 8px; }
  .task-id { font-family: monospace; font-weight: 600; margin-bottom: 0.3rem; }
  .task-detail { font-size: 0.85rem; opacity: 0.8; }
  .error { background: #7f1d1d; color: #fca5a5; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
</style>
