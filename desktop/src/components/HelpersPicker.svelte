<script lang="ts">
  // The Code view's Helpers switch beside the model picker (docs/tentacles.md): whether the lead
  // may hand well-specified pieces to helper agents, how many run at once, and what they may spend
  // in this chat. Easy pieces run on this computer's model first (free), the rest on the network;
  // never on your frontier key. Escape or a click away closes.
  import { GitBranch, ChevronDown } from "@lucide/svelte";
  import { tick } from "svelte";
  import { helpersLabel, type ChatHelpers } from "../lib/helpers";

  interface Props {
    /** What the chat runs with now (its own choice, or Settings' default). */
    helpers: { enabled: boolean; maxParallel: number; budgetCSats: number };
    /** The user changed something: kept with the chat. */
    onChange: (patch: ChatHelpers) => void;
    disabled?: boolean;
    /** Open upward (it sits under the message box). */
    up?: boolean;
  }
  let { helpers, onChange, disabled = false, up = true }: Props = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();
  const uid = $props.id();

  async function show() {
    if (disabled) return;
    open = true;
    await tick();
    panel?.querySelector<HTMLElement>("[role=switch]")?.focus();
  }

  function close(returnFocus = true) {
    open = false;
    if (returnFocus) trigger?.focus();
  }

  function num(e: Event, min: number, max: number): number | null {
    const n = Number((e.currentTarget as HTMLInputElement).value);
    return Number.isFinite(n) && (e.currentTarget as HTMLInputElement).value !== "" ? Math.min(max, Math.max(min, n)) : null;
  }

  function onWindowPointer(e: PointerEvent) {
    if (open && root && !root.contains(e.target as Node)) close(false);
  }
</script>

<svelte:window onpointerdown={onWindowPointer} />

<div class="helpers-picker" bind:this={root}>
  <button
    bind:this={trigger}
    type="button"
    class="trigger"
    class:on={helpers.enabled}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={open ? `${uid}-panel` : undefined}
    title="Helper agents: the lead hands easy pieces to this computer's model and medium ones to the network"
    {disabled}
    onclick={() => (open ? close() : void show())}
  >
    <GitBranch size={13} aria-hidden="true" />
    <span class="label">{helpersLabel(helpers)}</span>
    <ChevronDown size={12} aria-hidden="true" />
  </button>

  {#if open}
    <div
      bind:this={panel}
      id="{uid}-panel"
      class="panel"
      class:up
      role="dialog"
      tabindex="-1"
      aria-label="Helpers"
      onkeydown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
    >
      <div class="row">
        <span class="text">
          <span class="title">Helpers</span>
          <span class="desc">The lead hands well-specified pieces to helper agents: easy ones on this computer's model first (free), the rest on the network. Never on your frontier key.</span>
        </span>
        <button
          type="button"
          class="switch"
          role="switch"
          aria-checked={helpers.enabled}
          aria-label="Helpers"
          onclick={() => onChange({ enabled: !helpers.enabled })}
        ></button>
      </div>
      <label class="row field">
        <span class="title">At once</span>
        <input
          type="number"
          min="1"
          max="16"
          step="1"
          aria-label="Helpers at once"
          value={helpers.maxParallel}
          disabled={!helpers.enabled}
          onchange={(e) => {
            const n = num(e, 1, 16);
            if (n !== null) onChange({ maxParallel: Math.floor(n) });
          }}
        />
      </label>
      <label class="row field">
        <span class="title">Budget for this chat</span>
        <span class="unit">
          <input
            type="number"
            min="0"
            step="10"
            aria-label="Helper budget in cSats"
            value={helpers.budgetCSats}
            disabled={!helpers.enabled}
            onchange={(e) => {
              const n = num(e, 0, 1e7);
              if (n !== null) onChange({ budgetCSats: n });
            }}
          />
          cSats
        </span>
      </label>
    </div>
  {/if}
</div>

<style>
  .helpers-picker { position: relative; display: inline-flex; }
  .trigger {
    display: inline-flex; align-items: center; gap: 4px; height: var(--control-md); padding: 0 8px; border: none; border-radius: var(--radius-sm);
    background: transparent; color: var(--text-secondary); font: inherit; font-size: var(--fs-xs); line-height: 1; cursor: pointer; white-space: nowrap;
  }
  .trigger:hover, .trigger[aria-expanded="true"] { background: var(--bg-elevated); color: var(--text-primary); }
  .trigger.on { color: var(--accent); }
  .trigger:disabled { opacity: 0.5; cursor: default; }
  .panel {
    position: absolute; left: 0; z-index: 50; width: min(320px, calc(100vw - 32px)); padding: 8px;
    display: flex; flex-direction: column; gap: 6px;
    background: var(--bg-elevated); border: 0.5px solid var(--border-strong); border-radius: var(--radius-md);
    box-shadow: var(--shadow-md); outline: none;
  }
  .panel.up { bottom: calc(100% + 6px); }
  .panel:not(.up) { top: calc(100% + 6px); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px; }
  .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .title { font-size: 13px; font-weight: 500; color: var(--text-primary); }
  .desc { font-size: 12px; color: var(--text-secondary); line-height: 1.35; }
  .field input { width: 72px; font: inherit; font-size: 12px; }
  .unit { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-secondary); }
  .switch {
    flex: none; position: relative; width: 30px; height: 18px; border-radius: 9px; border: none; padding: 0;
    background: var(--border-strong); cursor: pointer;
  }
  .switch::after {
    content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--bg-surface);
    transition: transform 0.15s;
  }
  .switch[aria-checked="true"] { background: var(--accent); }
  .switch[aria-checked="true"]::after { transform: translateX(12px); }
  .switch:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
</style>
