<script lang="ts">
  import type { EditorFile } from "../lib/editor-store";

  interface Props {
    files: EditorFile[];
    activeFile: string | null;
    onSelect: (path: string) => void;
  }
  let { files, activeFile, onSelect }: Props = $props();
</script>

<div class="explorer">
  <div class="explorer-header">FILES</div>
  {#if files.length === 0}
    <div class="empty">No files open</div>
  {:else}
    {#each files as file}
      <button
        class="file-item {activeFile === file.path ? 'active' : ''}"
        onclick={() => onSelect(file.path)}
      >
        <span class="filename">{file.path.split("/").pop()}</span>
        {#if file.dirty}
          <span class="dot">*</span>
        {/if}
      </button>
    {/each}
  {/if}
</div>

<style>
  .explorer {
    width: 100%;
    height: 100%;
    overflow-y: auto;
    padding: 8px 0;
  }
  .explorer-header {
    padding: 4px 16px 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.05em;
  }
  .empty {
    padding: 16px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .file-item {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 4px 16px;
    border: none;
    background: none;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.1s;
  }
  .file-item:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .file-item.active {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .filename {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    color: var(--accent);
    font-weight: bold;
  }
</style>
