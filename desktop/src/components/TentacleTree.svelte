<script lang="ts">
  // The live session's tentacles (helper agents the lead delegates to): one row each with its
  // status, where it runs and what it cost; expand a row for the summary and patch. Cancel a
  // running one, and merge or drop a passed patch waiting for approval (any attached client).
  // Each helper call shows its own served line; the footer shows the merged totals.
  import { GitBranch, X } from "@lucide/svelte";
  import { callLines, isActive, statusLabel, whereOf, type TentacleState } from "../lib/tentacles";

  interface Props {
    tree: TentacleState;
    canAct: boolean;
    onCancel: (id: string) => void;
    onMerge: (id: string, approved: boolean) => void;
  }
  let { tree, canAct, onCancel, onMerge }: Props = $props();

  const running = $derived(tree.items.filter(isActive).length);
  const fmt = (c: number) => `${c < 10 ? c.toFixed(1) : Math.round(c)} cSats`;
</script>

{#if tree.items.length}
  <details class="tentacles" open={running > 0}>
    <summary>
      <GitBranch size={12} />
      Tentacles · {running} running · {fmt(tree.spentCSats)}
    </summary>
    <ul>
      {#each tree.items as t (t.id)}
        <li class="row" data-status={t.status}>
          <details>
            <summary>
              <span class="dot" aria-hidden="true"></span>
              <span class="task" title={t.task}>{t.task}</span>
              <span class="meta">{statusLabel(t)} · {whereOf(t)} · {fmt(t.cSats)}</span>
              {#if isActive(t)}<span class="progress">{t.progress}</span>{/if}
            </summary>
            {#each callLines(t) as line, i (i)}<p class="served">↳ {line}</p>{/each}
            {#if t.result}
              {#if t.result.summary}<p class="summary">{t.result.summary}</p>{/if}
              {#if t.result.unverified}<p class="err">{t.result.unverified}</p>{/if}
              {#if t.result.error || t.merge?.error}<p class="err">{t.result.error ?? t.merge?.error}</p>{/if}
              {#if t.result.patch}<pre class="patch">{t.result.patch}</pre>{/if}
            {/if}
          </details>
          {#if canAct && isActive(t)}
            <button class="btn btn--sm" type="button" title="Cancel this tentacle" onclick={() => onCancel(t.id)}><X size={12} /></button>
          {/if}
          {#if canAct && t.merge?.state === "awaiting_approval"}
            <button class="btn btn--sm btn--primary" type="button" onclick={() => onMerge(t.id, true)}>Merge</button>
            <button class="btn btn--sm" type="button" onclick={() => onMerge(t.id, false)}>Drop</button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if tree.totals}
      <p class="totals" title={`This session's helpers: ${tree.totals.session}`}>Helpers merged: {tree.totals.batch}</p>
    {/if}
  </details>
{/if}

<style>
  .served,
  .totals {
    margin: 2px 0 0;
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-xs);
    color: var(--text-tertiary, var(--text-secondary));
    overflow-wrap: anywhere;
  }
  .tentacles {
    padding: 4px 16px 6px;
    border-bottom: 0.5px solid var(--border);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .tentacles > summary {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  ul {
    list-style: none;
    margin: 4px 0 0;
    padding: 0 0 0 10px;
    border-left: 1px solid var(--border);
    max-height: 30vh;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 2px 0;
  }
  .row > details {
    flex: 1;
    min-width: 0;
  }
  .row summary {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    min-width: 0;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }
  .row[data-status="running"] .dot,
  .row[data-status="verifying"] .dot {
    background: var(--accent, var(--green));
  }
  .row[data-status="passed"] .dot {
    background: var(--green);
  }
  .row[data-status="failed"] .dot,
  .row[data-status="error"] .dot {
    background: var(--red);
  }
  .task {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary, inherit);
  }
  .meta,
  .progress {
    white-space: nowrap;
    color: var(--text-muted);
  }
  .progress {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .summary,
  .err {
    margin: 4px 0;
    white-space: pre-wrap;
  }
  .err {
    color: var(--red);
  }
  .patch {
    margin: 4px 0;
    max-height: 240px;
    overflow: auto;
    font-size: var(--fs-2xs);
    background: var(--bg-subtle, transparent);
  }
</style>
