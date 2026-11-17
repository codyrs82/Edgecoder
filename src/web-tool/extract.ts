// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Readable text from a fetched page, without dependencies: the title and the main text of HTML
 * (scripts, styles, navigation, headers, footers, forms and asides dropped; headings, paragraphs,
 * list items and table rows kept as lines), JSON pretty-printed, plain text as it is, and the text
 * of simple PDFs (uncompressed or Flate streams with Tj/TJ text; anything else is refused).
 */

import { inflateSync } from "node:zlib";

/** Longest text a page read returns (characters). */
export const PAGE_TEXT_MAX_CHARS = 20_000;

export interface PageText {
  title: string;
  text: string;
  /** The text was cut at PAGE_TEXT_MAX_CHARS. */
  truncated: boolean;
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•",
  laquo: "«", raquo: "»", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢", times: "×", divide: "÷",
};

/** Decode HTML character references (named ones above, decimal and hex). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED[ref.toLowerCase()] ?? m;
  });
}

/** Whitespace tidied: no runs of spaces, at most one blank line between blocks. */
function tidy(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cap(title: string, text: string): PageText {
  const truncated = text.length > PAGE_TEXT_MAX_CHARS;
  return { title: title.slice(0, 300), text: truncated ? `${text.slice(0, PAGE_TEXT_MAX_CHARS)}\n\n[… cut at ${PAGE_TEXT_MAX_CHARS.toLocaleString("en-US")} characters]` : text, truncated };
}

/** Elements dropped with everything inside them. */
const DROP = ["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "nav", "header", "footer", "aside", "form", "button", "select", "dialog", "menu"];

function dropElements(html: string, tags: string[]): string {
  let out = html;
  for (const tag of tags) {
    // Innermost first is not needed: a non-greedy match to the first close tag, repeated, removes nested copies too.
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    for (let i = 0; i < 20; i++) {
      const next = out.replace(re, " ");
      if (next === out) break;
      out = next;
    }
    // An unclosed one (or a self-closed <svg/>) goes too.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
  }
  return out;
}

/** The inner HTML of the largest <main> or <article>, when the page has one with real text. */
function mainRegion(html: string): string | null {
  let best: string | null = null;
  for (const tag of ["main", "article"]) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
    for (const m of html.matchAll(re)) {
      const inner = m[1];
      if (inner.replace(/<[^>]*>/g, "").trim().length > 200 && (!best || inner.length > best.length)) best = inner;
    }
    if (best) return best;
  }
  return best;
}

/** Title and main text of an HTML page. */
export function htmlToText(html: string): PageText {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ");
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(s);
  let title = titleMatch ? tidy(decodeEntities(titleMatch[1].replace(/<[^>]*>/g, ""))).replace(/\n/g, " ") : "";
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " ");
  s = dropElements(s, DROP);
  s = mainRegion(s) ?? s;
  if (!title) {
    const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(s);
    if (h1) title = tidy(decodeEntities(h1[1].replace(/<[^>]*>/g, ""))).replace(/\n/g, " ");
  }
  s = s
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|blockquote|pre|ul|ol|table|tr|dl|dt|dd|figure|figcaption|h[1-6])\s*>/gi, "\n\n")
    .replace(/<(p|div|section|blockquote|pre|tr|dt|dd|figure)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " | ")
    // Inline elements join their text to the words around them ("<b>bold</b>." stays "bold.").
    .replace(/<\/?(?:a|b|i|u|s|em|strong|span|code|small|sup|sub|abbr|mark|q|cite|time|kbd|var|bdi|bdo|data|font)\b[^>]*>/gi, "")
    .replace(/<[^>]*>/g, " ");
  const text = tidy(decodeEntities(s)).replace(/ \|\s*$/gm, "");
  return cap(title, text);
}

/** JSON pretty-printed (or as it came when it doesn't parse). */
export function jsonToText(raw: string): PageText {
  try {
    return cap("", JSON.stringify(JSON.parse(raw), null, 2));
  } catch {
    return cap("", raw.trim());
  }
}

export function plainToText(raw: string): PageText {
  return cap("", tidy(raw));
}

// ---------------------------------------------------------------------------
// PDF: the text-showing operators of simple PDFs
// ---------------------------------------------------------------------------

/** A PDF literal string's bytes as text ((…) with escapes). */
function pdfLiteral(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_m, e: string) => {
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: "\n", r: "", t: " ", b: "", f: "", "(": "(", ")": ")", "\\": "\\" } as Record<string, string>)[e] ?? "";
  });
}

/** The text a content stream shows: (…) Tj, ' and ", [(…) n (…)] TJ, with line breaks at T*, Td, TD. */
function pdfStreamText(content: string): string {
  const out: string[] = [];
  const re = /\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ|T\*|-?[\d.]+\s+-?[\d.]+\s+T[dD]|ET/g;
  for (const m of content.matchAll(re)) {
    const tok = m[0];
    if (tok === "T*" || /T[dD]$/.test(tok) || tok === "ET") {
      out.push("\n");
      continue;
    }
    if (tok.startsWith("[")) {
      for (const part of (m[1] ?? "").matchAll(/\((?:\\.|[^\\)])*\)|-?\d+(?:\.\d+)?/g)) {
        const p = part[0];
        if (p.startsWith("(")) out.push(pdfLiteral(p.slice(1, -1)));
        else if (Number(p) < -200) out.push(" ");
      }
      continue;
    }
    const lit = /^\(((?:\\.|[^\\)])*)\)/.exec(tok);
    if (lit) out.push(pdfLiteral(lit[1]));
  }
  return out.join("");
}

/**
 * The text of a simple PDF: each stream (Flate-decoded when it says so) scanned for text
 * operators. Fonts with custom encodings (most CID fonts) come out as noise or nothing; then null.
 */
export function pdfToText(buf: Buffer): PageText | null {
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return null;
  const raw = buf.toString("latin1");
  const parts: string[] = [];
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  for (const m of raw.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const dict = m[1];
    let data = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try {
        data = inflateSync(data);
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(dict)) continue; // other filters (images, LZW, ...) aren't text we can read
    const text = pdfStreamText(data.toString("latin1"));
    if (text.trim()) parts.push(text);
  }
  const titleMatch = /\/Title\s*\(((?:\\.|[^\\)])*)\)/.exec(raw);
  const text = tidy(parts.join("\n"));
  // Mostly readable characters, or it's an encoding we can't map.
  const readable = text.replace(/[^\p{L}\p{N}\p{P}\s]/gu, "").length;
  if (text.length < 20 || readable / text.length < 0.85) return null;
  return cap(titleMatch ? pdfLiteral(titleMatch[1]).trim() : "", text);
}
