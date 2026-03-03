<script lang="ts">
  interface Props {
    id: string;
    command?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    status: "pending" | "approved" | "completed";
    onApprove?: (id: string) => void;
    onReject?: (id: string) => void;
  }
  let { id, command, stdout, stderr, exitCode, status, onApprove, onReject }: Props = $props();

  function handleApprove(e: MouseEvent) {
    e.stopPropagation();
    onApprove?.(id);
  }

  function handleReject(e: MouseEvent) {
    e.stopPropagation();
    onReject?.(id);
  }
</script>

<div class="shell-block">
  <div class="header">
    <div class="prompt-line">
      <span class="prompt">$</span>
      {#if command}
        <span class="command">{command}</span>
      {/if}
    </div>
    <div class="header-actions">
      {#if status === "pending"}
        <button class="btn run" onclick={handleApprove} type="button">Run</button>
        <button class="btn deny" onclick={handleReject} type="button">Deny</button>
      {:else if status === "completed"}
        {#if exitCode === 0 || exitCode === undefined}
          <span class="exit-badge success">&#10003;</span>
        {:else}
          <span class="exit-badge failure">exit {exitCode}</span>
        {/if}
      {/if}
    </div>
  </div>

  {#if stdout || stderr}
    <div class="body">
      {#if stdout}
        <pre class="output stdout">{stdout}</pre>
      {/if}
      {#if stderr}
        <pre class="output stderr">{stderr}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .shell-block {
    border-radius: var(--radius-sm, 6px);
    background: var(--bg-deep, #1a1a18);
    margin: 6px 0;
    overflow: hidden;
    border: 1px solid var(--border, rgba(214, 204, 194, 0.08));
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    gap: 12px;
  }

  .prompt-line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
  }

  .prompt {
    color: var(--green, #4ade80);
    font-family: var(--font-mono, monospace);
    font-size: 14px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .command {
    font-family: var(--font-mono, monospace);
    font-size: 13px;
    color: var(--text-primary, #f7f5f0);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .header-actions {
    display: flex;
    align-items: center;
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
  .btn.run {
    background: var(--green, #4ade80);
    color: #000;
  }
  .btn.deny {
    background: var(--red, #f87171);
    color: #000;
  }

  .exit-badge {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: var(--radius-sm, 6px);
  }
  .exit-badge.success {
    color: var(--green, #4ade80);
  }
  .exit-badge.failure {
    color: var(--red, #f87171);
    background: rgba(248, 113, 113, 0.1);
  }

  .body {
    border-top: 1px solid var(--border, rgba(214, 204, 194, 0.08));
    padding: 8px 12px;
    max-height: 300px;
    overflow-y: auto;
  }

  .output {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }

  .stdout {
    color: var(--text-secondary, #b8b0a4);
  }

  .stderr {
    color: var(--yellow, #fbbf24);
  }
</style>
