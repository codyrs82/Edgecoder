<script lang="ts">
  // "Add to chat": select text in a message and a small chip appears just above it; the chip or
  // Cmd+L (Ctrl+L elsewhere) adds the selection to the composer as a quote (lib/quote-selection.ts).
  // Only selections in message bodies ([data-quotable]) inside `scope` count. The chip never takes
  // the selection (mousedown is cancelled), so Cmd+C still copies it.
  import { quotableSelection, quoteButtonPosition, quoteMarkdown } from "../lib/quote-selection";

  interface Props {
    /** The conversation's scroll pane: selections outside it are ignored, and the chip stays inside it. */
    scope: HTMLElement | undefined;
    /** Adds the quote (Markdown) to the composer. */
    onQuote: (block: string) => void;
  }
  let { scope, onQuote }: Props = $props();

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
  const keyLabel = isMac ? "⌘L" : "Ctrl+L";

  let pos = $state<{ left: number; top: number } | null>(null);
  let buttonEl: HTMLButtonElement | undefined = $state(undefined);
  /** Hidden by Esc, scrolling or a click away until the selection changes. */
  let dismissedFor: string | null = null;

  function current() {
    return quotableSelection(typeof window !== "undefined" ? window.getSelection() : null, scope);
  }

  function refresh() {
    const q = current();
    if (!q || !scope) {
      pos = null;
      dismissedFor = null;
      return;
    }
    if (dismissedFor === q.text) return;
    dismissedFor = null;
    const w = buttonEl?.offsetWidth || 128;
    const h = buttonEl?.offsetHeight || 28;
    pos = quoteButtonPosition(q.rect, scope.getBoundingClientRect(), w, h);
  }

  function hide() {
    if (!pos) return;
    dismissedFor = current()?.text ?? null;
    pos = null;
  }

  function add() {
    const q = current();
    pos = null;
    if (!q) return;
    dismissedFor = q.text;
    onQuote(quoteMarkdown(q.text, q.code));
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && pos) {
      hide();
      return;
    }
    const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== "l") return;
    const t = e.target as HTMLElement | null;
    if (t && t !== buttonEl && t.closest?.("textarea, input, [contenteditable]:not([contenteditable='false'])")) return;
    if (!current()) return;
    e.preventDefault();
    add();
  }

  function onPointerDown(e: Event) {
    if (pos && buttonEl && e.target instanceof Node && buttonEl.contains(e.target)) return;
    hide();
  }

  $effect(() => {
    const el = scope;
    document.addEventListener("selectionchange", refresh);
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("resize", hide);
    el?.addEventListener("scroll", hide, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", refresh);
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("resize", hide);
      el?.removeEventListener("scroll", hide);
    };
  });
</script>

<button
  type="button"
  class="quote-chip"
  class:shown={!!pos}
  bind:this={buttonEl}
  style:left={pos ? `${pos.left}px` : undefined}
  style:top={pos ? `${pos.top}px` : undefined}
  hidden={!pos}
  aria-label="Add selection to chat"
  aria-keyshortcuts={isMac ? "Meta+L" : "Control+L"}
  title="Quote the selection in your message ({keyLabel})"
  data-testid="quote-selection"
  onmousedown={(e) => e.preventDefault()}
  onclick={add}
>
  Add to chat <kbd>{keyLabel}</kbd>
</button>

<style>
  .quote-chip {
    position: fixed;
    z-index: 40;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px 0 12px;
    border: 0.5px solid var(--border-control);
    border-radius: 999px;
    background: var(--bg-elevated);
    color: var(--text-primary);
    box-shadow: var(--shadow-md);
    font: inherit;
    font-size: var(--fs-xs, 12px);
    white-space: nowrap;
    cursor: pointer;
  }
  .quote-chip[hidden] {
    display: none;
  }
  .quote-chip:hover {
    background: var(--bg-surface);
  }
  .quote-chip:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 1px;
  }
  kbd {
    font-family: inherit;
    color: var(--text-muted);
  }
</style>
