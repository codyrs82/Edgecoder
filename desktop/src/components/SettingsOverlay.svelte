<script lang="ts">
  import { ArrowLeft, Search, Compass, Settings2, UserRound, BarChart3, Cpu, Plug, Boxes, Github, Network, LayoutDashboard, Activity, ListChecks, Wallet, ScrollText } from "@lucide/svelte";
  import "../styles/settings-page.css";
  import Account from "../pages/Account.svelte";
  import Integrations from "../pages/Integrations.svelte";
  import ActiveWork from "../pages/ActiveWork.svelte";
  import Dashboard from "../pages/Dashboard.svelte";
  import MeshTopology from "../pages/MeshTopology.svelte";
  import ModelManager from "../pages/ModelManager.svelte";
  import PlanUsage from "../pages/PlanUsage.svelte";
  import Usage from "../pages/Usage.svelte";
  import ComputeMarket from "../pages/ComputeMarket.svelte";
  import Connections from "../pages/Connections.svelte";
  import TaskQueue from "../pages/TaskQueue.svelte";
  import Settings from "../pages/Settings.svelte";
  import GettingStarted from "../pages/GettingStarted.svelte";
  import LogViewer from "../pages/LogViewer.svelte";
  import ProfileMenu from "./ProfileMenu.svelte";
  import type { AuthUser } from "../lib/api";
  import { Tabs } from "bits-ui";
  import Dialog from "./ui/Dialog.svelte";
  import { untrack } from "svelte";

  interface Props {
    onClose: () => void;
    user: AuthUser;
    onLogout: () => void;
    /** Section to open on (profile, plan, compute, connect, ...); General when unset. */
    initialSection?: string;
    onUserChange?: (user: AuthUser) => void;
    /** Opens the Getting started guide (Settings closes first). */
    onOpenGuide?: () => void;
  }
  let { onClose, user, onLogout, initialSection, onUserChange, onOpenGuide }: Props = $props();

  // Grouped like Cursor's settings; keywords make the search find a section by what's in it.
  const sections = [
    { id: "general", label: "General", icon: Settings2, group: 0, keywords: "preferences theme appearance editor network bluetooth ble mesh startup legal terms privacy acceptable use host agreement" },
    { id: "profile", label: "Profile", icon: UserRound, group: 0, keywords: "account name email sign out" },
    { id: "plan", label: "Wallet", icon: Wallet, group: 1, keywords: "csats buy add funds top up balance lightning invoice billing activity sats earnings withdraw payout" },
    { id: "usage", label: "Usage", icon: BarChart3, group: 1, keywords: "spend cost tokens budget requests history csv export chart" },
    { id: "compute", label: "Compute", icon: Cpu, group: 1, keywords: "reserve gpu cpu apple machines prices market" },
    { id: "connect", label: "Connect your tools", icon: Plug, group: 1, keywords: "claude code cursor continue cline aider zed api key port connection openai anthropic" },
    { id: "models", label: "Models", icon: Boxes, group: 2, keywords: "ollama install download" },
    { id: "integrations", label: "Integrations", icon: Github, group: 2, keywords: "github git" },
    { id: "mesh", label: "Network", icon: Network, group: 3, keywords: "mesh peers coordinator machines topology" },
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, group: 3, keywords: "status cpu memory disk ollama" },
    { id: "active-work", label: "Active work", icon: Activity, group: 3, keywords: "queue agents jobs" },
    { id: "tasks", label: "Tasks", icon: ListChecks, group: 3, keywords: "task queue" },
    { id: "logs", label: "Logs", icon: ScrollText, group: 4, keywords: "debug log" },
    { id: "getting-started", label: "Getting started", icon: Compass, group: 5, keywords: "guide welcome setup onboarding tutorial start wizard" },
  ] as const;

  const LEGACY: Record<string, string> = { account: "profile", preferences: "general", wallet: "plan" };
  // The section to open on is read once, when the window opens.
  const startAt = untrack(() => LEGACY[initialSection ?? ""] ?? initialSection);
  let activeSectionId = $state<string>(sections.some((s) => s.id === startAt) ? startAt! : "general");
  let query = $state("");
  // Every key starts as null: binding `undefined` to bits-ui's `ref` (which has a default) throws.
  let tabButtons: Record<string, HTMLElement | null> = $state(Object.fromEntries(sections.map((s) => [s.id, null])));

  let visible = $derived(
    query.trim()
      ? sections.filter((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(query.trim().toLowerCase()))
      : sections,
  );

  function openGuide() {
    onClose();
    onOpenGuide?.();
  }

  function go(id?: string) {
    if (id === "guide") return openGuide();
    activeSectionId = id && sections.some((s) => s.id === id) ? id : LEGACY[id ?? ""] ?? "general";
  }
</script>

<!-- #24/#26: a full-window bits-ui Dialog (focus trap, Escape, focus return) holding vertical
     bits-ui Tabs (arrow keys, Home/End, automatic activation). Only the open section is rendered,
     so one Tabs.Content follows the active value. -->
<Dialog variant="full" label="Settings" {onClose} initialFocus={() => tabButtons[activeSectionId]}>
  <Tabs.Root orientation="vertical" bind:value={activeSectionId}>
    {#snippet child({ props })}
      <div {...props} class="overlay">
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
          <Tabs.List aria-label="Settings sections">
            {#snippet child({ props })}
              <div {...props} class="settings-nav">
                {#each visible as section, i (section.id)}
                  {#if i > 0 && visible[i - 1].group !== section.group}<div class="gap" role="presentation"></div>{/if}
                  <Tabs.Trigger value={section.id} id="settings-tab-{section.id}" bind:ref={tabButtons[section.id]}>
                    {#snippet child({ props })}
                      <button {...props} class="nav-item">
                        <section.icon size={16} strokeWidth={1.8} />
                        {section.label}
                      </button>
                    {/snippet}
                  </Tabs.Trigger>
                {/each}
              </div>
            {/snippet}
          </Tabs.List>
          {#if visible.length === 0}<p class="no-match" role="status">No settings match "{query}"</p>{/if}
          <ProfileMenu {user} onOpenSettings={(s) => go(s)} {onLogout} />
        </aside>
        <Tabs.Content value={activeSectionId} id="settings-panel">
          {#snippet child({ props })}
            <!-- Keyed, so a section opens at its top instead of at the last one's scroll offset. -->
            {#key activeSectionId}
              <div {...props} class="settings-content">
                {@render page()}
              </div>
            {/key}
          {/snippet}
        </Tabs.Content>
      </div>
    {/snippet}
  </Tabs.Root>
</Dialog>

{#snippet page()}
    {#if activeSectionId === "getting-started"}
      <GettingStarted onOpenGuide={openGuide} />
    {:else if activeSectionId === "profile"}
      <Account {user} {onLogout} {onUserChange} />
    {:else if activeSectionId === "plan"}
      <PlanUsage />
    {:else if activeSectionId === "usage"}
      <Usage />
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
    {:else if activeSectionId === "logs"}
      <LogViewer />
    {:else}
      <Settings />
    {/if}
{/snippet}

<style>
  .overlay {
    flex: 1;
    min-height: 0;
    background: var(--bg-base);
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
    height: var(--control-md);
    padding: 0 8px;
    border: none;
    background: none;
    color: var(--text-secondary);
    border-radius: var(--radius-md);
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
    height: var(--control-lg);
    padding: 0 10px;
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-md);
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
    height: 30px;
    padding: 0 10px;
    border: none;
    background: none;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-sm);
    border-radius: var(--radius-md);
  }
  .nav-item:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }
  .nav-item[data-state="active"] {
    color: var(--text-primary);
    background: var(--bg-surface);
  }
  .nav-item:focus-visible,
  .back-btn:focus-visible,
  .settings-content:focus-visible {
    outline: 2px solid var(--focus-ring);
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
  /* On macOS the window's traffic lights sit over the top of the section list. */
  :global(html[data-titlebar="overlay"]) .settings-side {
    padding-top: 30px;
  }
  /* Sections not yet built from styles/settings-page.css read at the same scale: a centred
     column, a 20 px title and quiet group titles (no shouting uppercase). */
  .settings-content > :global(:not(.sp)) {
    max-width: 1080px;
    margin: 0 auto;
    box-sizing: border-box;
  }
  .settings-content :global(h1) {
    font-size: var(--fs-xl);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .settings-content :global(h2:not(.peer-id)) {
    font-size: var(--fs-sm);
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
    color: var(--text-secondary);
  }
  /* #29: at the 640px minimum window the nav gives its width to the page. */
  @media (max-width: 760px) {
    .settings-side { width: 176px; }
    .back-btn { margin: 8px 6px 4px; }
    .search { margin: 4px 6px 8px; }
    .settings-nav { padding: 0 6px 8px; }
    .nav-item { gap: 8px; padding: 6px 8px; }
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
