// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { safeTokenEqual } from "./crypto-utils.js";

/*
 * Shared-secret rotation without downtime (docs/security/rotation.md).
 *
 * A verifier holds the current value and, during a rotation, the previous one (`<NAME>_PREVIOUS`).
 * The previous value is accepted only until TOKEN_PREVIOUS_UNTIL (an ISO 8601 time or epoch
 * milliseconds), so a forgotten `_PREVIOUS` secret stops working on its own. Without
 * TOKEN_PREVIOUS_UNTIL, or with a value more than MAX_PREVIOUS_WINDOW_MS ahead, the previous value
 * is never accepted. Senders always send the current value.
 */

/** Longest dual-accept window TOKEN_PREVIOUS_UNTIL may set: 7 days. */
export const MAX_PREVIOUS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface TokenSet {
  current: string;
  previous?: string;
  /** Epoch ms after which `previous` is no longer accepted. */
  previousUntilMs?: number;
}

/** Parses TOKEN_PREVIOUS_UNTIL: ISO 8601 or epoch milliseconds. Undefined when unset or unparseable. */
export function parsePreviousUntil(raw: string | undefined): number | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Whether a TOKEN_PREVIOUS_UNTIL value is well-formed and within the 7-day limit (config validation). */
export function previousUntilProblem(raw: string | undefined, nowMs = Date.now()): string | null {
  if (!(raw ?? "").trim()) return null;
  const ms = parsePreviousUntil(raw);
  if (ms === undefined) return "must be an ISO 8601 time or epoch milliseconds";
  if (ms - nowMs > MAX_PREVIOUS_WINDOW_MS) return "must be at most 7 days ahead";
  return null;
}

export function tokenSet(current: string | undefined, previous: string | undefined, previousUntil: string | undefined, nowMs = Date.now()): TokenSet {
  const prev = (previous ?? "").trim();
  const until = parsePreviousUntil(previousUntil);
  // A window set further ahead than the limit is ignored rather than trusted.
  const usable = prev && until !== undefined && until - nowMs <= MAX_PREVIOUS_WINDOW_MS;
  return { current: current ?? "", ...(usable ? { previous: prev, previousUntilMs: until } : {}) };
}

/** The values accepted at `nowMs`: the current one, and the previous one inside its window. */
export function acceptedTokens(set: TokenSet, nowMs = Date.now()): string[] {
  const out: string[] = [];
  if (set.current) out.push(set.current);
  if (set.previous && set.previousUntilMs !== undefined && nowMs <= set.previousUntilMs && set.previous !== set.current) out.push(set.previous);
  return out;
}

/** Constant-time match of `provided` against every accepted value (each one compared). */
export function matchesTokenSet(provided: unknown, set: TokenSet, nowMs = Date.now()): boolean {
  if (typeof provided !== "string" || !provided) return false;
  let ok = false;
  for (const t of acceptedTokens(set, nowMs)) {
    if (safeTokenEqual(provided, t)) ok = true;
  }
  return ok;
}
