<script lang="ts">
  // A paid reply's cost check (src/apps/ide/cost-guard.ts): the turn waits here once the reply has
  // spent the limit from Settings → General. Keep going, Switch to the cheaper model (the same
  // reply carries on there), or Stop. Answered: one quiet line with what was chosen.
  import { CircleDollarSign } from "@lucide/svelte";
  import { costCheckArgs } from "../lib/cost-check";

  type Choice = "continue" | "switch" | "stop";
  interface Props {
    id: string;
    args: Record<string, unknown>;
    /** Waiting for an answer. */
    pending: boolean;
    /** What was chosen ("Kept going", "Switched to …", "Stopped"), once answered. */
    result?: string;
    onChoice?: (id: string, choice: Choice, suggest?: { id: string; name: string }) => void;
    /** Offer Switch (the app's own turn; a phone-started turn can only go on or stop). */
    canSwitch?: boolean;
  }
  let { id, args, pending, result, onChoice, canSwitch = true }: Props = $props();

  let a = $derived(costCheckArgs(args));
  let answered = $state(false);

  function choose(choice: Choice) {
    if (answered) return;
    answered = true;
    onChoice?.(id, choice, choice === "switch" ? a.suggest : undefined);
  }
</script>

{#if pending && !answered}
  <div class="cost-check" role="group" aria-label="Keep going? {a.question}" data-testid="cost-check">
    <div class="cc-q"><CircleDollarSign size={14} aria-hidden="true" /> <span>{a.question}</span></div>
    {#if a.waste}<div class="cc-waste">{a.waste}</div>{/if}
    <div class="cc-actions">
      <button type="button" class="cc-btn primary" onclick={() => choose("continue")}>Keep going</button>
      {#if a.suggest && canSwitch}
        <button type="button" class="cc-btn" onclick={() => choose("switch")}>{a.switchLabel}</button>
      {/if}
      <button type="button" class="cc-btn" onclick={() => choose("stop")}>Stop</button>
    </div>
  </div>
{:else}
  <div class="cost-check-done" role="note"><CircleDollarSign size={12} aria-hidden="true" /> {a.question} {result ?? (answered ? "Answered." : "")}</div>
{/if}

<style>
  .cost-check {
    margin: 6px 0;
    padding: 10px 12px;
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cc-q {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-sm);
    color: var(--text-primary);
  }
  .cc-waste {
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .cc-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .cc-btn {
    padding: 4px 12px;
    border-radius: var(--radius-sm);
    border: 0.5px solid var(--border-strong);
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
    max-width: 100%;
  }
  .cc-btn:hover {
    background: var(--bg-elevated);
  }
  .cc-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .cost-check-done {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0;
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
</style>
