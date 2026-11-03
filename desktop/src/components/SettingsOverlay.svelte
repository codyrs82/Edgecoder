<script lang="ts">
  import { ArrowLeft, Search, Settings2, UserRound, CreditCard, Cpu, Plug, Boxes, Github, Network, LayoutDashboard, Activity, ListChecks, Wallet, ScrollText } from "@lucide/svelte";
  import "../styles/settings-page.css";
  import Account from "../pages/Account.svelte";
  import Integrations from "../pages/Integrations.svelte";
  import ActiveWork from "../pages/ActiveWork.svelte";
  import Dashboard from "../pages/Dashboard.svelte";
  import MeshTopology from "../pages/MeshTopology.svelte";
  import ModelManager from "../pages/ModelManager.svelte";
  import Credits from "../pages/Credits.svelte";
  import PlanUsage from "../pages/PlanUsage.svelte";
  import ComputeMarket from "../pages/ComputeMarket.svelte";
  import Connections from "../pages/Connections.svelte";
  import TaskQueue from "../pages/TaskQueue.svelte";
  import Settings from "../pages/Settings.svelte";
  import LogViewer from "../pages/LogViewer.svelte";
  import ProfileMenu from "./ProfileMenu.svelte";
  import type { AuthUser } from "../lib/api";
  import { focusTrap } from "../lib/focus-trap";
  import { untrack } from "svelte";

  interface Props {
    onClose: () => void;
    user: AuthUser;
    onLogout: () => void;
    /** Section to open on (profile, plan, compute, connect, ...); General when unset. */
    initialSection?: string;
    onUserChange?: (user: AuthUser) => void;
  }
  let { onClose, user, onLogout, initialSection, onUserChange }: Props = $props();

  // Grouped like Cursor's settings; keywords make the search find a section by what's in it.
  const sections = [
    { id: "general", label: "General", icon: Settings2, group: 0, keywords: "preferences theme appearance editor network bluetooth ble mesh startup" },
    { id: "profile", label: "Profile", icon: UserRound, group: 0, keywords: "account name email sign out" },
    { id: "plan", label: "Plan & usage", icon: CreditCard, group: 1, keywords: "csats buy balance lightning invoice billing activity" },
    { id: "compute", label: "Compute", icon: Cpu, group: 1, keywords: "reserve gpu cpu apple machines prices market" },
    { id: "connect", label: "Connect your tools", icon: Plug, group: 1, keywords: "claude code cursor continue cline aider zed api key port connection openai anthropic" },
    { id: "models", label: "Models", icon: Boxes, group: 2, keywords: "ollama install download" },
    { id: "integrations", label: "Integrations", icon: Github, group: 2, keywords: "github git" },
    { id: "mesh", label: "Network", icon: Network, group: 3, keywords: "mesh peers coordinator machines topology" },
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, group: 3, keywords: "status cpu memory disk ollama" },
    { id: "active-work", label: "Active work", icon: Activity, group: 3, keywords: "queue agents jobs" },
    { id: "tasks", label: "Tasks", icon: ListChecks, group: 3, keywords: "task queue" },
    { id: "wallet", label: "Wallet", icon: Wallet, group: 3, keywords: "sats earnings withdraw seed" },
    { id: "logs", label: "Logs", icon: ScrollText, group: 4, keywords: "debug log" },
  ] as const;

  const LEGACY: Record<string, string> = { account: "profile", preferences: "general" };
  // The section to open on is read once, when the window opens.
  const startAt = untrack(() => LEGACY[initialSection ?? ""] ?? initialSection);
  let activeSectionId = $state<string>(sections.some((s) => s.id === startAt) ? startAt! : "general");
  let query = $state("");
  let tabButtons: Record<string, HTMLButtonElement> = $state({});

  let visible = $derived(
    query.trim()
      ? sections.filter((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(query.trim().toLowerCase()))
      : sections,
  );

  function go(id?: string) {
    activeSectionId = id && sections.some((s) => s.id === id) ? id : LEGACY[id ?? ""] ?? "general";
  }

  // #26: arrow keys / Home / End move between sections (WAI-ARIA tabs, automatic activation).
  function onNavKeydown(e: KeyboardEvent, id: string) {
    const ids: string[] = visible.map((s) => s.id);
    const i = ids.indexOf(id);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % ids.length;
    else if (e.key === "ArrowUp") next = (i - 1 + ids.length) % ids.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = ids.length - 1;
    if (next < 0) return;
    e.preventDefault();
    activeSectionId = ids[next];
    tabButtons[ids[next]]?.focus();
  }
</script>

<div
  class="overlay"
  role="dialog"
  aria-modal="true"
  aria-label="Settings"
  tabindex="-1"
  use:focusTrap={{ onEscape: onClose, initialFocus: () => tabButtons[activeSectionId] }}
>
  <aside class="settings-side">
    <button class="back-btn" onclick={onClose}>
      <ArrowLeft size={15} strokeWidth={2} />
      Back
    </button>
    <label class="search">
      <Search size={14} />
      <input type="text" placeholder="Search settings" aria-label="Search settings" bind:value={query}
        onkeydown={(e) => { if (e.key === "Enter" && visible[0]) activeSectionId = visible[0].id; }} />
    </label>
    <nav class="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
      {#each visible as section, i (section.id)}
        {#if i > 0 && visible[i - 1].group !== section.group}<div class="gap"></div>{/if}
        <button
          bind:this={tabButtons[section.id]}
          class="nav-item"
          class:active={activeSectionId === section.id}
          role="tab"
          id="settings-tab-{section.id}"
          aria-selected={activeSectionId === section.id}
          aria-controls="settings-panel"
          tabindex={activeSectionId === section.id ? 0 : -1}
          onclick={() => (activeSectionId = section.id)}
          onkeydown={(e) => onNavKeydown(e, section.id)}
        >
          <section.icon size={16} strokeWidth={1.8} />
          {section.label}
        </button>
      {/each}
      {#if visible.length === 0}<p class="no-match">No settings match "{query}"</p>{/if}
    </nav>
    <ProfileMenu {user} onOpenSettings={(s) => go(s)} {onLogout} />
  </aside>
  <div class="settings-content" role="tabpanel" id="settings-panel" aria-labelledby="settings-tab-{activeSectionId}" tabindex="0">
    {#if activeSectionId === "profile"}
      <Account {user} {onLogout} {onUserChange} />
    {:else if activeSectionId === "plan"}
      <PlanUsage />
    {:else if activeSectionId === "compute"}
      <ComputeMarket onNavigate={go} />
    {:else if activeSectionId === "connect"}
      <Connections onNavigate={go} />
    {:else if activeSectionId === "models"}
      <ModelManager />
    {:else if activeSectionId === "integrations"}
      <Integrations />
    {:else if activeSectionId === "mesh"}
      <MeshTopology />
    {:else if activeSectionId === "dashboard"}
      <Dashboard />
    {:else if activeSectionId === "active-work"}
      <ActiveWork />
    {:else if activeSectionId === "tasks"}
      <TaskQueue />
    {:else if activeSectionId === "wallet"}
      <Credits />
    {:else if activeSectionId === "logs"}
      <LogViewer />
    {:else}
      <Settings />
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-base);
    z-index: 100;
    display: flex;
    animation: fadeIn 0.15s ease;
  }
  .settings-side {
    width: 250px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 0.5px solid var(--border);
    background: color-mix(in srgb, var(--bg-surface) 45%, var(--bg-base));
  }
  .back-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 10px 6px;
    padding: 6px 8px;
    border: none;
    background: none;
    color: var(--text-secondary);
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
  }
  .back-btn:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 10px 10px;
    padding: 7px 10px;
    border: 0.5px solid var(--border);
    border-radius: 9px;
    background: var(--bg-base);
    color: var(--text-secondary);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
  }
  .settings-nav {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 10px 10px;
  }
  .gap {
    height: 12px;
    flex-shrink: 0;
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border: none;
    background: none;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    font-size: 13px;
    border-radius: 8px;
  }
  .nav-item:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }
  .nav-item.active {
    color: var(--text-primary);
    background: var(--bg-surface);
  }
  .nav-item:focus-visible,
  .back-btn:focus-visible,
  .settings-content:focus-visible {
    outline: 2px solid var(--accent, #3b82f6);
    outline-offset: -2px;
  }
  .no-match {
    padding: 8px 10px;
    color: var(--text-secondary);
    font-size: 12.5px;
  }
  .settings-content {
    flex: 1;
    overflow-y: auto;
    min-width: 0;
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
