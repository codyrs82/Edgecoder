<script lang="ts">
  import { Folder, GitBranch } from "@lucide/svelte";
  interface Props {
    projectRoot: string | null;
    gitBranch: string | null;
    onOpenProject: () => void;
  }
  let { projectRoot, gitBranch, onOpenProject }: Props = $props();

  let displayPath = $derived(
    projectRoot
      ? projectRoot.replace(/^\/Users\/\w+/, "~")
      : null
  );
</script>

<div class="project-bar">
  {#if projectRoot}
    <span class="project-path" title={projectRoot}>
      <Folder size={14} />
      {displayPath}
    </span>
    {#if gitBranch}
      <span class="git-branch" title="Current branch">
        <GitBranch size={12} />
        {gitBranch}
      </span>
    {/if}
    <button class="change-btn" onclick={onOpenProject}>Change</button>
  {:else}
    <button class="open-btn" onclick={onOpenProject}>
      <Folder size={14} />
      Open Project
    </button>
  {/if}
</div>

<style>
  .project-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 16px;
    background: var(--bg-surface);
    border-bottom: 0.5px solid var(--border);
    font-size: 12px;
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .project-path {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
  }
  .git-branch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    background: var(--bg-elevated);
    border-radius: 999px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent);
  }
  .open-btn, .change-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border: 0.5px solid var(--border-strong);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 12px;
    transition: all 0.15s;
  }
  .open-btn:hover, .change-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .change-btn {
    margin-left: auto;
    padding: 2px 8px;
    font-size: 11px;
  }
</style>
