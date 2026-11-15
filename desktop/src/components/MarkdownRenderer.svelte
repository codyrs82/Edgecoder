<script lang="ts">
  import { open as openShell } from "@tauri-apps/plugin-shell";
  import { renderMarkdown, safeLinkUrl } from "../lib/markdown";

  interface Props {
    source: string;
    onOpenInEditor?: (code: string, language: string) => void;
  }
  let { source, onOpenInEditor }: Props = $props();

  // Model output: raw HTML is escaped and URLs are scheme-checked in renderMarkdown.
  let html = $derived(renderMarkdown(source));

  function handleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    // A link never navigates the app window: http(s)/mailto open in the system browser.
    const link = target.closest("a");
    if (link) {
      e.preventDefault();
      const url = safeLinkUrl(link.getAttribute("href"));
      if (url) void openShell(url).catch(() => {});
      return;
    }
    const button = target.closest<HTMLElement>(".code-btn");
    const codeEl = button?.closest(".code-block-wrapper")?.querySelector("code");
    if (!button || !codeEl) return;
    if (button.classList.contains("open-in-editor-btn")) {
      onOpenInEditor?.(codeEl.textContent || "", button.dataset.lang || "plaintext");
    } else if (button.classList.contains("copy-code-btn")) {
      void navigator.clipboard?.writeText(codeEl.textContent || "").then(() => {
        button.textContent = "Copied";
        setTimeout(() => (button.textContent = "Copy"), 1500);
      }).catch(() => {});
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="markdown" onclick={handleClick}>{@html html}</div>

<style>
  /* Chat prose: 15 px body (14 px in the narrow code-view panel), restrained headings, 4/8 px rhythm. */
  .markdown {
    font-size: var(--prose-size, var(--fs-md));
    line-height: var(--lh-prose);
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }
  .markdown > :global(:first-child) { margin-top: 0; }
  .markdown > :global(:last-child) { margin-bottom: 0; }
  .markdown :global(p) {
    margin: 0 0 12px;
  }
  .markdown :global(h1), .markdown :global(h2), .markdown :global(h3),
  .markdown :global(h4), .markdown :global(h5), .markdown :global(h6) {
    margin: 20px 0 8px;
    font-weight: 600;
    line-height: var(--lh-tight);
    letter-spacing: -0.005em;
  }
  .markdown :global(h1) { font-size: 1.2em; }
  .markdown :global(h2) { font-size: 1.1em; }
  .markdown :global(h3), .markdown :global(h4), .markdown :global(h5), .markdown :global(h6) { font-size: 1em; }
  .markdown :global(strong) { font-weight: 600; }
  .markdown :global(hr) { border: none; border-top: 0.5px solid var(--border-strong); margin: 20px 0; }
  .markdown :global(ul), .markdown :global(ol) {
    margin: 0 0 12px;
    padding-left: 1.5em;
  }
  .markdown :global(li) { margin: 4px 0; padding-left: 2px; }
  .markdown :global(li > p) { margin: 0; }
  .markdown :global(li > ul), .markdown :global(li > ol) { margin: 4px 0 0; }
  .markdown :global(li::marker) { color: var(--text-secondary); }
  .markdown :global(code) {
    font-family: var(--font-mono);
    font-size: 0.86em;
  }
  .markdown :global(:not(pre) > code) {
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--bg-elevated);
    border: 0.5px solid var(--border);
  }
  .markdown :global(pre) {
    margin: 0 0 12px;
    padding: 12px 14px;
    overflow-x: auto;
    border-radius: var(--radius-md);
    background: var(--bg-deep);
    font-size: var(--fs-sm);
    line-height: 1.55;
  }
  .markdown :global(pre code) { font-size: inherit; }
  .markdown :global(a) {
    color: var(--accent-secondary);
    text-decoration: none;
  }
  .markdown :global(a:hover) {
    text-decoration: underline;
  }
  .markdown :global(table) {
    border-collapse: collapse;
    margin: 0 0 12px;
    width: 100%;
    font-size: var(--fs-sm);
  }
  .markdown :global(th), .markdown :global(td) {
    border-bottom: 0.5px solid var(--border-strong);
    padding: 6px 10px;
    text-align: left;
  }
  .markdown :global(th) {
    font-weight: 600;
    color: var(--text-secondary);
  }
  .markdown :global(blockquote) {
    border-left: 2px solid var(--border-control);
    margin: 0 0 12px;
    padding: 0 12px;
    color: var(--text-secondary);
  }
  .markdown :global(.plan-list) {
    margin: 0 0 12px;
    padding: 10px 12px;
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .markdown :global(.plan-title) { font-size: var(--fs-xs); color: var(--text-secondary); margin-bottom: 6px; }
  .markdown :global(.plan-list ol) { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .markdown :global(.plan-list li) { display: flex; gap: 8px; align-items: center; margin: 0; }
  .markdown :global(.plan-list li.done) { color: var(--text-secondary); text-decoration: line-through; }
  .markdown :global(.plan-box) {
    width: 14px; height: 14px; flex: none; border-radius: 4px; display: inline-grid; place-items: center;
    border: 1px solid var(--text-secondary); font-size: 10px;
  }
  /* Code blocks: a quiet header with the language, Copy and Open in editor. */
  .markdown :global(.code-block-wrapper) {
    margin: 0 0 12px;
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--bg-deep);
  }
  .markdown :global(.code-block-wrapper pre) {
    margin: 0;
    border-radius: 0;
    background: transparent;
  }
  .markdown :global(.code-block-header) {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 32px;
    padding: 0 6px 0 12px;
    border-bottom: 0.5px solid var(--border);
    background: var(--bg-elevated);
  }
  .markdown :global(.code-lang) {
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }
  .markdown :global(.code-actions) { display: flex; gap: 2px; }
  .markdown :global(.code-btn) {
    height: var(--control-sm);
    padding: 0 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--fs-xs);
    line-height: 1;
    cursor: pointer;
  }
  .markdown :global(.code-btn:hover) {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
</style>
