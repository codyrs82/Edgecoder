<script lang="ts">
  import DiffModal from "./DiffModal.svelte";
  import { CloudUpload, Download, GitBranch, Github, Link, LoaderCircle } from "@lucide/svelte";
  import {
    gitState, gitHeadContent, gitStage, gitUnstage, gitDiscard, gitCommit, gitCheckout, gitPull, gitPush,
    gitInit, gitClone, gitAddRemote, gitPublishGitHub, gitGitHubStatus, ideGetProject,
    fsRead, type GitState, type GitFile, type GitHubCliStatus,
  } from "../lib/api";

  interface Props {
    /** Bump to reload (files changed on disk, a save, the agent). */
    refreshKey: number;
    onOpen: (path: string) => void;
    /** Files on disk changed (discard, pull, branch switch): reload open buffers and the tree. */
    onChanged: () => void;
    onError: (message: string) => void;
    onInfo: (message: string) => void;
    /** A clone finished and the IDE server opened it: show that folder. */
    onProjectOpened?: (root: string) => void;
  }
  let { refreshKey, onOpen, onChanged, onError, onInfo, onProjectOpened }: Props = $props();

  // Setting up git: init, clone, publish to GitHub (gh CLI), add a remote.
  let form = $state<null | "clone" | "publish" | "remote">(null);
  let cloneUrl = $state("");
  let remoteUrl = $state("");
  let repoName = $state("");
  let visibility = $state<"private" | "public">("private");
  let gh = $state<GitHubCliStatus | null>(null);
  let checkingGh = $state(false);
  /** What a long action is doing ("Cloning…"), shown with a spinner. */
  let progress = $state<string | null>(null);
  /** The last setup error, shown inline in the panel. */
  let setupError = $state<string | null>(null);

  async function checkGitHub() {
    checkingGh = true;
    try {
      gh = await gitGitHubStatus();
    } catch (e) {
      gh = null;
      setupError = (e as Error).message;
    } finally {
      checkingGh = false;
    }
  }

  async function openForm(which: "clone" | "publish" | "remote") {
    setupError = null;
    form = which;
    if (which === "publish") {
      if (!repoName) {
        const root = await ideGetProject().catch(() => null);
        repoName = (root ?? "").replace(/[/\\]+$/, "").split(/[/\\]/).pop()?.replace(/[^A-Za-z0-9._-]+/g, "-") ?? "";
      }
      void checkGitHub();
    }
  }

  /** Run a setup step with inline progress and errors. */
  async function setup(label: string, fn: () => Promise<void>) {
    setupError = null;
    busy = true;
    progress = label;
    try {
      await fn();
      form = null;
    } catch (e) {
      setupError = (e as Error).message;
    } finally {
      busy = false;
      progress = null;
      await load();
    }
  }

  const initRepo = () =>
    setup("Initializing…", async () => {
      await gitInit();
      onInfo("Initialized a git repository on main.");
    });

  async function cloneRepo() {
    const url = cloneUrl.trim();
    if (!url) return;
    setupError = null;
    let parent: string | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, title: "Choose a folder to clone into" });
      parent = typeof picked === "string" ? picked : null;
    } catch (e) {
      setupError = (e as Error).message;
      return;
    }
    if (!parent) return;
    const dir = parent;
    await setup("Cloning…", async () => {
      const root = await gitClone(url, dir);
      cloneUrl = "";
      onInfo(`Cloned into ${root}`);
      onProjectOpened?.(root);
      onChanged();
    });
  }

  const publishGitHub = () =>
    setup("Publishing to GitHub…", async () => {
      const r = await gitPublishGitHub(repoName.trim(), visibility);
      onInfo(`Published to ${r.url}`);
    });

  const addRemote = () =>
    setup("Adding remote…", async () => {
      const r = await gitAddRemote(remoteUrl.trim());
      remoteUrl = "";
      onInfo(`Added remote ${r.name}: ${r.url}`);
    });

  /** No upstream: push -u to the remote, or ask where to publish when there is none. */
  async function publishBranch() {
    if (!st) return;
    if (st.remotes.length === 0) {
      await openForm("publish");
      return;
    }
    await setup("Publishing branch…", async () => {
      onInfo(await gitPush());
    });
  }

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

{#snippet publishForm()}
  <form class="setup-form" onsubmit={(e) => { e.preventDefault(); void publishGitHub(); }}>
    <label class="field">
      <span>Repository name</span>
      <input class="text" bind:value={repoName} placeholder="my-project" aria-label="Repository name" />
    </label>
    <div class="radio-row" role="radiogroup" aria-label="Visibility">
      <label><input type="radio" name="visibility" value="private" bind:group={visibility} /> Private</label>
      <label><input type="radio" name="visibility" value="public" bind:group={visibility} /> Public</label>
    </div>
    {#if checkingGh && !gh}
      <p class="muted">Checking GitHub sign-in…</p>
    {:else if gh?.loggedIn}
      <p class="muted">Signed in to GitHub as <strong>{gh.login}</strong> (GitHub CLI).</p>
    {:else if gh && !gh.ghInstalled}
      <p class="hint">
        Publishing uses the GitHub CLI. Install it (<code>brew install gh</code>), run <code>gh auth login</code> in a terminal, then
        <button type="button" class="link" onclick={checkGitHub}>check again</button>.
      </p>
    {:else if gh}
      <p class="hint">
        Sign in to GitHub: run <code>gh auth login</code> in a terminal, then
        <button type="button" class="link" onclick={checkGitHub}>check again</button>.
      </p>
    {/if}
    {#if notRepo || (st && !st.hasCommits)}
      <p class="muted">Your files (except those in .gitignore) go into a first commit.</p>
    {/if}
    <div class="form-actions">
      <button type="submit" class="primary" disabled={busy || !gh?.loggedIn || !repoName.trim()}>
        <Github size={13} /> Publish {visibility === "private" ? "private" : "public"} repository
      </button>
      <button type="button" disabled={busy} onclick={() => (form = null)}>Cancel</button>
    </div>
  </form>
{/snippet}

{#snippet status()}
  {#if progress}
    <p class="progress" role="status"><span class="spin"><LoaderCircle size={13} /></span> {progress}</p>
  {/if}
  {#if setupError}
    <p class="error" role="alert">{setupError}</p>
  {/if}
{/snippet}

<div class="scm">
  {#if notRepo}
    <p class="muted">This folder isn't a git repository yet.</p>
    {#if form === "publish"}
      {@render publishForm()}
    {:else if form === "clone"}
      <form class="setup-form" onsubmit={(e) => { e.preventDefault(); void cloneRepo(); }}>
        <label class="field">
          <span>Repository URL</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input class="text" bind:value={cloneUrl} placeholder="https://github.com/owner/repo or owner/repo" aria-label="Repository URL" autofocus />
        </label>
        <div class="form-actions">
          <button type="submit" class="primary" disabled={busy || !cloneUrl.trim()}><Download size={13} /> Choose folder and clone</button>
          <button type="button" disabled={busy} onclick={() => (form = null)}>Cancel</button>
        </div>
      </form>
    {:else}
      <button class="primary wide" disabled={busy} onclick={initRepo}><GitBranch size={13} /> Initialize Repository</button>
      <button class="wide" disabled={busy} onclick={() => openForm("publish")}><Github size={13} /> Publish to GitHub</button>
      <button class="wide" disabled={busy} onclick={() => openForm("clone")}><Download size={13} /> Clone Repository…</button>
    {/if}
    {@render status()}
  {:else if st}
    {#if form === "publish"}
      {@render publishForm()}
      {@render status()}
    {:else if form === "remote"}
      <form class="setup-form" onsubmit={(e) => { e.preventDefault(); void addRemote(); }}>
        <label class="field">
          <span>Remote URL (origin)</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input class="text" bind:value={remoteUrl} placeholder="https://github.com/owner/repo.git" aria-label="Remote URL" autofocus />
        </label>
        <div class="form-actions">
          <button type="submit" class="primary" disabled={busy || !remoteUrl.trim()}><Link size={13} /> Add remote</button>
          <button type="button" disabled={busy} onclick={() => (form = null)}>Cancel</button>
        </div>
      </form>
      {@render status()}
    {/if}
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
      {#if st.upstream}
        <button disabled={busy} title={st.behind ? `Pull ${st.behind} commit(s)` : "Pull"} onclick={() => run("Pull", gitPull, true)}>↓{st.behind || ""}</button>
        <button disabled={busy} title={st.ahead ? `Push ${st.ahead} commit(s)` : "Push"} onclick={() => run("Push", gitPush)}>↑{st.ahead || ""}</button>
      {:else}
        <button class="publish" disabled={busy || !st.branch || !st.hasCommits}
          title={!st.hasCommits ? "Commit first, then publish" : st.remotes.length ? `Push ${st.branch} to ${st.remotes[0]} and track it` : "Publish this branch"}
          onclick={publishBranch}><CloudUpload size={13} /> Publish Branch</button>
      {/if}
    </div>
    {#if !st.upstream && form === null}
      <div class="remote-row">
        {#if st.remotes.length === 0}
          <span class="muted">No remote.</span>
          <button class="link" disabled={busy} onclick={() => openForm("remote")}>Add remote…</button>
          <button class="link" disabled={busy} onclick={() => openForm("publish")}>Publish to GitHub…</button>
        {:else}
          <span class="muted">{st.branch} isn't on {st.remotes[0]} yet.</span>
        {/if}
      </div>
      {@render status()}
    {/if}

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
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
  }
  .wide {
    width: 100%;
    padding: 5px;
  }
  .primary {
    background: var(--accent);
    color: var(--bg-base);
    border-color: var(--accent);
    font-weight: 600;
  }
  .primary:hover:not(:disabled) {
    color: var(--bg-base);
  }
  .primary:disabled,
  .wide:disabled,
  .publish:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .link {
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    display: inline;
  }
  .link:hover:not(:disabled) {
    text-decoration: underline;
  }
  .setup-form {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    color: var(--text-muted);
    font-size: 11px;
  }
  .text {
    font: inherit;
    font-size: 12px;
    padding: 4px 6px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 0.5px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .radio-row {
    display: flex;
    gap: 12px;
    color: var(--text-secondary);
  }
  .radio-row label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .form-actions {
    display: flex;
    gap: 4px;
  }
  .form-actions .primary {
    flex: 1;
    padding: 4px;
  }
  .remote-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
  }
  .remote-row .muted {
    margin: 0;
  }
  .hint {
    margin: 0;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  .hint code {
    font-size: 11px;
    padding: 0 3px;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
  }
  .progress {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px 0;
    color: var(--text-secondary);
  }
  .spin {
    display: inline-flex;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .error {
    margin: 2px 0;
    color: var(--danger, #f85149);
    white-space: pre-wrap;
    word-break: break-word;
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
    display: block;
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
