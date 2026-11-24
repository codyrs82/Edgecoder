// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * What one reply costs on a paid model, for the per-reply cost check (src/apps/ide/cost-guard.ts:
 * "This reply has used 160 cSats … Keep going · Switch · Stop") and the cost hint in the desktop
 * compute picker ("~140 cSats per long reply").
 *
 * The hint is a model's price times a fixed reference workload, REFERENCE_REPLY: a long exploring
 * reply that sends 200K input tokens in all (half of them cached, at the model's cached-input price
 * when it has one, else the full input price) and writes 5K output tokens. It is a yardstick for
 * comparing models, not a forecast: a reply that reads more costs more.
 *
 * Kept byte-identical in src/common/reply-cost.ts and desktop/src/lib/reply-cost.ts (the desktop
 * app does not import from src/); tests/common/reply-cost.test.ts checks the two match. No imports.
 */

/** The reference long exploring reply the picker's cost hint is computed for. */
export const REFERENCE_REPLY = { inputTokens: 200_000, cachedShare: 0.5, outputTokens: 5_000 };

/** Ask before a reply on a network or cloud model spends more than this many cSats (default). */
export const DEFAULT_REPLY_ASK_CSATS = 150;
/** Ask before a reply on your own frontier key spends more than this many USD (default). */
export const DEFAULT_REPLY_ASK_USD = 0.5;
export const REPLY_ASK_CSATS_MIN = 10;
export const REPLY_ASK_CSATS_MAX = 1_000_000;
export const REPLY_ASK_USD_MIN = 0.05;
export const REPLY_ASK_USD_MAX = 1_000;

/** A price per million tokens (cSats or USD): input, output and, when the model has one, cached input. */
export interface ReplyPrice {
  input: number;
  output: number;
  cachedInput?: number;
}

/** The reference reply's cost at a price per million tokens, in the price's unit. */
export function referenceReplyCost(price: ReplyPrice): number {
  const r = REFERENCE_REPLY;
  const cached = r.inputTokens * r.cachedShare;
  const fresh = r.inputTokens - cached;
  const cachedRate = typeof price.cachedInput === "number" && price.cachedInput >= 0 ? price.cachedInput : price.input;
  return (fresh * price.input + cached * cachedRate + r.outputTokens * price.output) / 1_000_000;
}

/** A threshold setting in cSats, or null when it isn't a sane number. */
export function clampReplyAskCSats(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= REPLY_ASK_CSATS_MIN && n <= REPLY_ASK_CSATS_MAX ? Math.round(n) : null;
}

/** A threshold setting in USD, or null when it isn't a sane number. */
export function clampReplyAskUsd(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= REPLY_ASK_USD_MIN && n <= REPLY_ASK_USD_MAX ? Math.round(n * 100) / 100 : null;
}

/** 210000 -> "210K", 4600 -> "4.6K", 1250000 -> "1.3M", 800 -> "800". */
export function formatTokensShort(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v >= 1_000_000) return `${Number((v / 1_000_000).toFixed(1))}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}K`;
  if (v >= 1_000) return `${Number((v / 1000).toFixed(1))}K`;
  return String(v);
}

/** "160 cSats", "$0.52" ("<$0.01" under a cent). */
export function formatSpend(amount: number, unit: "cSats" | "usd"): string {
  if (unit === "usd") return amount > 0 && amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`;
  const v = amount >= 10 ? Math.round(amount) : Number(amount.toFixed(1));
  return `${v.toLocaleString("en-US")} cSats`;
}

/** A rounded estimate: "~140 cSats", "~40 cSats", "~$0.52". */
export function roughSpend(amount: number, unit: "cSats" | "usd"): string {
  if (unit === "usd") return `~${amount > 0 && amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`}`;
  const v = amount >= 100 ? Math.round(amount / 10) * 10 : Math.max(1, Math.round(amount));
  return `~${v.toLocaleString("en-US")} cSats`;
}

/** The picker's line for a paid model: "~140 cSats per long reply". */
export function costHintLine(price: ReplyPrice, unit: "cSats" | "usd"): string {
  return `${roughSpend(referenceReplyCost(price), unit)} per long reply`;
}

/** How many times cheaper `cheap` is than `dear` (same unit), rounded; null under 2x or without a price. */
export function cheaperFactor(dear: number, cheap: number): number | null {
  if (!(dear > 0) || !(cheap > 0)) return null;
  const f = dear / cheap;
  return f >= 2 ? Math.round(f) : null;
}

/** The cost check's question: "This reply has used 160 cSats (read 210K tokens, wrote 3K)." */
export function costAskQuestion(a: { spent: number; unit: "cSats" | "usd"; inputTokens?: number; outputTokens?: number }): string {
  const tokens = a.inputTokens && a.inputTokens > 0 ? ` (read ${formatTokensShort(a.inputTokens)} tokens, wrote ${formatTokensShort(a.outputTokens ?? 0)})` : "";
  return `This reply has used ${formatSpend(a.spent, a.unit)}${tokens}.`;
}

/** The "Switch to …" button: "Switch to DeepSeek V4.1 Flash (~5× cheaper)". */
export function switchLabel(name: string, factor?: number | null): string {
  return `Switch to ${name}${factor ? ` (~${factor}× cheaper)` : ""}`;
}

/** Display names for the cloud models the hints mention ("glm-5.3" -> "GLM-5.3"); others as they are. */
export function replyModelName(model: string): string {
  const names: Record<string, string> = { "glm-5.3": "GLM-5.3", "deepseek-v4.1-flash": "DeepSeek V4.1 Flash" };
  return names[model] ?? model;
}

/** The hint under the composer for a premium model: "GLM-5.3 costs ~5× Flash for exploring; Flash or Claude (your key) may fit better." */
export function premiumHint(a: { name: string; factor: number; cheaperName: string; frontierName?: string | null }): string {
  const alt = a.frontierName ? `${a.cheaperName} or ${a.frontierName} (your key)` : a.cheaperName;
  return `${a.name} costs ~${a.factor}× ${a.cheaperName} for exploring; ${alt} may fit better.`;
}
