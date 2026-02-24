<script lang="ts">
  import Dashboard from "./pages/Dashboard.svelte";
  import MeshTopology from "./pages/MeshTopology.svelte";
  import ModelManager from "./pages/ModelManager.svelte";
  import Credits from "./pages/Credits.svelte";
  import TaskQueue from "./pages/TaskQueue.svelte";
  import Settings from "./pages/Settings.svelte";
  import LogViewer from "./pages/LogViewer.svelte";
  import ConnectionBar from "./components/ConnectionBar.svelte";

  const pages = [
    { id: "dashboard", label: "Dashboard", icon: "\u25A3" },
    { id: "mesh", label: "Mesh Topology", icon: "\u2B21" },
    { id: "models", label: "Model Manager", icon: "\u2699" },
    { id: "credits", label: "Credits & Wallet", icon: "\u26C1" },
    { id: "tasks", label: "Task Queue", icon: "\u2630" },
    { id: "logs", label: "Activity Log", icon: "\u2261" },
    { id: "settings", label: "Settings", icon: "\u2318" },
  ] as const;

  const components: Record<string, typeof Dashboard> = {
    dashboard: Dashboard,
    mesh: MeshTopology,
    models: ModelManager,
    credits: Credits,
    tasks: TaskQueue,
    logs: LogViewer,
    settings: Settings,
  };

  let activePageId = $state("dashboard");
  let ActiveComponent = $derived(components[activePageId] ?? Dashboard);
</script>

<div class="app">
  <nav class="sidebar">
    <div class="logo">EdgeCoder</div>
    {#each pages as page}
      <button
        class="nav-item {activePageId === page.id ? 'active' : ''}"
        onclick={() => (activePageId = page.id)}
      >
        <span class="nav-icon">{page.icon}</span>
        <span class="nav-label">{page.label}</span>
      </button>
    {/each}
  </nav>
  <main class="content">
    <ConnectionBar />
    <div class="page-content">
      <ActiveComponent />
    </div>
  </main>
</div>

<style>
  :root {
    --bg-base: #0d0d1a;
    --bg-card: #1a1a2e;
    --bg-sidebar: #111128;
    --border: #1e1e3f;
    --accent: #3b82f6;
    --text: #e2e8f0;
    --text-muted: #94a3b8;
    --green: #4ade80;
    --red: #f87171;
    --yellow: #fbbf24;
  }
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg-base);
    color: var(--text);
  }
  .app { display: flex; height: 100vh; }
  .sidebar {
    width: 220px; background: var(--bg-sidebar); display: flex; flex-direction: column;
    padding: 1rem 0; border-right: 1px solid var(--border); flex-shrink: 0;
  }
  .logo { font-weight: 700; font-size: 1.2rem; padding: 0 1rem 1rem; border-bottom: 1px solid var(--border); margin-bottom: 0.5rem; }
  .nav-item {
    background: none; border: none; color: var(--text-muted); text-align: left;
    padding: 0.65rem 1rem; cursor: pointer; font-size: 0.9rem; transition: all 0.15s;
    display: flex; align-items: center; gap: 0.6rem;
  }
  .nav-item:hover { background: #1a1a3e; color: var(--text); }
  .nav-item.active { background: #1e1e4f; color: var(--accent); font-weight: 600; border-left: 3px solid var(--accent); }
  .nav-icon { font-size: 1rem; width: 1.2rem; text-align: center; }
  .content { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
  .page-content { flex: 1; overflow-y: auto; animation: fadeIn 0.15s ease; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  @media (max-width: 768px) {
    .sidebar { width: 60px; }
    .nav-label { display: none; }
    .logo { font-size: 0; padding: 0.5rem; text-align: center; }
    .logo::after { content: "EC"; font-size: 1rem; font-weight: 700; }
    .nav-item { justify-content: center; padding: 0.65rem 0; }
    .nav-icon { width: auto; font-size: 1.2rem; }
  }
</style>
