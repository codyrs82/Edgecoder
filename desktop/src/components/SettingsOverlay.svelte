<script lang="ts">
  import { ArrowLeft } from "@lucide/svelte"; // #23: Lucide replaces inline SVGs gradually
  import Account from "../pages/Account.svelte";
  import Integrations from "../pages/Integrations.svelte";
  import ActiveWork from "../pages/ActiveWork.svelte";
  import Dashboard from "../pages/Dashboard.svelte";
  import MeshTopology from "../pages/MeshTopology.svelte";
  import ModelManager from "../pages/ModelManager.svelte";
  import Credits from "../pages/Credits.svelte";
  import TaskQueue from "../pages/TaskQueue.svelte";
  import Settings from "../pages/Settings.svelte";
  import LogViewer from "../pages/LogViewer.svelte";
  import type { AuthUser } from "../lib/api";
  import { focusTrap, rovingIndex } from "../lib/focus-trap";

  interface Props {
    onClose: () => void;
    user: AuthUser;
    onLogout: () => void;
  }
  let { onClose, user, onLogout }: Props = $props();

  const sections = [
    { id: "account", label: "Account", component: Account },
    { id: "integrations", label: "Integrations", component: Integrations },
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
  let tabButtons: HTMLButtonElement[] = $state([]);

  // #26: arrow keys / Home / End move between sections (WAI-ARIA tabs, automatic activation).
  function onNavKeydown(e: KeyboardEvent, index: number) {
    const next = rovingIndex(e.key, index, sections.length);
    if (next === null) return;
    e.preventDefault();
    activeSectionId = sections[next].id;
    tabButtons[next]?.focus();
  }
  let ActiveSection = $derived(
    sections.find((s) => s.id === activeSectionId)?.component ?? Account
  );
</script>

<div
  class="overlay"
  role="dialog"
  aria-modal="true"
  aria-labelledby="settings-title"
  tabindex="-1"
  use:focusTrap={{ onEscape: onClose, initialFocus: () => tabButtons[sections.findIndex((s) => s.id === activeSectionId)] }}
>
  <div class="overlay-header">
    <button class="back-btn" onclick={onClose}>
      <ArrowLeft size={16} strokeWidth={2} />
      Back
    </button>
    <h2 id="settings-title">Settings</h2>
  </div>
  <div class="overlay-body">
    <nav class="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
      {#each sections as section, i}
        <button
          bind:this={tabButtons[i]}
          class="nav-item {activeSectionId === section.id ? 'active' : ''}"
          role="tab"
          id="settings-tab-{section.id}"
          aria-selected={activeSectionId === section.id}
          aria-controls="settings-panel"
          tabindex={activeSectionId === section.id ? 0 : -1}
          onclick={() => activeSectionId = section.id}
          onkeydown={(e) => onNavKeydown(e, i)}
        >
          {section.label}
        </button>
      {/each}
    </nav>
    <div class="settings-content" role="tabpanel" id="settings-panel" aria-labelledby="settings-tab-{activeSectionId}" tabindex="0">
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
  .nav-item:focus-visible,
  .back-btn:focus-visible,
  .settings-content:focus-visible {
    outline: 2px solid var(--accent, #3b82f6);
    outline-offset: -2px;
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
