<script lang="ts">
  interface Props {
    lines?: number;
    height?: string;
  }
  let { lines = 3, height = "1.2rem" }: Props = $props();
</script>

<div class="skeleton-wrap">
  {#each Array(lines) as _, i}
    <div class="skeleton-line" style="height: {height}; width: {i === lines - 1 ? '60%' : '100%'}"></div>
  {/each}
</div>

<style>
  .skeleton-wrap { display: flex; flex-direction: column; gap: 0.5rem; }
  .skeleton-line { background: linear-gradient(90deg, #1e1e3f 25%, #2a2a4f 50%, #1e1e3f 75%); background-size: 200% 100%; border-radius: 4px; animation: shimmer 1.5s infinite; }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
</style>
