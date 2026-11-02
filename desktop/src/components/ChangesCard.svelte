<script lang="ts">
  import DiffModal from "./DiffModal.svelte";
  import { ideTurnChanges, ideRevertTurn, FsError, type FileChange } from "../lib/api";

  interface Props {
    turnId: string;
    /** Files the turn wrote (from its file_change events). */
    files: string[];
    /** Files were put back: reload open buffers and the tree. */
    onReverted?: () => void;
    onOpenPath?: (path: string) => void;
  }
  let { turnId, files, onReverted, onOpenPath }: Props = $props();

  let changes = $state<FileChange[] | null>(null);
  let error = $state<string | null>(null);
  let reviewing = $state<FileChange | null>(null);
  let busy = $state(false);

  async function load() {
    try {
      changes = await ideTurnChanges(turnId);
      error = null;
    } catch (e) {
      // The IDE server keeps the last 50 turns in memory; older ones (or ones from before a
      // restart) can no longer be reviewed.
      changes = null;
      error = e instanceof FsError && e.code === "unknown_turn"
        ? "These changes can no longer be reviewed or undone (the agent restarted since)."
        : (e as Error).message;
    }
  }

  $effect(() => {
    void files.length;
    void load();
  });

  function stats(c: FileChange): string {
    const a = c.before === null ? 0 : c.before.split("\n").length;
    const b = c.after === null ? 0 : c.after.split("\n").length;
    if (c.before === null) return `new, ${b} lines`;
    if (c.after === null) return "deleted";
    const d = b - a;
    return d === 0 ? "edited" : `${d > 0 ? "+" : ""}${d} lines`;
  }

  async function undo(paths?: string[]) {
    busy = true;
    try {
      await ideRevertTurn(turnId, paths);
      reviewing = null;
      onReverted?.();
      await load();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

{#if changes && changes.length > 0}
  <div class="card">
    <div class="head">
      <span>{changes.length} file{changes.length === 1 ? "" : "s"} changed</span>
      <button class="undo-all" disabled={busy} onclick={() => undo()}>Undo all</button>
    </div>
    {#each changes as c (c.path)}
      <div class="row">
        <button class="path" title="Open {c.path}" onclick={() => c.after !== null && onOpenPath?.(c.path)}>{c.path}</button>
        <span class="stat">{stats(c)}</span>
        <button disabled={busy} onclick={() => (reviewing = c)}>Review</button>
        <button disabled={busy} onclick={() => undo([c.path])}>Undo</button>
      </div>
    {/each}
  </div>
{:else if changes && changes.length === 0 && files.length > 0}
  <div class="card muted">Changes from this reply were undone.</div>
{:else if error}
  <div class="card muted">{error}</div>
{/if}

{#if reviewing}
  {@const c = reviewing}
  <DiffModal path={c.path} before={c.before} after={c.after} onClose={() => (reviewing = null)} onUndo={() => undo([c.path])} />
{/if}

<style>
  .card {
    margin: 8px 0 4px;
    border: 0.5px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    font-size: 12px;
    overflow: hidden;
  }
  .card.muted {
    padding: 8px 10px;
    color: var(--text-muted);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-bottom: 0.5px solid var(--border);
    color: var(--text-secondary);
    font-weight: 600;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
  }
  .row + .row {
    border-top: 0.5px solid var(--border);
  }
  .path {
    flex: 1;
    min-width: 0;
    text-align: left;
    border: none;
    background: none;
    padding: 0;
    color: var(--text-primary);
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .stat {
    color: var(--text-muted);
    white-space: nowrap;
  }
  button:not(.path) {
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    border: 0.5px solid var(--border);
    background: var(--bg-base);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 11px;
  }
  button:not(.path):hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--accent);
  }
  .undo-all:hover:not(:disabled) {
    border-color: var(--danger, #f85149) !important;
    color: var(--danger, #f85149) !important;
  }
</style>
