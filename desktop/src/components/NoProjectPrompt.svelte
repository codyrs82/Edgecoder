<script lang="ts">
  // A coding chat needs a project. With none open this is the one thing the chat shows: pick a
  // recent project, or create, clone or open one. A chat that already has messages (from before
  // chats were tied to projects) gets the compact form, under its messages, to link it to one.
  import { Folder, FolderGit2, FolderOpen, FolderPlus } from "@lucide/svelte";
  import { loadRecentProjects, projectName, tildePath } from "../lib/projects";

  interface Props {
    /** The chat has messages: offer to link it rather than start one. */
    compact?: boolean;
    onPick: (root: string) => void;
    onNewProject: () => void;
    onOpenFolder: () => void;
    onClone: () => void;
  }
  let { compact = false, onPick, onNewProject, onOpenFolder, onClone }: Props = $props();
  const uid = $props.id();

  const recent = $derived(loadRecentProjects().slice(0, compact ? 4 : 6));
</script>

<section class="no-project" class:compact aria-labelledby="{uid}-title">
  {#if compact}
    <h2 id="{uid}-title">This chat isn't linked to a project</h2>
    <p>Pick one to keep going. The agent then works in its folder and repository.</p>
  {:else}
    <h2 id="{uid}-title">Pick a project to start</h2>
    <p>Coding chats work in a project: a folder and its git repository. The agent reads and edits its files, runs commands, and every change stays reviewable.</p>
  {/if}

  {#if recent.length > 0}
    <ul class="recent" aria-label="Recent projects">
      {#each recent as r (r.root)}
        <li>
          <button type="button" class="recent-row" onclick={() => onPick(r.root)}>
            <Folder size={15} aria-hidden="true" />
            <span class="name">{projectName(r.root)}</span>
            <span class="path">{tildePath(r.root)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="actions">
    <button type="button" class="btn btn--primary btn--lg" onclick={onNewProject}><FolderPlus size={15} /> New project</button>
    <button type="button" class="btn btn--lg" onclick={onClone}><FolderGit2 size={15} /> Clone from GitHub</button>
    <button type="button" class="btn btn--lg" onclick={onOpenFolder}><FolderOpen size={15} /> Open folder</button>
  </div>
</section>

<style>
  .no-project {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: 100%;
    max-width: 520px;
    margin: 0 auto;
    text-align: center;
  }
  .no-project.compact {
    max-width: none;
    align-items: stretch;
    text-align: left;
    padding: 12px 14px;
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
  }
  h2 {
    margin: 0;
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--text-primary);
  }
  .compact h2 {
    font-size: var(--fs-sm);
  }
  p {
    margin: 0 0 8px;
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text-secondary);
  }
  .compact p {
    font-size: var(--fs-xs);
    margin: 0;
  }
  .recent {
    list-style: none;
    margin: 0 0 8px;
    padding: 4px;
    width: 100%;
    border: 0.5px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
  }
  .compact .recent {
    border: none;
    padding: 0;
    margin: 4px 0;
    background: none;
  }
  .recent-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: var(--control-lg);
    padding: 0 10px;
    border: none;
    border-radius: var(--radius-md);
    background: none;
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
    text-align: left;
  }
  .recent-row:hover {
    background: var(--bg-elevated);
  }
  .recent-row:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: -2px;
  }
  .recent-row :global(svg) {
    flex-shrink: 0;
    color: var(--text-secondary);
  }
  .name {
    font-weight: 500;
    white-space: nowrap;
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    text-align: right;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }
  .compact .actions {
    justify-content: flex-start;
  }
  .compact .actions :global(.btn--lg) {
    height: var(--control-md);
  }
</style>
