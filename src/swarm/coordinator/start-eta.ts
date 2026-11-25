// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * C9 (network test run 3, 2026-11-24): a coordinator whose hosts for a model are few and small
 * (2-slot EU CPU hosts) accepted bursts it could not start in time. The calls queued, ran late on
 * saturated hosts and ended at the 180 s call timeout, instead of being sent to the other
 * coordinator up front.
 *
 * Before a network call is accepted, /inference/submit now estimates when it would start here:
 *
 *   startEta = (calls waiting for the model - free slots + 1) / slots serving the model
 *              × typical service time of the model on that class here
 *
 * (0 while a free slot is left for it). Service time is measured per model and class from claim to
 * the last reply piece (recent calls only, median). When the estimate exceeds the threshold
 * (INFERENCE_START_ETA_FRACTION × the call's timeout, and never more than the claim bound
 * INFERENCE_CLAIM_TIMEOUT_MS, after which an unclaimed call is cancelled anyway), the call is
 * answered route_elsewhere when the caller allows it and a peer has a free slot (the #526
 * mechanism), else 503 no_capacity with Retry-After. Nothing is reserved in either case. With too
 * few measurements there is no estimate and the call is accepted as before.
 *
 * Completion (network test run 4, 2026-11-25): a call that starts in time can still not finish in
 * time (a heavy prompt and 2,000 output tokens on a 2-slot CPU host ran to the 180 s deadline). Each
 * service-time sample also keeps its speed: measured time ÷ expectedWorkMs (job-pricing.ts) for the
 * tokens it read and wrote. The median speed per model and class, times expectedWorkMs for a new
 * call's prompt and max_tokens (INFERENCE_COMPLETION_OUTPUT_SHARE of it), plus its start estimate, is
 * when it would finish there. A class that would not finish within INFERENCE_COMPLETION_ETA_FRACTION
 * of the call's timeout does not get the call (its agents are excluded from it, or Auto picks again
 * without them); when no class here would finish it in time, the call goes to a peer or is refused,
 * before anything is reserved.
 *
 * Run 5 (2026-11-25): the speed of a class was the median over all its recent calls, and most were
 * short (lookups of a few dozen tokens, ~1 s), so heavy calls were judged at that speed: a 3k-token
 * prompt with max_tokens 2000 on a 1.5b CPU host "would finish" in ~35 s and ran to the deadline
 * (inf-1795598815058-e13b5460, inf-1795599047742-2e35fe93). Now:
 *
 *   - relevance: only samples whose own work (expectedWorkMs for their tokens) is at least
 *     RELEVANT_WORK_SHARE of the judged call's work count for it; a short call says little about a
 *     long one;
 *   - prior: with fewer than SERVICE_MIN_SAMPLES relevant samples (always right after a deploy:
 *     samples live in memory), the missing ones are the class's prior speed (COMPLETION_PRIOR_SPEED,
 *     INFERENCE_COMPLETION_PRIOR_SPEED: expectedWorkMs at the class's conservative throughput), so
 *     a class is judged from the first call and real samples take over as they arrive;
 *   - exploration: a class judged on its prior alone still gets one call at a time while nothing of
 *     the model runs there and the prior says it would finish within the call's whole timeout, so a
 *     class with a pessimistic prior learns its real speed instead of never being tried;
 *   - timeouts: a call that ran out its deadline with nothing sent is a sample too (at least that
 *     slow for the work it was judged on), so a class learns from the calls it could not finish;
 *   - contention: the calls already running (and queued) on the class's hosts share them with this
 *     one (best-fit.ts CONTENTION_SHARE: a 2-slot CPU host runs two calls at about half speed each).
 *
 * Run 7 (2026-11-25): hosts' speeds measured while a fleet deploy had left them throttled (CPU credit)
 * kept sending lhr and fra buyers to iad on "iad 936 ms vs lhr 2160 ms" long after (lhr served the
 * call in about 1 s). Speeds now:
 *
 *   - decay: every speed median is weighted by its samples' age, halving every
 *     INFERENCE_SPEED_HALF_LIFE_MS (SPEED_HALF_LIFE_MS), so recent calls outweigh older ones;
 *   - host window: a host's own speed counts only its samples of the last
 *     INFERENCE_HOST_SPEED_WINDOW_MS (HOST_SPEED_WINDOW_MS), and /inference/models says how old its
 *     newest one is (speedAgeMs), so the portal trusts only a fresh measurement;
 *   - steal: a sample from a call during which its host reported CPU steal (host-steal.ts) is kept
 *     out of every speed, and a host's own speed counts only samples taken after its last stolen
 *     report, so a speed measured while throttled does not linger once the throttling ends.
 */

import type { ComputeClassId } from "../../economy/compute-classes.js";
import { expectedWorkMs, SLOW_HOST_PREFILL_FACTOR } from "../../economy/job-pricing.js";
import { CONTENTION_SHARE } from "./best-fit.js";
import { paramsB } from "../../inference-api/auto-route.js";
import { agentHasModel } from "../model-catalog.js";
import { queue, reservations } from "./context.js";
import { agentCapabilities, activeBlacklistRecord } from "./agent-state.js";
import { agentContextWindow, agentLoadReport, freeModelSlots } from "./dispatch.js";
import { effectiveHardware } from "./economy.js";
import { agentUnavailable, memoryAdmits } from "./memory-admission.js";
import { agentFlapping } from "./agent-liveness.js";
import { agentStolenAt, stolenDuring } from "./host-steal.js";

/** Run 7: a speed sample's weight halves every this many ms (0: every sample in the window weighs the same). */
export const SPEED_HALF_LIFE_MS = 3 * 60_000;
/** Run 7: a host's own speed counts only its samples of this window (a class's keeps SERVICE_WINDOW_MS). */
export const HOST_SPEED_WINDOW_MS = 10 * 60_000;

/** Positive integer ms from the environment, within [min, max]; `fallback` when unset or not a number. */
function envMs(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number((raw ?? "").trim() || NaN);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** INFERENCE_SPEED_HALF_LIFE_MS (0 to SERVICE_WINDOW_MS; 0 turns the weighting off), read when used. */
export function speedHalfLifeMs(): number {
  return envMs(process.env.INFERENCE_SPEED_HALF_LIFE_MS, SPEED_HALF_LIFE_MS, 0, SERVICE_WINDOW_MS);
}

/** INFERENCE_HOST_SPEED_WINDOW_MS (60 s to SERVICE_WINDOW_MS), read when used. */
export function hostSpeedWindowMs(): number {
  return envMs(process.env.INFERENCE_HOST_SPEED_WINDOW_MS, HOST_SPEED_WINDOW_MS, 60_000, SERVICE_WINDOW_MS);
}

/** Service times are kept this long ... */
export const SERVICE_WINDOW_MS = 15 * 60_000;
/** ... at most this many per model and class ... */
export const SERVICE_SAMPLES = 64;
/** ... and an estimate needs at least this many. */
export const SERVICE_MIN_SAMPLES = 3;

/** A sample counts for a call when its own work is at least this share of the call's (relevance). */
export const RELEVANT_WORK_SHARE = 1 / 8;

/**
 * Speed (measured ÷ expectedWorkMs) a class is judged at before it has SERVICE_MIN_SAMPLES relevant
 * samples. expectedWorkMs is the slow-host bound with a 2x safety margin, so 0.5 is the slow host's
 * own throughput: right for the CPU fleet (run 5: long calls on 1.5b CPU hosts ran at 0.5-0.85 of
 * the bound). Macs and GPUs run well above their class's slow-host rate (a 9b Mac writes ~20 tok/s
 * against the bound's ~3; a GPU's MoE model is sized by its total, not its active, parameters),
 * hence lower priors there. The cloud host is not judged by a prior (hosted APIs).
 */
export const COMPLETION_PRIOR_SPEED: Readonly<Record<string, number>> = { cpu: 0.5, apple: 0.15, gpu: 0.1, "gpu.dc": 0.1 };

/**
 * INFERENCE_COMPLETION_PRIOR_SPEED: unset, the defaults above; "off" or 0, no prior (a class with
 * too few relevant samples is not judged, as before run 5); a number, every class at it;
 * "cpu=0.5,apple=0.25", those classes (others keep their default; class=0 removes one).
 */
export function parseCompletionPrior(raw: string | undefined): Record<string, number> {
  const t = (raw ?? "").trim().toLowerCase();
  if (t === "") return { ...COMPLETION_PRIOR_SPEED };
  if (t === "off" || t === "none" || t === "false" || t === "0") return {};
  const ok = (n: number) => Number.isFinite(n) && n >= 0 && n <= 10;
  if (!t.includes("=")) {
    const n = Number(t);
    if (!ok(n)) return { ...COMPLETION_PRIOR_SPEED };
    return n === 0 ? {} : Object.fromEntries(Object.keys(COMPLETION_PRIOR_SPEED).map((c) => [c, n]));
  }
  const out: Record<string, number> = { ...COMPLETION_PRIOR_SPEED };
  for (const part of t.split(",").map((x) => x.trim()).filter(Boolean)) {
    const eq = part.lastIndexOf("=");
    const cls = part.slice(0, eq).trim();
    const n = Number(part.slice(eq + 1).trim());
    if (eq <= 0 || !cls || !ok(n)) continue;
    if (n === 0) delete out[cls];
    else out[cls] = n;
  }
  return out;
}

/** A class's speed for one call: the speed, how many relevant samples it rests on, and whether the prior filled in. */
export interface SpeedEstimate {
  speed: number | null;
  samples: number;
  prior: boolean;
}

type Sample = { at: number; ms: number; speed?: number; work?: number; stolen?: boolean };

/** Recent service times (claim to last reply piece) per model and compute class. */
export class ServiceTimes {
  private readonly byKey = new Map<string, Sample[]>();

  /** `speedWindowMs`: how far back a speed looks (SERVICE_WINDOW_MS when not given; run 7: shorter for one host's own). */
  constructor(private readonly speedWindowMs: () => number = () => SERVICE_WINDOW_MS) {}

  /**
   * One sample. `expectedMs`: expectedWorkMs for the tokens the call read and wrote; with it the
   * sample also keeps its speed (ms ÷ expectedMs), for the completion estimate. `stolen` (run 7):
   * its host reported CPU steal during the call, so it keeps no speed (its time still counts as a
   * service time: the slot was held that long).
   */
  record(model: string, computeClass: string, ms: number, atMs = Date.now(), expectedMs?: number, stolen = false): void {
    if (!model || !Number.isFinite(ms) || ms < 0) return;
    const key = `${model}|${computeClass}`;
    const list = this.byKey.get(key) ?? [];
    const speed = expectedMs !== undefined && Number.isFinite(expectedMs) && expectedMs > 0 ? ms / expectedMs : undefined;
    list.push({ at: atMs, ms, ...(speed !== undefined ? { speed, work: expectedMs } : {}), ...(stolen ? { stolen: true } : {}) });
    if (list.length > SERVICE_SAMPLES) list.splice(0, list.length - SERVICE_SAMPLES);
    this.byKey.set(key, list);
    if (this.byKey.size > 512) this.byKey.delete(this.byKey.keys().next().value as string);
  }

  private samples(model: string, computeClass: string, nowMs: number, windowMs: number, sinceMs?: number): Sample[] {
    const out: Sample[] = [];
    for (const [key, list] of this.byKey) {
      const sep = key.lastIndexOf("|");
      if (key.slice(0, sep) !== model || (computeClass !== "any" && key.slice(sep + 1) !== computeClass)) continue;
      for (const s of list) if (nowMs - s.at <= windowMs && (sinceMs === undefined || s.at > sinceMs)) out.push(s);
    }
    return out;
  }

  private values(model: string, computeClass: string, nowMs: number, pick: (s: Sample) => number | undefined): number[] {
    return this.samples(model, computeClass, nowMs, SERVICE_WINDOW_MS).map(pick).filter((v): v is number => v !== undefined);
  }

  /** Run 7: the speed samples (not stolen) of the speed window, each weighted by its age. */
  private speeds(model: string, computeClass: string, nowMs: number, keep: (s: Sample) => boolean = () => true, sinceMs?: number): Weighted[] {
    const half = speedHalfLifeMs();
    return this.samples(model, computeClass, nowMs, this.speedWindowMs(), sinceMs)
      .filter((s) => s.speed !== undefined && !s.stolen && keep(s))
      .map((s) => ({ v: s.speed!, w: half > 0 ? Math.pow(0.5, Math.max(0, nowMs - s.at) / half) : 1 }));
  }

  /** Median recent service time of `model` on `computeClass` ("any": every class), null when too few are known. */
  typicalMs(model: string, computeClass: string, nowMs = Date.now()): number | null {
    const m = median(this.values(model, computeClass, nowMs, (s) => s.ms));
    return m === null ? null : Math.round(m);
  }

  /**
   * Run 7: mean recent service time (how long a call holds a slot on average), null when too few are
   * known. Slots free at slots ÷ mean hold time (Little's law); the median of a mix of short lookups
   * and long replies says far less about when a slot frees, so the start estimate uses this.
   */
  meanMs(model: string, computeClass: string, nowMs = Date.now()): number | null {
    const v = this.values(model, computeClass, nowMs, (s) => s.ms);
    if (v.length < SERVICE_MIN_SAMPLES) return null;
    return Math.round(v.reduce((a, b) => a + b, 0) / v.length);
  }

  /**
   * Median recent speed of `model` on `computeClass`: measured time ÷ expectedWorkMs for the same
   * tokens (below 1: faster than the slow-host estimate). Null when too few samples carry one.
   * Run 7: weighted by age (SPEED_HALF_LIFE_MS), without samples whose host was stolen from, and,
   * with `sinceMs`, only samples taken after it.
   */
  speed(model: string, computeClass: string, nowMs = Date.now(), sinceMs?: number): number | null {
    return weightedMedian(this.speeds(model, computeClass, nowMs, undefined, sinceMs));
  }

  /** Run 7: how old the newest sample behind speed() is (ms); null when there is none. */
  speedAgeMs(model: string, computeClass: string, nowMs = Date.now(), sinceMs?: number): number | null {
    let newest: number | null = null;
    for (const s of this.samples(model, computeClass, nowMs, this.speedWindowMs(), sinceMs)) {
      if (s.speed !== undefined && !s.stolen && (newest === null || s.at > newest)) newest = s.at;
    }
    return newest === null ? null : Math.max(0, nowMs - newest);
  }

  /**
   * Run 5: the speed to judge a call of `workMs` at: the median over the recent samples at least
   * RELEVANT_WORK_SHARE of its size, with the prior (`priorSpeed`) in place of each missing one
   * below SERVICE_MIN_SAMPLES. Without a prior, null while too few relevant samples are known.
   */
  speedFor(model: string, computeClass: string, workMs: number, priorSpeed: number | undefined, nowMs = Date.now()): SpeedEstimate {
    const floor = Number.isFinite(workMs) ? workMs * RELEVANT_WORK_SHARE : 0;
    const values = this.speeds(model, computeClass, nowMs, (s) => (s.work ?? 0) >= floor);
    const samples = values.length;
    const prior = priorSpeed !== undefined && priorSpeed > 0 && samples < SERVICE_MIN_SAMPLES;
    // The prior stands in for a missing sample at full weight.
    if (prior) for (let i = samples; i < SERVICE_MIN_SAMPLES; i++) values.push({ v: priorSpeed!, w: 1 });
    return { speed: weightedMedian(values), samples, prior };
  }

  clear(): void {
    this.byKey.clear();
  }
}

function median(values: number[]): number | null {
  if (values.length < SERVICE_MIN_SAMPLES) return null;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

type Weighted = { v: number; w: number };

/**
 * Run 7: the median of `values` by weight (the value at half the total weight; halfway between two
 * when the half falls exactly between them, so equal weights give the plain median). Null with
 * fewer than SERVICE_MIN_SAMPLES values.
 */
export function weightedMedian(values: Weighted[]): number | null {
  if (values.length < SERVICE_MIN_SAMPLES) return null;
  const sorted = values.filter((x) => Number.isFinite(x.v) && x.w > 0).sort((a, b) => a.v - b.v);
  if (!sorted.length) return null;
  const total = sorted.reduce((n, x) => n + x.w, 0);
  const half = total / 2;
  const eps = total * 1e-9;
  let cum = 0;
  for (let i = 0; i < sorted.length; i++) {
    cum += sorted[i].w;
    if (Math.abs(cum - half) <= eps && i + 1 < sorted.length) return (sorted[i].v + sorted[i + 1].v) / 2;
    if (cum > half) return sorted[i].v;
  }
  return sorted[sorted.length - 1].v;
}

export const serviceTimes = new ServiceTimes();
/**
 * The same per model and agent (the agent id in the class slot): one host's own speed, for
 * /inference/models freeHosts (hostServiceMs). Run 7: its speed looks back HOST_SPEED_WINDOW_MS only.
 */
export const agentServiceTimes = new ServiceTimes(hostSpeedWindowMs);

/** The reference call hostServiceMs is given for (tokens read and written). */
export const REFERENCE_CALL_TOKENS = { promptTokens: 1_000, outputTokens: 200 } as const;

/**
 * One host's time for a reference call of `model`: its measured speed (its own, else its class's here)
 * times the work that call is estimated at. Unlike a median of its calls, it does not depend on how
 * large its recent calls were, so hosts and coordinators compare. Run 5: with neither known (right
 * after a restart), the class's prior speed (`priorSpeed`, COMPLETION_PRIOR_SPEED), when given, as
 * completion admission uses it. Null when no speed is known.
 */
export function hostServiceMs(model: string, agentId: string, computeClass: string, nowMs = Date.now(), priorSpeed?: number): number | null {
  const s = hostSpeed(model, agentId, computeClass, nowMs, priorSpeed);
  return s === null ? null : Math.round(s.speed * callWorkMs(model, computeClass, REFERENCE_CALL_TOKENS.promptTokens, REFERENCE_CALL_TOKENS.outputTokens));
}

/** Where a host's speed comes from: its own recent calls, its class's here, or the class's prior. */
export type HostSpeedSource = "host" | "class" | "prior";

/**
 * Run 6: one host's speed for `model` (ms per ms of expectedWorkMs), and where it comes from, so the
 * portal can scale it to the call it is placing (speed × expectedWorkMs for that call's tokens) and
 * tell a host's own measurement from its class's or the prior (two hosts of one class compare as
 * equal unless both are measured). Null when no speed is known.
 */
export function hostSpeed(model: string, agentId: string, computeClass: string, nowMs = Date.now(), priorSpeed?: number): { speed: number; from: HostSpeedSource; ageMs?: number } | null {
  const ok = (n: number | null | undefined): n is number => n !== null && n !== undefined && Number.isFinite(n) && n > 0;
  // Run 7: only the host's samples since it last reported CPU steal; `ageMs`, how old the newest is.
  const since = agentStolenAt(agentId);
  const own = agentServiceTimes.speed(model, agentId, nowMs, since);
  if (ok(own)) return { speed: own, from: "host", ageMs: agentServiceTimes.speedAgeMs(model, agentId, nowMs, since) ?? 0 };
  const cls = serviceTimes.speed(model, computeClass, nowMs);
  if (ok(cls)) return { speed: cls, from: "class" };
  return ok(priorSpeed) ? { speed: priorSpeed, from: "prior" } : null;
}

/** The model work a call with these token counts is estimated at on a slow host of `computeClass` (job-pricing.ts). */
export function callWorkMs(model: string, computeClass: string, promptTokens: number, outputTokens: number): number {
  return expectedWorkMs({ paramsB: paramsB(model), computeClass, promptTokens, outputTokens });
}

/**
 * A reply's last piece came from `agentId`, claimed at `claimedAtMs`: one service-time sample. With
 * the tokens the call read and wrote (`tokens`), the sample also gives the class's speed.
 */
export function noteServiceTime(model: string | undefined, agentId: string | undefined, claimedAtMs: number | undefined, nowMs = Date.now(), tokens?: { promptTokens: number; outputTokens: number }): void {
  if (!model || !agentId || claimedAtMs === undefined) return;
  const cls = effectiveHardware(agentId)?.computeClass ?? agentCapabilities.get(agentId)?.computeClass ?? "cpu";
  const expected = tokens && tokens.outputTokens > 0 ? callWorkMs(model, cls, tokens.promptTokens, tokens.outputTokens) : undefined;
  // Run 7: a call its host was stolen from during (host-steal.ts) gives no speed.
  const stolen = stolenDuring(agentId, claimedAtMs);
  serviceTimes.record(model, cls, nowMs - claimedAtMs, nowMs, expected, stolen);
  agentServiceTimes.record(model, agentId, nowMs - claimedAtMs, nowMs, expected, stolen);
}

/** Slots (all, and free now) of this coordinator's agents that could run `model` in `taskClass`. */
export function modelSlots(model: string, taskClass: ComputeClassId | "any", neededTokens: number, nowMs = Date.now()): { slots: number; free: number } {
  let slots = 0;
  let free = 0;
  for (const h of modelHolders(model, taskClass, neededTokens, nowMs)) {
    slots += h.slots;
    free += h.free;
  }
  return { slots, free };
}

/** This coordinator's agents that could run `model` in `taskClass`, with their class and slots (all, and free now). */
export function modelHolders(model: string, taskClass: ComputeClassId | "any", neededTokens: number, nowMs = Date.now()): Array<{ agentId: string; computeClass: string; slots: number; free: number }> {
  const claims = queue.activeClaims();
  const out: Array<{ agentId: string; computeClass: string; slots: number; free: number }> = [];
  for (const [id, cap] of agentCapabilities) {
    if (!agentHasModel(cap, model)) continue;
    if (activeBlacklistRecord(id) || cap.hostApproved === false || reservations.isHeld(id, nowMs) || agentUnavailable(id, nowMs)) continue;
    if (nowMs - cap.lastSeenMs > 60_000) continue;
    // Run 6: an agent that keeps dropping out is not capacity (agent-liveness.ts agentFlapping).
    if (agentFlapping(id, nowMs)) continue;
    const cls = effectiveHardware(id, cap)?.computeClass ?? cap.computeClass ?? "cpu";
    if (taskClass !== "any" && cls !== taskClass) continue;
    const ctx = agentContextWindow(id);
    if (ctx !== undefined && neededTokens > ctx) continue;
    const held = claims.get(id)?.inference ?? 0;
    const reported = Math.max(1, agentLoadReport(id)?.slots ?? cap.maxConcurrentTasks ?? 1);
    // Run 7: slots a host withholds (it reports fewer free than it has idle: a throttled CPU, #563)
    // take no call when they free up, so they are not counted as slots a waiting call could get.
    const slots = Math.max(0, reported - withheldSlots(id, held, nowMs));
    if (slots <= 0) continue;
    const free = memoryAdmits(id, model, held, nowMs) ? Math.max(0, freeModelSlots(id, claims)) : 0;
    out.push({ agentId: id, computeClass: cls, slots, free });
  }
  return out;
}

/** When a new call would start (ms from now): 0 with a slot left for it; null when it cannot be estimated. */
export function startEtaMs(c: { waiting: number; slots: number; free: number; typicalMs: number | null }): number | null {
  if (c.typicalMs === null || c.slots <= 0) return null;
  const ahead = c.waiting - c.free;
  if (ahead < 0) return 0;
  return Math.round(((ahead + 1) / c.slots) * c.typicalMs);
}

/** Past this estimated start a call is sent elsewhere or refused (0: never). */
export function startEtaLimitMs(timeoutMs: number, fraction: number, claimTimeoutMs: number): number {
  if (!(fraction > 0)) return Infinity;
  return Math.min(fraction * timeoutMs, claimTimeoutMs);
}

/** When a new call would finish (ms from now): its start plus speed × its work; null without a speed. */
export function completionEtaMs(c: { startEtaMs: number | null; speed: number | null; workMs: number }): number | null {
  if (c.speed === null || !Number.isFinite(c.workMs)) return null;
  return Math.round((c.startEtaMs ?? 0) + c.speed * c.workMs);
}

/** Past this expected completion a class does not get the call (0: never). */
export function completionLimitMs(timeoutMs: number, fraction: number): number {
  return fraction > 0 ? fraction * timeoutMs : Infinity;
}

/** One class's estimate for a call: when it would start and finish there (null: not known). */
export interface ClassCompletion {
  computeClass: string;
  agents: string[];
  startEtaMs: number | null;
  completionEtaMs: number | null;
  /** Judged on its prior alone (fewer than SERVICE_MIN_SAMPLES relevant samples). */
  priorOnly?: boolean;
  /** Calls of the model running or waiting on the class's hosts now. */
  inFlight?: number;
}

/**
 * How much slower a call runs on a class whose hosts already run `running` calls: the new call shares
 * the least loaded host with ceil((running + 1) / hosts) - 1 others (never more than a host's other
 * slots), each costing CONTENTION_SHARE of the class (best-fit.ts contentionFactor).
 */
export function classContention(computeClass: string, hosts: number, maxSlotsPerHost: number, running: number): number {
  const share = CONTENTION_SHARE[computeClass] ?? CONTENTION_SHARE.cpu;
  if (!(share > 0) || hosts <= 0 || maxSlotsPerHost <= 1) return 1;
  const others = Math.min(maxSlotsPerHost - 1, Math.max(0, Math.ceil((Math.max(0, running) + 1) / hosts) - 1));
  return 1 + share * others;
}

/**
 * Per class of this coordinator's holders of `model` (within `taskClass`): when a call reading
 * `promptTokens` and writing `outputTokens` would start and finish there. `waiting`: calls for the
 * model already queued (they go to whichever class frees a slot, so each class is judged as if they
 * were all ahead of it in proportion to its slots). `prior`: the prior speed per class (run 5;
 * parseCompletionPrior), none: a class with too few relevant samples is not judged.
 */
export function completionByClass(input: { model: string; taskClass: ComputeClassId | "any"; neededTokens: number; promptTokens: number; outputTokens: number; waiting: number; prior?: Readonly<Record<string, number>>; decode?: boolean }, nowMs = Date.now()): ClassCompletion[] {
  const holders = modelHolders(input.model, input.taskClass, input.neededTokens, nowMs);
  const claims = queue.activeClaims();
  const totalSlots = holders.reduce((n, h) => n + h.slots, 0);
  const byClass = new Map<string, { agents: string[]; slots: number; free: number; maxSlots: number; running: number }>();
  for (const h of holders) {
    const e = byClass.get(h.computeClass) ?? { agents: [], slots: 0, free: 0, maxSlots: 0, running: 0 };
    e.agents.push(h.agentId);
    e.slots += h.slots;
    e.free += h.free;
    e.maxSlots = Math.max(e.maxSlots, h.slots);
    e.running += claims.get(h.agentId)?.inference ?? 0;
    byClass.set(h.computeClass, e);
  }
  const out: ClassCompletion[] = [];
  for (const [cls, e] of byClass) {
    const waiting = totalSlots > 0 ? Math.round((input.waiting * e.slots) / totalSlots) : input.waiting;
    const workMs = callWorkMs(input.model, cls, input.promptTokens, input.outputTokens);
    const est = serviceTimes.speedFor(input.model, cls, workMs, input.prior?.[cls], nowMs);
    // The calls running on the class's hosts, and the waiting ones that will take its free slots, run beside this one.
    const slowdown = classContention(cls, e.agents.length, e.maxSlots, e.running + Math.min(waiting, e.free));
    // Run 7: the decode-rate estimate (prefill + max_tokens ÷ the class's decode rate); the call is
    // judged on the slower of the two, so a long reply is never judged at the speed of short calls.
    // Only for a call that set its max_tokens (`decode` false: judged on a typical reply, the speed estimate alone).
    const decode = input.decode === false ? null : decodeEstimateMs(input.model, cls, input.promptTokens, input.outputTokens, nowMs, input.prior?.[cls] !== undefined);
    const bySpeed = est.speed === null ? null : est.speed * workMs;
    const own = bySpeed === null && decode === null ? null : Math.max(bySpeed ?? 0, decode?.ms ?? 0);
    const ownMs = own === null ? null : own * slowdown;
    const priorOnly = decode !== null && decode.ms >= (bySpeed ?? 0) ? decode.prior && (bySpeed === null || est.prior) : est.prior;
    // With no service times known yet, a call ahead is taken to hold a slot about as long as this one.
    // Run 7: the mean hold (slots free at slots ÷ mean), not the median of mostly short calls.
    const typicalMs = serviceTimes.meanMs(input.model, cls, nowMs) ?? serviceTimes.meanMs(input.model, "any", nowMs) ?? (ownMs !== null ? Math.round(ownMs) : null);
    const start = startEtaMs({ waiting, slots: e.slots, free: e.free, typicalMs }) ?? (e.free > waiting ? 0 : null);
    out.push({
      computeClass: cls, agents: e.agents, startEtaMs: start,
      completionEtaMs: ownMs === null ? null : Math.round((start ?? 0) + ownMs),
      priorOnly, inFlight: e.running + waiting,
    });
  }
  return out;
}

/**
 * The completion check for a call: `exclude`, the agents of classes that would not finish it within
 * `limitMs`; `none`, true when no class here would (each class known and over the limit); `etaMs`,
 * the soonest known completion. A class with no estimate is never excluded. Exploration (run 5): a
 * class judged on its prior alone, with nothing of the model in flight there, is not excluded while
 * its estimate is within `exploreWithinMs` (the call's whole timeout): one call teaches it its speed.
 */
export function judgeCompletion(classes: ClassCompletion[], limitMs: number, exploreWithinMs = 0): { exclude: string[]; none: boolean; etaMs: number | null } {
  if (!Number.isFinite(limitMs) || classes.length === 0) return { exclude: [], none: false, etaMs: null };
  const explores = (c: ClassCompletion) => c.priorOnly === true && (c.inFlight ?? 0) === 0 && c.completionEtaMs !== null && c.completionEtaMs <= exploreWithinMs;
  const over = classes.filter((c) => c.completionEtaMs !== null && c.completionEtaMs > limitMs && !explores(c));
  const known = classes.map((c) => c.completionEtaMs).filter((n): n is number => n !== null);
  const etaMs = known.length ? Math.min(...known) : null;
  if (over.length === classes.length) return { exclude: over.flatMap((c) => c.agents), none: true, etaMs };
  return { exclude: over.flatMap((c) => c.agents), none: false, etaMs };
}

/**
 * Run 5: a call that ran out its deadline with nothing sent is a sample too. It held its slot for
 * `ms` and was not done: measured against the work admission judged it on (its prompt and its
 * max_tokens, COMPLETION_UNSET_MAX_TOKENS when it set none), its speed is at least ms ÷ that work.
 * Kept as a sample (a lower bound), so a class learns from the calls it cannot finish.
 */
export function noteTimedOutCall(model: string | undefined, agentId: string | undefined, claimedAtMs: number | undefined, input: string, nowMs = Date.now()): void {
  if (!model || !agentId || claimedAtMs === undefined) return;
  const cls = effectiveHardware(agentId)?.computeClass ?? agentCapabilities.get(agentId)?.computeClass ?? "cpu";
  let promptBytes = Buffer.byteLength(input, "utf8");
  let maxTokens: number = TIMED_OUT_UNSET_MAX_TOKENS;
  try {
    const parsed = JSON.parse(input) as { messages?: unknown; tools?: unknown; maxTokens?: unknown };
    promptBytes = Buffer.byteLength(JSON.stringify({ messages: parsed.messages ?? [], tools: parsed.tools ?? [] }), "utf8");
    if (typeof parsed.maxTokens === "number" && parsed.maxTokens > 0) maxTokens = parsed.maxTokens;
  } catch {
    // Not JSON: its bytes are the prompt.
  }
  const work = callWorkMs(model, cls, Math.max(1, Math.ceil(promptBytes / 4)), maxTokens);
  // Run 7: not when its host was stolen from during the call (host-steal.ts).
  const stolen = stolenDuring(agentId, claimedAtMs);
  serviceTimes.record(model, cls, nowMs - claimedAtMs, nowMs, work, stolen);
  // The host's own samples too (#558 hostServiceMs): it was at least this slow.
  agentServiceTimes.record(model, agentId, nowMs - claimedAtMs, nowMs, work, stolen);
}

/** The reply a timed-out call without max_tokens is measured against (routes/inference.ts COMPLETION_UNSET_MAX_TOKENS). */
const TIMED_OUT_UNSET_MAX_TOKENS = 1_024;

/**
 * Run 6 (CPU ramp): 16 named 1.5b calls were accepted, waited out the 45 s claim bound and were then
 * refused "busy" (40-50 s after submit). The start estimate counted the calls waiting and the median
 * service time, but the slots were held by calls running far longer than that median (some to the
 * 180 s deadline), so nothing freed in time. While a model is saturated (no free slot for the calls
 * waiting for it), the rate at which its calls are actually picked up is a second estimate:
 *
 *   startEta = calls ahead (and this one) ÷ pickups per ms over the saturated span (at most RATE_WINDOW_MS)
 *
 * It is used once the model has been saturated for RATE_MIN_SPAN_MS; the later of the two estimates
 * judges a new call at submit, and the queue sweep (routes/inference.ts sweepWaitingInference)
 * re-judges each waiting call against the time left in its claim bound.
 */
export const RATE_WINDOW_MS = 60_000;
/**
 * Run 7: was 10 s. A burst that filled every slot was judged on the (short-call) median service time
 * for those 10 s, then refused by the sweep (claim-time refusals at p50 8.5 s). Pickups over a few
 * seconds are enough: with none, the estimate is one pickup per two spans (see etaMs).
 */
export const RATE_MIN_SPAN_MS = 3_000;

export class ModelPickups {
  private readonly claims = new Map<string, number[]>();
  private readonly saturatedSince = new Map<string, number>();

  /** A call for `model` was claimed. */
  record(model: string, atMs = Date.now()): void {
    if (!model) return;
    const list = (this.claims.get(model) ?? []).filter((t) => atMs - t <= RATE_WINDOW_MS);
    list.push(atMs);
    this.claims.set(model, list.slice(-2_000));
  }

  /** Whether `model` has calls waiting with no free slot for them (the sweep says so every tick). */
  noteSaturated(model: string, saturated: boolean, nowMs = Date.now()): void {
    if (!saturated) this.saturatedSince.delete(model);
    else if (!this.saturatedSince.has(model)) this.saturatedSince.set(model, nowMs);
  }

  /** Saturated models (the sweep clears the ones with nothing waiting any more). */
  saturatedModels(): string[] {
    return [...this.saturatedSince.keys()];
  }

  /** When the call with `ahead` calls before it would start (ms), from the pickup rate; null while not known. */
  etaMs(model: string, ahead: number, nowMs = Date.now()): number | null {
    const since = this.saturatedSince.get(model);
    if (since === undefined || nowMs - since < RATE_MIN_SPAN_MS) return null;
    const span = Math.min(RATE_WINDOW_MS, nowMs - since);
    const n = (this.claims.get(model) ?? []).filter((t) => t > nowMs - span && t <= nowMs).length;
    // No pickup at all over the span: at least as slow as one in each span (half a pickup).
    const perMs = Math.max(n, 0.5) / span;
    return Math.round(Math.max(1, ahead) / perMs);
  }

  clear(): void {
    this.claims.clear();
    this.saturatedSince.clear();
  }
}

export const modelPickups = new ModelPickups();

/**
 * Run 7 (long calls, inf-1795616749810-31c83bfe on gru and inf-1795616757465-36c23c3c on syd): a
 * 1.5b CPU call with max_tokens 1400 was admitted on its nearest, unthrottled host and cut at the 180 s
 * deadline after ~1400 tokens at 7-8 tok/s. Admission judged it at the class prior (0.5 × expectedWorkMs:
 * ~103 s), i.e. a decode rate of ~28 tok/s: expectedWorkMs scales the slow-host rate by 7 / paramsB,
 * which a 1.5b model on a 4-vCPU host does not reach (memory bandwidth and per-token overhead do not
 * shrink with the model), and the speed samples it learns from are dominated by short calls.
 *
 * The completion estimate now also takes the decode rate itself: a call of max_tokens N on a class
 * that decodes at R tok/s needs about N / R plus its prefill (prompt ÷ the prefill rate), and is
 * judged on the slower of that and the speed estimate. R and the prefill rate are measured here per
 * model and class from finished calls (first piece to last piece, and claim to first piece; see
 * noteDecodeRate), normalised for the calls that shared the host; with fewer than SERVICE_MIN_SAMPLES
 * the class prior fills in (COMPLETION_PRIOR_DECODE_TPS_7B, scaled by √(7 / paramsB) below 7B).
 */
export const COMPLETION_PRIOR_DECODE_TPS_7B: Readonly<Record<string, number>> = { cpu: 3 };
/** A decode sample needs at least this many output tokens, and a prefill sample this many prompt tokens. */
export const DECODE_SAMPLE_MIN_TOKENS = 64;
export const PREFILL_SAMPLE_MIN_TOKENS = 256;

/** The prior decode rate (tok/s) of `model` on `computeClass`, undefined when the class has none. */
export function priorDecodeTps(model: string, computeClass: string): number | undefined {
  const base = COMPLETION_PRIOR_DECODE_TPS_7B[computeClass];
  if (!(base > 0)) return undefined;
  const b = Math.max(0.3, paramsB(model) || 7);
  return base * (b < 7 ? Math.sqrt(7 / b) : 7 / b);
}

/** Recent token rates (tok/s) per model and class (or agent), with the prior filling missing samples. */
export class TokenRates {
  private readonly byKey = new Map<string, Array<{ at: number; tps: number }>>();

  record(model: string, key: string, tps: number, atMs = Date.now()): void {
    if (!model || !key || !Number.isFinite(tps) || tps <= 0) return;
    const k = `${model}|${key}`;
    const list = this.byKey.get(k) ?? [];
    list.push({ at: atMs, tps });
    if (list.length > SERVICE_SAMPLES) list.splice(0, list.length - SERVICE_SAMPLES);
    this.byKey.set(k, list);
    if (this.byKey.size > 512) this.byKey.delete(this.byKey.keys().next().value as string);
  }

  /** Median recent rate, the prior in place of each missing sample below SERVICE_MIN_SAMPLES; null without enough. */
  rate(model: string, key: string, prior: number | undefined, nowMs = Date.now()): { tps: number; samples: number; prior: boolean } | null {
    const values = (this.byKey.get(`${model}|${key}`) ?? []).filter((s) => nowMs - s.at <= SERVICE_WINDOW_MS).map((s) => s.tps);
    const samples = values.length;
    const usePrior = prior !== undefined && prior > 0 && samples < SERVICE_MIN_SAMPLES;
    if (usePrior) for (let i = samples; i < SERVICE_MIN_SAMPLES; i++) values.push(prior!);
    const m = median(values);
    return m === null ? null : { tps: m, samples, prior: usePrior };
  }

  clear(): void {
    this.byKey.clear();
  }
}

export const decodeRates = new TokenRates();
export const prefillRates = new TokenRates();

/**
 * One finished call's rates: decode = output tokens ÷ (last piece − first piece), prefill = prompt
 * tokens ÷ (first piece − claim). Each is scaled up by the contention the call ran under (`running`
 * calls on the host, itself included; best-fit.ts CONTENTION_SHARE), so a class's rate is its rate
 * for one call and completionByClass applies the contention of the moment.
 */
export function noteDecodeRate(model: string | undefined, agentId: string | undefined, claimedAtMs: number | undefined, firstPieceAtMs: number | undefined, nowMs: number, tokens: { promptTokens: number; outputTokens: number } | undefined, running = 1): void {
  if (!model || !agentId || claimedAtMs === undefined || firstPieceAtMs === undefined || !tokens) return;
  const cls = effectiveHardware(agentId)?.computeClass ?? agentCapabilities.get(agentId)?.computeClass ?? "cpu";
  if (cls === "cloud") return;
  // As the speed samples (#572): a call its host was stolen from during says nothing about the class.
  if (stolenDuring(agentId, claimedAtMs)) return;
  const contention = 1 + (CONTENTION_SHARE[cls] ?? CONTENTION_SHARE.cpu) * Math.max(0, running - 1);
  const genMs = nowMs - firstPieceAtMs;
  if (tokens.outputTokens >= DECODE_SAMPLE_MIN_TOKENS && genMs >= 1_000) decodeRates.record(model, cls, (tokens.outputTokens / (genMs / 1000)) * contention, nowMs);
  const ttftMs = firstPieceAtMs - claimedAtMs;
  if (tokens.promptTokens >= PREFILL_SAMPLE_MIN_TOKENS && ttftMs >= 500) prefillRates.record(model, cls, (tokens.promptTokens / (ttftMs / 1000)) * contention, nowMs);
}

/** Fixed time per call besides prefill and decode (first-token scheduling, a warm model's setup). */
export const DECODE_ESTIMATE_OVERHEAD_MS = 2_000;

/**
 * When a call reading `promptTokens` and writing `outputTokens` would be done on one free host of
 * `computeClass` (ms, no contention): prompt ÷ prefill rate + output ÷ decode rate + a small overhead,
 * from the class's measured rates (prior-filled). `prior`: judged on the prior alone. Null when the
 * class has neither samples nor a prior (it is then judged on the speed estimate only). `usePrior`
 * false: measured rates only (admission passes false for a class whose speed prior is off,
 * INFERENCE_COMPLETION_PRIOR_SPEED, so "off" turns off both priors).
 */
export function decodeEstimateMs(model: string, computeClass: string, promptTokens: number, outputTokens: number, nowMs = Date.now(), usePrior = true): { ms: number; prior: boolean; decodeTps: number } | null {
  const prior = usePrior ? priorDecodeTps(model, computeClass) : undefined;
  const decode = decodeRates.rate(model, computeClass, prior, nowMs);
  if (decode === null) return null;
  const prefillFactor = SLOW_HOST_PREFILL_FACTOR[computeClass] ?? SLOW_HOST_PREFILL_FACTOR.cpu;
  const prefill = prefillRates.rate(model, computeClass, decode.tps * prefillFactor, nowMs);
  const prefillTps = prefill?.tps ?? decode.tps * prefillFactor;
  const ms = DECODE_ESTIMATE_OVERHEAD_MS + (Math.max(0, promptTokens) / prefillTps + Math.max(0, outputTokens) / decode.tps) * 1000;
  return { ms: Math.round(ms), prior: decode.prior, decodeTps: decode.tps };
}

/** A load report older than this says nothing about withheld slots. */
export const WITHHELD_REPORT_FRESH_MS = 15_000;

/**
 * Run 7 (CPU ramp): slots an agent holds back: idle by the coordinator's count (its slots less the
 * calls it holds) but not reported free in its latest pull (a throttled CPU, #563; also memory or an
 * engine that is down). 0 without a fresh report.
 */
export function withheldSlots(agentId: string, held: number, nowMs = Date.now()): number {
  const load = agentLoadReport(agentId);
  if (!load || load.reportedFree === undefined || nowMs - load.atMs > WITHHELD_REPORT_FRESH_MS) return 0;
  return Math.max(0, Math.max(0, load.slots - held) - load.reportedFree);
}

/**
 * Whether `agentId` is held back now: it withholds slots (withheldSlots > 0), or it reported CPU steal
 * or its throttle guard within WITHHELD_REPORT_FRESH_MS (host-steal.ts, #572: sent with every pull and
 * reply piece, so a host whose slots are all busy says so too). A call it claimed but has not started
 * would run there stolen from.
 */
export function agentWithholding(agentId: string, nowMs = Date.now()): boolean {
  const stolenAt = agentStolenAt(agentId);
  if (stolenAt !== undefined && nowMs - stolenAt <= WITHHELD_REPORT_FRESH_MS) return true;
  return withheldSlots(agentId, queue.activeClaims().get(agentId)?.inference ?? 0, nowMs) > 0;
}

/** Live agents that hold `model` but take no new call now (every slot withheld). */
export function withholdingHolders(model: string, nowMs = Date.now()): string[] {
  const claims = queue.activeClaims();
  const out: string[] = [];
  for (const [id, cap] of agentCapabilities) {
    if (!agentHasModel(cap, model) || activeBlacklistRecord(id) || nowMs - cap.lastSeenMs > 60_000) continue;
    const held = claims.get(id)?.inference ?? 0;
    const slots = Math.max(1, agentLoadReport(id)?.slots ?? cap.maxConcurrentTasks ?? 1);
    if (slots - withheldSlots(id, held, nowMs) <= 0) out.push(id);
  }
  return out;
}

/** A claimed call with no first piece is taken back after at least this long (stalledClaimMs). */
export const STALL_MIN_MS = 20_000;

/**
 * Run 7 (inf-1795617240059-949e8a28, inf-1795617241236-f9c28e38: claimed at once by a host that then
 * ran out of CPU credit, nothing sent in 180 s): how long a claimed call may go without its first
 * piece before it is taken back: STALL_MIN_MS + 3 × (cold load + its prompt at the class's prefill
 * rate). Null for a class with no rate known or prior (the cloud host: reasoning before the first
 * piece), which is never taken back this way.
 */
export function stalledClaimMs(model: string, computeClass: string, promptTokens: number, nowMs = Date.now()): number | null {
  const prior = priorDecodeTps(model, computeClass);
  const decode = decodeRates.rate(model, computeClass, prior, nowMs);
  if (decode === null) return null;
  const prefillFactor = SLOW_HOST_PREFILL_FACTOR[computeClass] ?? SLOW_HOST_PREFILL_FACTOR.cpu;
  const prefillTps = prefillRates.rate(model, computeClass, decode.tps * prefillFactor, nowMs)?.tps ?? decode.tps * prefillFactor;
  const loadMs = 1_000 + (paramsB(model) || 7) * 400;
  return Math.round(STALL_MIN_MS + 3 * (loadMs + (Math.max(0, promptTokens) / prefillTps) * 1000));
}
