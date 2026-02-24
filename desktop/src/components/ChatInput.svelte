<script lang="ts">
  interface Props {
    onSend: (message: string) => void;
    placeholder?: string;
    disabled?: boolean;
  }
  let { onSend, placeholder = "Message EdgeCoder...", disabled = false }: Props = $props();

  let text = $state("");
  let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function send() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    text = "";
    if (textareaEl) textareaEl.style.height = "auto";
  }

  function autoResize(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }
</script>

<div class="input-bar">
  <textarea
    bind:this={textareaEl}
    bind:value={text}
    {placeholder}
    {disabled}
    rows="1"
    onkeydown={handleKeydown}
    oninput={autoResize}
  ></textarea>
  <button class="send-btn" onclick={send} disabled={!text.trim() || disabled}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13"/>
    </svg>
  </button>
</div>

<style>
  .input-bar {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--bg-surface);
    border: 0.5px solid var(--border-strong);
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
    color: white;
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
