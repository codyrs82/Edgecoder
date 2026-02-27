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

  interface Props {
    open: boolean;
    onClose: () => void;
    onSelectConversation: (id: string) => void;
    onNewChat: () => void;
    activeConversationId: string | null;
    /** Render as inline panel instead of fixed overlay */
    inline?: boolean;
  }

  let { open, onClose, onSelectConversation, onNewChat, activeConversationId, inline = false }: Props = $props();

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

  function getPreview(convo: Conversation): string {
    const msgCount = convo.messages.length;
    const firstMsg = convo.messages[0];
    const prefix = msgCount > 0 ? `${msgCount} msg${msgCount !== 1 ? "s" : ""} · ` : "";
    if (!firstMsg) return "No messages yet";
    const text = firstMsg.content;
    const preview = text.length > 60 ? text.slice(0, 60) + "..." : text;
    return prefix + preview;
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

<div class="sidebar" class:open class:inline>
  {#if !inline}
    <div class="sidebar-header">
      <h2 class="sidebar-title">History</h2>
      <button class="close-btn" onclick={onClose} title="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
    </div>
  {/if}

  <div class="sidebar-actions">
    <button class="new-chat-btn" onclick={handleNewChat}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 5v14M5 12h14"/>
      </svg>
      New Chat
    </button>
  </div>

  <div class="search-wrapper">
    <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
    <input
      class="search-input"
      type="text"
      placeholder="Search conversations..."
      bind:value={searchQuery}
    />
  </div>

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
      {#each filtered as convo (convo.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="conversation-item"
          class:active={convo.id === activeConversationId}
          onclick={() => handleSelect(convo.id)}
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
              <div class="convo-title">{convo.title}</div>
            {/if}
            <div class="convo-meta">
              <span class="convo-date">{formatRelativeTime(convo.updatedAt)}</span>
              <span class="convo-separator">&middot;</span>
              <span class="convo-preview">{getPreview(convo)}</span>
            </div>
          </div>
          <div class="convo-actions">
            <button
              class="kebab-btn"
              onclick={(e) => toggleMenu(e, convo.id)}
              title="More options"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>
              </svg>
            </button>
            {#if menuOpenId === convo.id}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="context-menu" onclick={(e) => e.stopPropagation()}>
                <button class="context-menu-item" onclick={() => startRename(convo)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                  Rename
                </button>
                <button class="context-menu-item delete" onclick={() => handleDelete(convo.id)}>
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
    {/if}
  </div>
</div>

<style>
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
    transform: none;
    width: 100%;
    max-width: none;
    border-left: none;
    box-shadow: none;
    background: var(--bg-base, #2f2f2d);
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

  .sidebar-actions {
    padding: 12px 16px 0;
    flex-shrink: 0;
  }

  .new-chat-btn {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 16px;
    border: 0.5px solid var(--border-strong);
    background: var(--bg-elevated);
    color: var(--text-primary);
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.15s;
  }

  .new-chat-btn:hover {
    border-color: var(--accent);
    background: rgba(193, 120, 80, 0.1);
    color: var(--accent);
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
    border: 0.5px solid var(--border);
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
    align-items: flex-start;
    gap: 4px;
    padding: 12px 16px;
    cursor: pointer;
    transition: background 0.15s;
    border-left: 3px solid transparent;
    position: relative;
  }

  .conversation-item:hover {
    background: var(--bg-elevated);
  }

  .conversation-item.active {
    border-left-color: var(--accent);
    background: rgba(193, 120, 80, 0.08);
  }

  .convo-content {
    flex: 1;
    min-width: 0;
  }

  .convo-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .convo-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
  }

  .convo-date {
    flex-shrink: 0;
    color: var(--text-muted);
  }

  .convo-separator {
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .convo-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-secondary);
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
    background: rgba(248, 113, 113, 0.1);
  }
</style>
