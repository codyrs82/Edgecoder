<script lang="ts">
  import { Square, ArrowUp, Plus } from "@lucide/svelte";
  import { tick, type Snippet } from "svelte";

  interface Props {
    onSend: (message: string) => void;
    placeholder?: string;
    disabled?: boolean;
    /** A reply is streaming: the send button becomes Stop (typing stays allowed). */
    streaming?: boolean;
    onStop?: () => void;
    /** Project path search; when set, typing @ offers files and folders to mention. */
    mentions?: (query: string) => Promise<Array<{ path: string; kind: "file" | "dir" | "codebase" }>>;
    /** Controls on the bottom-right of the box, before Send (the compute picker). */
    toolbar?: Snippet;
  }
  let { onSend, placeholder = "Message EdgeCoder...", disabled = false, streaming = false, onStop, mentions, toolbar }: Props = $props();

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
    if (!trimmed || disabled || streaming) return;
    onSend(trimmed);
    text = "";
    if (textareaEl) textareaEl.style.height = "auto";
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

  function autoResize(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    void updateMention();
  }
</script>

<div class="input-bar">
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
  <textarea
    bind:this={textareaEl}
    bind:value={text}
    {placeholder}
    aria-label={placeholder || "Message"}
    {disabled}
    rows="1"
    onkeydown={handleKeydown}
    oninput={autoResize}
  ></textarea>
  <div class="bottom-row">
  {#if mentions}
    <button type="button" class="icon-btn" title="Add a file or folder (@)" aria-label="Add a file or folder" onclick={() => void addContext()}>
      <Plus size={16} />
    </button>
  {/if}
  <div class="toolbar">{@render toolbar?.()}</div>
  {#if streaming && onStop}
    <button type="button" class="send-btn stop" aria-label="Stop" onclick={onStop} title="Stop (Esc)">
      <Square size={12} fill="currentColor" />
    </button>
  {:else}
    <button type="button" class="send-btn" aria-label="Send message" onclick={send} disabled={!text.trim() || disabled} title="Send (Enter)">
      <ArrowUp size={16} strokeWidth={2.25} />
    </button>
  {/if}
  </div>
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
  /* Claude-style composer: a roomy box, + on the left, the model chip and Send on the right. */
  .input-bar {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: var(--bg-surface);
    border: 0.5px solid var(--border-control);
    border-radius: 18px;
    padding: 12px 8px 8px;
    flex: 1;
    box-shadow: var(--shadow-sm);
    transition: border-color 0.15s;
  }
  .input-bar:focus-within {
    border-color: var(--text-muted);
  }
  .bottom-row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: var(--control-md);
  }
  .toolbar {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
  }
  textarea {
    flex: 1;
    min-height: 44px;
    padding: 0 8px;
    border: none;
    background: none;
    color: var(--text-primary);
    font-family: inherit;
    font-size: var(--prose-size, var(--fs-md));
    line-height: 1.5;
    resize: none;
    outline: none;
    max-height: 200px;
  }
  textarea::placeholder {
    color: var(--text-muted);
  }
  .send-btn {
    width: var(--control-md);
    height: var(--control-md);
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s, color 0.15s;
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
</style>
