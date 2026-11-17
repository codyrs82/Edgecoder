<script lang="ts">
  // The composer's quiet Web indicator (docs/web-tool.md): web is automatic, the model decides when
  // a question needs fresh information. "Web: Auto" (the default, from Settings → General) or
  // "Web: Off" for this chat, picked from a small menu. Hidden while web search isn't set up on
  // EdgeCoder's servers; dimmed with "Web: unavailable with this model" for a model that can't call
  // tools; "needs cSats" when the account can't pay for a search (the chat answers without the web).
  import { Check, Globe } from "@lucide/svelte";
  import { tick } from "svelte";
  import { webIndicatorView, type WebMode, type WebStatus } from "../lib/web-tool";

  interface Props {
    status: WebStatus | null;
    mode: WebMode;
    onChange: (mode: WebMode) => void;
  }
  let { status, mode, onChange }: Props = $props();
  const view = $derived(webIndicatorView(status, mode));

  const OPTIONS: Array<{ mode: WebMode; title: string; desc: string }> = [
    { mode: "auto", title: "Auto", desc: "Searches when a question needs fresh information, and cites sources." },
    { mode: "off", title: "Off for this chat", desc: "Answers from the model alone." },
  ];

  let open = $state(false);
  let active = $state(0);
  let root: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  const uid = $props.id();

  async function show() {
    if (view.unavailable) return;
    open = true;
    active = Math.max(0, OPTIONS.findIndex((o) => o.mode === mode));
    await tick();
    list?.focus();
  }
  function close(returnFocus = true) {
    open = false;
    if (returnFocus) trigger?.focus();
  }
  function pick(m: WebMode) {
    if (m !== mode) onChange(m);
    close();
  }
  function onListKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + 1) % OPTIONS.length;
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(OPTIONS[active].mode);
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

{#if view.visible}
  <div class="web-indicator" bind:this={root}>
    <button
      bind:this={trigger}
      type="button"
      class="trigger"
      class:off={mode === "off" && !view.unavailable}
      class:unavailable={view.unavailable}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? `${uid}-list` : undefined}
      aria-disabled={view.unavailable}
      title={view.title}
      aria-label={view.unavailable ? view.title : view.note ? `${view.label} (${view.note})` : view.label}
      data-testid="web-indicator"
      onclick={() => (open ? close() : void show())}
    >
      <Globe size={13} aria-hidden="true" />
      <span class="label">{view.label}</span>
      {#if view.note}<span class="note">{view.note}</span>{/if}
    </button>

    {#if open}
      <div
        bind:this={list}
        id="{uid}-list"
        class="menu"
        role="listbox"
        tabindex="-1"
        aria-label="Web search"
        aria-activedescendant="{uid}-opt-{active}"
        onkeydown={onListKey}
      >
        <div class="menu-title" aria-hidden="true">Web search</div>
        {#each OPTIONS as o, i (o.mode)}
          <div
            id="{uid}-opt-{i}"
            class="option"
            class:active={i === active}
            role="option"
            aria-selected={o.mode === mode}
            tabindex="-1"
            data-web-mode={o.mode}
            onclick={() => pick(o.mode)}
            onkeydown={() => {}}
            onpointermove={() => (active = i)}
          >
            <span class="text">
              <span class="title">{o.title}</span>
              <span class="desc">{o.desc}</span>
            </span>
            <span class="check" aria-hidden="true">{#if o.mode === mode}<Check size={14} />{/if}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .web-indicator { position: relative; display: inline-flex; }
  .trigger {
    display: inline-flex; align-items: center; gap: 4px; height: var(--control-md); padding: 0 8px; border: none; border-radius: var(--radius-sm);
    background: transparent; color: var(--text-secondary); font: inherit; font-size: var(--fs-xs); line-height: 1; cursor: pointer; white-space: nowrap;
  }
  .trigger:hover:not(.unavailable), .trigger[aria-expanded="true"] { background: var(--bg-elevated); color: var(--text-primary); }
  .trigger.off { color: var(--text-muted); }
  .trigger.unavailable { opacity: 0.5; cursor: default; }
  .note { font-size: 11px; color: var(--text-muted); }
  .menu {
    position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 50; width: min(280px, calc(100vw - 32px)); padding: 6px;
    background: var(--bg-elevated); border: 0.5px solid var(--border-strong); border-radius: var(--radius-md);
    box-shadow: var(--shadow-md); outline: none;
  }
  .menu-title { padding: 4px 8px 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
  .option { display: flex; align-items: flex-start; gap: 10px; padding: 8px; border-radius: var(--radius-sm); cursor: pointer; }
  .option.active { background: var(--bg-surface); }
  .menu:focus-visible .option.active { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
  .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .title { font-size: 13px; font-weight: 500; color: var(--text-primary); }
  .desc { font-size: 12px; color: var(--text-secondary); line-height: 1.35; }
  .check { flex: none; width: 14px; margin-top: 1px; color: var(--accent); }
</style>
