<script lang="ts">
  import {
    listConversationsBySource,
    deleteConversation,
    renameConversation,
  } from "../lib/chat-store";
  import {
    portalDeleteConversation,
    portalRenameConversation,
  } from "../lib/api";
  import type { Conversation } from "../lib/types";
  import type { AuthUser } from "../lib/api";
  import { SquarePen, Search, Cpu, Plug, Laptop, Server, Cloud, Plus } from "@lucide/svelte";
  import { bots } from "../lib/bots-store";
  import { botInitial, botStatusLine } from "../lib/bots";
  import { parseChoice } from "../lib/compute-choice";
  import ProfileMenu from "./ProfileMenu.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
    onSelectConversation: (id: string) => void;
    onNewChat: () => void;
    activeConversationId: string | null;
    /** Render as inline panel instead of fixed overlay */
    inline?: boolean;
    /** Signed-in user: shows the profile row and its menu at the bottom. */
    user?: AuthUser;
    onOpenSettings?: (section?: string) => void;
    onLogout?: () => void;
    /** Persistent bots: shown in their own section when these are set. */
    onSelectBot?: (id: string) => void;
    onNewBot?: () => void;
    activeBotId?: string | null;
  }

  let { open, onClose, onSelectConversation, onNewChat, activeConversationId, inline = false, user, onOpenSettings, onLogout, onSelectBot, onNewBot, activeBotId = null }: Props = $props();

  let searchOpen = $state(false);
  let searchEl: HTMLInputElement | undefined = $state();

  /** Today / Yesterday / Previous 7 days / Older, newest first. */
  let groups = $derived.by(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const t0 = startOfToday.getTime();
    const day = 86_400_000;
    const out: Array<{ label: string; items: Conversation[] }> = [
      { label: "Today", items: [] },
      { label: "Yesterday", items: [] },
      { label: "Previous 7 days", items: [] },
      { label: "Older", items: [] },
    ];
    for (const c of filtered) {
      const at = new Date(c.updatedAt).getTime();
      out[at >= t0 ? 0 : at >= t0 - day ? 1 : at >= t0 - 7 * day ? 2 : 3].items.push(c);
    }
    return out.filter((g) => g.items.length);
  });

  function ranOnText(c: Conversation): string {
    const w = parseChoice(c.selectedModel).where;
    return w === "mine" ? "Ran on your machines" : w === "anywhere" ? "Auto: cheapest place for each request" : w === "network" || w === "reserved" ? "Ran on network compute" : "Ran on this computer";
  }

  function toggleSearch() {
    searchOpen = !searchOpen;
    if (searchOpen) queueMicrotask(() => searchEl?.focus());
    else searchQuery = "";
  }

  let conversations: Conversation[] = $state([]);
  let searchQuery = $state("");
  let loading = $state(false);
  let menuOpenId: string | null = $state(null);
  let renamingId: string | null = $state(null);
  let renameValue = $state("");
  let confirmDeleteId: string | null = $state(null);

  let filtered = $derived.by(() => {
    if (!searchQuery.trim()) return conversations;
    const q = searchQuery.toLowerCase();
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some((m) => m.content.toLowerCase().includes(q)),
    );
  });

  $effect(() => {
    if (open) {
      loadConversations();
    } else {
      // Reset state when closing
      searchQuery = "";
      menuOpenId = null;
      renamingId = null;
      confirmDeleteId = null;
    }
  });

  async function loadConversations() {
    loading = true;
    try {
      conversations = await listConversationsBySource("chat");
    } catch {
      conversations = [];
    } finally {
      loading = false;
    }
  }

  function formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days}d ago`;
    const date = new Date(timestamp);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }


  function handleSelect(id: string) {
    if (renamingId) return;
    onSelectConversation(id);
    if (!inline) onClose();
  }

  async function handleDelete(id: string) {
    // First click: show confirmation (keep menu open)
    if (confirmDeleteId !== id) {
      confirmDeleteId = id;
      return;
    }
    // Second click: actually delete
    confirmDeleteId = null;
    menuOpenId = null;
    const convo = conversations.find((c) => c.id === id);
    // Delete from portal if synced
    if (convo?.portalConversationId) {
      portalDeleteConversation(convo.portalConversationId).catch(() => {});
    }
    await deleteConversation(id);
    conversations = conversations.filter((c) => c.id !== id);
  }

  function startRename(convo: Conversation) {
    menuOpenId = null;
    renamingId = convo.id;
    renameValue = convo.title;
  }

  async function commitRename() {
    if (renamingId && renameValue.trim()) {
      const trimmed = renameValue.trim();
      await renameConversation(renamingId, trimmed);
      const idx = conversations.findIndex((c) => c.id === renamingId);
      if (idx !== -1) {
        // Also rename on portal if synced
        if (conversations[idx].portalConversationId) {
          portalRenameConversation(
            conversations[idx].portalConversationId!,
            trimmed,
          ).catch(() => {});
        }
        conversations[idx].title = trimmed;
        conversations[idx].updatedAt = Date.now();
      }
    }
    renamingId = null;
    renameValue = "";
  }

  function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      renamingId = null;
      renameValue = "";
    }
  }

  function handleBackdropClick() {
    if (menuOpenId) {
      menuOpenId = null;
    } else {
      onClose();
    }
  }

  function handleNewChat() {
    onNewChat();
    if (!inline) onClose();
  }

  // #25: keyboard access. Enter/Space opens a conversation; Escape closes the open menu,
  // then the drawer.
  function handleItemKeydown(e: KeyboardEvent, id: string) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleSelect(id);
    }
  }

  function handleSidebarKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || renamingId) return;
    if (menuOpenId) {
      menuOpenId = null;
      e.stopPropagation();
    } else if (!inline && open) {
      onClose?.();
    }
  }

  function toggleMenu(e: MouseEvent, id: string) {
    e.stopPropagation();
    confirmDeleteId = null;
    menuOpenId = menuOpenId === id ? null : id;
  }
</script>

{#if !inline && open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={handleBackdropClick}></div>
{/if}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="sidebar" class:open class:inline onkeydown={handleSidebarKeydown}>
  {#if !inline}
    <div class="sidebar-header">
      <h2 class="sidebar-title">History</h2>
      <button class="close-btn" type="button" onclick={onClose} title="Close" aria-label="Close history">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
    </div>
  {/if}

  <nav class="side-nav" aria-label="Chat">
    <button class="nav-row primary" onclick={handleNewChat}><SquarePen size={16} /> New chat</button>
    <button class="nav-row" onclick={toggleSearch} aria-expanded={searchOpen}><Search size={16} /> Search</button>
    {#if onOpenSettings}
      <button class="nav-row" onclick={() => onOpenSettings?.("compute")}><Cpu size={16} /> Compute</button>
      <button class="nav-row" onclick={() => onOpenSettings?.("connect")}><Plug size={16} /> Connect your tools</button>
    {/if}
  </nav>

  {#if onSelectBot}
    <div class="bots-section" aria-label="Bots">
      <div class="group-label bots-label">
        <span>Bots</span>
        {#if onNewBot}<button class="bots-add" type="button" title="New bot" aria-label="New bot" onclick={onNewBot}><Plus size={13} /></button>{/if}
      </div>
      {#if $bots.length === 0}
        {#if onNewBot}<button class="bot-row empty-bot" type="button" onclick={onNewBot}>Create a bot that owns a job</button>{/if}
      {:else}
        {#each $bots as bot (bot.id)}
          <button
            class="bot-row"
            type="button"
            class:active={bot.id === activeBotId}
            aria-current={bot.id === activeBotId ? "true" : undefined}
            onclick={() => { onSelectBot?.(bot.id); if (!inline) onClose(); }}
            title="{bot.name}{bot.role ? ` · ${bot.role}` : ''}: {botStatusLine(bot)}"
          >
            <span class="bot-avatar" style="background: {bot.color}">{botInitial(bot.name)}
              {#if bot.status === "running" || bot.status === "needs_approval"}<span class="bot-dot" class:warn={bot.status === "needs_approval"}></span>{/if}
            </span>
            <span class="bot-text">
              <span class="bot-name">{bot.name}{#if bot.role}<span class="bot-role"> · {bot.role}</span>{/if}</span>
              <span class="bot-status" class:warn={bot.status === "needs_approval" || bot.status === "over_budget"} class:err={bot.status === "error"}>{botStatusLine(bot)}</span>
            </span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}

  {#if searchOpen || !inline}
  <div class="search-wrapper">
    <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
    <input
      class="search-input"
      type="text"
      placeholder="Search conversations..."
      aria-label="Search conversations"
      bind:this={searchEl}
      bind:value={searchQuery}
      onkeydown={(e) => { if (e.key === "Escape") toggleSearch(); }}
    />
  </div>
  {/if}

  <div class="conversation-list">
    {#if loading}
      <div class="empty-state">Loading...</div>
    {:else if filtered.length === 0}
      <div class="empty-state">
        {#if searchQuery}
          No conversations match "{searchQuery}"
        {:else}
          No conversations yet. Start a new chat!
        {/if}
      </div>
    {:else}
      {#each groups as group (group.label)}
      <div class="group-label">{group.label}</div>
      {#each group.items as convo (convo.id)}
        <div
          class="conversation-item"
          class:active={convo.id === activeConversationId}
          role="button"
          tabindex="0"
          aria-current={convo.id === activeConversationId ? "true" : undefined}
          onclick={() => handleSelect(convo.id)}
          onkeydown={(e) => handleItemKeydown(e, convo.id)}
        >
          <div class="convo-content">
            {#if renamingId === convo.id}
              <input
                class="rename-input"
                type="text"
                bind:value={renameValue}
                onkeydown={handleRenameKeydown}
                onblur={commitRename}
                onclick={(e) => e.stopPropagation()}
                autofocus
              />
            {:else}
              <div class="convo-title" title="{convo.title} · {formatRelativeTime(convo.updatedAt)}">{convo.title}</div>
            {/if}
          </div>
          <span class="ran-on" title={ranOnText(convo)}>
            {#if parseChoice(convo.selectedModel).where === "mine"}<Server size={13} />{:else if ["network", "reserved", "anywhere"].includes(parseChoice(convo.selectedModel).where)}<Cloud size={13} />{:else}<Laptop size={13} />{/if}
          </span>
          <div class="convo-actions">
            <button
              class="kebab-btn"
              type="button"
              onclick={(e) => toggleMenu(e, convo.id)}
              title="More options"
              aria-label="More options for {convo.title}"
              aria-haspopup="menu"
              aria-expanded={menuOpenId === convo.id}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>
              </svg>
            </button>
            {#if menuOpenId === convo.id}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div class="context-menu" role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()}>
                <button class="context-menu-item" type="button" role="menuitem" onclick={() => startRename(convo)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                  Rename
                </button>
                <button class="context-menu-item delete" type="button" role="menuitem" onclick={() => handleDelete(convo.id)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                  </svg>
                  {confirmDeleteId === convo.id ? "Confirm delete?" : "Delete"}
                </button>
              </div>
            {/if}
          </div>
        </div>
      {/each}
      {/each}
    {/if}
  </div>

  {#if user && onOpenSettings && onLogout}
    <ProfileMenu {user} {onOpenSettings} {onLogout} />
  {/if}
</div>

<style>
  .bots-section {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    max-height: 40vh;
    overflow-y: auto;
    padding: 0 8px 4px;
  }
  .bots-label {
    display: flex;
    align-items: center;
    padding-left: 4px !important;
    padding-right: 2px !important;
  }
  .bots-add {
    margin-left: auto;
    display: inline-flex;
    border: none;
    background: none;
    color: var(--text-secondary);
    padding: 2px;
    border-radius: 5px;
    cursor: pointer;
  }
  .bots-add:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .bot-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: none;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
    min-width: 0;
  }
  .bot-row:hover,
  .bot-row.active {
    background: var(--bg-surface);
  }
  .bot-row.empty-bot {
    font-size: 12.5px;
    color: var(--text-secondary);
  }
  .bot-avatar {
    position: relative;
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 13px;
    font-weight: 600;
  }
  .bot-dot {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--green);
    border: 2px solid var(--bg-deep);
  }
  .bot-dot.warn {
    background: var(--yellow);
  }
  .bot-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .bot-name {
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bot-role {
    color: var(--text-secondary);
  }
  .bot-status {
    font-size: 11.5px;
    color: var(--text-muted, var(--text-secondary));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bot-status.warn {
    color: var(--yellow);
  }
  .bot-status.err {
    color: var(--danger);
  }
  .side-nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px 8px 4px;
  }
  .nav-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border: none;
    border-radius: 8px;
    background: none;
    color: var(--text-secondary);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }
  .nav-row:hover,
  .nav-row[aria-expanded="true"] {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .nav-row.primary {
    color: var(--text-primary);
  }
  .ran-on {
    display: inline-flex;
    color: var(--text-muted, var(--text-secondary));
    opacity: 0.8;
  }
  .conversation-item:hover .ran-on {
    display: none;
  }
  .group-label {
    padding: 14px 12px 4px;
    font-size: 11px;
    color: var(--text-muted, var(--text-secondary));
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 99;
    animation: fadeIn 200ms ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .sidebar {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 320px;
    max-width: 90vw;
    background: var(--bg-surface);
    border-left: 0.5px solid var(--border-strong);
    z-index: 100;
    display: flex;
    flex-direction: column;
    transform: translateX(100%);
    transition: transform 250ms cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.3);
  }

  .sidebar.open {
    transform: translateX(0);
  }

  .sidebar.inline {
    position: static;
    height: 100%;
    transform: none;
    width: 100%;
    max-width: none;
    border-left: none;
    box-shadow: none;
    background: var(--bg-base);
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border-bottom: 0.5px solid var(--border);
    flex-shrink: 0;
  }

  .sidebar-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    width: 32px;
    height: 32px;
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .close-btn:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }




  .search-wrapper {
    position: relative;
    padding: 12px 16px;
    flex-shrink: 0;
  }

  .search-icon {
    position: absolute;
    left: 28px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }

  .search-input {
    width: 100%;
    padding: 8px 12px 8px 34px;
    border: 1px solid var(--border-control);
    background: var(--bg-input);
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
  }

  .search-input::placeholder {
    color: var(--text-muted);
  }

  .search-input:focus {
    border-color: var(--accent);
  }

  .conversation-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }

  .empty-state {
    padding: 32px 16px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.6;
  }

  .conversation-item {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0 8px;
    padding: 6px 6px 6px 10px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s;
    position: relative;
  }

  .conversation-item:hover {
    background: var(--bg-surface);
  }

  .conversation-item.active {
    background: var(--bg-surface);
  }

  .conversation-item.active .convo-title {
    color: var(--text-primary);
  }

  .convo-content {
    flex: 1;
    min-width: 0;
  }

  .convo-title {
    font-size: 13px;
    font-weight: 400;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }



  .rename-input {
    width: 100%;
    padding: 4px 8px;
    border: 0.5px solid var(--accent);
    background: var(--bg-input);
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 500;
    outline: none;
  }

  .convo-actions {
    flex-shrink: 0;
    position: relative;
  }

  .kebab-btn {
    width: 28px;
    height: 28px;
    border: none;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: all 0.15s;
  }

  .conversation-item:hover .kebab-btn {
    opacity: 1;
  }

  .kebab-btn:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  .context-menu {
    position: absolute;
    top: 100%;
    right: 0;
    background: var(--bg-elevated);
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-md);
    padding: 4px;
    min-width: 140px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    z-index: 10;
    animation: menuIn 150ms ease-out;
  }

  @keyframes menuIn {
    from {
      opacity: 0;
      transform: scale(0.95) translateY(-4px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .context-menu-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: none;
    background: none;
    color: var(--text-primary);
    cursor: pointer;
    border-radius: var(--radius-sm);
    font-size: 13px;
    text-align: left;
    transition: background 0.15s;
  }

  .context-menu-item:hover {
    background: var(--bg-surface);
  }

  .context-menu-item.delete {
    color: var(--red);
  }

  .context-menu-item.delete:hover {
    background: color-mix(in srgb, var(--red) 10%, transparent);
  }
</style>
