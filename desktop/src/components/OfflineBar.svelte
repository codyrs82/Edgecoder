<script lang="ts">
  // The app-wide offline bar (lib/connectivity.ts): calm, not an error. Gone when back online.
  import { WifiOff } from "@lucide/svelte";
  import { connectivity, OFFLINE_TEXT } from "../lib/connectivity";
</script>

{#if $connectivity.state === "offline"}
  <div class="offline-bar" role="status" data-testid="offline-bar">
    <WifiOff size={13} aria-hidden="true" />
    <span>{OFFLINE_TEXT}</span>
  </div>
{/if}

<style>
  .offline-bar { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 5px 14px; background: var(--bg-surface); border-bottom: 0.5px solid var(--border); color: var(--text-secondary); font-size: 12px; }
</style>
