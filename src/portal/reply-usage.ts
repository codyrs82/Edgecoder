// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { CallUsage, Served } from "../common/served.js";

/**
 * What a reply ran on and cost, as the page's footer reads it (src/common/served.ts servedLine,
 * the same line the desktop app shows): sent with the final `done` event on every path, and saved
 * with the assistant message (portal_messages.usage_meta) so the footer survives a reload.
 */
export interface ReplyUsage {
  cSats: number;
  where?: string;
  calls: CallUsage[];
}

/** At most this many per-call entries are stored; the rest are dropped (the totals stay). */
export const REPLY_USAGE_MAX_CALLS = 20;
/** The stored JSON is kept under this many bytes. */
export const REPLY_USAGE_MAX_BYTES = 4096;

const STR_MAX = 200;
function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v.slice(0, STR_MAX) : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Only the footer's known fields (never prompts or secrets: anything else is dropped). */
function compactServed(v: unknown): Served | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  const out: Served = {
    label: str(s.label) ?? "",
    own: s.own === true,
    computeClass: str(s.computeClass) ?? "",
    tier: str(s.tier) ?? null,
    hardware: str(s.hardware) ?? "",
    region: str(s.region) ?? null,
    country: str(s.country) ?? null,
  };
  for (const k of ["gpu", "city"] as const) {
    const x = str(s[k]);
    if (x !== undefined) out[k] = x;
  }
  for (const k of ["pickupMs", "promptMs", "genMs", "promptTokens", "outputTokens", "usd"] as const) {
    const x = num(s[k]);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

function compactCall(v: unknown): CallUsage | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c = v as Record<string, unknown>;
  const out: CallUsage = { cSats: num(c.cSats) ?? 0 };
  const where = str(c.where);
  if (where) out.where = where;
  const model = str(c.model);
  if (model) out.model = model;
  const served = compactServed(c.served);
  if (served) out.served = served;
  return out;
}

/**
 * The usage to store: whitelisted fields, at most REPLY_USAGE_MAX_CALLS calls, and under
 * REPLY_USAGE_MAX_BYTES (oldest calls dropped first; cost and where always kept). Undefined when
 * there is nothing usable.
 */
export function compactReplyUsage(v: unknown): ReplyUsage | undefined {
  if (!v || typeof v !== "object") return undefined;
  const u = v as Record<string, unknown>;
  const calls = (Array.isArray(u.calls) ? u.calls : []).map(compactCall).filter((c): c is CallUsage => !!c);
  const out: ReplyUsage = { cSats: num(u.cSats) ?? 0, calls: calls.slice(-REPLY_USAGE_MAX_CALLS) };
  const where = str(u.where);
  if (where) out.where = where;
  while (out.calls.length && Buffer.byteLength(JSON.stringify(out)) > REPLY_USAGE_MAX_BYTES) out.calls.shift();
  return out;
}
