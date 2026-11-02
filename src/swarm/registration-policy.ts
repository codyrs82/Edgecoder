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
