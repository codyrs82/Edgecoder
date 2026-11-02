<script lang="ts">
  import { tick } from "svelte";

  interface Props {
    onSend: (message: string) => void;
    placeholder?: string;
    disabled?: boolean;
    /** A reply is streaming: the send button becomes Stop (typing stays allowed). */
    streaming?: boolean;
    onStop?: () => void;
    /** Project path search; when set, typing @ offers files and folders to mention. */
    mentions?: (query: string) => Promise<Array<{ path: string; kind: "file" | "dir" | "codebase" }>>;
  }
  let { onSend, placeholder = "Message EdgeCoder...", disabled = false, streaming = false, onStop, mentions }: Props = $props();

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
  {#if streaming && onStop}
    <button type="button" class="send-btn stop" aria-label="Stop" onclick={onStop} title="Stop (Esc)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
    </button>
  {:else}
    <button type="button" class="send-btn" aria-label="Send message" onclick={send} disabled={!text.trim() || disabled} title="Send (Enter)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13"/>
      </svg>
    </button>
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
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
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
    font-family: var(--font-mono, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .input-bar {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--bg-surface);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-md);
    padding: 8px 12px;
    flex: 1;
  }
  textarea {
    flex: 1;
    border: none;
    background: none;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 14px;
    line-height: 1.5;
    resize: none;
    outline: none;
    max-height: 200px;
  }
  textarea::placeholder {
    color: var(--text-muted);
  }
  .send-btn {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    border: none;
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .send-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
