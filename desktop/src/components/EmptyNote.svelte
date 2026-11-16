<script lang="ts">
  // An empty state inside a settings card: what is missing and what would appear here.
  let { title, description }: { title: string; description?: string } = $props();
</script>

<div class="sp-row empty-note">
  <div class="sp-text">
    <span class="sp-title">{title}</span>
    {#if description}<span class="sp-desc">{description}</span>{/if}
  </div>
</div>

<style>
  .empty-note { min-height: 64px; }
</style>
