<script lang="ts">
  import type { AutoRestart, AutoRestartView } from "../lib/auto-restart";

  let { controller }: { controller: AutoRestart } = $props();
  let view = $state<AutoRestartView>({ phase: "off" });

  $effect(() => controller.subscribe((v) => (view = v)));
</script>

{#if view.phase === "countdown"}
  <div class="update-countdown" role="status" aria-live="polite">
    <span class="text">Updating to EdgeCoder {view.version} — restarting in {view.secondsLeft} s</span>
    <button class="primary" onclick={() => void controller.restartNow()}>Restart now</button>
    <button onclick={() => controller.later()}>Later</button>
  </div>
{:else if view.phase === "restarting"}
  <div class="update-countdown" role="status" aria-live="polite"><span class="text">Installing the update and restarting…</span></div>
{/if}

<style>
  .update-countdown {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 1000;
    max-width: min(440px, calc(100vw - 32px));
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 12px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-lg);
    font-size: 0.82rem;
  }
  .text { flex: 1 1 200px; min-width: 0; }
  button {
    padding: 3px 12px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    font: inherit;
    font-size: 0.78rem;
  }
  button.primary { background: var(--accent-secondary); color: var(--on-accent); border-color: transparent; font-weight: 600; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
