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
 * move above) is then kept unless another coordinator with a free slot is clearly faster end to end,
 * faster by both margins. The latency rule alone (time to start) never takes a call away from a free
 * host near the buyer; run 4 sent São Paulo buyers to the EU on 60 ms of round trip while 14 US slots
 * were free 0 km away.
 *
 * End to end scores each coordinator by its best free host for the model, with that host's own
 * numbers (/inference/models freeHosts): portal <-> coordinator round trip + the host's round trip to
 * the buyer (from the distance between their regions; the host's round trip to its coordinator when
 * the buyer's region is not known) + the host's own time for a reference call of the model (its
 * measured speed, claim to last reply piece over the work estimated for the tokens, so its
 * coordinator <-> host legs are in it, and how large its recent calls were is not). Run 5 compared
 * coordinator-wide medians of whatever calls ran there and the median round trip to every US agent
 * (163 ms) instead, and sent iad and lax buyers to the EU while a free host sat next to them. A
 * coordinator that does not report freeHosts (an older build) is scored by its nearest free region
 * and the model's median call there.
 *
 * Run 6: a host's time is scaled to the call being placed: its speed (ms per ms of expectedWorkMs,
 * job-pricing.ts) times expectedWorkMs for this call's prompt and output tokens, not a fixed reference
 * call of 1,000 tokens in and 200 out. Run 6 compared reference calls of 19-29 s on 1.5b CPU hosts, so
 * a 9 s gap (one host measured, the other on its class's prior) sent lhr buyers to iad and a fra
 * buyer to jnb for calls that took about a second. Two hosts of one class (the model is the call's)
 * count as equally fast unless both speeds are the host's own measurements and differ by at least
 * SAME_CLASS_SPEED_RATIO: a class median or the prior says nothing about one host against another,
 * so distance decides between them. A host of another class (a GPU against a CPU) keeps its own
 * time for the call, so a faster GPU elsewhere still wins a large call.
 *
 * Calls this portal sent a coordinator that its load report does not show yet (sentFor) have each
 * taken a slot on the free host nearest their own buyer, so a burst moves on to the next host or
 * coordinator instead of every call counting the same free host (run 5: 6 heavy calls onto the EU's
 * 4 slots).
 */

import { coordinatorHost, type CoordinatorChoice, type CoordinatorChoiceCandidate } from "../common/coordinator-choice.js";
import { distanceRttMs, regionDistanceKm } from "../common/geo-regions.js";
import { expectedWorkMs } from "../economy/job-pricing.js";

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
  /** Its hosts with a free slot for the model, each with its own numbers (/inference/models freeHosts). */
  freeHosts?: readonly FreeHost[];
  /**
   * Calls this portal sent it that its load report does not show yet, by their buyers' regions (null:
   * not known): each has taken a slot on the free host nearest its buyer.
   */
  sentFor?: readonly (string | null)[];
}

/** One host with a free slot for the model, as its coordinator reports it. */
export interface FreeHost {
  region: string;
  /** Its free slots for the model. */
  free: number;
  /** Coordinator <-> host round trip, ms. */
  rttMs?: number;
  /**
   * The host's time for a reference call of the model, ms: its measured speed (claim to last reply
   * piece, over the work estimated for the call's tokens) times the reference call's work. Used only
   * when `speed` is not reported (an older coordinator).
   */
  serviceMs?: number;
  /** Its compute class (newer coordinators). */
  computeClass?: string;
  /** Its speed for the model: ms per ms of expectedWorkMs (newer coordinators). */
  speed?: number;
  /** Where `speed` comes from: the host's own recent calls, its class's on that coordinator, or the class's prior. */
  speedFrom?: "host" | "class" | "prior";
}

/** The call being placed: the model's size and the tokens it reads and may write (run 6). */
export interface CallSize {
  paramsB: number;
  promptTokens: number;
  outputTokens: number;
}

/** The call a host's time is given for when the call's own size is not known (the coordinator's reference call). */
export const DEFAULT_CALL_TOKENS = { promptTokens: 1_000, outputTokens: 200 } as const;
/**
 * Two hosts of one class compare by speed only when both speeds are their own measurements and one
 * is at least this many times the other; otherwise they count as equally fast (distance decides).
 */
export const SAME_CLASS_SPEED_RATIO = 1.5;

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

/** The free host a coordinator would most likely put the call on: what end to end is scored with. */
export interface BestHost {
  region: string | null;
  /** Buyer <-> host round trip from their regions, else the host's round trip to its coordinator. */
  legMs: number;
  /** Its time for this call (newer coordinators), else for a reference call, else the model's median call there. */
  serviceMs: number | null;
  /**
   * "call": the host's time for this call (its speed, newer coordinators); "host": its reference-call
   * time (freeHosts without speed); "model": the model's median call there (older coordinators).
   */
  serviceKind: "call" | "host" | "model";
  /** Its compute class and where its speed comes from, when reported (same-class hosts compare as equal unless both are measured). */
  computeClass?: string;
  speed?: number;
  speedFrom?: "host" | "class" | "prior";
  /** Buyer <-> host distance, km; null when not known. */
  km: number | null;
}

/**
 * The free hosts `c` still has for this call, the one its coordinator would place it on first: nearest
 * the buyer (the coordinator offers a call to the free host nearest its buyer, #526), then the faster.
 * Without the buyer's region: round trip to its coordinator + own service time. Each call sent there
 * that its report does not show yet has first taken a slot on the host nearest that call's own buyer.
 * Null when it does not report freeHosts (an older coordinator).
 */
export function openHosts(c: LatencyCandidate, clientRegion: string | null | undefined, call?: CallSize | null): BestHost[] | null {
  if (!c.freeHosts?.length) return null;
  const hostFor = (h: FreeHost, region: string | null | undefined): BestHost => {
    const km = region ? regionDistanceKm(region, h.region) : null;
    const legMs = km !== null ? distanceRttMs(km) : Math.max(0, h.rttMs ?? c.agentRttMs ?? 0);
    const forCall = hostCallMs(h, call);
    return { region: h.region, legMs, serviceMs: forCall ?? h.serviceMs ?? null, serviceKind: forCall !== null ? "call" : "host", km, ...(h.computeClass ? { computeClass: h.computeClass } : {}), ...(h.speed !== undefined ? { speed: h.speed } : {}), ...(h.speedFrom ? { speedFrom: h.speedFrom } : {}) };
  };
  const order = (region: string | null | undefined) => (a: BestHost, b: BestHost) =>
    region && a.km !== null && b.km !== null && a.km !== b.km ? a.km - b.km : a.legMs + Math.max(0, a.serviceMs ?? 0) - (b.legMs + Math.max(0, b.serviceMs ?? 0));
  const slots = c.freeHosts.filter((h) => h.free > 0).map((h) => ({ h, left: Math.floor(h.free) }));
  for (const region of c.sentFor ?? []) {
    const open = slots.filter((s) => s.left > 0);
    if (!open.length) break;
    const byIt = open.map((s) => ({ s, host: hostFor(s.h, region) })).sort((a, b) => order(region)(a.host, b.host));
    byIt[0].s.left--;
  }
  return slots
    .filter((s) => s.left > 0)
    .map((s) => hostFor(s.h, clientRegion))
    .sort(order(clientRegion));
}

/**
 * A host's time for this call: its speed times expectedWorkMs for the call's tokens on its class
 * (DEFAULT_CALL_TOKENS when the call's size is not known). Null when it reports no speed or class.
 */
export function hostCallMs(h: Pick<FreeHost, "speed" | "computeClass">, call?: CallSize | null): number | null {
  if (h.speed === undefined || !Number.isFinite(h.speed) || h.speed <= 0 || !h.computeClass || !call) return null;
  return Math.round(h.speed * expectedWorkMs({ paramsB: call.paramsB, computeClass: h.computeClass, promptTokens: call.promptTokens, outputTokens: call.outputTokens }));
}

/** The best free host of `c` for the buyer; null when it has none left. */
export function bestHost(c: LatencyCandidate, clientRegion: string | null | undefined, call?: CallSize | null): BestHost | null {
  const open = openHosts(c, clientRegion, call);
  if (open?.length) return open[0];
  // Older coordinator: its nearest free region and the model's service time there.
  const km = nearestKm(clientRegion, c.freeRegions);
  const region = km === null ? null : (c.freeRegions ?? []).find((r) => regionDistanceKm(clientRegion!, r) === km) ?? null;
  return { region, km, legMs: km !== null ? distanceRttMs(km) : Math.max(0, c.agentRttMs ?? 0), serviceMs: c.serviceMs ?? null, serviceKind: "model" };
}

type Scored = { c: LatencyCandidate; queueMs: number; expectedMs: number | null; host: BestHost | null };

/**
 * End to end for comparing two coordinators: portal <-> coordinator round trip + queueing + each one's
 * best free host (its round trip to the buyer + its own service time). When either service time is
 * not known (or they are not of one kind), both are given the same one (the known one, or the
 * default), so the comparison is the round trips against a realistic total.
 */
function endToEnd(a: Scored, b: Scored): [number, number] | null {
  if (a.expectedMs === null || b.expectedMs === null || a.c.rttMs === null || b.c.rttMs === null || !a.host || !b.host) return null;
  // Service times compare only when both are of one kind (two hosts' times for this call, two reference
  // calls, or two models' medians), and not between two hosts of one class that count as equally fast.
  const sameKind = a.host.serviceKind === b.host.serviceKind && !equallyFast(a.host, b.host);
  const sa = sameKind ? a.host.serviceMs : null;
  const sb = sameKind ? b.host.serviceMs : null;
  const shared = sa ?? sb ?? a.host.serviceMs ?? b.host.serviceMs ?? DEFAULT_CALL_MS;
  const [ta, tb] = sa !== null && sb !== null ? [sa, sb] : [shared, shared];
  const total = (s: Scored, t: number) => Math.round(s.c.rttMs! + s.queueMs + s.host!.legMs + Math.max(0, t));
  return [total(a, ta), total(b, tb)];
}

/**
 * Run 6: two hosts of one class (and the call's model) count as equally fast unless both speeds are
 * their own measurements and differ by SAME_CLASS_SPEED_RATIO; a class median or the prior does not
 * tell one host from another. Hosts that do not report their class (older coordinators) are not.
 */
export function equallyFast(a: Pick<BestHost, "computeClass" | "speed" | "speedFrom">, b: Pick<BestHost, "computeClass" | "speed" | "speedFrom">): boolean {
  if (!a.computeClass || a.computeClass !== b.computeClass) return false;
  if (a.speedFrom !== "host" || b.speedFrom !== "host" || !a.speed || !b.speed) return true;
  return Math.max(a.speed, b.speed) / Math.min(a.speed, b.speed) < SAME_CLASS_SPEED_RATIO;
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

/** Which hosts the end to end compared (for the record). */
function hostNote(a: Scored, b: Scored): string {
  const h = (s: Scored) => (s.host?.region ? `${s.host.region}${s.host.serviceMs !== null ? ` ${s.host.serviceMs} ms` : ""}${s.host.speedFrom ? ` (${s.host.computeClass ?? "?"}, ${s.host.speedFrom})` : ""}` : null);
  return h(a) && h(b) ? `, hosts ${h(a)} vs ${h(b)}` : "";
}

/** Why the nearest was kept, for the record: the best other end to end. */
function notFaster(near: Scored, open: readonly Scored[]): string {
  let best: { host: string; e2e: number; nearE2e: number; note: string } | null = null;
  for (const s of open) {
    if (s === near) continue;
    const pair = endToEnd(near, s);
    if (pair && (!best || pair[1] < best.e2e)) best = { host: coordinatorHost(s.c.url), e2e: pair[1], nearE2e: pair[0], note: hostNote(s, near) };
  }
  return best ? `${best.host} not clearly faster end to end (expected ${best.e2e} ms vs ${best.nearE2e} ms${best.note})` : "no other coordinator's latency known";
}

/** Pick among `candidates` (all can take the call), starting from the load rule's `baselineUrl`. */
export function chooseByLatency(
  candidates: readonly LatencyCandidate[],
  baselineUrl: string,
  policy: LatencyPolicy,
  where: { clientRegion?: string | null; portalRegion?: string | null; call?: CallSize | null } = {},
): CoordinatorChoice {
  // Hosts' times are for this call (run 6); a call of unknown size is given the reference call's tokens.
  const call: CallSize | null = where.call ?? null;
  const scored = candidates.map((c) => {
    const open = openHosts(c, where.clientRegion, call);
    // Locality: the nearest of the free hosts still open (or of the free regions, older coordinators).
    const nearKm = c.free <= 0 ? null : open?.length ? nearestKm(where.clientRegion, open.map((h) => h.region!)) : nearestKm(where.clientRegion, c.freeRegions);
    return { c, ...expectedLatency(c, policy.maxReportAgeMs), nearKm, host: c.free > 0 ? bestHost(c, where.clientRegion, call) : null };
  });
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
        return done(faster.s.c.url, "latency", `clearly faster end to end than the free host nearest the buyer (${where.clientRegion}, ${km(near.nearKm!)} on ${coordinatorHost(near.c.url)}): expected ${faster.e2e} ms vs ${faster.nearE2e} ms${hostNote(faster.s, near)}`);
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
