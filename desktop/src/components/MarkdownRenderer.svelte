<script lang="ts">
  import { marked } from "marked";

  interface Props {
    source: string;
  }
  let { source }: Props = $props();

  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  let html = $derived(marked.parse(source, { async: false }) as string);
</script>

<div class="markdown">{@html html}</div>

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
</style>
