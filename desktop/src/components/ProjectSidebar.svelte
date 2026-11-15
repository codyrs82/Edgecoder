<script lang="ts">
  // The Code view's sidebar: projects (folders) with their coding chats nested under them, like
  // Claude groups chats by project. Chats without a project are listed last.
  import { tick } from "svelte";
  import { ChevronRight, Folder, FolderOpen, FolderPlus, FolderGit2, SquarePen, Plus, EllipsisVertical, Pencil, Trash2, SquareTerminal } from "@lucide/svelte";
  import { listConversationsBySource, deleteConversation, renameConversation } from "../lib/chat-store";
  import { chatListVersion, chatsChanged, groupByProject, loadRecentProjects, tildePath, type ProjectGroup } from "../lib/projects";
  import { menu } from "../lib/menu";
  import type { Conversation } from "../lib/types";
  import type { AuthUser, SessionSummary } from "../lib/api";
  import ProfileMenu from "./ProfileMenu.svelte";

  interface Props {
    /** The open project folder. */
    currentProject: string | null;
    /** The chat showing in the Code view. */
    activeChatId: string | null;
    /** Open a project (its last chat comes with it). */
    onOpenProject: (root: string) => void;
    onSelectChat: (chat: Conversation) => void;
    /** A new chat in this project (null: the open one). */
    onNewChat: (root: string | null) => void;
    onNewProject: () => void;
    onOpenFolder: () => void;
    onClone: () => void;
    user?: AuthUser;
    onOpenSettings?: (section?: string) => void;
    onLogout?: () => void;
    /** Sessions published from a terminal (`edgecoder code`, /remote), listed under their projects. */
    liveSessions?: SessionSummary[];
    activeSessionId?: string | null;
    onSelectSession?: (s: SessionSummary) => void;
  }
  let { currentProject, activeChatId, onOpenProject, onSelectChat, onNewChat, onNewProject, onOpenFolder, onClone, user, onOpenSettings, onLogout, liveSessions = [], activeSessionId = null, onSelectSession }: Props = $props();

  function sessionsIn(root: string): SessionSummary[] {
    return liveSessions.filter((x) => x.projectRoot === root);
  }

  /** Chats shown per project before "Show more". */
  const SHOWN = 5;

  let chats = $state<Conversation[]>([]);
  let loaded = $state(false);
  /** Collapsed projects (the open one starts expanded, the others collapsed). */
  let expanded = $state<Record<string, boolean>>({});
  let showAll = $state<Record<string, boolean>>({});

  $effect(() => {
    void $chatListVersion;
    void currentProject;
    void activeChatId;
    listConversationsBySource("editor")
      .then((c) => { chats = c; })
      .catch(() => { chats = []; })
      .finally(() => { loaded = true; });
  });

  const grouped = $derived.by(() => {
    void chats;
    // A terminal session's folder is a project here too, even if the app never opened it.
    const fromSessions = liveSessions.map((x) => ({ root: x.projectRoot, openedAt: x.updatedAt }));
    return groupByProject(chats, [...loadRecentProjects(), ...fromSessions], currentProject);
  });

  function isOpen(g: ProjectGroup): boolean {
    return expanded[g.root] ?? g.root === currentProject;
  }

  function toggle(g: ProjectGroup) {
    expanded = { ...expanded, [g.root]: !isOpen(g) };
  }

  function openProject(g: ProjectGroup) {
    expanded = { ...expanded, [g.root]: true };
    onOpenProject(g.root);
  }

  function ago(ts: number): string {
    const m = Math.floor((Date.now() - ts) / 60_000);
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d`;
    return `${Math.floor(d / 30)}mo`;
  }

  // Row menu (rename, delete), the same keyboard menu as the Chat sidebar (#161).
  let menuOpenId = $state<string | null>(null);
  let menuTrigger: HTMLElement | null = $state.raw(null);
  let confirmDeleteId = $state<string | null>(null);
  let renamingId = $state<string | null>(null);
  let renameValue = $state("");
  let listEl: HTMLElement | undefined = $state();

  function toggleMenu(e: MouseEvent, id: string) {
    confirmDeleteId = null;
    if (menuOpenId === id) {
      closeMenu(true);
      return;
    }
    menuTrigger = e.currentTarget as HTMLElement;
    menuOpenId = id;
  }

  function closeMenu(returnFocus: boolean) {
    const trigger = menuTrigger;
    menuOpenId = null;
    confirmDeleteId = null;
    menuTrigger = null;
    if (returnFocus && trigger) void tick().then(() => trigger.focus());
  }

  async function remove(c: Conversation) {
    if (confirmDeleteId !== c.id) {
      confirmDeleteId = c.id;
      return;
    }
    closeMenu(false);
    await deleteConversation(c.id);
    chats = chats.filter((x) => x.id !== c.id);
    chatsChanged();
    if (c.id === activeChatId) onNewChat(c.projectRoot ?? null);
  }

  function startRename(c: Conversation) {
    closeMenu(false);
    renamingId = c.id;
    renameValue = c.title;
  }

  async function commitRename() {
    const id = renamingId;
    const title = renameValue.trim();
    renamingId = null;
    if (!id || !title) return;
    await renameConversation(id, title);
    chats = chats.map((c) => (c.id === id ? { ...c, title } : c));
    chatsChanged();
    await tick();
    listEl?.querySelector<HTMLElement>(`[data-chat-id="${id}"]`)?.focus();
  }
</script>

{#snippet chatRow(c: Conversation)}
  <li class="chat-row" class:active={c.id === activeChatId}>
    {#if renamingId === c.id}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="rename"
        aria-label="Rename chat"
        bind:value={renameValue}
        autofocus
        onblur={() => void commitRename()}
        onkeydown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); renamingId = null; }
        }}
      />
    {:else}
      <button class="chat-open" type="button" data-chat-id={c.id} aria-current={c.id === activeChatId ? "true" : undefined} title={c.title} onclick={() => onSelectChat(c)}>
        <span class="chat-title">{c.title}</span>
        <span class="chat-age" aria-label="updated {ago(c.updatedAt)} ago">{ago(c.updatedAt)}</span>
      </button>
      <div class="row-actions">
        <button
          class="row-btn kebab"
          type="button"
          aria-label="More options for {c.title}"
          aria-haspopup="menu"
          aria-expanded={menuOpenId === c.id}
          onclick={(e) => toggleMenu(e, c.id)}
        ><EllipsisVertical size={14} /></button>
        {#if menuOpenId === c.id}
          <div class="row-menu" role="menu" tabindex="-1" aria-label="Options for {c.title}" use:menu={{ onClose: closeMenu, trigger: menuTrigger }}>
            <button role="menuitem" tabindex="-1" type="button" onclick={() => startRename(c)}><Pencil size={14} /> Rename</button>
            <button role="menuitem" tabindex="-1" type="button" class="danger" onclick={() => void remove(c)}><Trash2 size={14} /> {confirmDeleteId === c.id ? "Confirm delete?" : "Delete"}</button>
          </div>
        {/if}
      </div>
    {/if}
  </li>
{/snippet}

<div class="project-sidebar">
  <nav class="side-nav" aria-label="Code">
    <button class="nav-row primary" type="button" onclick={() => onNewChat(null)} disabled={!currentProject} title={currentProject ? `New chat in ${grouped.projects.find((p) => p.root === currentProject)?.name ?? "this project"}` : "Open or create a project first"}>
      <SquarePen size={16} /> New chat
    </button>
    <button class="nav-row" type="button" onclick={onNewProject}><FolderPlus size={16} /> New project</button>
    <button class="nav-row" type="button" onclick={onClone}><FolderGit2 size={16} /> Clone from GitHub</button>
    <button class="nav-row" type="button" onclick={onOpenFolder}><FolderOpen size={16} /> Open folder</button>
  </nav>

  <div class="list" bind:this={listEl}>
    <div class="group-label">Projects</div>
    {#if loaded && grouped.projects.length === 0}
      <p class="empty">No projects yet. Create one, clone a repository from GitHub, or open a folder.</p>
    {/if}
    <ul class="projects" aria-label="Projects">
      {#each grouped.projects as g (g.root)}
        {@const open = isOpen(g)}
        {@const current = g.root === currentProject}
        <li class="project">
          <div class="project-row" class:current>
            <button class="row-btn chevron" type="button" aria-expanded={open} aria-label="{open ? 'Collapse' : 'Expand'} {g.name}" onclick={() => toggle(g)}>
              <span class="chev" class:open><ChevronRight size={13} /></span>
            </button>
            <button class="project-open" type="button" aria-current={current ? "true" : undefined} title={tildePath(g.root)} onclick={() => openProject(g)}>
              {#if current}<FolderOpen size={15} />{:else}<Folder size={15} />{/if}
              <span class="project-name">{g.name}</span>
            </button>
            <button class="row-btn add" class:shown={current} type="button" aria-label="New chat in {g.name}" title="New chat in {g.name}" onclick={() => onNewChat(g.root)}>
              <Plus size={14} />
            </button>
          </div>
          {#if sessionsIn(g.root).length > 0}
            <ul class="chats sessions" aria-label="Live sessions in {g.name}">
              {#each sessionsIn(g.root) as x (x.id)}
                <li class="chat-row" class:active={x.id === activeSessionId}>
                  <button class="chat-open" type="button" data-session-id={x.id} aria-current={x.id === activeSessionId ? "true" : undefined} title="{x.title} ({x.live ? 'live' : 'shared'} from the terminal)" onclick={() => onSelectSession?.(x)}>
                    <SquareTerminal size={13} />
                    <span class="chat-title">{x.title}</span>
                    {#if x.live}<span class="live-dot" aria-label="live">Live</span>{:else}<span class="chat-age">{ago(x.updatedAt)}</span>{/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          {#if open}
            {#if g.chats.length === 0 && sessionsIn(g.root).length === 0}
              <p class="no-chats">No chats yet</p>
            {:else}
              <ul class="chats" aria-label="Chats in {g.name}">
                {#each showAll[g.root] ? g.chats : g.chats.slice(0, SHOWN) as c (c.id)}
                  {@render chatRow(c)}
                {/each}
              </ul>
              {#if g.chats.length > SHOWN}
                <button class="more" type="button" onclick={() => (showAll = { ...showAll, [g.root]: !showAll[g.root] })}>
                  {showAll[g.root] ? "Show less" : `Show ${g.chats.length - SHOWN} more`}
                </button>
              {/if}
            {/if}
          {/if}
        </li>
      {/each}
    </ul>

    {#if grouped.loose.length > 0}
      <div class="group-label">Without a project</div>
      <ul class="chats loose" aria-label="Chats without a project">
        {#each grouped.loose as c (c.id)}
          {@render chatRow(c)}
        {/each}
      </ul>
    {/if}
  </div>

  {#if user && onOpenSettings && onLogout}
    <ProfileMenu {user} {onOpenSettings} {onLogout} />
  {/if}
</div>

<style>
  .sessions .chat-open {
    gap: 6px;
  }
  .live-dot {
    flex-shrink: 0;
    padding: 0 6px;
    border-radius: 999px;
    font-size: var(--fs-2xs);
    color: var(--green);
    background: color-mix(in srgb, var(--green) 12%, transparent);
  }
  .project-sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-base);
    min-width: 0;
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
    height: 30px;
    padding: 0 10px;
    border: none;
    border-radius: var(--radius-md);
    background: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
    text-align: left;
  }
  .nav-row:hover:not(:disabled) {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .nav-row.primary {
    color: var(--text-primary);
  }
  .nav-row:disabled {
    cursor: default;
    color: var(--text-muted);
  }
  .list {
    flex: 1;
    overflow-y: auto;
    padding: 0 8px 8px;
  }
  .group-label {
    padding: 14px 4px 4px 10px;
    font-size: var(--fs-2xs);
    color: var(--text-muted);
  }
  .empty, .no-chats {
    margin: 0;
    padding: 4px 10px 8px;
    font-size: var(--fs-xs);
    color: var(--text-muted);
    line-height: var(--lh-ui);
  }
  .no-chats {
    padding-left: 34px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .project-row {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 30px;
    border-radius: var(--radius-md);
  }
  .project-row:hover {
    background: var(--bg-surface);
  }
  .project-open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 100%;
    padding: 0 4px;
    border: none;
    background: none;
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
    text-align: left;
  }
  .project-row.current .project-open {
    font-weight: 500;
  }
  .project-open :global(svg) {
    flex-shrink: 0;
    color: var(--text-secondary);
  }
  .project-name, .chat-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--control-sm);
    height: var(--control-sm);
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .row-btn:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }
  .chev {
    display: inline-flex;
    transition: transform 0.15s;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .add, .kebab {
    opacity: 0;
  }
  .add.shown,
  .project-row:hover .add,
  .project-row:focus-within .add,
  .chat-row:hover .kebab,
  .chat-row:focus-within .kebab,
  .kebab[aria-expanded="true"] {
    opacity: 1;
  }
  .chat-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 28px;
    padding: 0 2px 0 34px;
    border-radius: var(--radius-md);
  }
  .loose .chat-row {
    padding-left: 10px;
  }
  .chat-row:hover, .chat-row.active {
    background: var(--bg-surface);
  }
  .chat-open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0;
    border: none;
    background: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
    text-align: left;
  }
  .chat-row.active .chat-open {
    color: var(--text-primary);
  }
  .chat-title {
    flex: 1;
    min-width: 0;
  }
  .chat-age {
    flex-shrink: 0;
    font-size: var(--fs-2xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .chat-row:hover .chat-age, .chat-row:focus-within .chat-age {
    display: none;
  }
  .row-actions {
    position: relative;
    flex-shrink: 0;
  }
  .row-menu {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 20;
    min-width: 150px;
    padding: 4px;
    background: var(--bg-elevated);
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
  }
  .row-menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
    text-align: left;
  }
  .row-menu button:hover, .row-menu button:focus-visible {
    background: var(--bg-surface);
    outline: none;
  }
  .row-menu button.danger {
    color: var(--red);
  }
  .rename {
    flex: 1;
    min-width: 0;
    height: var(--control-sm);
    padding: 0 6px;
    border: 0.5px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
    outline: none;
  }
  .more {
    margin: 0 0 4px 34px;
    padding: 2px 0;
    border: none;
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .more:hover {
    color: var(--text-primary);
  }
  button:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: -2px;
  }
</style>
