<script lang="ts">
  // The composer's "Web" toggle (docs/web-tool.md): off by default, kept per chat. Hidden while web
  // search isn't set up on EdgeCoder's servers; disabled (with the reason as its tooltip) for a
  // model that can't call tools or an account without cSats.
  import { Globe } from "@lucide/svelte";
  import { webToggleView, type WebStatus } from "../lib/web-tool";

  interface Props {
    status: WebStatus | null;
    on: boolean;
    onChange: (on: boolean) => void;
  }
  let { status, on, onChange }: Props = $props();
  const view = $derived(webToggleView(status, on));
</script>

{#if view.visible}
  <button
    type="button"
    class="web-toggle"
    class:on={view.pressed}
    aria-pressed={view.pressed}
    disabled={view.disabled}
    title={view.title}
    aria-label={view.note ? `Web (${view.note})` : "Web"}
    data-testid="web-toggle"
    onclick={() => { if (!view.disabled) onChange(!on); }}
  >
    <Globe size={13} aria-hidden="true" />
    <span>Web</span>
    {#if view.note}<span class="note">{view.note}</span>{/if}
  </button>
{/if}

<style>
  .web-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: var(--control-sm, 26px);
    padding: 0 9px;
    border: 0.5px solid var(--border-strong);
    border-radius: 999px;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
    white-space: nowrap;
  }
  .web-toggle:hover:not(:disabled) {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }
  .web-toggle.on {
    border-color: var(--accent);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .web-toggle:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .note {
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
</style>
