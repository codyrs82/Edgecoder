<script lang="ts">
  // Numbered sources under a web answer (the [n] it cites, as links) and the web footer
  // ("2 searches · 1 page · 1.2 cSats").
  import { open as openShell } from "@tauri-apps/plugin-shell";
  import { safeLinkUrl } from "../lib/markdown";
  import { citedSources, webFooter, type WebUsage } from "../lib/web-tool";

  interface Props {
    web: WebUsage;
    /** The answer's text: only the sources it cites are listed (all of them when it cites none). */
    text: string;
  }
  let { web, text }: Props = $props();
  const sources = $derived(citedSources(text, web.sources));
  const footer = $derived(webFooter(web));

  function host(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }
  function openLink(e: MouseEvent, url: string) {
    e.preventDefault();
    const safe = safeLinkUrl(url);
    if (safe) void openShell(safe).catch(() => {});
  }
</script>

{#if sources.length || footer}
  <div class="web-sources" data-testid="web-sources">
    {#if sources.length}
      <div class="title">Sources</div>
      <ol>
        {#each sources as s (s.n)}
          <li value={s.n}>
            <a href={s.url} target="_blank" rel="noopener noreferrer" onclick={(e) => openLink(e, s.url)}>{s.title}</a>
            <span class="host">{host(s.url)}</span>
          </li>
        {/each}
      </ol>
    {/if}
    {#if footer}<div class="footer">{footer}</div>{/if}
  </div>
{/if}

<style>
  .web-sources {
    margin-top: 10px;
    font-size: var(--fs-sm);
    line-height: 1.5;
  }
  .title {
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  ol {
    margin: 4px 0 0;
    padding-left: 22px;
  }
  a {
    color: var(--accent);
    overflow-wrap: anywhere;
  }
  .host {
    margin-left: 6px;
    color: var(--text-muted);
  }
  .footer {
    margin-top: 4px;
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
</style>
