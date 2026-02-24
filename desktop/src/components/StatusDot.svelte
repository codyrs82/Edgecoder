<script lang="ts">
  interface Props {
    status: "online" | "degraded" | "offline" | "unknown";
    label?: string;
  }
  let { status, label }: Props = $props();
</script>

<span class="status-dot-wrap">
  <span class="dot {status}"></span>
  {#if label}<span class="dot-label">{label}</span>{/if}
</span>

<style>
  .status-dot-wrap { display: inline-flex; align-items: center; gap: 0.4rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot.online { background: var(--green, #4ade80); box-shadow: 0 0 4px var(--green, #4ade80); }
  .dot.degraded { background: var(--yellow, #fbbf24); box-shadow: 0 0 4px var(--yellow, #fbbf24); }
  .dot.offline { background: var(--red, #f87171); box-shadow: 0 0 4px var(--red, #f87171); }
  .dot.unknown { background: #64748b; }
  .dot-label { font-size: 0.8rem; color: var(--text-muted, #94a3b8); }
</style>
