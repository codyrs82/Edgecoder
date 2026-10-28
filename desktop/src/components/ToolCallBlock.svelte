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
    "list_directory",
    "search_files",
    "git_status",
    "git_diff",
    "git_log",
    "git_fetch",
    "github_list_prs",
    "github_list_issues",
  ];

  let borderColor = $derived.by(() => {
    if (status === "rejected") return "var(--red)";
    if (status === "completed") return "var(--green)";
    if (status === "pending" && requiresApproval)
      return "var(--yellow)";
    if (readTools.includes(tool))
      return "var(--accent-secondary)";
    return "var(--yellow)";
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
  <button class="header" onclick={toggle} type="button" aria-expanded={expanded}>
    <span class="tool-info">
      {#if status === "executing"}
        <span class="spinner"></span>
      {:else if status === "completed"}
        <span class="icon check" role="img" aria-label="Completed">&#10003;</span>
      {:else if status === "rejected"}
        <span class="icon cross" role="img" aria-label="Rejected">&#10007;</span>
      {:else}
        <span class="dot" style="background: {borderColor}"></span>
      {/if}
      <span class="tool-name">{tool}</span>
      {#if mainArg}
        <span class="main-arg">{mainArg}</span>
      {/if}
    </span>
    <span class="chevron" class:open={expanded} aria-hidden="true">&#9656;</span>
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
    border-left: 3px solid var(--accent-secondary);
    border-radius: var(--radius-sm, 6px);
    background: var(--bg-surface);
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
    color: var(--text-primary);
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
    text-align: left;
  }
  .header:hover {
    background: var(--bg-elevated);
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
    color: var(--green);
  }
  .icon.cross {
    color: var(--red);
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
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
    color: var(--text-muted);
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chevron {
    font-size: 12px;
    color: var(--text-muted);
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
    background: color-mix(in srgb, var(--yellow) 8%, transparent);
    border-top: 1px solid var(--border);
  }
  .approval-label {
    font-size: 12px;
    color: var(--yellow);
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
    background: var(--green);
    color: var(--bg-deep);
  }
  .btn.deny {
    background: var(--red);
    color: var(--bg-deep);
  }

  .body {
    border-top: 1px solid var(--border);
    padding: 8px 12px;
  }

  .output {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 300px;
    overflow-y: auto;
    margin: 0;
  }

  .error-output {
    color: var(--red);
  }

  .placeholder {
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
