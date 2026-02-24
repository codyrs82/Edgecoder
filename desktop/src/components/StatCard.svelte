<script lang="ts">
  interface Props {
    label: string;
    value: string | number;
    color?: string;
    progress?: number;
  }
  let { label, value, color, progress }: Props = $props();
</script>

<div class="stat-card">
  <span class="label">{label}</span>
  <span class="value" style={color ? `color: ${color}` : ""}>{value}</span>
  {#if progress !== undefined}
    <div class="progress-track">
      <div class="progress-fill" style="width: {Math.min(progress, 100)}%"></div>
    </div>
  {/if}
</div>

<style>
  .stat-card { background: var(--bg-card, #1a1a2e); padding: 1.2rem; border-radius: 8px; }
  .label { display: block; font-size: 0.85rem; opacity: 0.7; margin-bottom: 0.3rem; }
  .value { font-size: 1.6rem; font-weight: 600; }
  .progress-track { margin-top: 0.6rem; height: 4px; background: #2d2d5f; border-radius: 2px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent, #3b82f6); border-radius: 2px; transition: width 0.3s ease; }
</style>
