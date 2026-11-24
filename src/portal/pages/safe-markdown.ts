// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { CLIENT_MARKDOWN_CAP_JS } from "../../common/markdown-cap.js";

/**
 * The browser markdown the relay pages (Bots, Code) use for agent and user text. Everything is
 * escaped first (the shell's escapeHtml), then code blocks, inline code, bold and italics are
 * turned back on; no links, images or raw HTML ever come through. Capped like the desktop (issue 333).
 */
export const CLIENT_SAFE_MARKDOWN_JS =
  CLIENT_MARKDOWN_CAP_JS +
  String.raw`
    /* Chat markdown: escaped first, then code blocks, inline code, bold, italics; capped like the desktop (issue 333). */
    function renderMarkdown(text) {
      var html = escapeHtml(capMarkdownSource(text));
      html = html.replace(/&#96;&#96;&#96;[^\n]*\n?([\s\S]*?)&#96;&#96;&#96;/g, function(_m, code) { return "<pre><code>" + code.replace(/\n$/, "") + "</code></pre>"; });
      html = html.replace(/&#96;([^&\n]|&(?!#96;))+?&#96;/g, function(m) { return "<code>" + m.slice(5, -5) + "</code>"; });
      html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      return html.split(/(<pre>[\s\S]*?<\/pre>)/).map(function(part) { return part.indexOf("<pre>") === 0 ? part : part.replace(/^\n+|\n+$/g, "").replace(/\n/g, "<br>"); }).join("");
    }
`;
