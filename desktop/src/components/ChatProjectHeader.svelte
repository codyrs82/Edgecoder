<script lang="ts">
  // The coding chat's project line: project · branch (switcher), uncommitted changes, ahead/behind,
  // the GitHub repository, and Pull / Commit / Publish / Connect GitHub.
  import { Popover } from "bits-ui";
  import { ArrowDown, ArrowUp, Check, ChevronDown, CloudUpload, Download, Folder, GitBranch, GitCommitHorizontal, Github, LoaderCircle, Plus, RefreshCw } from "@lucide/svelte";
  import { gitCheckout, gitCommit, gitInit, gitPublishGitHub, gitPull, gitPush, gitState, type GitHubCliStatus, type GitState } from "../lib/api";
  import { githubCli, githubCliStatus } from "../lib/github-cli";
  import { githubSlug, projectName, repoWebUrl, tildePath } from "../lib/projects";
  import { notify } from "../lib/toast";

  interface Props {
    projectRoot: string;
    /** Bump to reload the git state (files changed, the agent finished a turn). */
    refreshKey?: number;
    /** Files on disk changed (pull, branch switch): reload buffers and the tree. */
    onChanged?: () => void;
    /** Show the changes (Source Control). */
    onReviewChanges?: () => void;
    /** Settings → Integrations, for connecting GitHub. */
    onConnectGitHub?: () => void;
  }
  let { projectRoot, refreshKey = 0, onChanged, onReviewChanges, onConnectGitHub }: Props = $props();
  const uid = $props.id();

  let st = $state<GitState | null>(null);
  let notRepo = $state(false);
  const gh = $derived<GitHubCliStatus | null>($githubCli);
  /** What a running action is doing ("Pulling…"). */
  let busy = $state<string | null>(null);

  let branchOpen = $state(false);
  let commitOpen = $state(false);
  let publishOpen = $state(false);
  let githubOpen = $state(false);
  let newBranch = $state("");
  let commitMessage = $state("");
  let repoName = $state("");
  let visibility = $state<"private" | "public">("private");

  const name = $derived(projectName(projectRoot));
  const changes = $derived(st ? new Set([...st.staged, ...st.unstaged].map((f) => f.path)).size : 0);
  const webUrl = $derived(repoWebUrl(st?.remoteUrl));
  const slug = $derived(githubSlug(st?.remoteUrl));
  const hasRemote = $derived((st?.remotes.length ?? 0) > 0);

  async function load() {
    const root = projectRoot;
    try {
      const r = await gitState();
      if (root !== projectRoot) return;
      if ("notARepo" in r) {
        notRepo = true;
        st = null;
      } else {
        notRepo = false;
        st = r;
      }
    } catch {
      // no IDE server, or the project closed: show the folder only
      st = null;
      notRepo = false;
    }
  }

  $effect(() => {
    void projectRoot;
    void refreshKey;
    void load();
  });

  $effect(() => {
    void githubCliStatus();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });

  async function act(label: string, fn: () => Promise<string | void>, changesFiles = false) {
    busy = label;
    try {
      const out = await fn();
      if (out) notify(out, "success");
      if (changesFiles) onChanged?.();
    } catch (e) {
      notify(`${label.replace(/…$/, "")} failed: ${(e as Error).message}`, "error");
    } finally {
      busy = null;
      await load();
    }
  }

  const pull = () => act("Pulling…", async () => (await gitPull()) || "Pulled.", true);
  const push = () => act(st?.upstream ? "Pushing…" : "Publishing branch…", async () => (await gitPush()) || "Pushed.");
  const init = () => act("Initialising git…", async () => { await gitInit(); return "Initialised a git repository on main."; });

  async function checkout(branch: string, create = false) {
    branchOpen = false;
    newBranch = "";
    await act(create ? "Creating branch…" : "Switching branch…", async () => {
      await gitCheckout(branch, create);
      return create ? `Created and switched to ${branch}.` : `Switched to ${branch}.`;
    }, true);
  }

  async function commit(e: Event) {
    e.preventDefault();
    const msg = commitMessage.trim();
    if (!msg) return;
    commitOpen = false;
    await act("Committing…", async () => {
      const sha = await gitCommit(msg, true);
      commitMessage = "";
      return `Committed ${sha.slice(0, 7)}.`;
    });
  }

  async function publish(e: Event) {
    e.preventDefault();
    publishOpen = false;
    await act("Publishing to GitHub…", async () => {
      const r = await gitPublishGitHub(repoName.trim(), visibility);
      return `Published to ${r.url}.`;
    });
  }

  function openPublish() {
    if (!repoName) repoName = name.replace(/[^A-Za-z0-9._-]+/g, "-");
  }

  async function recheckGitHub() {
    const s = await githubCliStatus(true);
    if (s.loggedIn) {
      githubOpen = false;
      publishOpen = false;
      notify(`Connected to GitHub as ${s.login}.`, "success");
    } else {
      notify(s.ghInstalled ? "Still not signed in. Run gh auth login in a terminal, then check again." : "The GitHub CLI still isn't installed.", "info");
    }
  }

  async function openRepo() {
    if (!webUrl) return;
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(webUrl);
    } catch {
      window.open(webUrl, "_blank", "noopener");
    }
  }
</script>

<div class="project-header" aria-label="Project" role="group">
  <div class="where">
    <span class="project" title={tildePath(projectRoot)}><Folder size={14} aria-hidden="true" /><span class="project-name">{name}</span></span>

    {#if st}
      <span class="sep sep-project" aria-hidden="true">·</span>
      <Popover.Root bind:open={branchOpen}>
        <Popover.Trigger>
          {#snippet child({ props })}
            <button {...props} class="chip" aria-label="Branch {st?.branch ?? 'detached'}: switch or create" title="Switch or create a branch">
              <GitBranch size={13} aria-hidden="true" /><span class="branch-name">{st?.branch ?? "detached"}</span><ChevronDown size={12} aria-hidden="true" />
            </button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content role="dialog" class="ui-popup ph-pop" align="start" sideOffset={6} collisionPadding={8} aria-label="Branches">
            <div class="pop-title">Switch branch</div>
            <ul class="branch-list">
              {#each st?.branches ?? [] as b (b)}
                <li>
                  <button class="branch-item" type="button" aria-current={b === st?.branch ? "true" : undefined} onclick={() => (b === st?.branch ? (branchOpen = false) : void checkout(b))}>
                    <span class="tick">{#if b === st?.branch}<Check size={13} />{/if}</span>{b}
                  </button>
                </li>
              {:else}
                <li class="muted">No branches until the first commit.</li>
              {/each}
            </ul>
            <form class="new-branch" onsubmit={(e) => { e.preventDefault(); if (newBranch.trim()) void checkout(newBranch.trim(), true); }}>
              <label class="visually-hidden" for="{uid}-branch">New branch name</label>
              <input id="{uid}-branch" bind:value={newBranch} placeholder="new-branch-name" spellcheck="false" autocomplete="off" />
              <button class="btn btn--sm" type="submit" disabled={!newBranch.trim()}><Plus size={13} /> Create</button>
            </form>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {#if changes > 0}
        <button class="chip changes" type="button" onclick={() => onReviewChanges?.()} aria-label="{changes} uncommitted {changes === 1 ? 'change' : 'changes'}: review" title="Review uncommitted changes">
          <span class="dot" aria-hidden="true"></span>{changes}
        </button>
      {/if}
      {#if st.ahead > 0}<span class="count" title="{st.ahead} {st.ahead === 1 ? 'commit' : 'commits'} to push"><ArrowUp size={12} aria-hidden="true" />{st.ahead}<span class="visually-hidden"> to push</span></span>{/if}
      {#if st.behind > 0}<span class="count" title="{st.behind} {st.behind === 1 ? 'commit' : 'commits'} to pull"><ArrowDown size={12} aria-hidden="true" />{st.behind}<span class="visually-hidden"> to pull</span></span>{/if}
    {:else if notRepo}
      <span class="sep sep-project" aria-hidden="true">·</span>
      <span class="muted">Not a git repository</span>
    {/if}
  </div>

  <div class="actions">
    {#if busy}
      <span class="busy" role="status"><LoaderCircle size={13} class="spin" /> {busy}</span>
    {/if}
    {#if notRepo}
      <button class="btn btn--sm" type="button" disabled={!!busy} onclick={() => void init()}>Initialise git</button>
    {:else if st}
      {#if webUrl}
        <button class="chip repo" type="button" onclick={() => void openRepo()} title="Open {webUrl}" aria-label="Open the repository {slug ?? webUrl}">
          <Github size={13} aria-hidden="true" /><span class="repo-name">{slug ?? "Repository"}</span>
        </button>
      {/if}
      {#if st.upstream}
        <button class="icon-btn" type="button" disabled={!!busy} onclick={() => void pull()} title={st.behind ? `Pull ${st.behind} commit${st.behind === 1 ? "" : "s"}` : "Pull"} aria-label="Pull"><Download size={15} /></button>
      {/if}

      <Popover.Root bind:open={commitOpen}>
        <Popover.Trigger disabled={!!busy || changes === 0}>
          {#snippet child({ props })}
            <button {...props} class="icon-btn" title={changes ? "Commit all changes" : "Nothing to commit"} aria-label="Commit"><GitCommitHorizontal size={15} /></button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content role="dialog" class="ui-popup ph-pop" align="end" sideOffset={6} collisionPadding={8} aria-label="Commit">
            <form class="pop-form" onsubmit={commit}>
              <label class="pop-title" for="{uid}-msg">Commit {changes} {changes === 1 ? "change" : "changes"} on {st.branch ?? "HEAD"}</label>
              <textarea id="{uid}-msg" rows="3" bind:value={commitMessage} placeholder="Describe the change"></textarea>
              <div class="pop-actions">
                <button class="btn btn--sm" type="button" onclick={() => { commitOpen = false; onReviewChanges?.(); }}>Review changes</button>
                <button class="btn btn--sm btn--primary" type="submit" disabled={!commitMessage.trim()}>Commit</button>
              </div>
            </form>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {#if hasRemote}
        {#if !st.upstream || st.ahead > 0}
          <button class="icon-btn" type="button" disabled={!!busy || !st.branch} onclick={() => void push()} title={st.upstream ? `Push ${st.ahead} commit${st.ahead === 1 ? "" : "s"}` : `Publish ${st.branch ?? "the branch"}`} aria-label={st.upstream ? "Push" : "Publish branch"}><CloudUpload size={15} /></button>
        {/if}
      {:else}
        <Popover.Root bind:open={publishOpen} onOpenChange={(o) => { if (o) openPublish(); }}>
          <Popover.Trigger disabled={!!busy}>
            {#snippet child({ props })}
              <button {...props} class="btn btn--sm" title="Create a GitHub repository and push"><CloudUpload size={13} /> Publish</button>
            {/snippet}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content role="dialog" class="ui-popup ph-pop" align="end" sideOffset={6} collisionPadding={8} aria-label="Publish to GitHub">
              {#if gh?.loggedIn}
                <form class="pop-form" onsubmit={publish}>
                  <label class="pop-title" for="{uid}-repo">Publish to GitHub as {gh.login}</label>
                  <input id="{uid}-repo" bind:value={repoName} spellcheck="false" autocomplete="off" />
                  <div class="vis" role="radiogroup" aria-label="Visibility">
                    <label><input type="radio" bind:group={visibility} value="private" /> Private</label>
                    <label><input type="radio" bind:group={visibility} value="public" /> Public</label>
                  </div>
                  <p class="hint">Commits everything first if there are no commits yet, then pushes {st.branch ?? "the branch"}.</p>
                  <div class="pop-actions"><button class="btn btn--sm btn--primary" type="submit" disabled={!repoName.trim()}>Publish</button></div>
                </form>
              {:else}
                {@render connectSteps()}
              {/if}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      {/if}
    {/if}

    {#if gh && !gh.loggedIn}
      <Popover.Root bind:open={githubOpen}>
        <Popover.Trigger>
          {#snippet child({ props })}
            <button {...props} class="btn btn--sm connect" title="Connect GitHub to clone private repositories, push and publish"><Github size={13} /> Connect GitHub</button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content role="dialog" class="ui-popup ph-pop" align="end" sideOffset={6} collisionPadding={8} aria-label="Connect GitHub">
            {@render connectSteps()}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    {/if}
  </div>
</div>

{#snippet connectSteps()}
  <div class="pop-form">
    <div class="pop-title">Connect GitHub</div>
    {#if gh && !gh.ghInstalled}
      <p class="hint">Pushing and publishing use the GitHub CLI, which isn't installed. Install it, then sign in:</p>
      <pre class="cmd">brew install gh
gh auth login</pre>
    {:else}
      <p class="hint">Pushing and publishing use the GitHub CLI. Sign in once in a terminal:</p>
      <pre class="cmd">gh auth login</pre>
    {/if}
    <div class="pop-actions">
      {#if onConnectGitHub}<button class="btn btn--sm" type="button" onclick={() => { githubOpen = false; publishOpen = false; onConnectGitHub?.(); }}>Settings</button>{/if}
      <button class="btn btn--sm btn--primary" type="button" onclick={() => void recheckGitHub()}><RefreshCw size={13} /> Check again</button>
    </div>
  </div>
{/snippet}

<style>
  .project-header {
    container-type: inline-size;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 8px 0 12px;
    border-bottom: 0.5px solid var(--border);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    flex-shrink: 0;
    min-width: 0;
  }
  .where {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex: 1;
    overflow: hidden;
  }
  .project {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-primary);
    font-weight: 500;
    min-width: 48px;
    flex-shrink: 1;
  }
  .where > :global(*) {
    flex-shrink: 0;
  }
  .where > .project {
    flex-shrink: 1;
  }
  .project :global(svg) {
    flex-shrink: 0;
    color: var(--text-secondary);
  }
  .project-name, .branch-name, .repo-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .branch-name {
    max-width: 140px;
  }
  .repo-name {
    max-width: 150px;
  }
  /* A narrow chat panel: the repository shows as its icon only. */
  @container (max-width: 440px) {
    .repo-name { display: none; }
    .branch-name { max-width: 110px; }
    /* The project's name is in the title bar and the sidebar; the branch matters more here. */
    .project-name, .sep-project { display: none; }
    .project { min-width: 0; }
  }
  .sep {
    color: var(--text-muted);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: var(--control-sm);
    padding: 0 6px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
    min-width: 0;
    flex-shrink: 1;
  }
  .chip:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .changes .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--yellow);
  }
  .count {
    display: inline-flex;
    align-items: center;
    gap: 1px;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .muted {
    color: var(--text-muted);
    white-space: nowrap;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }
  .busy {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-right: 4px;
    white-space: nowrap;
  }
  :global(.ph-pop) {
    width: 280px;
    padding: 10px;
  }
  .pop-title {
    display: block;
    margin: 0 0 6px;
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--text-secondary);
  }
  .branch-list {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    max-height: 220px;
    overflow-y: auto;
  }
  .branch-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: var(--control-md);
    padding: 0 6px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
    text-align: left;
  }
  .branch-item:hover, .branch-item:focus-visible {
    background: var(--bg-surface);
    outline: none;
  }
  .tick {
    display: inline-flex;
    width: 14px;
    color: var(--accent);
  }
  .new-branch, .pop-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .pop-actions {
    justify-content: flex-end;
    margin-top: 8px;
  }
  .pop-form {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  :global(.ph-pop) input:not([type="radio"]), :global(.ph-pop) textarea {
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    border: 0.5px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
    resize: vertical;
  }
  :global(.ph-pop) input:focus, :global(.ph-pop) textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .vis {
    display: flex;
    gap: 12px;
    font-size: var(--fs-sm);
    color: var(--text-primary);
  }
  .vis label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .hint {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    line-height: var(--lh-ui);
  }
  .cmd {
    margin: 0;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text-primary);
    user-select: text;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
