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
 */

import type { ComputeClassId } from "../../economy/compute-classes.js";
import { expectedWorkMs } from "../../economy/job-pricing.js";
import { CONTENTION_SHARE } from "./best-fit.js";
import { paramsB } from "../../inference-api/auto-route.js";
import { agentHasModel } from "../model-catalog.js";
import { queue, reservations } from "./context.js";
import { agentCapabilities, activeBlacklistRecord } from "./agent-state.js";
import { agentContextWindow, agentLoadReport, freeModelSlots } from "./dispatch.js";
import { effectiveHardware } from "./economy.js";
import { agentUnavailable, memoryAdmits } from "./memory-admission.js";
import { agentFlapping } from "./agent-liveness.js";

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

/** Recent service times (claim to last reply piece) per model and compute class. */
export class ServiceTimes {
  private readonly byKey = new Map<string, Array<{ at: number; ms: number; speed?: number; work?: number }>>();

  /**
   * One sample. `expectedMs`: expectedWorkMs for the tokens the call read and wrote; with it the
   * sample also keeps its speed (ms ÷ expectedMs), for the completion estimate.
   */
  record(model: string, computeClass: string, ms: number, atMs = Date.now(), expectedMs?: number): void {
    if (!model || !Number.isFinite(ms) || ms < 0) return;
    const key = `${model}|${computeClass}`;
    const list = this.byKey.get(key) ?? [];
    const speed = expectedMs !== undefined && Number.isFinite(expectedMs) && expectedMs > 0 ? ms / expectedMs : undefined;
    list.push({ at: atMs, ms, ...(speed !== undefined ? { speed, work: expectedMs } : {}) });
    if (list.length > SERVICE_SAMPLES) list.splice(0, list.length - SERVICE_SAMPLES);
    this.byKey.set(key, list);
    if (this.byKey.size > 512) this.byKey.delete(this.byKey.keys().next().value as string);
  }

  private values(model: string, computeClass: string, nowMs: number, pick: (s: { ms: number; speed?: number; work?: number }) => number | undefined): number[] {
    const values: number[] = [];
    for (const [key, list] of this.byKey) {
      const sep = key.lastIndexOf("|");
      if (key.slice(0, sep) !== model || (computeClass !== "any" && key.slice(sep + 1) !== computeClass)) continue;
      for (const s of list) {
        const v = nowMs - s.at <= SERVICE_WINDOW_MS ? pick(s) : undefined;
        if (v !== undefined) values.push(v);
      }
    }
    return values;
  }

  /** Median recent service time of `model` on `computeClass` ("any": every class), null when too few are known. */
  typicalMs(model: string, computeClass: string, nowMs = Date.now()): number | null {
    const m = median(this.values(model, computeClass, nowMs, (s) => s.ms));
    return m === null ? null : Math.round(m);
  }

  /**
   * Median recent speed of `model` on `computeClass`: measured time ÷ expectedWorkMs for the same
   * tokens (below 1: faster than the slow-host estimate). Null when too few samples carry one.
   */
  speed(model: string, computeClass: string, nowMs = Date.now()): number | null {
    return median(this.values(model, computeClass, nowMs, (s) => s.speed));
  }

  /**
   * Run 5: the speed to judge a call of `workMs` at: the median over the recent samples at least
   * RELEVANT_WORK_SHARE of its size, with the prior (`priorSpeed`) in place of each missing one
   * below SERVICE_MIN_SAMPLES. Without a prior, null while too few relevant samples are known.
   */
  speedFor(model: string, computeClass: string, workMs: number, priorSpeed: number | undefined, nowMs = Date.now()): SpeedEstimate {
    const floor = Number.isFinite(workMs) ? workMs * RELEVANT_WORK_SHARE : 0;
    const values = this.values(model, computeClass, nowMs, (s) => (s.speed !== undefined && (s.work ?? 0) >= floor ? s.speed : undefined));
    const samples = values.length;
    const prior = priorSpeed !== undefined && priorSpeed > 0 && samples < SERVICE_MIN_SAMPLES;
    if (prior) for (let i = samples; i < SERVICE_MIN_SAMPLES; i++) values.push(priorSpeed!);
    return { speed: median(values), samples, prior };
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

export const serviceTimes = new ServiceTimes();
/**
 * The same per model and agent (the agent id in the class slot): one host's own speed, for
 * /inference/models freeHosts (hostServiceMs).
 */
export const agentServiceTimes = new ServiceTimes();

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
export function hostSpeed(model: string, agentId: string, computeClass: string, nowMs = Date.now(), priorSpeed?: number): { speed: number; from: HostSpeedSource } | null {
  const ok = (n: number | null | undefined): n is number => n !== null && n !== undefined && Number.isFinite(n) && n > 0;
  const own = agentServiceTimes.speed(model, agentId, nowMs);
  if (ok(own)) return { speed: own, from: "host" };
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
  serviceTimes.record(model, cls, nowMs - claimedAtMs, nowMs, expected);
  agentServiceTimes.record(model, agentId, nowMs - claimedAtMs, nowMs, expected);
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
    const slots = Math.max(1, agentLoadReport(id)?.slots ?? cap.maxConcurrentTasks ?? 1);
    const free = memoryAdmits(id, model, claims.get(id)?.inference ?? 0, nowMs) ? Math.max(0, freeModelSlots(id, claims)) : 0;
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
export function completionByClass(input: { model: string; taskClass: ComputeClassId | "any"; neededTokens: number; promptTokens: number; outputTokens: number; waiting: number; prior?: Readonly<Record<string, number>> }, nowMs = Date.now()): ClassCompletion[] {
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
    const ownMs = est.speed === null ? null : est.speed * workMs * slowdown;
    // With no service times known yet, a call ahead is taken to hold a slot about as long as this one.
    const typicalMs = serviceTimes.typicalMs(input.model, cls, nowMs) ?? serviceTimes.typicalMs(input.model, "any", nowMs) ?? (ownMs !== null ? Math.round(ownMs) : null);
    const start = startEtaMs({ waiting, slots: e.slots, free: e.free, typicalMs }) ?? (e.free > waiting ? 0 : null);
    out.push({
      computeClass: cls, agents: e.agents, startEtaMs: start,
      completionEtaMs: completionEtaMs({ startEtaMs: start, speed: est.speed === null ? null : est.speed * slowdown, workMs }),
      priorOnly: est.prior, inFlight: e.running + waiting,
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
  serviceTimes.record(model, cls, nowMs - claimedAtMs, nowMs, work);
  // The host's own samples too (#558 hostServiceMs): it was at least this slow.
  agentServiceTimes.record(model, agentId, nowMs - claimedAtMs, nowMs, work);
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
export const RATE_MIN_SPAN_MS = 10_000;

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
