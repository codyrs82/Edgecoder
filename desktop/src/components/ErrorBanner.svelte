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
  .error-banner { display: flex; align-items: center; justify-content: space-between; background: #7f1d1d; color: #fca5a5; padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; }
  .error-msg { font-size: 0.9rem; }
  .retry-btn { background: rgba(255,255,255,0.15); color: #fca5a5; border: 1px solid rgba(255,255,255,0.2); padding: 0.3rem 0.8rem; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
  .retry-btn:hover { background: rgba(255,255,255,0.25); }
</style>
