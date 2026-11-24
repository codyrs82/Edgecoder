<script lang="ts">
  // "context ~42K tokens" next to the model picker (compaction.ts): how big the chat's prompt has
  // grown, shown from 10K tokens on. Clicking it compacts the conversation now (same as /compact).
  import { contextLabel, METER_MIN } from "../lib/compaction";

  interface Props {
    tokens: number;
    onCompact?: () => void;
    busy?: boolean;
    disabled?: boolean;
    /** A short word after a manual compaction ("Nothing to compact yet"). */
    note?: string | null;
  }
  let { tokens, onCompact, busy = false, disabled = false, note = null }: Props = $props();
</script>

{#if busy}
  <span class="meter" role="status">Compacting…</span>
{:else if note}
  <span class="meter" role="status">{note}</span>
{:else if tokens > METER_MIN}
  {#if onCompact}
    <button type="button" class="meter" {disabled} onclick={onCompact} aria-label="Compact conversation ({contextLabel(tokens)})" title="Compact conversation: summarize earlier messages to save tokens (or type /compact)">{contextLabel(tokens)}</button>
  {:else}
    <span class="meter">{contextLabel(tokens)}</span>
  {/if}
{/if}

<style>
  .meter {
    display: inline-flex;
    align-items: center;
    height: var(--control-sm);
    padding: 0 6px;
    border: none;
    background: none;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font: inherit;
    font-size: var(--fs-xs);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  button.meter {
    cursor: pointer;
  }
  button.meter:hover:not(:disabled) {
    background: var(--bg-elevated);
    color: var(--text-secondary);
  }
</style>
