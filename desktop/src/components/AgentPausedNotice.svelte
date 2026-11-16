<script lang="ts">
  // Shown instead of "Not connected" when the network refused this machine's agent (lib/agent-paused.ts).
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import { pausedReasonText, reviewMailto, thisMachineLabel } from "../lib/agent-paused";

  let { reason, agentId, onRetry }: { reason: string; agentId?: string; onRetry?: () => void } = $props();
</script>

<div class="sp-card agent-paused" role="alert">
  <div class="sp-row">
    <div class="sp-text">
      <span class="sp-title">{thisMachineLabel()} was paused by the network's safety check</span>
      <span class="sp-desc">Reason: {pausedReasonText(reason)}. It doesn't take network work, and Compute and Usage are unavailable until the pause is lifted. Automatic pauses lift by themselves after a while; if you think this is a mistake, ask for a review.</span>
    </div>
    <div class="actions">
      <button class="primary" onclick={() => void openUrl(reviewMailto(reason, agentId))}>Request review</button>
      {#if onRetry}<button onclick={onRetry}>Retry</button>{/if}
    </div>
  </div>
</div>

<style>
  .agent-paused { border-left: 3px solid var(--danger); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
