<script lang="ts">
  import { marked } from "marked";

  interface Props {
    source: string;
    onOpenInEditor?: (code: string, language: string) => void;
  }
  let { source, onOpenInEditor }: Props = $props();

  const renderer = new marked.Renderer();
  renderer.code = function({ text, lang }) {
    const escapedCode = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="code-block-wrapper">
      <div class="code-block-header">
        <span class="code-lang">${lang || ''}</span>
        <button class="open-in-editor-btn" data-lang="${lang || 'plaintext'}">Open in Editor</button>
      </div>
      <pre><code class="language-${lang || ''}">${escapedCode}</code></pre>
    </div>`;
  };

  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  let html = $derived(marked.parse(source, { renderer, async: false }) as string);

  function handleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.classList.contains('open-in-editor-btn')) {
      const wrapper = target.closest('.code-block-wrapper');
      const codeEl = wrapper?.querySelector('code');
      if (codeEl && onOpenInEditor) {
        const lang = target.dataset.lang || 'plaintext';
        onOpenInEditor(codeEl.textContent || '', lang);
      }
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="markdown" onclick={handleClick}>{@html html}</div>

<style>
  .markdown {
    font-size: 14px;
    line-height: 1.6;
    word-wrap: break-word;
  }
  .markdown :global(p) {
    margin: 0 0 0.75em;
  }
  .markdown :global(p:last-child) {
    margin-bottom: 0;
  }
  .markdown :global(pre) {
    background: var(--bg-deep, #1a1a18);
    border-radius: var(--radius-sm, 6px);
    padding: 12px 16px;
    overflow-x: auto;
    margin: 0.75em 0;
    font-size: 13px;
  }
  .markdown :global(code) {
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .markdown :global(:not(pre) > code) {
    background: var(--bg-deep, #1a1a18);
    padding: 2px 6px;
    border-radius: 4px;
  }
  .markdown :global(ul), .markdown :global(ol) {
    padding-left: 1.5em;
    margin: 0.5em 0;
  }
  .markdown :global(a) {
    color: var(--accent);
    text-decoration: none;
  }
  .markdown :global(a:hover) {
    text-decoration: underline;
  }
  .markdown :global(table) {
    border-collapse: collapse;
    margin: 0.75em 0;
    width: 100%;
  }
  .markdown :global(th), .markdown :global(td) {
    border: 0.5px solid var(--border-strong);
    padding: 6px 10px;
    text-align: left;
    font-size: 13px;
  }
  .markdown :global(th) {
    background: var(--bg-surface);
    font-weight: 600;
  }
  .markdown :global(blockquote) {
    border-left: 3px solid var(--accent);
    margin: 0.75em 0;
    padding: 4px 12px;
    color: var(--text-secondary);
  }
  /* Code block wrapper styles */
  .markdown :global(.code-block-wrapper) {
    position: relative;
    margin: 0.75em 0;
  }
  .markdown :global(.code-block-wrapper pre) {
    margin: 0;
    border-radius: 0 0 var(--radius-sm, 6px) var(--radius-sm, 6px);
    border: 0.5px solid var(--border);
    border-top: none;
  }
  .markdown :global(.code-block-header) {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 12px;
    background: var(--bg-elevated);
    border-radius: var(--radius-sm, 6px) var(--radius-sm, 6px) 0 0;
    border: 0.5px solid var(--border);
    border-bottom: none;
  }
  .markdown :global(.code-lang) {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .markdown :global(.open-in-editor-btn) {
    font-size: 11px;
    padding: 2px 8px;
    background: none;
    border: 0.5px solid var(--border-strong);
    border-radius: 4px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }
  .markdown :global(.open-in-editor-btn:hover) {
    color: var(--accent);
    border-color: var(--accent);
  }
</style>
