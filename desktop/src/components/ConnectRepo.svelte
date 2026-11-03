<script lang="ts">
  import { onMount } from "svelte";
  import { GitBranch, LoaderCircle } from "@lucide/svelte";
  import { connectRepo, getProjectsFolder, recentRepos, type RepoConnection } from "../lib/api";

  interface Props {
    /** The repository is in place and open as the project. */
    onConnected: (r: RepoConnection) => void;
  }
  let { onConnected }: Props = $props();

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
    <label for="connect-repo-input">Connect a repository</label>
    <div class="row">
      <input
        id="connect-repo-input"
        bind:this={input}
        bind:value={repo}
        placeholder="owner/repo or https://github.com/owner/repo"
        autocomplete="off"
        spellcheck="false"
        disabled={busy}
      />
      <button type="submit" class="primary" disabled={busy || !repo.trim()}>
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
    gap: 6px;
  }
  label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .row {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  input {
    flex: 1;
    min-width: 0;
    padding: 7px 10px;
    border: 0.5px solid var(--border-strong, var(--border));
    border-radius: 8px;
    background: var(--bg-surface);
    color: var(--text-primary);
    font-size: 13px;
    font-family: var(--font-mono, monospace);
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
  }
  button.primary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    border: none;
    border-radius: 8px;
    background: var(--accent);
    color: var(--bg-base);
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
  }
  button.primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hint, .progress, .error {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted, var(--text-secondary));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .progress {
    font-family: var(--font-mono, monospace);
  }
  .error {
    color: var(--red, #e5484d);
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
    padding: 4px 10px;
    border: 0.5px solid var(--border);
    border-radius: 999px;
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }
  .chip:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--text-primary);
  }
  :global(.connect-repo .spin) {
    animation: connect-spin 1s linear infinite;
  }
  @keyframes connect-spin {
    to { transform: rotate(360deg); }
  }
</style>
