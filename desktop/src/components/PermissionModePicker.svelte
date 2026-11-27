<script lang="ts">
  // The permission mode picker beside the composer, like Claude Code's: a quiet button with the
  // current mode, and a list of the modes (title, one-line description, a check on the current
  // one, number keys 1–5). Up/Down move, Enter picks, Escape or a click away closes. Full access
  // is offered only where `allowFull` (Code view chats and sessions, never bots), and picking it
  // the first time in a project asks for a confirm.
  import { Check, ChevronDown, ShieldCheck, Hand, FilePen, ListChecks, ShieldAlert } from "@lucide/svelte";
  import { tick } from "svelte";
  import Dialog from "./ui/Dialog.svelte";
  import { confirmFullAccess, FULL_ACCESS_WARNING, fullAccessConfirmed, modeOption, modeOptions, optionForKey, type EngineMode } from "../lib/permission-modes";

  interface Props {
    /** The current mode (the engine's name: ask, auto-edits, auto, plan or full). */
    mode: EngineMode;
    onChange: (mode: EngineMode) => void;
    disabled?: boolean;
    /** Open upward (it sits under the message box). */
    up?: boolean;
    /** Offer Full access (Code view chats and live sessions; not bots). */
    allowFull?: boolean;
    /** The project folder the confirm for Full access is remembered for. */
    project?: string | null;
  }
  let { mode, onChange, disabled = false, up = true, allowFull = false, project = null }: Props = $props();

  let open = $state(false);
  let active = $state(0);
  let root: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  let confirming = $state(false);
  const uid = $props.id();
  const current = $derived(modeOption(mode));
  // A chat already in Full access keeps showing it, even where it isn't offered.
  const options = $derived(modeOptions(allowFull || mode === "full"));
  const ICONS = { auto: ShieldCheck, manual: Hand, "accept-edits": FilePen, plan: ListChecks, full: ShieldAlert } as const;
  const TriggerIcon = $derived(ICONS[current.id]);

  async function show() {
    if (disabled) return;
    open = true;
    active = Math.max(0, options.findIndex((o) => o.engine === mode));
    await tick();
    list?.focus();
  }

  function close(returnFocus = true) {
    open = false;
    if (returnFocus) trigger?.focus();
  }

  function pick(engine: EngineMode) {
    if (engine === "full" && engine !== mode && !fullAccessConfirmed(project)) {
      close(false);
      confirming = true;
      return;
    }
    if (engine !== mode) onChange(engine);
    close();
  }

  function confirmFull() {
    confirmFullAccess(project);
    confirming = false;
    onChange("full");
    trigger?.focus();
  }

  function onListKey(e: KeyboardEvent) {
    const byKey = optionForKey(e.key, options);
    if (byKey) {
      e.preventDefault();
      pick(byKey.engine);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % options.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + options.length) % options.length;
    } else if (e.key === "Home") {
      e.preventDefault();
      active = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      active = options.length - 1;
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(options[active].engine);
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
    class:full={mode === "full"}
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
      {#each options as o, i (o.id)}
        {@const Icon = ICONS[o.id]}
        <div
          id="{uid}-opt-{i}"
          class="option"
          class:active={i === active}
          class:full={o.engine === "full"}
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

{#if confirming}
  <Dialog labelledby="{uid}-full-title" width="440px" onClose={() => { confirming = false; trigger?.focus(); }}>
    <div class="full-confirm">
      <h2 id="{uid}-full-title"><ShieldAlert size={16} aria-hidden="true" /> Turn on Full access?</h2>
      <p>{FULL_ACCESS_WARNING}</p>
      <p class="muted">Asked once per project. Bits, the phone and other accounts never get Full access.</p>
      <div class="actions">
        <button type="button" class="btn" onclick={() => { confirming = false; trigger?.focus(); }}>Cancel</button>
        <button type="button" class="btn btn--primary" onclick={confirmFull}>Turn on Full access</button>
      </div>
    </div>
  </Dialog>
{/if}

<style>
  .mode-picker { position: relative; display: inline-flex; }
  .trigger {
    display: inline-flex; align-items: center; gap: 4px; height: var(--control-md); padding: 0 8px; border: none; border-radius: var(--radius-sm);
    background: transparent; color: var(--text-secondary); font: inherit; font-size: var(--fs-xs); line-height: 1; cursor: pointer; white-space: nowrap;
  }
  .trigger:hover, .trigger[aria-expanded="true"] { background: var(--bg-elevated); color: var(--text-primary); }
  .trigger.plan { color: var(--accent); }
  .trigger.full { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); font-weight: 500; }
  .option.full .icon, .option.full .title { color: var(--warn); }
  .full-confirm { display: flex; flex-direction: column; gap: 10px; padding: 18px; }
  .full-confirm h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; color: var(--text-primary); }
  .full-confirm h2 :global(svg) { color: var(--warn); }
  .full-confirm p { margin: 0; font-size: 13px; line-height: 1.45; color: var(--text-primary); }
  .full-confirm .muted { color: var(--text-secondary); font-size: 12px; }
  .full-confirm .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
  .trigger:disabled { opacity: 0.5; cursor: default; }
  .menu {
    position: absolute; left: 0; z-index: 50; width: min(340px, calc(100vw - 32px)); padding: 6px;
    background: var(--bg-elevated); border: 0.5px solid var(--border-strong); border-radius: var(--radius-md);
    box-shadow: var(--shadow-md); outline: none;
  }
  .menu.up { bottom: calc(100% + 6px); }
  .menu:not(.up) { top: calc(100% + 6px); }
  .menu-title { padding: 4px 8px 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
  .option { display: flex; align-items: flex-start; gap: 10px; padding: 8px; border-radius: var(--radius-sm); cursor: pointer; }
  .option.active { background: var(--bg-surface); }
  .menu:focus-visible .option.active { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
  .icon { flex: none; margin-top: 1px; color: var(--text-secondary); }
  .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .title { font-size: 13px; font-weight: 500; color: var(--text-primary); }
  .desc { font-size: 12px; color: var(--text-secondary); line-height: 1.35; }
  .check { flex: none; width: 14px; margin-top: 1px; color: var(--accent); }
  .key {
    flex: none; min-width: 18px; padding: 1px 5px; border: 0.5px solid var(--border-control); border-radius: 4px;
    font: inherit; font-size: 11px; text-align: center; color: var(--text-secondary);
  }
</style>
