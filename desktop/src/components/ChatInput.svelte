<script lang="ts">
  import { Square, ArrowUp, Plus, X, FileText, FileArchive, Paperclip, AtSign } from "@lucide/svelte";
  import { tick, type Snippet } from "svelte";
  import { ACCEPT, MAX_ATTACHMENTS, MESSAGE_MAX_BYTES, chipLabel, formatBytes, readAttachment, toPayload, visionNote, type Attachment, type AttachmentPayload, type Vision } from "../lib/attachments";
  import { menu } from "../lib/menu";
  import { insertQuoteText } from "../lib/quote-selection";

  interface Props {
    /** `attachments`: files attached in the box (only when `attach` is set). */
    onSend: (message: string, attachments?: AttachmentPayload[]) => void;
    placeholder?: string;
    disabled?: boolean;
    /**
     * A reply is streaming (or the bot is working). With `onStop`, the send arrow becomes Stop
     * (Esc too) and Enter queues what is typed (shown as Queued, removable; an "Enter to queue"
     * hint shows while there is text); it is sent when the reply ends.
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
    /**
     * Attachments (+, paste, drag and drop): what the model can see, who it is ("Cyber SIMP") and
     * whether the app saves attachments into its folder (bots), for the note shown when it can't
     * see an attached image or PDF.
     */
    attach?: { vision: Vision; who?: string; savedToFolder?: boolean };
    /**
     * Co-editing a live session: a message goes to the session at once even while it works, so a
     * visible Send stays next to Stop (and no "Enter to queue" hint).
     */
    sendWhileWorking?: boolean;
  }
  let { onSend, placeholder = "Message EdgeCoder...", disabled = false, streaming = false, onStop, mentions, controls, queue, onUnqueue, attach, sendWhileWorking = false }: Props = $props();

  // Messages typed while a reply streams, sent in order when it ends (unless the queue is external).
  let localQueue = $state<Array<{ id: string; text: string; attachments?: AttachmentPayload[] }>>([]);
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
    if (next.attachments?.length) onSend(next.text, next.attachments);
    else onSend(next.text);
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
    if ((!trimmed && attached.length === 0) || disabled || reading > 0) return;
    const files = attached.map(toPayload);
    if (streaming && !queue) localQueue = [...localQueue, { id: `q${++queueSeq}`, text: trimmed, ...(files.length ? { attachments: files } : {}) }];
    else if (files.length) onSend(trimmed, files);
    else onSend(trimmed);
    text = "";
    clearAttachments();
    // Back to one line once the box is empty (the value is written on the next tick).
    void tick().then(resize);
  }

  /** Put the cursor in the box (Plan's "Revise"). */
  export function focus() {
    textareaEl?.focus();
  }

  /**
   * "Add to chat": put a quote (Markdown from lib/quote-selection.ts) into the box at the caret,
   * keeping what is typed and attached; the caret lands on the line after it, ready for the reply.
   */
  export async function insertQuote(block: string) {
    const caret = textareaEl ? (textareaEl.selectionEnd ?? text.length) : text.length;
    const next = insertQuoteText(text, caret, block);
    text = next.value;
    mention = null;
    matches = [];
    await tick();
    if (!textareaEl) return;
    textareaEl.focus();
    textareaEl.setSelectionRange(next.caret, next.caret);
    resize();
    // Keep the caret in view when the box scrolls inside.
    const line = text.slice(0, next.caret).split("\n").length;
    textareaEl.scrollTop = Math.max(0, line * 22 - textareaEl.clientHeight + 10);
  }

  // --- Attachments ---
  let attached = $state<Attachment[]>([]);
  let attachError = $state<string | null>(null);
  let reading = $state(0);
  let dragging = $state(false);
  let fileInput: HTMLInputElement | undefined = $state(undefined);
  let plusEl: HTMLButtonElement | undefined = $state(undefined);
  let plusMenuOpen = $state(false);
  const note = $derived(attach ? visionNote(attached, attach.vision, attach.who, attach.savedToFolder) : null);
  const canSend = $derived((!!text.trim() || attached.length > 0) && !disabled && reading === 0);

  async function addFiles(files: Iterable<File>) {
    if (!attach) return;
    attachError = null;
    for (const f of files) {
      if (attached.length + reading >= MAX_ATTACHMENTS) {
        attachError = `Up to ${MAX_ATTACHMENTS} files per message (a zip counts as one).`;
        break;
      }
      reading++;
      try {
        const r = await readAttachment(f);
        if ("error" in r) attachError = r.error;
        else if (attached.reduce((n, a) => n + a.size, 0) + r.size > MESSAGE_MAX_BYTES) {
          attachError = `${r.name}: attachments can be up to ${formatBytes(MESSAGE_MAX_BYTES)} per message in all.`;
          if (r.previewUrl) URL.revokeObjectURL?.(r.previewUrl);
        } else attached = [...attached, r];
      } catch {
        attachError = `${f.name || "That file"} couldn't be read.`;
      } finally {
        reading--;
      }
    }
  }
  function removeAttachment(id: string) {
    const a = attached.find((x) => x.id === id);
    if (a?.previewUrl) URL.revokeObjectURL?.(a.previewUrl);
    attached = attached.filter((x) => x.id !== id);
    attachError = null;
    textareaEl?.focus();
  }
  function clearAttachments() {
    for (const a of attached) if (a.previewUrl) URL.revokeObjectURL?.(a.previewUrl);
    attached = [];
    attachError = null;
  }
  function pickFiles() {
    plusMenuOpen = false;
    fileInput?.click();
  }
  function onPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    void addFiles(files);
  }
  /** Cmd+V with an image (a screenshot) attaches it; pasted text stays plain text. */
  function onPaste(e: ClipboardEvent) {
    if (!attach) return;
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  }
  function hasFiles(e: DragEvent) {
    return !!attach && [...(e.dataTransfer?.types ?? [])].includes("Files");
  }
  function onDragOver(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragging = true;
  }
  function onDrop(e: DragEvent) {
    dragging = false;
    if (!hasFiles(e)) return;
    e.preventDefault();
    void addFiles([...(e.dataTransfer?.files ?? [])]);
  }
  function onPlus() {
    if (attach && mentions) plusMenuOpen = !plusMenuOpen;
    else if (attach) pickFiles();
    else void addContext();
  }

  /** The + button: start an @-mention, which offers the project's files and folders. */
  async function addContext() {
    plusMenuOpen = false;
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
          <span class="queued-text" title={q.text}>{q.text}{"attachments" in q && q.attachments?.length ? ` (+${q.attachments.length} file${q.attachments.length > 1 ? "s" : ""})` : ""}</span>
          {#if "from" in q && q.from}<span class="queued-from">from {q.from}</span>{/if}
          {#if !queue || onUnqueue}
            <button type="button" class="icon-btn icon-btn--sm" aria-label={`Remove queued message: ${q.text}`} title="Remove from the queue" onclick={() => unqueue(q.id)}><X size={12} /></button>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
  {#if attached.length > 0 || reading > 0 || attachError || note}
    <div class="attachments" data-testid="composer-attachments">
      {#if attached.length > 0 || reading > 0}
        <ul class="att-list" aria-label="Attached files">
          {#each attached as a (a.id)}
            <li class="att" title="{chipLabel(a)} · {formatBytes(a.size)}">
              {#if a.kind === "image" && a.previewUrl}
                <img class="thumb" src={a.previewUrl} alt="" />
              {:else}
                <span class="att-icon" aria-hidden="true">{#if a.kind === "archive"}<FileArchive size={14} />{:else}<FileText size={14} />{/if}</span>
              {/if}
              <span class="att-name">{a.name}</span>{#if a.fileCount !== undefined}<span class="att-count">· {a.fileCount} file{a.fileCount === 1 ? "" : "s"}</span>{/if}
              <button type="button" class="icon-btn icon-btn--sm" aria-label={`Remove ${a.name}`} title="Remove" onclick={() => removeAttachment(a.id)}><X size={12} /></button>
            </li>
          {/each}
          {#if reading > 0}<li class="att reading" aria-live="polite">Reading…</li>{/if}
        </ul>
      {/if}
      {#each attached.filter((a) => a.notes?.length) as a (a.id)}
        <p class="att-note" data-testid="attach-skipped">{a.name}: {a.notes!.length} {a.notes!.length === 1 ? "entry" : "entries"} will be left out ({a.notes!.slice(0, 3).join("; ")}{a.notes!.length > 3 ? "; …" : ""}).</p>
      {/each}
      {#if note}<p class="att-note" data-testid="attach-note">{note}</p>{/if}
      {#if attachError}<p class="att-error" role="alert">{attachError}</p>{/if}
    </div>
  {/if}
  <!-- One slim row: + on the left, the text inline, Send (or Stop while working) on the right. It grows with the text. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="composer-box" class:dragging data-testid="composer-box" ondragover={onDragOver} ondragleave={() => (dragging = false)} ondrop={onDrop}>
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
    {#if attach}
      <button type="button" class="round-btn add" bind:this={plusEl} title={mentions ? "Attach files or mention a project file" : "Attach files (or paste / drop them)"} aria-label={mentions ? "Add files" : "Attach files"} aria-haspopup={mentions ? "menu" : undefined} aria-expanded={mentions ? plusMenuOpen : undefined} onclick={onPlus}>
        <Plus size={16} />
      </button>
      <input bind:this={fileInput} type="file" multiple accept={ACCEPT} class="file-input" tabindex="-1" aria-hidden="true" onchange={onPicked} />
      {#if plusMenuOpen}
        <div class="plus-menu" role="menu" aria-label="Add" use:menu={{ trigger: plusEl, onClose: (returnFocus) => { plusMenuOpen = false; if (returnFocus) plusEl?.focus(); } }}>
          <button type="button" role="menuitem" onclick={pickFiles}><Paperclip size={14} /> Attach files…</button>
          <button type="button" role="menuitem" onclick={() => void addContext()}><AtSign size={14} /> Mention a project file</button>
        </div>
      {/if}
    {:else if mentions}
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
      aria-describedby={streaming && onStop && canSend && !sendWhileWorking ? "composer-queue-hint" : undefined}
      onkeydown={handleKeydown}
      oninput={onInput}
      onpaste={onPaste}
    ></textarea>
    {#if streaming && onStop}
      <!-- Working: the send arrow becomes Stop; Enter queues what is typed for when the work ends. -->
      {#if canSend && !sendWhileWorking}<span class="queue-hint" id="composer-queue-hint">Enter to queue</span>{/if}
      <button type="button" class="round-btn send-btn stop" aria-label="Stop" onclick={onStop} title={sendWhileWorking ? "Stop the reply (Esc)" : "Stop (Esc). Enter queues your message for when this ends."}>
        <Square size={12} fill="currentColor" />
      </button>
    {/if}
    {#if !(streaming && onStop) || sendWhileWorking}
      <button type="button" class="round-btn send-btn" aria-label="Send message" onclick={send} disabled={!canSend} title={streaming && sendWhileWorking && queue ? "Send now: the session takes it next (Enter)" : streaming ? "Queue: sent when the reply ends (Enter)" : "Send (Enter)"}>
        <ArrowUp size={16} strokeWidth={2.25} />
      </button>
    {/if}
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
  .file-input {
    display: none;
  }
  .composer-box.dragging {
    border-color: var(--accent);
    border-style: dashed;
  }
  .queue-hint {
    align-self: center;
    flex-shrink: 0;
    padding: 0 4px;
    font-size: var(--fs-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .plus-menu {
    position: absolute;
    left: 4px;
    bottom: calc(100% + 6px);
    display: flex;
    flex-direction: column;
    min-width: 200px;
    padding: 4px;
    background: var(--bg-elevated);
    border: 0.5px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    z-index: 30;
  }
  .plus-menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: none;
    background: none;
    color: var(--text-primary);
    font-size: var(--fs-sm, 12px);
    text-align: left;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .plus-menu button:hover,
  .plus-menu button:focus-visible {
    background: var(--bg-surface);
  }
  .attachments {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0 0 6px;
  }
  .att-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .att {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 280px;
    padding: 3px 4px 3px 4px;
    border: 0.5px solid var(--border-control);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .att.reading {
    padding: 3px 8px;
    color: var(--text-muted);
  }
  .thumb {
    width: 28px;
    height: 28px;
    object-fit: cover;
    border-radius: var(--radius-sm);
  }
  .att-icon {
    display: inline-flex;
    padding: 0 2px;
    color: var(--text-muted);
  }
  .att-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .att-count {
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--text-muted);
  }
  .att-note,
  .att-error {
    margin: 0;
    padding: 0 4px;
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .att-error {
    color: var(--danger, var(--text-primary));
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
