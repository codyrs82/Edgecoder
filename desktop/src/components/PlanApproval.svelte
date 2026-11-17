<script lang="ts">
  // Under a plan written in Plan mode: "Approve plan" switches to the chosen mode (Accept edits
  // unless changed) and carries the plan out; "Revise" puts the cursor in the composer to say what
  // to change (the agent stays in Plan mode).
  import { ListChecks } from "@lucide/svelte";
  import { DEFAULT_EXECUTION_MODE, EXECUTION_OPTIONS, type EngineMode } from "../lib/permission-modes";

  interface Props {
    onApprove: (mode: EngineMode) => void;
    onRevise: () => void;
    disabled?: boolean;
  }
  let { onApprove, onRevise, disabled = false }: Props = $props();
  let next = $state<EngineMode>(DEFAULT_EXECUTION_MODE);
  const uid = $props.id();
</script>

<div class="plan-approval" role="group" aria-label="Plan approval" data-testid="plan-approval">
  <span class="what"><ListChecks size={14} aria-hidden="true" /> Plan ready. Nothing has changed yet.</span>
  <div class="actions">
    <label class="then" for="{uid}-mode">Then</label>
    <select id="{uid}-mode" bind:value={next} {disabled} aria-label="Mode to carry out the plan in">
      {#each EXECUTION_OPTIONS as o (o.engine)}<option value={o.engine}>{o.title}</option>{/each}
    </select>
    <button type="button" class="primary" {disabled} onclick={() => onApprove(next)}>Approve plan</button>
    <button type="button" {disabled} onclick={onRevise}>Revise</button>
  </div>
</div>

<style>
  .plan-approval {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;
    margin: 6px 0 2px; padding: 8px 10px; border: 0.5px solid var(--border-strong); border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm); background: var(--bg-surface); font-size: 13px;
  }
  .what { display: inline-flex; align-items: center; gap: 6px; color: var(--text-primary); }
  .actions { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .then { color: var(--text-secondary); font-size: 12px; }
  select { font: inherit; font-size: 12px; padding: 3px 6px; border-radius: var(--radius-sm); border: 0.5px solid var(--border-control); background: var(--bg-elevated); color: var(--text-primary); }
  button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: var(--radius-sm); border: 0.5px solid var(--border-control); background: transparent; color: var(--text-primary); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  button:disabled, select:disabled { opacity: 0.5; cursor: default; }
</style>
