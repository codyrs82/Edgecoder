<script lang="ts">
  // The permission mode picker beside the composer, like Claude Code's: a quiet button with the
  // current mode, and a list of the four modes (title, one-line description, a check on the
  // current one, number keys 1–4). Up/Down move, Enter picks, Escape or a click away closes.
  import { Check, ChevronDown, ShieldCheck, Hand, FilePen, ListChecks } from "@lucide/svelte";
  import { tick } from "svelte";
  import { MODE_OPTIONS, modeOption, optionForKey, type EngineMode } from "../lib/permission-modes";

  interface Props {
    /** The current mode (the engine's name: ask, auto-edits, auto or plan). */
    mode: EngineMode;
    onChange: (mode: EngineMode) => void;
    disabled?: boolean;
    /** Open upward (it sits under the message box). */
    up?: boolean;
  }
  let { mode, onChange, disabled = false, up = true }: Props = $props();

  let open = $state(false);
  let active = $state(0);
  let root: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  const uid = $props.id();
  const current = $derived(modeOption(mode));
  const ICONS = { auto: ShieldCheck, manual: Hand, "accept-edits": FilePen, plan: ListChecks } as const;
  const TriggerIcon = $derived(ICONS[current.id]);

  async function show() {
    if (disabled) return;
    open = true;
    active = Math.max(0, MODE_OPTIONS.findIndex((o) => o.engine === mode));
    await tick();
    list?.focus();
  }

  function close(returnFocus = true) {
    open = false;
    if (returnFocus) trigger?.focus();
  }

  function pick(engine: EngineMode) {
    if (engine !== mode) onChange(engine);
    close();
  }

  function onListKey(e: KeyboardEvent) {
    const byKey = optionForKey(e.key);
    if (byKey) {
      e.preventDefault();
      pick(byKey.engine);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % MODE_OPTIONS.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + MODE_OPTIONS.length) % MODE_OPTIONS.length;
    } else if (e.key === "Home") {
      e.preventDefault();
      active = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      active = MODE_OPTIONS.length - 1;
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(MODE_OPTIONS[active].engine);
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      close(e.key === "Escape");
    }
  }

  function onWindowPointer(e: PointerEvent) {
    if (open && root && !root.contains(e.target as Node)) close(false);
  }
</script>

<svelte:window onpointerdown={onWindowPointer} />

<div class="mode-picker" bind:this={root}>
  <button
    bind:this={trigger}
    type="button"
    class="trigger"
    class:plan={mode === "plan"}
    class:auto={mode === "auto"}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? `${uid}-list` : undefined}
    title="Permission mode: {current.title}. {current.desc}"
    {disabled}
    onclick={() => (open ? close() : void show())}
  >
    <TriggerIcon size={13} aria-hidden="true" />
    <span class="label">{current.title}</span>
    <ChevronDown size={12} aria-hidden="true" />
  </button>

  {#if open}
    <div
      bind:this={list}
      id="{uid}-list"
      class="menu"
      class:up
      role="listbox"
      tabindex="-1"
      aria-label="Permission mode"
      aria-activedescendant="{uid}-opt-{active}"
      onkeydown={onListKey}
    >
      <div class="menu-title" aria-hidden="true">Permission mode</div>
      {#each MODE_OPTIONS as o, i (o.id)}
        {@const Icon = ICONS[o.id]}
        <div
          id="{uid}-opt-{i}"
          class="option"
          class:active={i === active}
          role="option"
          aria-selected={o.engine === mode}
          tabindex="-1"
          data-mode={o.engine}
          onclick={() => pick(o.engine)}
          onkeydown={() => {}}
          onpointermove={() => (active = i)}
        >
          <span class="icon" aria-hidden="true"><Icon size={15} /></span>
          <span class="text">
            <span class="title">{o.title}</span>
            <span class="desc">{o.desc}</span>
          </span>
          <span class="check" aria-hidden="true">{#if o.engine === mode}<Check size={14} />{/if}</span>
          <kbd class="key" aria-hidden="true">{o.key}</kbd>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .mode-picker { position: relative; display: inline-flex; }
  .trigger {
    display: inline-flex; align-items: center; gap: 4px; height: var(--control-md, 26px); padding: 0 8px; border: none; border-radius: var(--radius-sm);
    background: transparent; color: var(--text-secondary); font: inherit; font-size: var(--fs-xs, 12px); line-height: 1; cursor: pointer; white-space: nowrap;
  }
  .trigger:hover, .trigger[aria-expanded="true"] { background: var(--bg-elevated); color: var(--text-primary); }
  .trigger.plan { color: var(--accent); }
  .trigger:disabled { opacity: 0.5; cursor: default; }
  .menu {
    position: absolute; left: 0; z-index: 50; width: min(340px, calc(100vw - 32px)); padding: 6px;
    background: var(--bg-elevated, var(--bg-surface)); border: 0.5px solid var(--border-strong, var(--border)); border-radius: var(--radius-md, 8px);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25); outline: none;
  }
  .menu.up { bottom: calc(100% + 6px); }
  .menu:not(.up) { top: calc(100% + 6px); }
  .menu-title { padding: 4px 8px 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted, var(--text-secondary)); }
  .option { display: flex; align-items: flex-start; gap: 10px; padding: 8px; border-radius: var(--radius-sm); cursor: pointer; }
  .option.active { background: var(--bg-surface); }
  .menu:focus-visible .option.active { outline: 2px solid var(--focus-ring, var(--accent)); outline-offset: -2px; }
  .icon { flex: none; margin-top: 1px; color: var(--text-secondary); }
  .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .title { font-size: 13px; font-weight: 500; color: var(--text-primary); }
  .desc { font-size: 12px; color: var(--text-secondary); line-height: 1.35; }
  .check { flex: none; width: 14px; margin-top: 1px; color: var(--accent); }
  .key {
    flex: none; min-width: 18px; padding: 1px 5px; border: 0.5px solid var(--border-control, var(--border)); border-radius: 4px;
    font: inherit; font-size: 11px; text-align: center; color: var(--text-secondary);
  }
</style>
