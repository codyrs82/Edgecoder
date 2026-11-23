// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";

/**
 * The rules every brand post is held to, checked when a draft is made or edited and again when it
 * is approved and right before it is sent. A post with any problem cannot be approved or sent.
 *
 * - Never-claim: wording EdgeCoder must not use (the license is BUSL-1.1, source-available; no
 *   end-to-end encryption or private-compute claim; no income promises; no parity with frontier
 *   models). A post that names the iOS app, iPhone or the App Store must not talk about earning,
 *   sats paid, hosting or withdrawing (App Store rules).
 * - Original posts only: no @mentions (a mention notifies someone; replies start with one), no "RT".
 * - X's 280 weighted characters, every URL counting 23.
 */

export const X_MAX_WEIGHTED = 280;
export const X_URL_WEIGHT = 23;

export interface RuleProblem {
  code: string;
  message: string;
}

const NEVER_CLAIM: Array<{ code: string; re: RegExp; message: string }> = [
  { code: "open_source", re: /\bopen[\s-]?sourced?\b|\bOSS\b/i, message: 'Says "open source": EdgeCoder is source-available (BUSL-1.1). Use "source-available".' },
  { code: "e2e_encrypted", re: /\bend[\s-]*to[\s-]*end[\s-]*encrypt\w*|\be2ee?\b/i, message: "Claims end-to-end encryption." },
  {
    code: "private_compute",
    re: /\bprivate\s+(?:network|compute|computing|inference|ai|llms?|cloud)\b|\b(?:fully|completely|totally|100%)\s+private\b/i,
    message: "Claims a private network or private compute."
  },
  { code: "passive_income", re: /\bpassive\s+income\b/i, message: 'Says "passive income".' },
  { code: "guaranteed_earnings", re: /\bguarantee(?:d|s)?\s+(?:earnings?|income|returns?|profits?|payouts?|sats)\b/i, message: "Promises guaranteed earnings, income or returns." },
  {
    code: "frontier_parity",
    re: /\b(?:as\s+good\s+as|on\s+par\s+with|par\s+with|matches|matching|rivals?|rivaling|equivalent\s+to|same\s+quality\s+as|better\s+than|beats?|outperforms?)\s+(?:chat\s?gpt|gpt|claude|gemini|openai|anthropic|frontier|o[134]\b)/i,
    message: "Claims parity with frontier models."
  },
  { code: "frontier_parity", re: /\bfrontier[\s-](?:level|class|grade|quality|tier)\b/i, message: "Claims parity with frontier models." },
  { code: "frontier_parity", re: /\b(?:gpt-?[3-9](?:\.\d)?o?|claude(?:[\s-]\w+)?|gemini)[\s-](?:level|class|grade|quality|tier)\b/i, message: "Claims parity with frontier models." }
];

const IOS_MENTION = /\b(?:ios|iphone|ipad|app\s*store|testflight)\b/i;
const IOS_FORBIDDEN = /\b(?:earn\w*|sats?|satoshis?|paid|payouts?|income|host(?:s|ing|ed)?|withdraw\w*)\b/i;

/** Wording the brand account must not use. Empty when the text is clean. */
export function neverClaimProblems(text: string): RuleProblem[] {
  const t = text.normalize("NFKC");
  const out: RuleProblem[] = [];
  const seen = new Set<string>();
  for (const rule of NEVER_CLAIM) {
    if (seen.has(rule.code) || !rule.re.test(t)) continue;
    seen.add(rule.code);
    out.push({ code: rule.code, message: rule.message });
  }
  if (IOS_MENTION.test(t) && IOS_FORBIDDEN.test(t)) {
    out.push({ code: "ios_earning", message: "Mentions the iOS app / iPhone / App Store together with earning, sats paid, hosting or withdrawing (App Store rule)." });
  }
  return out;
}

/** An @handle not inside an email address or a URL. */
const MENTION = /(^|[^\w@/.])[@＠][A-Za-z0-9_]{1,15}\b/;

/** Remove @mentions at the start of a text (a reply's prefix). Mentions elsewhere are refused, not rewritten. */
export function stripLeadingMentions(text: string): string {
  return text.replace(/^(?:\s*[@＠][A-Za-z0-9_]{1,15}\b[\s,:]*)+/, "").trimStart();
}

const URL_RE = /\bhttps?:\/\/[^\s<>"]+/gi;
// Bare domains X links anyway (edgecoder.io, docs.edgecoder.io/guides).
const BARE_DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:io|com|org|net|dev|app|ai|co|xyz)\b(?:\/[^\s<>"]*)?/gi;

/**
 * X's weighted length (twitter-text v3): each URL counts 23; code points in the Latin and
 * general-punctuation ranges count 1, everything else (CJK, emoji) 2. Emoji sequences are counted
 * per code point, which can only overcount (stricter than X).
 */
export function xWeightedLength(text: string): number {
  const withoutUrls = text.normalize("NFC").replace(URL_RE, "\u0000").replace(BARE_DOMAIN_RE, "\u0000");
  let n = 0;
  for (const ch of withoutUrls) {
    if (ch === "\u0000") {
      n += X_URL_WEIGHT;
      continue;
    }
    const cp = ch.codePointAt(0)!;
    const light = (cp >= 0 && cp <= 4351) || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
    n += light ? 1 : 2;
  }
  return n;
}

/** Every problem that keeps `text` from being posted (never-claim, mentions, length, empty). */
export function postProblems(text: string): RuleProblem[] {
  const out: RuleProblem[] = [];
  const t = text.trim();
  if (!t) return [{ code: "empty", message: "The post is empty." }];
  if (MENTION.test(t)) out.push({ code: "mention", message: "Contains an @mention. Brand posts are original posts only: no replies or mentions." });
  if (/^RT\b/i.test(t)) out.push({ code: "retweet", message: 'Starts with "RT". Brand posts are original posts only.' });
  const len = xWeightedLength(t);
  if (len > X_MAX_WEIGHTED) out.push({ code: "too_long", message: `${len} of ${X_MAX_WEIGHTED} characters (URLs count ${X_URL_WEIGHT}).` });
  out.push(...neverClaimProblems(t));
  return out;
}

/** Text compared for duplicates: case, whitespace and tracking parameters do not make a post new. */
export function normalizeForDedupe(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/([?&])utm_[a-z]+=[^&\s]*/gi, "$1")
    .replace(/[?&]+(?=\s|$)/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function dedupeHash(text: string): string {
  return createHash("sha256").update(normalizeForDedupe(text)).digest("hex");
}

export type UtmSource = "x" | "nostr";

/** `url` with utm_source / utm_medium=social / utm_campaign=<campaign> (existing utm_ values replaced). */
export function withUtm(url: string, source: UtmSource, campaign: string): string {
  const u = new URL(url);
  u.searchParams.set("utm_source", source);
  u.searchParams.set("utm_medium", "social");
  u.searchParams.set("utm_campaign", campaign);
  return u.toString();
}

/** The X text of a post, as sent to Nostr: links tagged utm_source=nostr instead of x. */
export function forNostr(text: string): string {
  return text.replace(/([?&]utm_source=)x(?=[&\s]|$)/g, "$1nostr");
}
