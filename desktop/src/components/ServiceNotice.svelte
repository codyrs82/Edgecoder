<script lang="ts">
  // The one notice for EdgeCoder's local service (lib/service-status.ts), shown by every page that
  // calls it. Starting or restarting: a neutral spinner line, never red, while the shell restarts
  // it. Failed (no answer for about a minute in spite of the automatic restarts): one message with
  // Restart now (stops and starts it at once) and View log (the last lines of ~/.edgecoder/agent.log).
  import { serviceStatus, restartServiceNow, STARTING_TEXT, FAILED_TEXT } from "../lib/service-status";
  import { readServiceLog } from "../lib/api";
  import { redactText } from "../lib/redact";
  import { scrollRegion } from "../lib/scroll-region";

  interface Props {
    /** Show the starting line even though the shared status says ready (e.g. the page found the agent missing; the probes catch up). */
    starting?: boolean;
  }
  let { starting = false }: Props = $props();

  let log = $state<string | null>(null);
  let logOpen = $state(false);
  let restarting = $state(false);

  async function restart(): Promise<void> {
    restarting = true;
    logOpen = false;
    try {
      await restartServiceNow();
    } finally {
      restarting = false;
    }
  }

  async function viewLog(): Promise<void> {
    logOpen = !logOpen;
    if (!logOpen) return;
    try {
      log = redactText(await readServiceLog()) || "The log is empty.";
    } catch (e) {
      log = e instanceof Error ? e.message : String(e);
    }
  }
</script>

{#if $serviceStatus.phase === "starting" || $serviceStatus.phase === "restarting" || (starting && $serviceStatus.phase === "ready")}
  <div class="svc-wait" role="status" data-testid="service-starting">
    <span class="spinner" aria-hidden="true"></span>
    <span>{STARTING_TEXT}</span>
  </div>
{:else if $serviceStatus.phase === "failed"}
  <div class="svc-failed" role="alert" data-testid="service-failed">
    <div class="row">
      <span class="msg">{FAILED_TEXT}</span>
      <span class="actions">
        <button type="button" onclick={restart} disabled={restarting}>{restarting ? "Restarting…" : "Restart now"}</button>
        <button type="button" onclick={viewLog} aria-expanded={logOpen}>{logOpen ? "Hide log" : "View log"}</button>
      </span>
    </div>
    {#if logOpen && log !== null}
      <pre class="log" data-testid="service-log" role="group" aria-label="Last lines of EdgeCoder's log" use:scrollRegion>{log}</pre>
    {/if}
  </div>
{/if}

<style>
  .svc-wait { display: flex; align-items: center; gap: 0.6rem; padding: 0.75rem 1rem; margin-bottom: 1rem; border: 0.5px solid var(--border); border-radius: 8px; background: var(--bg-surface); color: var(--text-secondary); font-size: 0.9rem; }
  .spinner { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text-secondary) 30%, transparent); border-top-color: var(--text-secondary); animation: svc-spin 0.9s linear infinite; }
  @keyframes svc-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .svc-failed { padding: 0.75rem 1rem; margin-bottom: 1rem; border: 1px solid color-mix(in srgb, var(--yellow) 45%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--yellow) 8%, var(--bg-surface)); color: var(--text-primary); font-size: 0.9rem; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
  .actions { display: flex; gap: 0.5rem; }
  .actions button { background: color-mix(in srgb, var(--text-primary) 12%, transparent); color: var(--text-primary); border: 1px solid var(--border-control); padding: 0.3rem 0.8rem; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
  .actions button:disabled { opacity: 0.6; cursor: default; }
  .log { margin: 0.75rem 0 0; max-height: 16rem; overflow: auto; padding: 0.5rem; border-radius: 6px; background: var(--bg-base, var(--bg-surface)); border: 0.5px solid var(--border); font-size: 11.5px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
</style>
