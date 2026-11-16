// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The markdown cap (#333), shared by the server side and the web portal. The desktop app keeps the
 * same numbers in desktop/src/lib/markdown.ts (tests/common/markdown-cap.test.ts keeps them in
 * step): a message is rendered as markdown up to MAX_MARKDOWN characters, its start and its latest
 * part, because markdown parsing grows quadratically on some model output and a reply of a few
 * hundred KB froze the app.
 */

/** How much of one message is rendered as markdown: its start and its latest part. */
export const MAX_MARKDOWN = 8_000;
export const MARKDOWN_HEAD = 2_000;
export const TRIMMED_TEXT = "… (earlier output trimmed) …";

/** A message within `max`: its start, the trim marker, and its latest part (a head already trimmed upstream is kept). */
export function capMarkdownSource(text: string, max = MAX_MARKDOWN): string {
  if (text.length <= max) return text;
  const cut = text.indexOf(TRIMMED_TEXT);
  const headLen = Math.min(MARKDOWN_HEAD, Math.floor(max / 4));
  const head = cut >= 0 && cut <= headLen ? text.slice(0, cut).trimEnd() : text.slice(0, headLen);
  const sep = `\n\n${TRIMMED_TEXT}\n\n`;
  return head + sep + text.slice(text.length - Math.max(0, max - head.length - sep.length));
}

/** The browser twin of capMarkdownSource (portal page scripts include it). */
export const CLIENT_MARKDOWN_CAP_JS = `
    var MAX_MARKDOWN = ${MAX_MARKDOWN};
    var TRIMMED_TEXT = ${JSON.stringify(TRIMMED_TEXT)};
    function capMarkdownSource(text, max) {
      max = max || MAX_MARKDOWN;
      text = String(text || "");
      if (text.length <= max) return text;
      var cut = text.indexOf(TRIMMED_TEXT);
      var headLen = Math.min(${MARKDOWN_HEAD}, Math.floor(max / 4));
      var head = cut >= 0 && cut <= headLen ? text.slice(0, cut).replace(/\\s+$/, "") : text.slice(0, headLen);
      var sep = "\\n\\n" + TRIMMED_TEXT + "\\n\\n";
      return head + sep + text.slice(text.length - Math.max(0, max - head.length - sep.length));
    }
`;
