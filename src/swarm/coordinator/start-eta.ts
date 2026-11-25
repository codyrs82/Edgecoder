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
 * before anything is reserved. A class with too few speed samples is not judged.
 */

import type { ComputeClassId } from "../../economy/compute-classes.js";
import { expectedWorkMs } from "../../economy/job-pricing.js";
import { paramsB } from "../../inference-api/auto-route.js";
import { agentHasModel } from "../model-catalog.js";
import { queue, reservations } from "./context.js";
import { agentCapabilities, activeBlacklistRecord } from "./agent-state.js";
import { agentContextWindow, agentLoadReport, freeModelSlots } from "./dispatch.js";
import { effectiveHardware } from "./economy.js";
import { agentUnavailable, memoryAdmits } from "./memory-admission.js";

/** Service times are kept this long ... */
export const SERVICE_WINDOW_MS = 15 * 60_000;
/** ... at most this many per model and class ... */
export const SERVICE_SAMPLES = 64;
/** ... and an estimate needs at least this many. */
export const SERVICE_MIN_SAMPLES = 3;

/** Recent service times (claim to last reply piece) per model and compute class. */
export class ServiceTimes {
  private readonly byKey = new Map<string, Array<{ at: number; ms: number; speed?: number }>>();

  /**
   * One sample. `expectedMs`: expectedWorkMs for the tokens the call read and wrote; with it the
   * sample also keeps its speed (ms ÷ expectedMs), for the completion estimate.
   */
  record(model: string, computeClass: string, ms: number, atMs = Date.now(), expectedMs?: number): void {
    if (!model || !Number.isFinite(ms) || ms < 0) return;
    const key = `${model}|${computeClass}`;
    const list = this.byKey.get(key) ?? [];
    const speed = expectedMs !== undefined && Number.isFinite(expectedMs) && expectedMs > 0 ? ms / expectedMs : undefined;
    list.push({ at: atMs, ms, ...(speed !== undefined ? { speed } : {}) });
    if (list.length > SERVICE_SAMPLES) list.splice(0, list.length - SERVICE_SAMPLES);
    this.byKey.set(key, list);
    if (this.byKey.size > 512) this.byKey.delete(this.byKey.keys().next().value as string);
  }

  private values(model: string, computeClass: string, nowMs: number, pick: (s: { ms: number; speed?: number }) => number | undefined): number[] {
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
}

/**
 * Per class of this coordinator's holders of `model` (within `taskClass`): when a call reading
 * `promptTokens` and writing `outputTokens` would start and finish there. `waiting`: calls for the
 * model already queued (they go to whichever class frees a slot, so each class is judged as if they
 * were all ahead of it in proportion to its slots).
 */
export function completionByClass(input: { model: string; taskClass: ComputeClassId | "any"; neededTokens: number; promptTokens: number; outputTokens: number; waiting: number }, nowMs = Date.now()): ClassCompletion[] {
  const holders = modelHolders(input.model, input.taskClass, input.neededTokens, nowMs);
  const totalSlots = holders.reduce((n, h) => n + h.slots, 0);
  const byClass = new Map<string, { agents: string[]; slots: number; free: number }>();
  for (const h of holders) {
    const e = byClass.get(h.computeClass) ?? { agents: [], slots: 0, free: 0 };
    e.agents.push(h.agentId);
    e.slots += h.slots;
    e.free += h.free;
    byClass.set(h.computeClass, e);
  }
  const out: ClassCompletion[] = [];
  for (const [cls, e] of byClass) {
    const waiting = totalSlots > 0 ? Math.round((input.waiting * e.slots) / totalSlots) : input.waiting;
    const typicalMs = serviceTimes.typicalMs(input.model, cls, nowMs) ?? serviceTimes.typicalMs(input.model, "any", nowMs);
    const start = startEtaMs({ waiting, slots: e.slots, free: e.free, typicalMs }) ?? (e.free > waiting ? 0 : null);
    const speed = serviceTimes.speed(input.model, cls, nowMs);
    out.push({ computeClass: cls, agents: e.agents, startEtaMs: start, completionEtaMs: completionEtaMs({ startEtaMs: start, speed, workMs: callWorkMs(input.model, cls, input.promptTokens, input.outputTokens) }) });
  }
  return out;
}

/**
 * The completion check for a call: `exclude`, the agents of classes that would not finish it within
 * `limitMs`; `none`, true when no class here would (each class known and over the limit); `etaMs`,
 * the soonest known completion. A class with no estimate is never excluded.
 */
export function judgeCompletion(classes: ClassCompletion[], limitMs: number): { exclude: string[]; none: boolean; etaMs: number | null } {
  if (!Number.isFinite(limitMs) || classes.length === 0) return { exclude: [], none: false, etaMs: null };
  const over = classes.filter((c) => c.completionEtaMs !== null && c.completionEtaMs > limitMs);
  const known = classes.map((c) => c.completionEtaMs).filter((n): n is number => n !== null);
  const etaMs = known.length ? Math.min(...known) : null;
  if (over.length === classes.length) return { exclude: over.flatMap((c) => c.agents), none: true, etaMs };
  return { exclude: over.flatMap((c) => c.agents), none: false, etaMs };
}
