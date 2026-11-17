// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * "Add to chat": text selected in a conversation's messages becomes a quote in the composer, so
 * the reply can answer that part. Prose becomes Markdown `> line` per line; a selection inside one
 * code block becomes a fenced block in its language. Past `max` characters (about 4,000) the text
 * is cut with "…" and a "(truncated)" line follows the block, so the model sees it too.
 *
 * Shared by the desktop app (Chat, Code, bots, live sessions: QuoteSelection.svelte and
 * ChatInput.svelte) and the portal (Chat and Bots pages, src/portal/pages/quote-selection.ts).
 * Kept byte-identical in src/common/quote-selection.ts and desktop/src/lib/quote-selection.ts (the
 * desktop app does not import from src/); tests/common/quote-selection.test.ts checks the two
 * match. Self-contained on purpose: the portal ships these functions to the browser via
 * Function.prototype.toString, so every function is a declaration and reads no module constant.
 * The DOM types are structural (src/ is compiled without the DOM library).
 */

/** A selection worth quoting: its text, the code block's language when it lies in one, and where it is. */
export interface QuotableSelection {
  text: string;
  code: { lang: string } | null;
  rect: QuoteRect;
}
export interface QuoteRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface QuoteNode {
  nodeType: number;
  parentElement: QuoteElement | null;
}
interface QuoteElement extends QuoteNode {
  closest(selector: string): QuoteElement | null;
  contains(other: QuoteNode | null): boolean;
  querySelector(selector: string): QuoteElement | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): QuoteRect;
}
interface QuoteRange {
  startContainer: QuoteNode;
  endContainer: QuoteNode;
  getBoundingClientRect?: () => QuoteRect;
  getClientRects?: () => ArrayLike<QuoteRect>;
}
interface QuoteSelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
  toString(): string;
  getRangeAt(index: number): QuoteRange;
}

/**
 * The quote for `text` as Markdown (no trailing newline): `> ` per line, or a fenced block when
 * `code` is set (the fence outgrows any backtick run inside). Over `max` characters it is cut
 * with "…" and followed by a "(truncated)" line.
 */
export function quoteMarkdown(text: string, code: { lang: string } | null, max: number = 4000): string {
  let body = String(text).replace(/\r\n?/g, "\n").replace(/ /g, " ");
  // Code keeps its indentation; prose loses surrounding blank space.
  body = code ? body.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "") : body.trim();
  let truncated = false;
  if (body.length > max) {
    body = body.slice(0, max).replace(/\s+$/, "") + "…";
    truncated = true;
  }
  let block: string;
  if (code) {
    const runs = body.match(/`+/g) || [];
    let longest = 0;
    for (const r of runs) longest = Math.max(longest, r.length);
    const fence = "`".repeat(Math.max(3, longest + 1));
    const lang = String(code.lang || "").replace(/[^\w+#.-]/g, "");
    block = fence + lang + "\n" + body + "\n" + fence;
  } else {
    // One bare ">" between paragraphs, however many blank lines were selected.
    block = body
      .split("\n")
      .map((line) => (line.trim() ? "> " + line.replace(/\s+$/, "") : ">"))
      .filter((line, i, all) => line !== ">" || all[i - 1] !== ">")
      .join("\n");
  }
  return truncated ? block + "\n(truncated)" : block;
}

/**
 * The composer text with `block` added at the caret: after the caret's line when that line has
 * text (so a quote never splits what is typed), otherwise at the caret. A blank line separates it
 * from text before and after; the new caret sits on the line after it, ready for the reply.
 */
export function insertQuoteText(value: string, caret: number, block: string): { value: string; caret: number } {
  const text = String(value);
  const at0 = Math.max(0, Math.min(caret, text.length));
  const lineStart = text.lastIndexOf("\n", at0 - 1) + 1;
  const nl = text.indexOf("\n", at0);
  const lineEnd = nl === -1 ? text.length : nl;
  const at = text.slice(lineStart, lineEnd).trim() ? lineEnd : at0;
  const before = text.slice(0, at).replace(/\s+$/, "");
  const after = text.slice(at).replace(/^\s+/, "");
  const head = (before ? before + "\n\n" : "") + block + "\n\n";
  return { value: head + (after ? "\n\n" + after : ""), caret: head.length };
}

/**
 * The selection when it can be quoted: not empty, both ends inside `scope` and inside a message
 * body (an element marked `data-quotable`), and not in a text field. `code` is set when both ends
 * are in the same `pre` (the language from its `language-…` class).
 */
export function quotableSelection(selection: QuoteSelectionLike | null, scope: QuoteElement | null | undefined): QuotableSelection | null {
  if (!selection || !scope || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (!text || !text.trim()) return null;
  const range = selection.getRangeAt(0);
  const elementOf = (n: QuoteNode | null): QuoteElement | null => (!n ? null : n.nodeType === 1 ? (n as QuoteElement) : n.parentElement);
  const start = elementOf(range.startContainer);
  const end = elementOf(range.endContainer);
  if (!start || !end || !scope.contains(start) || !scope.contains(end)) return null;
  const field = "textarea, input, [contenteditable]:not([contenteditable='false'])";
  if (start.closest(field) || end.closest(field)) return null;
  const qs = start.closest("[data-quotable]");
  const qe = end.closest("[data-quotable]");
  if (!qs || !qe || !scope.contains(qs) || !scope.contains(qe)) return null;
  const pre = start.closest("pre");
  let code: { lang: string } | null = null;
  if (pre && pre === end.closest("pre")) {
    const codeEl = pre.querySelector("code");
    const m = /(?:^|\s)language-([\w+#.-]+)/.exec((codeEl && codeEl.getAttribute("class")) || "");
    code = { lang: m ? m[1] : "" };
  }
  let rect: QuoteRect | null = null;
  const rects = typeof range.getClientRects === "function" ? range.getClientRects() : null;
  const box = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  if (box && (box.right > box.left || box.bottom > box.top)) {
    const first = rects && rects.length > 0 ? rects[0] : box;
    rect = { left: first.left, top: box.top, right: first.right, bottom: box.bottom };
  }
  if (!rect) rect = start.getBoundingClientRect();
  return { text, code, rect };
}

/**
 * Where the floating button goes (fixed coordinates): just above the selection, starting at its
 * left edge, kept inside the pane `bounds`; below it when there is no room above.
 */
export function quoteButtonPosition(sel: QuoteRect, bounds: QuoteRect, width: number, height: number): { left: number; top: number } {
  const gap = 6;
  const pad = 4;
  let top = sel.top - height - gap;
  if (top < bounds.top + pad) top = Math.min(sel.bottom + gap, bounds.bottom - height - pad);
  top = Math.max(bounds.top + pad, top);
  const maxLeft = Math.max(bounds.left + pad, bounds.right - width - pad);
  const left = Math.min(Math.max(sel.left, bounds.left + pad), maxLeft);
  return { left: Math.round(left), top: Math.round(top) };
}
