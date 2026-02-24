<script lang="ts">
  interface Props {
    title: string;
    description?: string;
  }
  let { title, description }: Props = $props();
</script>

<div class="empty-state">
  <div class="empty-title">{title}</div>
  {#if description}
    <div class="empty-desc">{description}</div>
  {/if}
</div>

<style>
  .empty-state { background: var(--bg-surface, #1a1a2e); padding: 2rem; border-radius: 8px; text-align: center; }
  .empty-title { font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem; opacity: 0.8; }
  .empty-desc { font-size: 0.85rem; opacity: 0.5; max-width: 400px; margin: 0 auto; line-height: 1.5; }
</style>
