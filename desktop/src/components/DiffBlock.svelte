<script lang="ts">
  interface Hunk {
    content: string;
  }

  interface Props {
    id: string;
    file: string;
    hunks: Array<Hunk>;
    onAccept?: (id: string) => void;
    onReject?: (id: string) => void;
    status: "pending" | "accepted" | "rejected";
  }
  let { id, file, hunks, onAccept, onReject, status }: Props = $props();

  let lines = $derived.by(() => {
    const all: Array<{ text: string; type: "add" | "remove" | "context" | "header" }> = [];
    for (const hunk of hunks) {
      for (const raw of hunk.content.split("\n")) {
        if (raw.startsWith("@@")) {
          all.push({ text: raw, type: "header" });
        } else if (raw.startsWith("+")) {
          all.push({ text: raw, type: "add" });
        } else if (raw.startsWith("-")) {
          all.push({ text: raw, type: "remove" });
        } else {
          all.push({ text: raw, type: "context" });
        }
      }
    }
    return all;
  });

  function handleAccept(e: MouseEvent) {
    e.stopPropagation();
    onAccept?.(id);
  }

  function handleReject(e: MouseEvent) {
    e.stopPropagation();
    onReject?.(id);
  }
</script>

<div class="diff-block">
  <div class="header">
    <span class="file-path">{file}</span>
    <div class="header-actions">
      {#if status === "pending"}
        <button class="btn accept" onclick={handleAccept} type="button">Accept</button>
        <button class="btn reject" onclick={handleReject} type="button">Reject</button>
      {:else if status === "accepted"}
        <span class="status-label applied">Applied</span>
      {:else if status === "rejected"}
        <span class="status-label rejected">Rejected</span>
      {/if}
    </div>
  </div>

  <div class="body">
    {#each lines as line}
      <div class="diff-line {line.type}">{line.text}</div>
    {/each}
  </div>
</div>

<style>
  .diff-block {
    border-radius: var(--radius-sm, 6px);
    background: var(--bg-surface);
    margin: 6px 0;
    overflow: hidden;
    border: 1px solid var(--border);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
  }

  .file-path {
    font-family: var(--font-mono, monospace);
    font-size: 13px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .header-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .btn {
    padding: 3px 12px;
    border-radius: var(--radius-sm, 6px);
    border: none;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .btn:hover {
    opacity: 0.85;
  }
  .btn.accept {
    background: var(--green);
    color: var(--bg-deep);
  }
  .btn.reject {
    background: var(--red);
    color: var(--bg-deep);
  }

  .status-label {
    font-size: 12px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: var(--radius-sm, 6px);
  }
  .status-label.applied {
    color: var(--green);
    background: color-mix(in srgb, var(--green) 10%, transparent);
  }
  .status-label.rejected {
    color: var(--red);
    background: color-mix(in srgb, var(--red) 10%, transparent);
  }

  .body {
    max-height: 400px;
    overflow-y: auto;
    padding: 4px 0;
  }

  .diff-line {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    line-height: 1.6;
    padding: 0 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .diff-line.add {
    color: var(--green);
    background: color-mix(in srgb, var(--green) 8%, transparent);
  }
  .diff-line.remove {
    color: var(--red);
    background: color-mix(in srgb, var(--red) 8%, transparent);
  }
  .diff-line.context {
    color: var(--text-muted);
  }
  .diff-line.header {
    color: var(--accent-secondary);
    font-weight: 500;
  }
</style>
