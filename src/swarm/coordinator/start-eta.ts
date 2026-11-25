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
 */

import type { ComputeClassId } from "../../economy/compute-classes.js";
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
  private readonly byKey = new Map<string, Array<{ at: number; ms: number }>>();

  record(model: string, computeClass: string, ms: number, atMs = Date.now()): void {
    if (!model || !Number.isFinite(ms) || ms < 0) return;
    const key = `${model}|${computeClass}`;
    const list = this.byKey.get(key) ?? [];
    list.push({ at: atMs, ms });
    if (list.length > SERVICE_SAMPLES) list.splice(0, list.length - SERVICE_SAMPLES);
    this.byKey.set(key, list);
    if (this.byKey.size > 512) this.byKey.delete(this.byKey.keys().next().value as string);
  }

  /** Median recent service time of `model` on `computeClass` ("any": every class), null when too few are known. */
  typicalMs(model: string, computeClass: string, nowMs = Date.now()): number | null {
    const values: number[] = [];
    for (const [key, list] of this.byKey) {
      const sep = key.lastIndexOf("|");
      if (key.slice(0, sep) !== model || (computeClass !== "any" && key.slice(sep + 1) !== computeClass)) continue;
      for (const s of list) if (nowMs - s.at <= SERVICE_WINDOW_MS) values.push(s.ms);
    }
    if (values.length < SERVICE_MIN_SAMPLES) return null;
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return Math.round(values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2);
  }

  clear(): void {
    this.byKey.clear();
  }
}

export const serviceTimes = new ServiceTimes();

/** A reply's last piece came from `agentId`, claimed at `claimedAtMs`: one service-time sample. */
export function noteServiceTime(model: string | undefined, agentId: string | undefined, claimedAtMs: number | undefined, nowMs = Date.now()): void {
  if (!model || !agentId || claimedAtMs === undefined) return;
  serviceTimes.record(model, effectiveHardware(agentId)?.computeClass ?? agentCapabilities.get(agentId)?.computeClass ?? "cpu", nowMs - claimedAtMs, nowMs);
}

/** Slots (all, and free now) of this coordinator's agents that could run `model` in `taskClass`. */
export function modelSlots(model: string, taskClass: ComputeClassId | "any", neededTokens: number, nowMs = Date.now()): { slots: number; free: number } {
  const claims = queue.activeClaims();
  let slots = 0;
  let free = 0;
  for (const [id, cap] of agentCapabilities) {
    if (!agentHasModel(cap, model)) continue;
    if (activeBlacklistRecord(id) || cap.hostApproved === false || reservations.isHeld(id, nowMs) || agentUnavailable(id, nowMs)) continue;
    if (nowMs - cap.lastSeenMs > 60_000) continue;
    const cls = effectiveHardware(id, cap)?.computeClass ?? cap.computeClass ?? "cpu";
    if (taskClass !== "any" && cls !== taskClass) continue;
    const ctx = agentContextWindow(id);
    if (ctx !== undefined && neededTokens > ctx) continue;
    slots += Math.max(1, agentLoadReport(id)?.slots ?? cap.maxConcurrentTasks ?? 1);
    if (memoryAdmits(id, model, claims.get(id)?.inference ?? 0, nowMs)) free += Math.max(0, freeModelSlots(id, claims));
  }
  return { slots, free };
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
