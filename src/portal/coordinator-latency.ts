// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Latency-aware coordinator choice for a network call (portal chat, hosted /v1).
 *
 * The load rule (chat-capacity.ts chooseByLoad: most free model slots, a tie to more agents) picks a
 * baseline. Each coordinator that can take the call is then given an expected latency:
 *
 *   expected = portal <-> coordinator round trip (measured on the portal's own capacity probes)
 *            + queueing: 0 when a slot for the model is free; otherwise the coordinator's pickup p90
 *              plus one call duration per round of calls ahead of this one (rounds = calls ahead / agents)
 *            + coordinator <-> agent round trip for agents holding the model (when it reports it).
 *
 * The pickup p90 is coordinator-wide over every model and includes calls that queued, so under load
 * it says seconds while slots for this model sit free (run 4: 1,928 ms with 14 free slots). It only
 * counts when this call would itself wait.
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
 *
 * Locality (#526) comes first when the buyer's region is known: each coordinator reports the regions
 * of its hosts with a free slot for the model (/inference/models freeRegions). The coordinator whose
 * nearest free host is closest to the buyer wins ("locality") when it is closer than the baseline's
 * by more than localityMarginKm. Only coordinators with a free slot count, so a busy near
 * coordinator never holds a call (it overflows as before). When a coordinator with a free slot does
 * not report its regions (an older build), locality is not compared.
 *
 * The nearest free coordinator (nearer than every other free one by localityMarginKm, or the locality
 * move above) is then kept unless another coordinator with a free slot is clearly faster end to end:
 * round trips + queueing + the model's service time there, faster by both margins. The latency rule
 * alone (time to start) never takes a call away from a free host near the buyer; run 4 sent São Paulo
 * buyers to the EU on 60 ms of round trip while 14 US slots were free 0 km away.
 */

import { coordinatorHost, type CoordinatorChoice, type CoordinatorChoiceCandidate } from "../common/coordinator-choice.js";
import { regionDistanceKm } from "../common/geo-regions.js";

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
  /** The model's own service time there (claim to last reply piece; /inference/models serviceMs), when reported. */
  serviceMs?: number | null;
  /** Regions of its hosts with a free slot for the call (newer coordinators); undefined: not reported. */
  freeRegions?: readonly string[];
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
  /** Locality (#526): a coordinator with a free host nearer the buyer by more than this many km wins; 0 turns it off. */
  localityMarginKm?: number;
}

export const COORD_LATENCY_DEFAULT_MARGIN_MS = 30;
export const COORD_LATENCY_DEFAULT_MARGIN_PCT = 15;
/** A call's duration when the coordinator has not reported one (a short chat reply). */
export const DEFAULT_CALL_MS = 15_000;
/** Locality margin: a free host this much nearer the buyer moves the call (about 10 ms of round trip). */
export const COORD_LOCALITY_DEFAULT_MARGIN_KM = 700;

/** Distance from the buyer to the nearest of `regions` (km); null when not known. */
export function nearestKm(clientRegion: string | null | undefined, regions: readonly string[] | undefined): number | null {
  if (!clientRegion || !regions?.length) return null;
  let best: number | null = null;
  for (const r of regions) {
    const km = regionDistanceKm(clientRegion, r);
    if (km !== null && (best === null || km < best)) best = km;
  }
  return best;
}

export function expectedLatency(c: LatencyCandidate, maxReportAgeMs: number): { queueMs: number; expectedMs: number | null; stale: boolean } {
  // A free slot takes the call now. No free slot: it waits for pickup plus (calls ahead + 1) / agents
  // rounds of calls to finish.
  const rounds = c.free > 0 ? 0 : Math.ceil((1 - c.free) / Math.max(1, c.agents));
  const queueMs = c.free > 0 ? 0 : Math.round(Math.max(0, c.pickupP90Ms ?? 0) + rounds * Math.max(0, c.callP50Ms ?? DEFAULT_CALL_MS));
  const stale = c.reportAgeMs > maxReportAgeMs;
  const expectedMs = stale || c.rttMs === null ? null : Math.round(c.rttMs + queueMs + Math.max(0, c.agentRttMs ?? 0));
  return { queueMs, expectedMs, stale };
}

type Scored = { c: LatencyCandidate; queueMs: number; expectedMs: number | null };

/**
 * End to end for comparing two coordinators: expected start + the model's service time there. When
 * either does not report its service time, both are given the same one (the reported one, or the
 * default), so the comparison is the start times against a realistic total.
 */
function endToEnd(a: Scored, b: Scored): [number, number] | null {
  if (a.expectedMs === null || b.expectedMs === null) return null;
  const sa = a.c.serviceMs ?? null;
  const sb = b.c.serviceMs ?? null;
  const shared = sa ?? sb ?? DEFAULT_CALL_MS;
  const [ta, tb] = sa !== null && sb !== null ? [sa, sb] : [shared, shared];
  return [Math.round(a.expectedMs + Math.max(0, ta)), Math.round(b.expectedMs + Math.max(0, tb))];
}

/** The coordinator with a free slot that beats `near` end to end by both margins, if any. */
function clearlyFaster(near: Scored, open: readonly Scored[], policy: LatencyPolicy): { s: Scored; e2e: number; nearE2e: number } | null {
  let best: { s: Scored; e2e: number; nearE2e: number } | null = null;
  for (const s of open) {
    if (s === near) continue;
    const pair = endToEnd(near, s);
    if (!pair) continue;
    const [nearE2e, e2e] = pair;
    const gain = nearE2e - e2e;
    if (gain > policy.marginMs && gain > (policy.marginPct / 100) * nearE2e && (!best || e2e < best.e2e)) best = { s, e2e, nearE2e };
  }
  return best;
}

/** Why the nearest was kept, for the record: the best other end to end. */
function notFaster(near: Scored, open: readonly Scored[]): string {
  let best: { host: string; e2e: number; nearE2e: number } | null = null;
  for (const s of open) {
    if (s === near) continue;
    const pair = endToEnd(near, s);
    if (pair && (!best || pair[1] < best.e2e)) best = { host: coordinatorHost(s.c.url), e2e: pair[1], nearE2e: pair[0] };
  }
  return best ? `${best.host} not clearly faster end to end (expected ${best.e2e} ms vs ${best.nearE2e} ms)` : "no other coordinator's latency known";
}

/** Pick among `candidates` (all can take the call), starting from the load rule's `baselineUrl`. */
export function chooseByLatency(
  candidates: readonly LatencyCandidate[],
  baselineUrl: string,
  policy: LatencyPolicy,
  where: { clientRegion?: string | null; portalRegion?: string | null } = {},
): CoordinatorChoice {
  const scored = candidates.map((c) => ({ c, ...expectedLatency(c, policy.maxReportAgeMs), nearKm: c.free > 0 ? nearestKm(where.clientRegion, c.freeRegions) : null }));
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
    ...(s.nearKm !== null ? { nearKm: s.nearKm } : {}),
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
  // Locality (#526): a free host nearer the buyer, when every coordinator with a free slot says where its are.
  const margin = policy.localityMarginKm ?? COORD_LOCALITY_DEFAULT_MARGIN_KM;
  const open = scored.filter((s) => s.c.free > 0);
  if (margin > 0 && where.clientRegion && open.length > 0 && open.every((s) => s.nearKm !== null)) {
    const near = open.reduce((a, b) => (b.nearKm! < a.nearKm! || (b.nearKm === a.nearKm && b.c.free > a.c.free) ? b : a));
    const km = (n: number) => (Number.isFinite(n) ? `${Math.round(n).toLocaleString("en-US")} km` : "no free host");
    const baseKm = base && base.c.free > 0 ? base.nearKm! : Infinity;
    // The load pick is itself the nearest: it holds when every other free host is farther by the margin.
    const runnerKm = Math.min(Infinity, ...open.filter((s) => s !== near).map((s) => s.nearKm!));
    const moves = near !== base && near.nearKm! + margin < baseKm;
    const holds = near === base && open.length > 1 && near.nearKm! + margin < runnerKm;
    if (moves || holds) {
      const faster = clearlyFaster(near, open, policy);
      if (faster) {
        return done(faster.s.c.url, "latency", `clearly faster end to end than the free host nearest the buyer (${where.clientRegion}, ${km(near.nearKm!)} on ${coordinatorHost(near.c.url)}): expected ${faster.e2e} ms vs ${faster.nearE2e} ms`);
      }
      return moves
        ? done(near.c.url, "locality", `free host nearest the buyer (${where.clientRegion}): ${km(near.nearKm!)} vs ${km(baseKm)} on ${coordinatorHost(baselineUrl)}`)
        : done(near.c.url, "locality", `free host nearest the buyer (${where.clientRegion}): ${km(near.nearKm!)} vs ${km(runnerKm)}; ${notFaster(near, open)}`);
    }
  }
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
    localityMarginKm: num(env.PORTAL_COORD_LOCALITY_MARGIN_KM, COORD_LOCALITY_DEFAULT_MARGIN_KM, 0, 20_000),
    maxReportAgeMs,
  };
}
