<script lang="ts">
  import { fsList, fsCreate, fsRename, fsDelete, indexStatus, indexBuild, type FsEntry, type IndexStatus, FsError } from "../lib/api";
  import { onDestroy } from "svelte";
  import { joinPath, parentDir } from "../lib/editor-store";

  interface Props {
    projectRoot: string;
    activePath: string | null;
    /** Project-relative path -> git status letter (M, U, A, D, R, C). */
    gitFiles: Record<string, string>;
    /** Bump to reload every expanded folder (after the agent or a save changed files). */
    refreshKey: number;
    onOpen: (path: string) => void;
    onRenamed: (from: string, to: string) => void;
    onDeleted: (path: string) => void;
    onError: (message: string) => void;
  }
  let { projectRoot, activePath, gitFiles, refreshKey, onOpen, onRenamed, onDeleted, onError }: Props = $props();

  let children = $state<Record<string, FsEntry[]>>({});
  let expanded = $state<Record<string, boolean>>({ "": true });
  /** Folder new entries go into: the last folder clicked, else the active file's folder. */
  let targetDir = $state("");
  /** Inline name input: creating in `dir`, or renaming `path`. */
  let editing = $state<{ mode: "file" | "dir"; dir: string } | { mode: "rename"; path: string; name: string } | null>(null);
  let editValue = $state("");

  async function load(dir: string) {
    try {
      children[dir] = await fsList(dir);
    } catch (e) {
      if (e instanceof FsError && e.code === "not_found") {
        delete children[dir];
        delete expanded[dir];
      } else {
        onError(`Couldn't list ${dir || "the project"}: ${(e as Error).message}`);
      }
    }
  }

  // Reload the root and every expanded folder when the project or refreshKey changes.
  $effect(() => {
    void projectRoot;
    void refreshKey;
    for (const dir of Object.keys(expanded)) if (expanded[dir]) void load(dir);
  });

  async function toggle(dir: string) {
    targetDir = dir;
    if (expanded[dir]) {
      expanded[dir] = false;
      return;
    }
    expanded[dir] = true;
    if (!children[dir]) await load(dir);
  }

  interface Row {
    entry: FsEntry;
    depth: number;
  }
  function rows(dir: string, depth: number): Row[] {
    const out: Row[] = [];
    for (const entry of children[dir] ?? []) {
      out.push({ entry, depth });
      if (entry.kind === "dir" && expanded[entry.path]) out.push(...rows(entry.path, depth + 1));
    }
    return out;
  }
  let visible = $derived(rows("", 0));

  function statusOf(entry: FsEntry): string | undefined {
    if (entry.kind === "file") return gitFiles[entry.path];
    const prefix = `${entry.path}/`;
    for (const p in gitFiles) if (p.startsWith(prefix)) return "•";
    return undefined;
  }

  function startCreate(mode: "file" | "dir") {
    const dir = targetDir || (activePath ? parentDir(activePath) : "");
    expanded[dir] = true;
    if (!children[dir]) void load(dir);
    editing = { mode, dir };
    editValue = "";
  }

  function startRename(entry: FsEntry) {
    editing = { mode: "rename", path: entry.path, name: entry.name };
    editValue = entry.name;
  }

  async function commitEdit() {
    const e = editing;
    const name = editValue.trim();
    editing = null;
    if (!e || !name) return;
    if (name.includes("/") && e.mode === "rename") {
      onError("Use a name, not a path, to rename.");
      return;
    }
    try {
      if (e.mode === "rename") {
        if (name === e.name) return;
        const to = joinPath(parentDir(e.path), name);
        await fsRename(e.path, to);
        onRenamed(e.path, to);
        await load(parentDir(e.path));
      } else {
        const path = joinPath(e.dir, name);
        await fsCreate(path, e.mode);
        await load(e.dir);
        if (e.mode === "file") onOpen(path);
        else {
          expanded[path] = true;
          await load(path);
        }
      }
    } catch (err) {
      onError((err as Error).message);
    }
  }

  async function remove(entry: FsEntry) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const ok = await ask(`Delete ${entry.path}${entry.kind === "dir" ? " and everything in it" : ""}? This can't be undone.`, {
      title: "Delete",
      kind: "warning",
    });
    if (!ok) return;
    try {
      await fsDelete(entry.path);
      onDeleted(entry.path);
      await load(parentDir(entry.path));
    } catch (err) {
      onError((err as Error).message);
    }
  }

  function onEditKey(ev: KeyboardEvent) {
    if (ev.key === "Enter") void commitEdit();
    else if (ev.key === "Escape") editing = null;
  }

  function focusInput(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  let projectName = $derived(projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? projectRoot);

  // Codebase index (search by meaning for @codebase and the agent): built in the background the
  // first time a project is opened, and on request.
  let index = $state<IndexStatus | null>(null);
  let indexTimer: ReturnType<typeof setTimeout> | undefined;
  async function pollIndex() {
    try {
      index = await indexStatus();
    } catch {
      index = null;
    }
    clearTimeout(indexTimer);
    if (index?.state === "building") indexTimer = setTimeout(pollIndex, 2000);
  }
  async function buildIndex() {
    try {
      index = await indexBuild();
    } catch (e) {
      onError(`Couldn't start indexing: ${(e as Error).message}`);
    }
    void pollIndex();
  }
  $effect(() => {
    void projectRoot;
    void (async () => {
      await pollIndex();
      if (index?.state === "none") await buildIndex();
    })();
  });
  onDestroy(() => clearTimeout(indexTimer));

  let indexLabel = $derived(
    !index ? "" :
    index.state === "building" ? `indexing ${index.progress && index.progress.total > 0 ? Math.round((100 * index.progress.done) / index.progress.total) : 0}%` :
    index.state === "ready" ? `⌕ ${index.files} files` :
    index.state === "error" ? "⌕ index failed" : "⌕ index",
  );
  let indexTitle = $derived(
    !index ? "" :
    index.state === "ready" ? `Codebase index (${index.model}): ${index.files} files, ${index.chunks} chunks. @codebase searches it. Click to update.` :
    index.state === "error" ? `Indexing failed: ${index.error}. Click to retry.` :
    index.state === "building" ? "Building the codebase index (local embeddings)…" : "Build the codebase index for @codebase",
  );
</script>

<div class="tree">
  <div class="tree-header">
    <span class="project" title={projectRoot}>{projectName}</span>
    <div class="actions">
      {#if index}
        <button class="index" class:failed={index.state === "error"} title={indexTitle} disabled={index.state === "building"} onclick={buildIndex}>{indexLabel}</button>
      {/if}
      <button title="New file" onclick={() => startCreate("file")} aria-label="New file">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M12 18v-6M9 15h6"/></svg>
      </button>
      <button title="New folder" onclick={() => startCreate("dir")} aria-label="New folder">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><path d="M12 11v6M9 14h6"/></svg>
      </button>
      <button title="Refresh" onclick={() => { for (const d of Object.keys(expanded)) if (expanded[d]) void load(d); }} aria-label="Refresh">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15"/></svg>
      </button>
    </div>
  </div>

  {#if editing && editing.mode !== "rename" && editing.dir === ""}
    <div class="row" style="padding-left: 12px">
      <input class="name-input" placeholder={editing.mode === "file" ? "file name" : "folder name"} bind:value={editValue} onkeydown={onEditKey} onblur={commitEdit} use:focusInput />
    </div>
  {/if}

  {#each visible as { entry, depth } (entry.path)}
    {@const status = statusOf(entry)}
    {#if editing?.mode === "rename" && editing.path === entry.path}
      <div class="row" style="padding-left: {12 + depth * 12}px">
        <input class="name-input" bind:value={editValue} onkeydown={onEditKey} onblur={commitEdit} use:focusInput />
      </div>
    {:else}
      <div
        class="row"
        class:active={entry.path === activePath}
        style="padding-left: {12 + depth * 12}px"
        role="treeitem"
        aria-selected={entry.path === activePath}
        aria-expanded={entry.kind === "dir" ? Boolean(expanded[entry.path]) : undefined}
        tabindex="0"
        onclick={() => (entry.kind === "dir" ? toggle(entry.path) : (targetDir = parentDir(entry.path), onOpen(entry.path)))}
        onkeydown={(ev) => { if (ev.key === "Enter") (entry.kind === "dir" ? toggle(entry.path) : onOpen(entry.path)); else if (ev.key === "F2") startRename(entry); }}
      >
        <span class="chevron">{entry.kind === "dir" ? (expanded[entry.path] ? "▾" : "▸") : ""}</span>
        <span class="name" class:dir={entry.kind === "dir"} data-status={status}>{entry.name}</span>
        {#if status}<span class="status" data-status={status}>{status}</span>{/if}
        <span class="row-actions">
          <button title="Rename (F2)" aria-label="Rename" onclick={(ev) => { ev.stopPropagation(); startRename(entry); }}>✎</button>
          <button title="Delete" aria-label="Delete" onclick={(ev) => { ev.stopPropagation(); void remove(entry); }}>✕</button>
        </span>
      </div>
    {/if}
    {#if entry.kind === "dir" && editing && editing.mode !== "rename" && editing.dir === entry.path && expanded[entry.path]}
      <div class="row" style="padding-left: {24 + depth * 12}px">
        <input class="name-input" placeholder={editing.mode === "file" ? "file name" : "folder name"} bind:value={editValue} onkeydown={onEditKey} onblur={commitEdit} use:focusInput />
      </div>
    {/if}
  {/each}
</div>

<style>
  .tree {
    width: 100%;
    height: 100%;
    overflow-y: auto;
    padding-bottom: 12px;
    font-size: 13px;
  }
  .tree-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 8px 6px 12px;
    position: sticky;
    top: 0;
    background: var(--bg-base);
    z-index: 1;
  }
  .project {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    gap: 2px;
  }
  .actions button,
  .row-actions button {
    border: none;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-sm);
    padding: 3px;
    display: flex;
    align-items: center;
    font-size: 11px;
    line-height: 1;
  }
  .actions button:hover,
  .row-actions button:hover {
    color: var(--text-primary);
    background: var(--bg-elevated);
  }
  .actions button.index {
    font-size: 10px;
    padding: 2px 4px;
    white-space: nowrap;
  }
  .actions button.index.failed {
    color: var(--danger, #f85149);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-right: 8px;
    height: 24px;
    cursor: pointer;
    color: var(--text-secondary);
    outline: none;
  }
  .row:hover,
  .row:focus-visible {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .row.active {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .chevron {
    width: 10px;
    font-size: 10px;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name[data-status="M"],
  .status[data-status="M"],
  .status[data-status="•"] {
    color: var(--warning, #d29922);
  }
  .name[data-status="U"],
  .name[data-status="A"],
  .status[data-status="U"],
  .status[data-status="A"] {
    color: var(--success, #3fb950);
  }
  .name[data-status="D"],
  .name[data-status="C"],
  .status[data-status="D"],
  .status[data-status="C"] {
    color: var(--danger, #f85149);
  }
  .status {
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .row-actions {
    display: none;
    gap: 2px;
    flex-shrink: 0;
  }
  .row:hover .row-actions {
    display: flex;
  }
  .name-input {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 13px;
    padding: 2px 6px;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-primary);
    outline: none;
  }
</style>
