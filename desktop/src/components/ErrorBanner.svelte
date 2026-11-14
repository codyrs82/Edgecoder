<script lang="ts">
  interface Props {
    message: string;
    onRetry?: () => void;
  }
  let { message, onRetry }: Props = $props();
</script>

<div class="error-banner">
  <span class="error-msg">{message}</span>
  {#if onRetry}
    <button class="retry-btn" onclick={onRetry}>Retry</button>
  {/if}
</div>

<style>
  .error-banner { display: flex; align-items: center; justify-content: space-between; background: color-mix(in srgb, var(--red) 14%, var(--bg-surface)); color: var(--text-primary); border: 1px solid color-mix(in srgb, var(--red) 45%, transparent); padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; }
  .error-msg { font-size: 0.9rem; }
  .retry-btn { background: color-mix(in srgb, var(--text-primary) 15%, transparent); color: var(--text-primary); border: 1px solid var(--border-control); padding: 0.3rem 0.8rem; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
  .retry-btn:hover { background: color-mix(in srgb, var(--text-primary) 25%, transparent); }
</style>
