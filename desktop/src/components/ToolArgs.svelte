<script lang="ts">
  import { approvalFields } from "../lib/tool-approval";

  /** Every argument of a tool call, in full: long values wrap and scroll, they are never cut. */
  interface Props {
    tool: string;
    args: Record<string, unknown>;
  }
  let { tool, args }: Props = $props();

  let fields = $derived(approvalFields(tool, args));
</script>

<div class="tool-args" data-testid="tool-args">
  {#each fields as f (f.key)}
    <div class="arg">
      <div class="arg-label">
        <span>{f.label}</span>
        {#if f.size}<span class="arg-size">{f.size}: scroll to read all of it</span>{/if}
      </div>
      {#if f.block}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <pre class="arg-value block" tabindex="0" aria-label={f.label}>{f.value}</pre>
      {:else}
        <code class="arg-value">{f.value}</code>
      {/if}
    </div>
  {:else}
    <span class="no-args">No arguments</span>
  {/each}
</div>

<style>
  .tool-args {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .arg {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .arg-label {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .arg-size {
    font-weight: 500;
    color: var(--yellow, var(--warning, #d29922));
  }
  .arg-value {
    display: block;
    margin: 0;
    padding: 6px 9px;
    border-radius: var(--radius-sm, 6px);
    background: var(--bg-base);
    color: var(--text-primary);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    line-height: 1.5;
    /* Wrap, never clip: no nowrap, no ellipsis. */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .arg-value.block {
    max-height: 240px;
    overflow: auto;
  }
  .no-args {
    font-size: 12px;
    font-style: italic;
    color: var(--text-muted);
  }
</style>
