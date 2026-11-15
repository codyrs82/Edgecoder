// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { escapeHtml } from "../pages/escape.js";

/**
 * The small Markdown subset the legal and explainer pages use (docs/legal/*.md): # to #### headings,
 * paragraphs, "- " and "1. " lists (one level), "> " blockquotes, "---" rules, **bold**, _italic_,
 * `code` and [links](href). Links go only to https:, mailto: or same-site paths. Bracketed
 * placeholders that are not links ([GOVERNING LAW], [CONTACT EMAIL]) are highlighted, so a draft's
 * open items are visible on the page. Everything is HTML-escaped first: no raw HTML passes through.
 */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const isBlockStart = (l: string) => /^(#{1,4} |> |- |\d+\. |---\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,4}) (.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = h[2]!;
      out.push(`<h${level} id="${slugify(text)}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }
    if (/^---\s*$/.test(line)) { out.push("<hr />"); i++; continue; }
    if (line.startsWith("> ")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) body.push(lines[i++]!.replace(/^> ?/, ""));
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }
    const list = /^(- |\d+\. )/.exec(line);
    if (list) {
      const ordered = list[1] !== "- ";
      const items: string[] = [];
      while (i < lines.length && /^(- |\d+\. )/.test(lines[i]!) === true && (/^\d/.test(lines[i]!) === ordered)) {
        let item = lines[i++]!.replace(/^(- |\d+\. )/, "");
        // Continuation lines (indented) belong to the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!)) item += " " + lines[i++]!.trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) para.push(lines[i++]!.trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
}

function safeHref(href: string): string | null {
  return /^(https:\/\/|mailto:|\/(?!\/)|#)/.test(href) ? href : null;
}

function inline(text: string): string {
  // Code spans first, so their contents are left alone.
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${codes.push(`<code>${escapeHtml(c)}</code>`) - 1}\u0000`);
  const links: string[] = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) => {
    const ok = safeHref(href);
    if (!ok) return m;
    return `\u0001${links.push(`<a href="${escapeHtml(ok)}"${ok.startsWith("https://") ? ' target="_blank" rel="noreferrer"' : ""}>${escapeHtml(label)}</a>`) - 1}\u0001`;
  });
  s = escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)]|$)/g, "$1<em>$2</em>")
    .replace(/\[((?:[A-Z]{2}|\d)[^\]]*)\]/g, '<mark class="placeholder">[$1]</mark>');
  return s
    .replace(/\u0001(\d+)\u0001/g, (_m, n: string) => links[Number(n)]!)
    .replace(/\u0000(\d+)\u0000/g, (_m, n: string) => codes[Number(n)]!);
}
