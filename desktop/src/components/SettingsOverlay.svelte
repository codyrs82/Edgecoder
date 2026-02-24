<script lang="ts">
  import Account from "../pages/Account.svelte";
  import ActiveWork from "../pages/ActiveWork.svelte";
  import Dashboard from "../pages/Dashboard.svelte";
  import MeshTopology from "../pages/MeshTopology.svelte";
  import ModelManager from "../pages/ModelManager.svelte";
  import Credits from "../pages/Credits.svelte";
  import TaskQueue from "../pages/TaskQueue.svelte";
  import Settings from "../pages/Settings.svelte";
  import LogViewer from "../pages/LogViewer.svelte";
  import type { AuthUser } from "../lib/api";

  interface Props {
    onClose: () => void;
    user: AuthUser;
    onLogout: () => void;
  }
  let { onClose, user, onLogout }: Props = $props();

  const sections = [
    { id: "account", label: "Account", component: Account },
    { id: "active-work", label: "Active Work", component: ActiveWork },
    { id: "dashboard", label: "Dashboard", component: Dashboard },
    { id: "mesh", label: "Mesh", component: MeshTopology },
    { id: "models", label: "Models", component: ModelManager },
    { id: "tasks", label: "Tasks", component: TaskQueue },
    { id: "wallet", label: "Wallet", component: Credits },
    { id: "logs", label: "Logs", component: LogViewer },
    { id: "preferences", label: "Preferences", component: Settings },
  ] as const;

  let activeSectionId = $state("account");
  let ActiveSection = $derived(
    sections.find((s) => s.id === activeSectionId)?.component ?? Account
  );
</script>

<div class="overlay">
  <div class="overlay-header">
    <button class="back-btn" onclick={onClose}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 12H5M12 19l-7-7 7-7"/>
      </svg>
      Back
    </button>
    <h2>Settings</h2>
  </div>
  <div class="overlay-body">
    <nav class="settings-nav">
      {#each sections as section}
        <button
          class="nav-item {activeSectionId === section.id ? 'active' : ''}"
          onclick={() => activeSectionId = section.id}
        >
          {section.label}
        </button>
      {/each}
    </nav>
    <div class="settings-content">
      {#if activeSectionId === "account"}
        <Account {user} {onLogout} />
      {:else}
        <ActiveSection />
      {/if}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-base);
    z-index: 100;
    display: flex;
    flex-direction: column;
    animation: slideUp 0.2s ease;
  }
  .overlay-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 0.5px solid var(--border);
    flex-shrink: 0;
  }
  .overlay-header h2 {
    margin: 0;
    font-size: 1rem;
  }
  .back-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    background: var(--bg-surface);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 13px;
    transition: color 0.15s;
  }
  .back-btn:hover {
    color: var(--text-primary);
  }
  .overlay-body {
    flex: 1;
    display: flex;
    overflow: hidden;
  }
  .settings-nav {
    width: 180px;
    border-right: 0.5px solid var(--border);
    padding: 12px 0;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    overflow-y: auto;
  }
  .nav-item {
    padding: 8px 20px;
    border: none;
    background: none;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.15s;
  }
  .nav-item:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }
  .nav-item.active {
    color: var(--text-primary);
    background: var(--bg-surface);
    font-weight: 600;
    border-left: 2px solid var(--accent);
  }
  .settings-content {
    flex: 1;
    overflow-y: auto;
  }
  @keyframes slideUp {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
</style>
