<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getHealth, getStatus } from "../lib/api";

  let health: { status: string; uptime: number } | null = null;
  let status: { agents: Record<string, unknown>; queueDepth: number } | null = null;
  let error = "";
  let interval: ReturnType<typeof setInterval>;

  async function refresh() {
    try {
      [health, status] = await Promise.all([getHealth(), getStatus()]);
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Connection failed";
    }
  }

  onMount(() => {
    refresh();
    interval = setInterval(refresh, 5000);
  });

  onDestroy(() => clearInterval(interval));

  function formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
</script>

<div class="dashboard">
  <h1>Dashboard</h1>

  {#if error}
    <div class="error">{error}</div>
  {:else if health}
    <div class="stats">
      <div class="stat">
        <span class="label">Status</span>
        <span class="value {health.status === 'ok' ? 'green' : 'red'}">{health.status}</span>
      </div>
      <div class="stat">
        <span class="label">Uptime</span>
        <span class="value">{formatUptime(health.uptime)}</span>
      </div>
      {#if status}
        <div class="stat">
          <span class="label">Connected Agents</span>
          <span class="value">{Object.keys(status.agents).length}</span>
        </div>
        <div class="stat">
          <span class="label">Queue Depth</span>
          <span class="value">{status.queueDepth}</span>
        </div>
      {/if}
    </div>
  {:else}
    <p>Connecting to agent...</p>
  {/if}
</div>

<style>
  .dashboard { padding: 1.5rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
  .stat { background: var(--bg-card, #1a1a2e); padding: 1.2rem; border-radius: 8px; }
  .label { display: block; font-size: 0.85rem; opacity: 0.7; margin-bottom: 0.3rem; }
  .value { font-size: 1.6rem; font-weight: 600; }
  .green { color: #4ade80; }
  .red { color: #f87171; }
  .error { background: #7f1d1d; color: #fca5a5; padding: 1rem; border-radius: 8px; }
</style>
