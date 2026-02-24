<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getMeshPeers } from "../lib/api";

  let peers: any[] = [];
  let error = "";
  let interval: ReturnType<typeof setInterval>;

  async function refresh() {
    try {
      const data = await getMeshPeers();
      peers = data.peers || [];
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load peers";
    }
  }

  onMount(() => {
    refresh();
    interval = setInterval(refresh, 10000);
  });

  onDestroy(() => clearInterval(interval));
</script>

<div class="mesh">
  <h1>Mesh Topology</h1>
  <p class="subtitle">{peers.length} peers connected globally</p>

  {#if error}
    <div class="error">{error}</div>
  {:else if peers.length === 0}
    <p>No peers discovered yet.</p>
  {:else}
    <div class="peer-grid">
      {#each peers as peer}
        <div class="peer-card">
          <div class="peer-id">{peer.agentId || peer.id || "unknown"}</div>
          <div class="peer-detail">Model: {peer.model || "—"}</div>
          <div class="peer-detail">Region: {peer.region || "—"}</div>
          <div class="peer-detail">Load: {peer.load ?? "—"}%</div>
          <div class="peer-status {peer.status === 'active' ? 'active' : 'idle'}">
            {peer.status || "unknown"}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .mesh { padding: 1.5rem; }
  .subtitle { opacity: 0.7; margin-bottom: 1rem; }
  .peer-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .peer-card { background: var(--bg-card, #1a1a2e); padding: 1rem; border-radius: 8px; }
  .peer-id { font-weight: 600; margin-bottom: 0.5rem; font-family: monospace; font-size: 0.9rem; }
  .peer-detail { font-size: 0.85rem; opacity: 0.8; margin-bottom: 0.2rem; }
  .peer-status { margin-top: 0.5rem; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; }
  .active { color: #4ade80; }
  .idle { color: #fbbf24; }
  .error { background: #7f1d1d; color: #fca5a5; padding: 1rem; border-radius: 8px; }
</style>
