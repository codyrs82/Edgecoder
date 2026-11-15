// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * When a worker should POST /register.
 *
 * The loop used to register on every tick (~1.2 s). The coordinator's behavioural
 * rule BHV008 ("registration storm": 10 registrations in 10 min) then auto-blacklisted
 * every healthy worker about 12 s after it joined. A worker now registers once per
 * coordinator session and re-registers only when the coordinator says it doesn't know
 * the agent (401 agent_not_registered), after a failover/offline recovery, or on a slow
 * refresh that stays well under the storm threshold.
 */

export const DEFAULT_REGISTER_REFRESH_MS = 4 * 60_000;

export interface RegistrationState {
  /** Coordinator URL the last successful /register went to, or null when (re)registration is needed. */
  registeredWithUrl: string | null;
  lastRegisteredAtMs: number;
}

export function registerRefreshMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AGENT_REGISTER_REFRESH_MS);
  // Never refresh faster than once a minute: 10 registrations in 10 minutes is the blacklist threshold.
  return Number.isFinite(n) && n >= 60_000 ? Math.floor(n) : DEFAULT_REGISTER_REFRESH_MS;
}

/** True when this tick should (re)register with `url`. */
export function shouldRegister(state: RegistrationState, url: string, nowMs: number, refreshMs = DEFAULT_REGISTER_REFRESH_MS): boolean {
  if (state.registeredWithUrl !== url) return true;
  return nowMs - state.lastRegisteredAtMs >= refreshMs;
}

/** A 401 whose body says agent_not_registered: the coordinator restarted or evicted us. */
export function isAgentNotRegisteredError(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string } | null;
  return e?.statusCode === 401 && typeof e.message === "string" && e.message.includes("agent_not_registered");
}

/** Longest a worker waits on one 429 before trying again (a bad Retry-After must not park it). */
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;
/** Wait used when a 429 carries no usable Retry-After. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;

/** Retry-After (delta seconds or an HTTP date) in ms, or null when absent or unreadable. */
export function parseRetryAfterMs(value: unknown, nowMs = Date.now()): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim();
  if (text === "") return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * A 429 from the coordinator: the agent is over its request rate. The answer is to wait the
 * Retry-After and carry on, never to re-register (a 401-style reaction): registering again on
 * every refusal is what trips the registration-storm rule (BHV008). Returns the wait in ms, or
 * null when the error is not a rate limit.
 */
export function rateLimitWaitMs(err: unknown): number | null {
  const e = err as { statusCode?: number; retryAfterMs?: number } | null;
  if (e?.statusCode !== 429) return null;
  const wait = typeof e.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs) ? e.retryAfterMs : DEFAULT_RATE_LIMIT_WAIT_MS;
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(1_000, wait));
}
