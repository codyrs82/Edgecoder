// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Latency-aware coordinator choice for a network call (portal chat, hosted /v1).
 *
 * The load rule (chat-capacity.ts chooseByLoad: most free model slots, a tie to more agents) picks a
 * baseline. Each coordinator that can take the call is then given an expected latency:
 *
 *   expected = portal <-> coordinator round trip (measured on the portal's own capacity probes)
 *            + queueing (the coordinator's pickup p90; when no slot is free, also one call duration
 *              per round of calls ahead of this one, rounds = calls ahead / agents)
 *            + coordinator <-> agent round trip for agents holding the model (when it reports it).
 *
 * The client <-> portal leg is left out: the portal relays every call, so that leg is the same
 * whichever coordinator is chosen. A buyer near Europe gets a European answer when the portal
 * machine serving them is in Europe (Fly sends them to the nearest portal machine), because its
 * measured round trip to the EU coordinator is then the short one.
 *
 * The baseline is kept unless another coordinator is faster by more than the margin
 * (both marginMs and marginPct of the baseline's expected latency), and either:
 * - it has a free slot ("latency"), or
 * - the baseline has none, so the call would queue there ("overflow").
 * Work is never moved to a slower coordinator to balance load: when the load rule's pick is slower
 * than one with a free slot by more than the margin, the faster one is taken. A coordinator whose
 * load report is stale, or whose round trip is unknown, is not compared (the baseline stands).
 */

import { coordinatorHost, type CoordinatorChoice, type CoordinatorChoiceCandidate } from "../common/coordinator-choice.js";

export interface LatencyCandidate {
  url: string;
  /** Free model slots minus calls waiting minus calls sent since the report (may be negative). */
  free: number;
  waiting: number;
  agents: number;
  /** Portal <-> coordinator round trip; null when not measured. */
  rttMs: number | null;
  pickupP90Ms: number | null;
  /** Typical call duration on that coordinator (p50); a default stands in when it does not say. */
  callP50Ms: number | null;
  agentRttMs: number | null;
  /** How old the load report is. */
  reportAgeMs: number;
}

export interface LatencyPolicy {
  /** A switch must save more than this many ms ... */
  marginMs: number;
  /** ... and more than this share of the baseline's expected latency (0.15 = 15 %). */
  marginPct: number;
  /** A load report older than this is not compared (LOAD_REPORT_MAX_AGE_MS). */
  maxReportAgeMs: number;
  /** Off: the load rule alone decides (the choice is still recorded). */
  enabled: boolean;
}

export const COORD_LATENCY_DEFAULT_MARGIN_MS = 30;
export const COORD_LATENCY_DEFAULT_MARGIN_PCT = 15;
/** A call's duration when the coordinator has not reported one (a short chat reply). */
export const DEFAULT_CALL_MS = 15_000;

export function expectedLatency(c: LatencyCandidate, maxReportAgeMs: number): { queueMs: number; expectedMs: number | null; stale: boolean } {
  const pickup = Math.max(0, c.pickupP90Ms ?? 0);
  // No free slot: this call waits for (calls ahead + 1) / agents rounds of calls to finish.
  const rounds = c.free > 0 ? 0 : Math.ceil((1 - c.free) / Math.max(1, c.agents));
  const queueMs = Math.round(pickup + rounds * Math.max(0, c.callP50Ms ?? DEFAULT_CALL_MS));
  const stale = c.reportAgeMs > maxReportAgeMs;
  const expectedMs = stale || c.rttMs === null ? null : Math.round(c.rttMs + queueMs + Math.max(0, c.agentRttMs ?? 0));
  return { queueMs, expectedMs, stale };
}

/** Pick among `candidates` (all can take the call), starting from the load rule's `baselineUrl`. */
export function chooseByLatency(
  candidates: readonly LatencyCandidate[],
  baselineUrl: string,
  policy: LatencyPolicy,
  where: { clientRegion?: string | null; portalRegion?: string | null } = {},
): CoordinatorChoice {
  const scored = candidates.map((c) => ({ c, ...expectedLatency(c, policy.maxReportAgeMs) }));
  const rows: CoordinatorChoiceCandidate[] = scored.map((s) => ({
    coordinator: coordinatorHost(s.c.url),
    rttMs: s.c.rttMs === null ? null : Math.round(s.c.rttMs),
    queueMs: s.queueMs,
    agentRttMs: s.c.agentRttMs === null ? null : Math.round(s.c.agentRttMs),
    expectedMs: s.expectedMs,
    free: s.c.free,
    waiting: s.c.waiting,
    agents: s.c.agents,
    ...(s.stale ? { stale: true } : {}),
  }));
  const done = (url: string, rule: CoordinatorChoice["rule"], reason: string): CoordinatorChoice => ({
    chosen: coordinatorHost(url),
    rule,
    reason,
    clientRegion: where.clientRegion ?? null,
    portalRegion: where.portalRegion ?? null,
    candidates: rows,
  });
  const ms = (n: number | null) => (n === null ? "?" : `${n} ms`);
  if (scored.length <= 1) return done(baselineUrl, "single", "only coordinator that can take it");
  const base = scored.find((s) => s.c.url === baselineUrl);
  const loadReason = base && base.c.free <= 0 && !scored.some((s) => s.c.free > 0) ? "every coordinator busy: backlog shared by agents" : "most free slots for the model";
  if (!policy.enabled) return done(baselineUrl, "load", `${loadReason} (latency-aware choice off)`);
  if (!base || base.expectedMs === null) return done(baselineUrl, "load", `${loadReason}; its latency is not known (${base?.stale ? "stale load report" : "round trip not measured"})`);
  const congested = base.c.free <= 0;
  let best: (typeof scored)[number] | undefined;
  for (const s of scored) {
    if (s === base || s.expectedMs === null) continue;
    if (!(s.c.free > 0 || congested)) continue;
    if (!best || s.expectedMs < best.expectedMs! || (s.expectedMs === best.expectedMs && s.c.free > best.c.free)) best = s;
  }
  if (best) {
    const gain = base.expectedMs - best.expectedMs!;
    if (gain > policy.marginMs && gain > (policy.marginPct / 100) * base.expectedMs) {
      const why = congested
        ? `overflow: ${coordinatorHost(baselineUrl)} has no free slot (queue ~${ms(base.queueMs)}); expected ${ms(best.expectedMs)} vs ${ms(base.expectedMs)}`
        : `faster with a free slot: expected ${ms(best.expectedMs)} vs ${ms(base.expectedMs)} (round trip ${ms(best.c.rttMs === null ? null : Math.round(best.c.rttMs))} vs ${ms(base.c.rttMs === null ? null : Math.round(base.c.rttMs))})`;
      return done(best.c.url, congested ? "overflow" : "latency", why);
    }
    return done(baselineUrl, "load", `${loadReason}; ${coordinatorHost(best.c.url)} not faster by the margin (expected ${ms(best.expectedMs)} vs ${ms(base.expectedMs)})`);
  }
  return done(baselineUrl, "load", `${loadReason}; no faster coordinator with a free slot (expected ${ms(base.expectedMs)})`);
}

/** PORTAL_COORD_LATENCY_* (the only place they are read). */
export function latencyPolicyFromEnv(env: NodeJS.ProcessEnv = process.env, maxReportAgeMs: number): LatencyPolicy {
  const num = (raw: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number((raw ?? "").trim() || NaN);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const flag = (env.PORTAL_COORD_LATENCY_ROUTING ?? "").trim().toLowerCase();
  return {
    enabled: !["0", "false", "off", "no"].includes(flag),
    marginMs: num(env.PORTAL_COORD_LATENCY_MARGIN_MS, COORD_LATENCY_DEFAULT_MARGIN_MS, 0, 10_000),
    marginPct: num(env.PORTAL_COORD_LATENCY_MARGIN_PCT, COORD_LATENCY_DEFAULT_MARGIN_PCT, 0, 100),
    maxReportAgeMs,
  };
}
