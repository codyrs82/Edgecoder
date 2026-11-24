<script lang="ts">
  // The round "Jump to latest" button above the message box (follow-bottom.ts): shown while the
  // conversation is scrolled up; a dot says something new arrived meanwhile. It sits at the end of
  // the scroll region, stuck to its bottom edge, so it needs no position from the page around it.
  import { ArrowDown } from "@lucide/svelte";

  interface Props {
    visible: boolean;
    unseen?: boolean;
    onJump: () => void;
  }
  let { visible, unseen = false, onJump }: Props = $props();
</script>

{#if visible}
  <div class="jump-wrap">
    <button type="button" class="jump" class:unseen aria-label="Jump to latest" title={unseen ? "New messages below. Jump to latest" : "Jump to latest"} onclick={onJump}>
      <ArrowDown size={16} aria-hidden="true" />
      {#if unseen}<span class="dot" data-testid="jump-unseen" aria-hidden="true"></span>{/if}
    </button>
  </div>
{/if}

<style>
  .jump-wrap {
    position: sticky;
    bottom: 12px;
    height: 0;
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    pointer-events: none;
    z-index: 5;
  }
  .jump {
    position: relative;
    pointer-events: auto;
    transform: translateY(-100%);
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0.5px solid var(--border-strong);
    background: var(--bg-elevated);
    color: var(--text-primary);
    box-shadow: var(--shadow-lg);
    cursor: pointer;
    transition: background 0.15s;
  }
  .jump:hover {
    background: var(--bg-surface);
  }
  .jump:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
  .dot {
    position: absolute;
    top: 1px;
    right: 1px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    border: 1.5px solid var(--bg-elevated);
  }
</style>
