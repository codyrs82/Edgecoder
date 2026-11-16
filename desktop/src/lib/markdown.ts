// Markdown for chat messages. Model output is untrusted: it reaches the DOM through {@html}, so
// raw HTML in it is shown as text, never parsed as markup (no <style>, forms, iframes, meta
// refresh, event handlers), every attribute value is escaped, and links and images keep only
// URLs with an allowed scheme. Links never navigate the app window: MarkdownRenderer opens them
// in the system browser.
import { Marked, type Tokens } from "marked";

/** Text made safe for an HTML text node or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The URL when a chat link may open it in the system browser (http, https, mailto), else null. */
export function safeLinkUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return null; // relative URLs would resolve against the app origin
  }
  return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.href : null;
}

/** A code fence's language, reduced to characters a language name uses. */
function langName(lang: string | undefined): string {
  return (lang ?? "").trim().split(/\s+/)[0].replace(/[^\w+#.-]/g, "").slice(0, 40);
}

// A plan a model wrote as text (```plan with a JSON step list) reads as a checklist, not JSON.
function planHtml(text: string): string | null {
  try {
    const steps = JSON.parse(text);
    if (!Array.isArray(steps) || steps.length === 0) return null;
    const items = steps.map((s: { description?: unknown; status?: unknown }) => {
      const done = s?.status === "completed";
      return `<li class="${done ? "done" : ""}"><span class="plan-box">${done ? "✓" : ""}</span>${escapeHtml(String(s?.description ?? ""))}</li>`;
    });
    return `<div class="plan-list"><div class="plan-title">Plan</div><ol>${items.join("")}</ol></div>`;
  } catch {
    return null;
  }
}

const md = new Marked({
  breaks: true,
  gfm: true,
  renderer: {
    // Raw HTML, block or inline: shown as the text the model wrote.
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      const url = safeLinkUrl(href);
      if (!url) return inner;
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(url)}" data-external-link${t} rel="noopener noreferrer">${inner}</a>`;
    },
    // Images are not fetched (they would load remote content into the app); the alt text and URL
    // are shown as a link instead.
    image({ href, title, text }: Tokens.Image) {
      const url = safeLinkUrl(href);
      const label = escapeHtml(text || title || href || "image");
      return url ? `<a href="${escapeHtml(url)}" data-external-link rel="noopener noreferrer">${label}</a>` : label;
    },
    code({ text, lang }: Tokens.Code) {
      const name = langName(lang);
      if (name === "plan") {
        const html = planHtml(text);
        if (html) return html;
      }
      return `<div class="code-block-wrapper">
      <div class="code-block-header">
        <span class="code-lang">${escapeHtml(name || "text")}</span>
        <span class="code-actions">
          <button type="button" class="code-btn copy-code-btn">Copy</button>
          <button type="button" class="code-btn open-in-editor-btn" data-lang="${escapeHtml(name || "plaintext")}">Open in editor</button>
        </span>
      </div>
      <pre><code class="language-${escapeHtml(name)}">${escapeHtml(text)}</code></pre>
    </div>`;
    },
  },
});

/** How much of one message is rendered as markdown: its start and its latest part. */
export const MAX_MARKDOWN = 8_000;
const MARKDOWN_HEAD = 2_000;
export const TRIMMED_TEXT = "… (earlier output trimmed) …";

/**
 * A message within MAX_MARKDOWN: its start, the trim marker, and its latest part. marked's
 * emphasis parsing grows quadratically on some model output (code like `self._x`, a small model
 * writing whole files as text), and a reply of a few hundred KB pinned the app for minutes.
 * Text already trimmed (the bots server trims stored replies) keeps its own head.
 */
export function capMarkdownSource(text: string, max = MAX_MARKDOWN): string {
  if (text.length <= max) return text;
  const cut = text.indexOf(TRIMMED_TEXT);
  const head = cut >= 0 && cut <= MARKDOWN_HEAD ? text.slice(0, cut).trimEnd() : text.slice(0, MARKDOWN_HEAD);
  const sep = `\n\n${TRIMMED_TEXT}\n\n`;
  return head + sep + text.slice(text.length - Math.max(0, max - head.length - sep.length));
}

/**
 * Rendered HTML by source text (at most MAX_MARKDOWN long, so keys stay small). Views re-create
 * message components (switching chats, a stream tick re-rendering the list); an unchanged message
 * is then never parsed again. Least recently used entries go first.
 */
const rendered = new Map<string, string>();
const MAX_RENDERED = 300;

/** Chat markdown as HTML that is safe to insert into the app. */
export function renderMarkdown(source: string): string {
  const src = capMarkdownSource(source);
  const hit = rendered.get(src);
  if (hit !== undefined) {
    rendered.delete(src);
    rendered.set(src, hit);
    return hit;
  }
  const html = md.parse(src, { async: false }) as string;
  rendered.set(src, html);
  if (rendered.size > MAX_RENDERED) rendered.delete(rendered.keys().next().value!);
  return html;
}
