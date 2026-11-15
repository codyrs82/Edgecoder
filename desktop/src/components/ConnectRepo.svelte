<script lang="ts">
  import { onMount } from "svelte";
  import { GitBranch, LoaderCircle } from "@lucide/svelte";
  import { connectRepo, getProjectsFolder, recentRepos, type RepoConnection } from "../lib/api";

  interface Props {
    /** The repository is in place and open as the project. */
    onConnected: (r: RepoConnection) => void;
  }
  let { onConnected }: Props = $props();
  const uid = $props.id();
  const inputId = `${uid}-repo`;

  let repo = $state("");
  let busy = $state(false);
  let progress = $state<string | null>(null);
  let error = $state<string | null>(null);
  let recent = $state<string[]>([]);
  let folder = $state<string | null>(null);
  let input: HTMLInputElement | undefined = $state(undefined);

  export function focus() {
    input?.focus();
  }

  onMount(() => {
    getProjectsFolder().then((f) => (folder = f.path)).catch(() => {});
    recentRepos().then((r) => (recent = r.repos ?? [])).catch(() => {});
  });

  const tilde = (p: string) => p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");

  async function connect(value = repo) {
    const r = value.trim();
    if (!r || busy) return;
    busy = true;
    error = null;
    progress = "Connecting…";
    try {
      const result = await connectRepo(r, (line) => (progress = line));
      repo = "";
      onConnected(result);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
      progress = null;
    }
  }
</script>

<div class="connect-repo">
  <form onsubmit={(e) => { e.preventDefault(); void connect(); }}>
    <label for={inputId}>Connect a repository</label>
    <div class="row">
      <input
        id={inputId}
        bind:this={input}
        bind:value={repo}
        placeholder="owner/repo or https://github.com/owner/repo"
        autocomplete="off"
        spellcheck="false"
        disabled={busy}
      />
      <button type="submit" class="btn btn--lg" disabled={busy || !repo.trim()}>
        {#if busy}<LoaderCircle size={13} class="spin" />{:else}<GitBranch size={13} />{/if}
        Connect
      </button>
    </div>
  </form>
  {#if progress}
    <p class="progress" aria-live="polite">{progress}</p>
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if folder}
    <p class="hint">Cloned into {tilde(folder)}, or updated if it's already there. Your local changes are never touched.</p>
  {/if}
  {#if recent.length > 0}
    <div class="recent" aria-label="Your recent GitHub repositories">
      {#each recent as r (r)}
        <button type="button" class="chip" disabled={busy} title="Connect {r}" onclick={() => void connect(r)}>{r}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .connect-repo {
    width: 100%;
    max-width: 520px;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  label {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-primary);
  }
  .row {
    display: flex;
    gap: 8px;
  }
  input {
    flex: 1;
    min-width: 0;
    height: var(--control-lg);
    padding: 0 10px;
    border: 0.5px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: var(--fs-sm);
    font-family: inherit;
  }
  input::placeholder {
    color: var(--text-muted);
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .hint, .progress, .error {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .progress {
    font-family: var(--font-mono);
  }
  .error {
    color: var(--red);
    white-space: normal;
  }
  .recent {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-height: 120px;
    overflow-y: auto;
  }
  .chip {
    height: var(--control-sm);
    padding: 0 10px;
    border: 0.5px solid var(--border-strong);
    border-radius: 999px;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .chip:hover:not(:disabled) {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }
  :global(.connect-repo .spin) {
    animation: connect-spin 1s linear infinite;
  }
  @keyframes connect-spin {
    to { transform: rotate(360deg); }
  }
</style>
