<script lang="ts">
  import Dashboard from "./pages/Dashboard.svelte";
  import MeshTopology from "./pages/MeshTopology.svelte";
  import ModelManager from "./pages/ModelManager.svelte";
  import Credits from "./pages/Credits.svelte";
  import TaskQueue from "./pages/TaskQueue.svelte";
  import Settings from "./pages/Settings.svelte";

  const pages = [
    { id: "dashboard", label: "Dashboard", component: Dashboard },
    { id: "mesh", label: "Mesh Topology", component: MeshTopology },
    { id: "models", label: "Model Manager", component: ModelManager },
    { id: "credits", label: "Credits & Wallet", component: Credits },
    { id: "tasks", label: "Task Queue", component: TaskQueue },
    { id: "settings", label: "Settings", component: Settings },
  ] as const;

  let activePageId = "dashboard";

  $: activePage = pages.find((p) => p.id === activePageId) ?? pages[0];
</script>

<div class="app">
  <nav class="sidebar">
    <div class="logo">EdgeCoder</div>
    {#each pages as page}
      <button
        class="nav-item {activePageId === page.id ? 'active' : ''}"
        on:click={() => (activePageId = page.id)}
      >
        {page.label}
      </button>
    {/each}
  </nav>
  <main class="content">
    <svelte:component this={activePage.component} />
  </main>
</div>

<style>
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d0d1a;
    color: #e2e8f0;
  }
  .app { display: flex; height: 100vh; }
  .sidebar {
    width: 220px; background: #111128; display: flex; flex-direction: column;
    padding: 1rem 0; border-right: 1px solid #1e1e3f;
  }
  .logo { font-weight: 700; font-size: 1.2rem; padding: 0 1rem 1rem; border-bottom: 1px solid #1e1e3f; margin-bottom: 0.5rem; }
  .nav-item {
    background: none; border: none; color: #94a3b8; text-align: left;
    padding: 0.65rem 1rem; cursor: pointer; font-size: 0.9rem; transition: all 0.15s;
  }
  .nav-item:hover { background: #1a1a3e; color: #e2e8f0; }
  .nav-item.active { background: #1e1e4f; color: #60a5fa; font-weight: 600; border-left: 3px solid #3b82f6; }
  .content { flex: 1; overflow-y: auto; }
</style>
