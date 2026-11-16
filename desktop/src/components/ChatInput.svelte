<script lang="ts">
  import { Square, ArrowUp, Plus, X } from "@lucide/svelte";
  import { tick, type Snippet } from "svelte";

  interface Props {
    onSend: (message: string) => void;
    placeholder?: string;
    disabled?: boolean;
    /**
     * A reply is streaming. Send stays: Enter queues the message (shown as Queued, removable) and
     * it is sent when the reply ends. Stop is a separate button next to Send (Esc too).
     */
    streaming?: boolean;
    onStop?: () => void;
    /**
     * The queue lives elsewhere (a shared session's queue on the provider): onSend is called at
     * once even while streaming, and these are shown as Queued; onUnqueue removes one.
     */
    queue?: Array<{ id: string; text: string; from?: string }>;
    onUnqueue?: (id: string) => void;
    /** Project path search; when set, typing @ offers files and folders to mention. */
    mentions?: (query: string) => Promise<Array<{ path: string; kind: "file" | "dir" | "codebase" }>>;
    /** The quiet row under the box: the compute picker, Auto-apply edits and the like. */
    controls?: Snippet;
  }
  let { onSend, placeholder = "Message EdgeCoder...", disabled = false, streaming = false, onStop, mentions, controls, queue, onUnqueue }: Props = $props();

  // Messages typed while a reply streams, sent in order when it ends (unless the queue is external).
  let localQueue = $state<Array<{ id: string; text: string }>>([]);
  let queueSeq = 0;
  const shownQueue = $derived(queue ?? localQueue);
  // One at a time: after sending a queued message, wait for its reply to start (and end) before
  // the next; a reply that never starts (an error) releases the queue after a few seconds.
  let awaitingStart = $state(false);
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (streaming && awaitingStart) {
      awaitingStart = false;
      clearTimeout(releaseTimer);
    }
  });
  $effect(() => {
    if (queue || streaming || disabled || awaitingStart || localQueue.length === 0) return;
    const [next, ...rest] = localQueue;
    localQueue = rest;
    awaitingStart = true;
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => (awaitingStart = false), 5_000);
    onSend(next.text);
  });
  function unqueue(id: string) {
    if (queue) onUnqueue?.(id);
    else localQueue = localQueue.filter((q) => q.id !== id);
  }

  let text = $state("");
  let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);

  // @-mention picker: the "@query" token ending at the caret, and its matches.
  let mention = $state<{ start: number; query: string } | null>(null);
  let matches = $state<Array<{ path: string; kind: "file" | "dir" | "codebase" }>>([]);
  let picked = $state(0);
  let searchSeq = 0;

  async function updateMention() {
    if (!mentions || !textareaEl) return;
    const caret = textareaEl.selectionStart ?? text.length;
    const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
    if (!m) {
      mention = null;
      return;
    }
    mention = { start: caret - m[2].length - 1, query: m[2] };
    const seq = ++searchSeq;
    try {
      const found = await mentions(m[2]);
      if (seq !== searchSeq) return;
      matches = found.slice(0, 8);
      picked = 0;
    } catch {
      matches = [];
    }
  }

  async function choose(i: number) {
    const target = matches[i];
    if (!target || !mention || !textareaEl) return;
    const caret = textareaEl.selectionStart ?? text.length;
    const insert = `@${target.path}${target.kind === "dir" ? "/" : ""} `;
    text = text.slice(0, mention.start) + insert + text.slice(caret);
    const pos = mention.start + insert.length;
    mention = null;
    matches = [];
    // Right after Svelte writes the new value (a microtask), before the next keystroke is handled;
    // a later caret move would land after fast typing and put the cursor back mid-text.
    await tick();
    textareaEl?.focus();
    textareaEl?.setSelectionRange(pos, pos);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (mention && matches.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        picked = (picked + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) {
        e.preventDefault();
        void choose(picked);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        mention = null;
        matches = [];
        return;
      }
    }
    // isComposing: Enter that confirms an IME composition must not send.
    if (e.key === "Escape" && streaming && onStop) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function send() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    if (streaming && !queue) localQueue = [...localQueue, { id: `q${++queueSeq}`, text: trimmed }];
    else onSend(trimmed);
    text = "";
    // Back to one line once the box is empty (the value is written on the next tick).
    void tick().then(resize);
  }

  /** The + button: start an @-mention, which offers the project's files and folders. */
  async function addContext() {
    if (!textareaEl) return;
    const caret = textareaEl.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const insert = `${before && !/\s$/.test(before) ? " " : ""}@`;
    text = before + insert + text.slice(caret);
    await tick();
    const pos = caret + insert.length;
    textareaEl.focus();
    textareaEl.setSelectionRange(pos, pos);
    void updateMention();
  }

  /** One line of text plus its padding: the box is then about 44 px tall. */
  const MIN_HEIGHT = 32;
  /** The tallest the text grows before it scrolls inside: 40% of the window. */
  function maxComposerHeight(): number {
    return Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.4));
  }

  /**
   * Fit the textarea to its content: one line when empty, growing with each line up to 40% of the
   * window, then scrolling inside. Only the height changes: no focus or scroll calls, so typing
   * never moves the conversation or the caret.
   */
  function resize() {
    const ta = textareaEl;
    if (!ta) return;
    ta.style.height = "auto";
    const max = maxComposerHeight();
    const h = Math.min(Math.max(ta.scrollHeight, MIN_HEIGHT), max);
    ta.style.height = `${h}px`;
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }

  function onInput() {
    resize();
    void updateMention();
  }

  // Programmatic changes (an @-mention picked, + pressed) refit too; so does a window resize.
  $effect(() => {
    void text;
    void tick().then(resize);
  });
  $effect(() => {
    const onWin = () => resize();
    window.addEventListener("resize", onWin);
    return () => window.removeEventListener("resize", onWin);
  });
</script>

<div class="composer-root">
  {#if shownQueue.length > 0}
    <ol class="queued" aria-label="Queued messages">
      {#each shownQueue as q, i (q.id)}
        <li class="queued-item">
          <span class="queued-tag">Queued{shownQueue.length > 1 ? ` ${i + 1}` : ""}</span>
          <span class="queued-text" title={q.text}>{q.text}</span>
          {#if "from" in q && q.from}<span class="queued-from">from {q.from}</span>{/if}
          {#if !queue || onUnqueue}
            <button type="button" class="icon-btn icon-btn--sm" aria-label={`Remove queued message: ${q.text}`} title="Remove from the queue" onclick={() => unqueue(q.id)}><X size={12} /></button>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
  <!-- One slim row: + on the left, the text inline, Stop and Send on the right. It grows with the text. -->
  <div class="composer-box" data-testid="composer-box">
    {#if mention && matches.length > 0}
      <div class="mentions" role="listbox" aria-label="Mention a file">
        {#each matches as m, i (m.path)}
          <button
            type="button"
            role="option"
            aria-selected={i === picked}
            class:picked={i === picked}
            onmousedown={(e) => { e.preventDefault(); void choose(i); }}
          >
            {#if m.kind === "codebase"}
              <span class="kind">⌕</span>
              <span class="mpath">@codebase</span><span class="hint">search the project by meaning</span>
            {:else}
              <span class="kind">{m.kind === "dir" ? "▸" : "·"}</span>
              <span class="mpath">{m.path}{m.kind === "dir" ? "/" : ""}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
    {#if mentions}
      <button type="button" class="round-btn add" title="Add a file or folder (@)" aria-label="Add a file or folder" onclick={() => void addContext()}>
        <Plus size={16} />
      </button>
    {/if}
    <textarea
      bind:this={textareaEl}
      bind:value={text}
      {placeholder}
      aria-label={placeholder || "Message"}
      {disabled}
      rows="1"
      onkeydown={handleKeydown}
      oninput={onInput}
    ></textarea>
    {#if streaming && onStop}
      <button type="button" class="round-btn send-btn stop" aria-label="Stop" onclick={onStop} title="Stop the reply (Esc)">
        <Square size={12} fill="currentColor" />
      </button>
    {/if}
    <button type="button" class="round-btn send-btn" aria-label="Send message" onclick={send} disabled={!text.trim() || disabled} title={streaming ? "Queue: sent when the reply ends (Enter)" : "Send (Enter)"}>
      <ArrowUp size={16} strokeWidth={2.25} />
    </button>
  </div>
  {#if controls || streaming}
    <div class="controls" data-testid="composer-controls">
      {@render controls?.()}
      {#if streaming}
        <!-- A glanceable cue only: the reply itself carries the announced progress. -->
        <span class="working" data-testid="composer-working"><span class="ring" aria-hidden="true"></span>Working</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .mentions {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 6px);
    max-height: 260px;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 0.5px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    padding: 4px;
    z-index: 30;
  }
  .mentions button {
    display: flex;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    border: none;
    background: none;
    color: var(--text-secondary);
    text-align: left;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 12px;
  }
  .mentions button.picked {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .kind {
    color: var(--text-muted);
    width: 10px;
  }
  .hint {
    color: var(--text-muted);
    margin-left: auto;
  }
  .mpath {
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A slim pill: one ~44 px row that grows with the text (see resize()), up to 40% of the window. */
  .composer-root {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .composer-box {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 4px;
    min-height: 44px;
    box-sizing: border-box;
    padding: 5px 6px;
    background: var(--bg-surface);
    border: 0.5px solid var(--border-control);
    border-radius: 22px;
    box-shadow: var(--shadow-sm);
    transition: border-color 0.15s;
  }
  /* The textarea draws no outline of its own; the whole pill carries the focus ring. */
  .composer-box:has(textarea:focus-visible) {
    outline: 2px solid var(--focus-ring);
    outline-offset: 1px;
  }
  textarea {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    height: 32px;
    min-height: 32px;
    max-height: 40vh;
    padding: 5px 6px;
    margin: 0;
    border: none;
    background: none;
    color: var(--text-primary);
    font-family: inherit;
    font-size: var(--prose-size, var(--fs-md));
    line-height: 22px;
    resize: none;
    outline: none;
    overflow-y: hidden;
  }
  textarea::placeholder {
    color: var(--text-muted);
  }
  .round-btn {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .add {
    background: none;
    color: var(--text-secondary);
  }
  .add:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }
  .send-btn {
    background: var(--accent);
    color: var(--on-accent);
  }
  .send-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  /* Nothing to send yet: a quiet grey button instead of a faded orange one. */
  .send-btn:disabled {
    background: var(--bg-elevated);
    color: var(--text-muted);
    cursor: not-allowed;
  }
  .send-btn.stop {
    background: var(--text-primary);
    color: var(--bg-surface);
  }
  /* The quiet row under the box: small, muted controls. */
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 8px;
    min-height: var(--control-sm);
    padding: 4px 8px 0;
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .working {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    color: var(--text-secondary);
  }
  .ring {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--border-control);
    border-top-color: var(--accent);
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ring {
      animation: none;
    }
  }
  .queued {
    list-style: none;
    margin: 0 0 6px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .queued-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px 4px 10px;
    border: 0.5px dashed var(--border-control);
    border-radius: var(--radius-md);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    min-width: 0;
  }
  .queued-tag {
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .queued-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .queued-from {
    color: var(--text-muted);
    flex-shrink: 0;
  }
</style>
