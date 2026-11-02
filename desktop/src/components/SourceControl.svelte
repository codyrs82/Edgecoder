<script lang="ts">
  import DiffModal from "./DiffModal.svelte";
  import {
    gitState, gitHeadContent, gitStage, gitUnstage, gitDiscard, gitCommit, gitCheckout, gitPull, gitPush,
    fsRead, type GitState, type GitFile,
  } from "../lib/api";

  interface Props {
    /** Bump to reload (files changed on disk, a save, the agent). */
    refreshKey: number;
    onOpen: (path: string) => void;
    /** Files on disk changed (discard, pull, branch switch): reload open buffers and the tree. */
    onChanged: () => void;
    onError: (message: string) => void;
    onInfo: (message: string) => void;
  }
  let { refreshKey, onOpen, onChanged, onError, onInfo }: Props = $props();

  let st = $state<GitState | null>(null);
  let notRepo = $state(false);
  let message = $state("");
  let busy = $state(false);
  let reviewing = $state<{ path: string; before: string | null; after: string | null } | null>(null);
  let newBranch = $state<string | null>(null);

  async function load() {
    try {
      const r = await gitState();
      if ("notARepo" in r) {
        notRepo = true;
        st = null;
      } else {
        notRepo = false;
        st = r;
      }
    } catch (e) {
      onError(`Git: ${(e as Error).message}`);
    }
  }

  $effect(() => {
    void refreshKey;
    void load();
  });

  async function run(label: string, fn: () => Promise<unknown>, changesFiles = false) {
    busy = true;
    try {
      const out = await fn();
      if (typeof out === "string" && out) onInfo(out);
      if (changesFiles) onChanged();
    } catch (e) {
      onError(`${label}: ${(e as Error).message}`);
    } finally {
      busy = false;
      await load();
    }
  }

  async function review(f: GitFile, staged: boolean) {
    try {
      const before = f.status === "U" || f.status === "A" ? null : await gitHeadContent(f.from ?? f.path);
      let after: string | null = null;
      if (f.status !== "D") {
        try {
          after = (await fsRead(f.path)).content;
        } catch {
          after = null;
        }
      }
      reviewing = { path: f.path + (staged ? " (staged)" : ""), before, after };
    } catch (e) {
      onError((e as Error).message);
    }
  }

  async function discard(f: GitFile) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const what = f.status === "U" ? `Delete the new file ${f.path}?` : `Discard your changes to ${f.path}?`;
    if (await ask(`${what} This can't be undone.`, { title: "Discard changes", kind: "warning", okLabel: "Discard" })) {
      await run("Discard", () => gitDiscard([f.path]), true);
    }
  }

  async function commit() {
    if (!st) return;
    const all = st.staged.length === 0;
    await run("Commit", async () => {
      const sha = await gitCommit(message, all);
      message = "";
      return `Committed ${sha}`;
    });
  }

  async function switchBranch(e: Event) {
    const b = (e.target as HTMLSelectElement).value;
    if (b === "__new") {
      newBranch = "";
      return;
    }
    if (st && b !== st.branch) await run("Switch branch", () => gitCheckout(b), true);
  }

  async function createBranch() {
    const name = (newBranch ?? "").trim();
    newBranch = null;
    if (name) await run("New branch", () => gitCheckout(name, true), true);
  }

  const LABEL: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", U: "new", C: "conflict" };
</script>

<div class="scm">
  {#if notRepo}
    <p class="muted">This folder is not a git repository.</p>
  {:else if st}
    <div class="branch-row">
      {#if newBranch !== null}
        <input class="branch-input" placeholder="new branch name" bind:value={newBranch}
          onkeydown={(e) => { if (e.key === "Enter") void createBranch(); if (e.key === "Escape") newBranch = null; }} />
      {:else}
        <select class="branch" value={st.branch ?? ""} disabled={busy} onchange={switchBranch} aria-label="Branch">
          {#if !st.branch}<option value="">(detached)</option>{/if}
          {#each st.branches as b (b)}<option value={b}>{b}</option>{/each}
          <option value="__new">New branch…</option>
        </select>
      {/if}
      <button disabled={busy} title={st.behind ? `Pull ${st.behind} commit(s)` : "Pull"} onclick={() => run("Pull", gitPull, true)}>↓{st.behind || ""}</button>
      <button disabled={busy} title={st.ahead ? `Push ${st.ahead} commit(s)` : "Push"} onclick={() => run("Push", gitPush)}>↑{st.ahead || ""}</button>
    </div>

    <textarea
      class="message"
      rows="3"
      placeholder={st.staged.length ? "Commit message (⌘↵)" : "Commit message (commits all changes) ⌘↵"}
      bind:value={message}
      onkeydown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void commit(); } }}
    ></textarea>
    <button class="commit" disabled={busy || !message.trim() || (st.staged.length === 0 && st.unstaged.length === 0)} onclick={commit}>
      {st.staged.length ? `Commit ${st.staged.length} staged` : "Commit all"}
    </button>

    {#if st.staged.length}
      <div class="section">
        <span>Staged ({st.staged.length})</span>
        <button disabled={busy} title="Unstage all" onclick={() => run("Unstage", () => gitUnstage(st!.staged.map((f) => f.path)))}>−</button>
      </div>
      {#each st.staged as f (f.path)}
        <div class="file" title={LABEL[f.status] ?? f.status}>
          <button class="name" onclick={() => review(f, true)}>{f.path}</button>
          <span class="actions">
            <button disabled={busy} title="Open" onclick={() => onOpen(f.path)}>↗</button>
            <button disabled={busy} title="Unstage" onclick={() => run("Unstage", () => gitUnstage([f.path]))}>−</button>
          </span>
          <span class="status" data-status={f.status}>{f.status}</span>
        </div>
      {/each}
    {/if}

    <div class="section">
      <span>Changes ({st.unstaged.length})</span>
      {#if st.unstaged.length}
        <button disabled={busy} title="Stage all" onclick={() => run("Stage", () => gitStage(st!.unstaged.map((f) => f.path)))}>+</button>
      {/if}
    </div>
    {#each st.unstaged as f (f.path)}
      <div class="file" title={LABEL[f.status] ?? f.status}>
        <button class="name" onclick={() => review(f, false)}>{f.path}</button>
        <span class="actions">
          {#if f.status !== "D"}<button disabled={busy} title="Open" onclick={() => onOpen(f.path)}>↗</button>{/if}
          <button disabled={busy} title="Discard changes" onclick={() => discard(f)}>↺</button>
          <button disabled={busy} title="Stage" onclick={() => run("Stage", () => gitStage([f.path]))}>+</button>
        </span>
        <span class="status" data-status={f.status}>{f.status}</span>
      </div>
    {:else}
      <p class="muted">No changes.</p>
    {/each}
  {/if}
</div>

{#if reviewing}
  <DiffModal path={reviewing.path} before={reviewing.before} after={reviewing.after} onClose={() => (reviewing = null)} />
{/if}

<style>
  .scm {
    height: 100%;
    overflow-y: auto;
    padding: 8px 8px 12px 12px;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .muted {
    color: var(--text-muted);
    margin: 6px 0;
  }
  .branch-row {
    display: flex;
    gap: 4px;
  }
  .branch,
  .branch-input {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 3px 6px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 0.5px solid var(--border);
    border-radius: var(--radius-sm);
  }
  button {
    border: 0.5px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    padding: 2px 7px;
    cursor: pointer;
    font: inherit;
  }
  button:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--accent);
  }
  .message {
    font: inherit;
    resize: vertical;
    padding: 6px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 0.5px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .commit {
    background: var(--accent);
    color: var(--bg-base);
    border-color: var(--accent);
    font-weight: 600;
    padding: 5px;
  }
  .commit:disabled {
    opacity: 0.5;
  }
  .section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 6px;
    color: var(--text-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 22px;
  }
  .file .name {
    flex: 1;
    min-width: 0;
    text-align: left;
    border: none;
    background: none;
    padding: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-secondary);
  }
  .file .name:hover {
    color: var(--text-primary);
  }
  .actions {
    display: none;
    gap: 2px;
  }
  .file:hover .actions {
    display: flex;
  }
  .actions button {
    padding: 0 5px;
    line-height: 16px;
  }
  .status {
    width: 12px;
    text-align: center;
    font-weight: 600;
    color: var(--warning, #d29922);
  }
  .status[data-status="U"],
  .status[data-status="A"] {
    color: var(--success, #3fb950);
  }
  .status[data-status="D"],
  .status[data-status="C"] {
    color: var(--danger, #f85149);
  }
</style>
