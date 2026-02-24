<script lang="ts">
  import { getHealth, getMeshPeers } from "../lib/api";
  import StatusDot from "./StatusDot.svelte";

  let agentOk = $state(false);
  let ollamaOk = $state(false);
  let ollamaVersion = $state("");
  let peerCount = $state(0);

  async function poll() {
    try {
      const [health, mesh] = await Promise.all([getHealth(), getMeshPeers()]);
      agentOk = health.ok;
      ollamaOk = health.ollama.reachable;
      ollamaVersion = health.ollama.version ?? "";
      peerCount = mesh.peers.length;
    } catch {
      agentOk = false;
    }
  }

  $effect(() => {
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  });
</script>

<div class="connection-bar">
  <div class="bar-item">
    <StatusDot status={agentOk ? "online" : "offline"} label={agentOk ? "Agent" : "Agent Offline"} />
  </div>
  <div class="bar-item">
    <StatusDot status={ollamaOk ? "online" : "offline"} label={ollamaOk ? `Ollama ${ollamaVersion}` : "Ollama Offline"} />
  </div>
  <div class="bar-item">
    <span class="peer-badge">{peerCount} peer{peerCount !== 1 ? "s" : ""}</span>
  </div>
</div>

<style>
  .connection-bar { display: flex; align-items: center; gap: 1.5rem; padding: 0.4rem 1.5rem; background: var(--bg-sidebar, #111128); border-bottom: 1px solid var(--border, #1e1e3f); min-height: 36px; }
  .bar-item { display: flex; align-items: center; }
  .peer-badge { font-size: 0.8rem; color: var(--text-muted, #94a3b8); background: #1e1e3f; padding: 0.15rem 0.6rem; border-radius: 10px; }
</style>
