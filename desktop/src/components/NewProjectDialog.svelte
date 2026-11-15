<script lang="ts">
  // New project: a name and a location (the projects folder by default), then start empty, from a
  // template, or by cloning a GitHub repository. Optionally initialise git and publish to GitHub.
  // It ends with the project open; the caller starts a chat in it.
  import { onMount } from "svelte";
  import { LoaderCircle, Search } from "@lucide/svelte";
  import Dialog from "./ui/Dialog.svelte";
  import Select from "./ui/Select.svelte";
  import {
    connectRepo, getProjectsFolder, gitClone, gitPublishGitHub, ideCreateProject, recentRepos,
    type GitHubCliStatus, type ProjectTemplate,
  } from "../lib/api";
  import { folderNameFrom, tildePath, type CreatedProject } from "../lib/projects";

  interface Props {
    /** Start on "Clone from GitHub". */
    mode?: "new" | "clone";
    onClose: () => void;
    onCreated: (p: CreatedProject) => void;
    /** Opens Settings → Integrations (connecting the GitHub CLI). */
    onConnectGitHub?: () => void;
  }
  let { mode = "new", onClose, onCreated, onConnectGitHub }: Props = $props();
  const uid = $props.id();

  type Source = ProjectTemplate | "clone";
  const SOURCES: Array<{ value: Source; label: string; desc: string }> = [
    { value: "empty", label: "Empty", desc: "An empty folder" },
    { value: "web", label: "Website", desc: "index.html, styles, script" },
    { value: "node", label: "Node.js", desc: "package.json and index.js" },
    { value: "clone", label: "Clone from GitHub", desc: "An existing repository" },
  ];

  // svelte-ignore state_referenced_locally (the starting tab only)
  let source = $state<Source>(mode === "clone" ? "clone" : "empty");
  let name = $state("");
  let repo = $state("");
  let repoFilter = $state("");
  let defaultFolder = $state<string | null>(null);
  /** Chosen location; null = the projects folder. */
  let location = $state<string | null>(null);
  let initGit = $state(true);
  let publish = $state(false);
  let visibility = $state<"private" | "public">("private");
  let gh = $state<GitHubCliStatus | null>(null);
  let repos = $state<string[]>([]);
  let busy = $state(false);
  let progress = $state<string | null>(null);
  let error = $state<string | null>(null);
  let nameInput: HTMLInputElement | undefined = $state();
  let repoInput: HTMLInputElement | undefined = $state();

  const folder = $derived(folderNameFrom(name));
  const where = $derived(location ?? defaultFolder);
  const filteredRepos = $derived(repoFilter.trim() ? repos.filter((r) => r.toLowerCase().includes(repoFilter.trim().toLowerCase())) : repos);
  const canCreate = $derived(!busy && (source === "clone" ? repo.trim().length > 0 : folder.length > 0) && (!publish || gh?.loggedIn === true));

  onMount(() => {
    getProjectsFolder().then((f) => (defaultFolder = f.path)).catch(() => {});
    recentRepos()
      .then((r) => {
        gh = { ghInstalled: r.ghInstalled, loggedIn: r.loggedIn, login: r.login };
        repos = r.repos ?? [];
      })
      .catch(() => (gh = { ghInstalled: false, loggedIn: false, login: null }));
  });

  async function chooseLocation() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, title: "Choose where the project goes", defaultPath: where ?? undefined });
      if (typeof picked === "string") location = picked;
    } catch (e) {
      error = `Couldn't open the folder picker: ${(e as Error).message}`;
    }
  }

  async function create(e?: Event) {
    e?.preventDefault();
    if (!canCreate) return;
    busy = true;
    error = null;
    try {
      if (source === "clone") {
        const url = repo.trim();
        let root: string;
        let summary: string;
        if (location && location !== defaultFolder) {
          progress = "Cloning…";
          root = await gitClone(url, location);
          summary = `Cloned **${url}** into \`${tildePath(root)}\`.`;
        } else {
          progress = "Connecting…";
          const r = await connectRepo(url, (line) => (progress = line));
          root = r.path;
          summary = `${r.action === "cloned" ? "Cloned" : "Opened"} **${r.name}**${r.branch ? ` on \`${r.branch}\`` : ""} in \`${tildePath(r.path)}\`. ${r.action === "updated" ? r.message : ""}`.trim();
        }
        onCreated({ root, summary });
        return;
      }
      progress = "Creating the project…";
      const root = await ideCreateProject({ folder, ...(location && location !== defaultFolder ? { parentDir: location } : {}), template: source, git: initGit || publish });
      const made = `New project **${folder}** in \`${tildePath(root)}\`${source !== "empty" ? ` from the ${SOURCES.find((s) => s.value === source)?.label} template` : ""}.`;
      if (publish) {
        progress = "Publishing to GitHub…";
        try {
          const r = await gitPublishGitHub(folder, visibility);
          onCreated({ root, summary: `${made} Published to ${r.url}.` });
        } catch (err) {
          onCreated({ root, summary: made, warning: `The project was created, but publishing to GitHub failed: ${(err as Error).message}` });
        }
        return;
      }
      onCreated({ root, summary: made });
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
      progress = null;
    }
  }
</script>

<Dialog labelledby="{uid}-title" width="600px" {onClose} initialFocus={() => (source === "clone" ? repoInput : nameInput)}>
  <form class="sp np" onsubmit={create}>
    <h1 id="{uid}-title">New project</h1>
    <p class="sp-lead">A folder for your code. Chats you start in it can read and edit its files and use its git repository.</p>

    <div class="sp-group">
      <div class="sp-group-title" id="{uid}-source">Start from</div>
      <div class="sources" role="radiogroup" aria-labelledby="{uid}-source">
        {#each SOURCES as s (s.value)}
          <label class="source" class:checked={source === s.value}>
            <input type="radio" name="{uid}-source" value={s.value} bind:group={source} disabled={busy} />
            <span class="source-label">{s.label}</span>
            <span class="source-desc">{s.desc}</span>
          </label>
        {/each}
      </div>
    </div>

    <div class="sp-group">
      <div class="sp-card">
        {#if source === "clone"}
          <label class="sp-row stack">
            <span class="sp-text"><span class="sp-title">Repository</span><span class="sp-desc">owner/repo, or an https or SSH URL.</span></span>
            <input type="text" bind:this={repoInput} bind:value={repo} placeholder="owner/repo or https://github.com/owner/repo" spellcheck="false" autocomplete="off" disabled={busy} />
          </label>
          {#if gh?.loggedIn && repos.length > 0}
            <div class="sp-row stack">
              <span class="sp-text"><span class="sp-title" id="{uid}-repos">Your repositories</span><span class="sp-desc">Signed in to GitHub as {gh.login}.</span></span>
              {#if repos.length > 6}
                <div class="filter">
                  <Search size={13} aria-hidden="true" />
                  <input type="text" bind:value={repoFilter} placeholder="Filter" aria-label="Filter your repositories" />
                </div>
              {/if}
              <ul class="repo-list" aria-labelledby="{uid}-repos">
                {#each filteredRepos as r (r)}
                  <li><button type="button" class="repo" class:picked={repo === r} aria-pressed={repo === r} disabled={busy} onclick={() => (repo = r)}>{r}</button></li>
                {:else}
                  <li class="sp-muted">No repository matches.</li>
                {/each}
              </ul>
            </div>
          {:else if gh && !gh.loggedIn}
            <div class="sp-row">
              <span class="sp-text"><span class="sp-desc">{gh.ghInstalled ? "Sign in to GitHub to pick from your repositories." : "Install the GitHub CLI to pick from your repositories and publish."}</span></span>
              {#if onConnectGitHub}<button type="button" onclick={onConnectGitHub}>Connect GitHub</button>{/if}
            </div>
          {/if}
        {:else}
          <label class="sp-row">
            <span class="sp-text"><span class="sp-title">Name</span>{#if name && folder !== name.trim()}<span class="sp-desc">Folder: {folder || "(letters, numbers, dots, dashes)"}</span>{/if}</span>
            <input type="text" bind:this={nameInput} bind:value={name} placeholder="my-website" maxlength="100" spellcheck="false" autocomplete="off" disabled={busy} required />
          </label>
        {/if}
        <div class="sp-row">
          <span class="sp-text"><span class="sp-title">Location</span><span class="sp-desc" title={where ?? ""}>{where ? tildePath(where) : "Your projects folder"}{source === "clone" && !location ? " (an existing copy is updated, never overwritten)" : ""}</span></span>
          <div class="sp-controls">
            {#if location}<button type="button" class="ghost" onclick={() => (location = null)} disabled={busy}>Reset</button>{/if}
            <button type="button" onclick={() => void chooseLocation()} disabled={busy}>Change…</button>
          </div>
        </div>
        {#if source !== "clone"}
          <label class="sp-row">
            <span class="sp-text"><span class="sp-title">Initialise git</span><span class="sp-desc">A repository on main, so you can commit, branch and undo.</span></span>
            <input type="checkbox" class="check" bind:checked={initGit} disabled={busy || publish} />
          </label>
          <div class="sp-row">
            <label class="sp-text" for="{uid}-publish"><span class="sp-title">Publish to GitHub</span>
              <span class="sp-desc">
                {#if gh?.loggedIn}Create {gh.login}/{folder || "name"} and push the first commit.
                {:else if gh && !gh.ghInstalled}Needs the GitHub CLI: install it, then sign in.
                {:else if gh}Sign in to GitHub first.
                {:else}Checking GitHub…{/if}
              </span>
            </label>
            <div class="sp-controls">
              {#if publish}
                <Select bind:value={visibility} ariaLabel="Repository visibility" class="ui-select--sm" options={[{ value: "private", label: "Private" }, { value: "public", label: "Public" }]} />
              {/if}
              {#if gh && !gh.loggedIn && onConnectGitHub}
                <button type="button" onclick={onConnectGitHub}>Connect GitHub</button>
              {/if}
              <input id="{uid}-publish" type="checkbox" class="check" bind:checked={publish} disabled={busy || !gh?.loggedIn} />
            </div>
          </div>
        {/if}
      </div>
    </div>

    {#if progress}
      <p class="status" aria-live="polite"><LoaderCircle size={14} class="spin" /> {progress}</p>
    {:else if error}
      <p class="sp-err status" role="alert">{error}</p>
    {/if}

    <div class="actions">
      <button type="button" class="ghost" onclick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" class="primary" disabled={!canCreate}>{source === "clone" ? "Clone and open" : "Create project"}</button>
    </div>
  </form>
</Dialog>

<style>
  .np {
    padding: 28px 28px 24px;
    gap: 20px;
  }
  .sources {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 8px;
  }
  .source {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 12px;
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
    cursor: pointer;
  }
  .source.checked {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .source:focus-within {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
  .source input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .source-label {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-primary);
  }
  .source-desc {
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    line-height: var(--lh-tight);
  }
  .np input[type="text"] {
    min-width: 0;
    width: 260px;
    max-width: 100%;
  }
  .np .stack input[type="text"] {
    width: 100%;
  }
  .check {
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
    flex-shrink: 0;
  }
  .filter {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
  }
  .repo-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 168px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .np .repo {
    width: 100%;
    justify-content: flex-start;
    border-color: transparent;
    background: none;
    font-weight: 400;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  .np .repo:hover:not(:disabled) {
    border-color: transparent;
    background: var(--bg-elevated);
  }
  .np .repo.picked {
    background: var(--bg-elevated);
    border-color: var(--accent);
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
