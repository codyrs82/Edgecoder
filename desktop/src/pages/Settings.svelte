<script lang="ts">
  let meshToken = "";
  let maxConcurrentTasks = 1;
  let idleOnly = true;
  let cpuCapPercent = 50;
  let bleEnabled = false;

  function save() {
    // Future: POST to agent config endpoint
    alert("Settings saved (local only — agent config endpoint coming soon)");
  }
</script>

<div class="settings">
  <h1>Settings</h1>

  <div class="section">
    <h2>Mesh Configuration</h2>
    <label>
      <span>Mesh Token</span>
      <input type="password" bind:value={meshToken} placeholder="Paste mesh token..." />
    </label>
  </div>

  <div class="section">
    <h2>Power Policy</h2>
    <label>
      <span>Max Concurrent Tasks</span>
      <input type="number" bind:value={maxConcurrentTasks} min="1" max="10" />
    </label>
    <label>
      <span>CPU Cap (%)</span>
      <input type="range" bind:value={cpuCapPercent} min="10" max="100" />
      <span>{cpuCapPercent}%</span>
    </label>
    <label class="toggle">
      <input type="checkbox" bind:checked={idleOnly} />
      <span>Only run tasks when idle</span>
    </label>
  </div>

  <div class="section">
    <h2>Local Mesh</h2>
    <label class="toggle">
      <input type="checkbox" bind:checked={bleEnabled} />
      <span>Enable BLE peer discovery (macOS)</span>
    </label>
  </div>

  <button on:click={save}>Save Settings</button>
</div>

<style>
  .settings { padding: 1.5rem; max-width: 600px; }
  .section { background: var(--bg-card, #1a1a2e); padding: 1.2rem; border-radius: 8px; margin-bottom: 1.5rem; }
  .section h2 { font-size: 1rem; margin-bottom: 1rem; opacity: 0.9; }
  label { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; }
  label span { min-width: 160px; font-size: 0.9rem; }
  input[type="text"], input[type="password"], input[type="number"] {
    flex: 1; padding: 0.4rem; background: #0d0d1a; border: 1px solid #333; border-radius: 4px; color: inherit;
  }
  .toggle { cursor: pointer; }
  button { padding: 0.6rem 1.5rem; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
</style>
