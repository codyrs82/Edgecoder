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
  .empty-state { background: var(--bg-surface); padding: 2rem; border-radius: 8px; text-align: center; }
  .empty-title { font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem; }
  .empty-desc { font-size: 0.85rem; max-width: 400px; margin: 0 auto; line-height: 1.5; color: var(--text-secondary); }
</style>
