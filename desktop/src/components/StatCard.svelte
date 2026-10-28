<script lang="ts">
  import type { Snippet } from "svelte";
  import { clampPercent } from "../lib/charts";

  interface Props {
    label: string;
    value: string | number;
    color?: string;
    progress?: number;
    /** Optional chart (e.g. a Sparkline) under the value. */
    children?: Snippet;
  }
  let { label, value, color, progress, children }: Props = $props();
  const id = `stat-${Math.random().toString(36).slice(2, 9)}`;
  let pct = $derived(progress === undefined ? undefined : clampPercent(progress));
</script>

<div class="stat-card" role="group" aria-labelledby={id}>
  <span class="label" {id}>{label}</span>
  <span class="value" style={color ? `color: ${color}` : ""}>{value}</span>
  {#if pct !== undefined}
    <div class="progress-track" role="progressbar" aria-labelledby={id} aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}>
      <div class="progress-fill" style="width: {pct}%"></div>
    </div>
  {/if}
  {#if children}<div class="chart">{@render children()}</div>{/if}
</div>

<style>
  .stat-card { background: var(--bg-surface, #1a1a2e); padding: 1.2rem; border-radius: 8px; }
  .label { display: block; font-size: 0.85rem; opacity: 0.7; margin-bottom: 0.3rem; }
  .value { font-size: 1.6rem; font-weight: 600; }
  .progress-track { margin-top: 0.6rem; height: 4px; background: #2d2d5f; border-radius: 2px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent, #3b82f6); border-radius: 2px; transition: width 0.3s ease; }
  .chart { margin-top: 0.6rem; }
  @media (prefers-reduced-motion: reduce) { .progress-fill { transition: none; } }
</style>
