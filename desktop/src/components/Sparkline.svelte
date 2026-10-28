<script lang="ts">
  import { areaPath, describeSeries, linePoints } from "../lib/charts";

  interface Props {
    values: number[];
    label: string;
    unit?: string;
    yMax?: number;
    height?: number;
  }
  let { values, label, unit = "", yMax, height = 40 }: Props = $props();
  const width = 300;
  let box = $derived({ width, height, yMax });
  let points = $derived(linePoints(values, box));
  let area = $derived(areaPath(values, box));
  let description = $derived(describeSeries(label, values, unit));
</script>

<svg class="sparkline" viewBox="0 0 {width} {height}" preserveAspectRatio="none" role="img" aria-label={description} style="height: {height}px">
  <title>{description}</title>
  {#if area}<path d={area} class="area" />{/if}
  {#if points}
    <polyline fill="none" points={points} class="line" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
  {/if}
</svg>

<style>
  .sparkline { width: 100%; display: block; }
  .line { stroke: var(--accent, #3b82f6); }
  .area { fill: var(--accent, #3b82f6); opacity: 0.15; }
</style>
