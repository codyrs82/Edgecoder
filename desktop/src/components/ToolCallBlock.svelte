<script lang="ts">
  interface Props {
    id: string;
    tool: string;
    args: Record<string, unknown>;
    requiresApproval: boolean;
    result?: string;
    error?: string;
    status: "pending" | "executing" | "completed" | "rejected";
    onApprove?: (id: string) => void;
    onReject?: (id: string) => void;
  }
  let {
    id,
    tool,
    args,
    requiresApproval,
    result,
    error,
    status,
    onApprove,
    onReject,
  }: Props = $props();

  let expanded = $state(false);

  const MAX_RESULT_LENGTH = 2000;

  const readTools = [
    "read_file",
    "glob",
    "grep",
    "search",
    "list_files",
    "find",
    "cat",
  ];

  let borderColor = $derived.by(() => {
    if (status === "rejected") return "var(--red, #f87171)";
    if (status === "completed") return "var(--green, #4ade80)";
    if (status === "pending" && requiresApproval)
      return "var(--yellow, #fbbf24)";
    if (readTools.some((t) => tool.toLowerCase().includes(t)))
      return "var(--accent-secondary, #4a90d9)";
    return "var(--accent-secondary, #4a90d9)";
  });

  let mainArg = $derived.by(() => {
    const keys = ["path", "file_path", "command", "pattern", "query", "url"];
    for (const key of keys) {
      if (args[key] && typeof args[key] === "string") {
        const val = args[key] as string;
        return val.length > 60 ? val.slice(0, 57) + "..." : val;
      }
    }
    return "";
  });

  let truncatedResult = $derived.by(() => {
    if (!result) return "";
    if (result.length > MAX_RESULT_LENGTH) {
      return result.slice(0, MAX_RESULT_LENGTH) + "\n... (truncated)";
    }
    return result;
  });

  function toggle() {
    expanded = !expanded;
  }

  function handleApprove(e: MouseEvent) {
    e.stopPropagation();
    onApprove?.(id);
  }

  function handleReject(e: MouseEvent) {
    e.stopPropagation();
    onReject?.(id);
  }
</script>

<div class="tool-call-block" style="border-left-color: {borderColor}">
  <button class="header" onclick={toggle} type="button">
    <span class="tool-info">
      {#if status === "executing"}
        <span class="spinner"></span>
      {:else if status === "completed"}
        <span class="icon check">&#10003;</span>
      {:else if status === "rejected"}
        <span class="icon cross">&#10007;</span>
      {:else}
        <span class="dot" style="background: {borderColor}"></span>
      {/if}
      <span class="tool-name">{tool}</span>
      {#if mainArg}
        <span class="main-arg">{mainArg}</span>
      {/if}
    </span>
    <span class="chevron" class:open={expanded}>&#9656;</span>
  </button>

  {#if status === "pending" && requiresApproval}
    <div class="approval-bar">
      <span class="approval-label">Approve this action?</span>
      <div class="approval-actions">
        <button class="btn allow" onclick={handleApprove} type="button"
          >Allow</button
        >
        <button class="btn deny" onclick={handleReject} type="button"
          >Deny</button
        >
      </div>
    </div>
  {/if}

  {#if expanded}
    <div class="body">
      {#if error}
        <pre class="output error-output">{error}</pre>
      {:else if truncatedResult}
        <pre class="output">{truncatedResult}</pre>
      {:else if status === "executing"}
        <span class="placeholder">Running...</span>
      {:else}
        <span class="placeholder">No output</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool-call-block {
    border-left: 3px solid var(--accent-secondary, #4a90d9);
    border-radius: var(--radius-sm, 6px);
    background: var(--bg-surface, #3a3a37);
    margin: 6px 0;
    overflow: hidden;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    color: var(--text-primary, #f7f5f0);
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
    text-align: left;
  }
  .header:hover {
    background: var(--bg-elevated, #454542);
  }

  .tool-info {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .icon {
    font-size: 13px;
    flex-shrink: 0;
    line-height: 1;
  }
  .icon.check {
    color: var(--green, #4ade80);
  }
  .icon.cross {
    color: var(--red, #f87171);
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--border-strong, rgba(214, 204, 194, 0.15));
    border-top-color: var(--accent, #3b82f6);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  .tool-name {
    font-family: var(--font-mono, monospace);
    font-weight: 600;
    white-space: nowrap;
  }

  .main-arg {
    color: var(--text-muted, #8a8478);
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chevron {
    font-size: 12px;
    color: var(--text-muted, #8a8478);
    transition: transform 0.15s ease;
    flex-shrink: 0;
    margin-left: 8px;
  }
  .chevron.open {
    transform: rotate(90deg);
  }

  .approval-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: rgba(251, 191, 36, 0.08);
    border-top: 1px solid var(--border, rgba(214, 204, 194, 0.08));
  }
  .approval-label {
    font-size: 12px;
    color: var(--yellow, #fbbf24);
    font-weight: 500;
  }
  .approval-actions {
    display: flex;
    gap: 6px;
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
  .btn.allow {
    background: var(--green, #4ade80);
    color: #000;
  }
  .btn.deny {
    background: var(--red, #f87171);
    color: #000;
  }

  .body {
    border-top: 1px solid var(--border, rgba(214, 204, 194, 0.08));
    padding: 8px 12px;
  }

  .output {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-secondary, #b8b0a4);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 300px;
    overflow-y: auto;
    margin: 0;
  }

  .error-output {
    color: var(--red, #f87171);
  }

  .placeholder {
    font-size: 12px;
    color: var(--text-muted, #8a8478);
    font-style: italic;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
