// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Fast dispatch: who is told about new work, and who may take a model call.
 *
 * Agents pull (signed POST /pull) and that stays the only way to get work: every claim rule
 * (signatures, leases, model, sandbox, market, reservations) is applied there. What this adds:
 *
 * 1. Nudges. When a subtask becomes claimable (enqueued, requeued, retried) the coordinator sends
 *    a few eligible idle agents a "work_available" frame down their authenticated mesh WebSocket
 *    (signed bind, src/mesh/ws-auth.ts). The frame carries nothing: no task, no id. An agent that
 *    gets one pulls at once instead of at its next poll (it still polls, less often, as a
 *    fallback). A forged or replayed nudge can at most make an agent pull early; /pull decides.
 *    Only agents that said they understand nudges (`wake: true` in their pull) get them, at most
 *    NUDGE_FANOUT per subtask, preferring the least loaded and those not already nudged.
 *
 * 2. Load. An agent with parallel model slots reports them with each pull (inferenceSlots,
 *    freeInferenceSlots). A model call is handed only to an agent with a free slot (the agent's
 *    report and the coordinator's own count of the calls it holds). And a call is not handed to an
 *    agent that is already running something while an idle eligible agent is connected to take
 *    it: that agent was nudged and gets DEFER_MS to pull; after that anyone may take it (and is
 *    nudged again), so a call never waits on an agent that does not come.
 *
 * The rule this gives: a request does not wait behind another request on one agent while another
 * eligible agent is idle.
 */

import type { Subtask } from "../../common/types.js";
import { meetsCapability } from "../../economy/order-book.js";
import { subtaskModelEligible } from "../model-catalog.js";
import { agentMayClaim } from "../sandbox-enforcement.js";
import { queue, reservations } from "./context.js";
import { agentCapabilities, activeBlacklistRecord } from "./agent-state.js";
import { askCapabilityOf, orderBook } from "./economy.js";
import { peerGrantAllowsClaim } from "./grants.js";

/** Agents nudged per claimable subtask. */
export const NUDGE_FANOUT = 2;
/** How long a busy agent's pull leaves a new model call to a nudged idle agent. */
export const DEFER_MS = 1_500;
/** A report (pull) older than this does not count: the agent is not taking work now. */
const LOAD_FRESH_MS = 60_000;
/** An agent nudged this recently, that has not pulled since, is not counted on to come twice. */
const NUDGE_PENDING_MS = 2_000;
const READY_KEEP_MS = 10 * 60_000;
const PICKUP_SAMPLES = 1_000;

type Capability = NonNullable<ReturnType<typeof agentCapabilities.get>>;
type Claims = Map<string, { all: number; inference: number }>;

interface AgentLoad {
  /** Parallel model slots (1-16). */
  slots: number;
  /** Free slots the agent reported with its last pull. */
  reportedFree?: number;
  /** Understands work_available nudges. */
  wake: boolean;
  atMs: number;
}

/** How nudges reach an agent: the mesh WebSocket routes register it (routes/mesh.ts). */
export interface NudgeTransport {
  /** An authenticated (signed bind) socket is open for the agent. */
  connected(agentId: string): boolean;
  /** Send the frame; false when it could not be sent. */
  send(agentId: string, frame: string): boolean;
}

export const WORK_AVAILABLE_FRAME = JSON.stringify({ type: "work_available" });

let transport: NudgeTransport | undefined;
const loads = new Map<string, AgentLoad>();
/** subtaskId -> when it became claimable (for deferral and pickup time). */
const readyAt = new Map<string, number>();
/** agentId -> when it was last nudged and has not pulled since. */
const nudgedAt = new Map<string, number>();
const pickups: number[] = [];
let nudgesSent = 0;

export function setNudgeTransport(t: NudgeTransport | undefined): void {
  transport = t;
}

/** What an agent says about its capacity when it pulls. */
export function noteAgentPull(agentId: string, report: { inferenceSlots?: number; freeInferenceSlots?: number; wake?: boolean }, nowMs = Date.now()): void {
  nudgedAt.delete(agentId);
  if (report.inferenceSlots === undefined && !report.wake) {
    loads.delete(agentId);
    return;
  }
  loads.set(agentId, {
    slots: Math.max(1, Math.min(16, report.inferenceSlots ?? 1)),
    reportedFree: report.freeInferenceSlots,
    wake: report.wake === true,
    atMs: nowMs
  });
}

export function forgetAgentLoad(agentId: string): void {
  loads.delete(agentId);
  nudgedAt.delete(agentId);
}

/**
 * The claim rule /pull applies (besides the queue's own exclusions): sandbox, peer grant, model,
 * reservation or own-machine placement, market match and capability. `pullerAccount` undefined
 * means "not known here" (nudge targeting): an own-machines-only job is then not ruled out.
 */
export function claimRule(agentId: string, capability: Capability | undefined, pullerAccount: string | undefined, nowMs = Date.now()): (subtask: Subtask) => boolean {
  const lease = reservations.activeForAgent(agentId, nowMs);
  return (subtask) => {
    if (!agentMayClaim(capability, subtask)) return false;
    // A subtask granted to us by its origin: only while enough of the grant is left to run it.
    if (!peerGrantAllowsClaim(subtask, nowMs)) return false;
    // #54: a job that names a model goes only to an agent that reported it (inference: installed;
    // code: its active model, which is what code work runs on).
    const hasModel = subtaskModelEligible(capability, subtask);
    const meta = subtask.projectMeta;
    // A reserved agent takes only its lease's jobs; a job for a lease or for its owner's own machines goes nowhere else.
    if (lease) return meta.reservationId === lease.id && hasModel;
    if (meta.reservationId) return false;
    if (meta.onlyAccountId) return (pullerAccount === undefined || meta.onlyAccountId === pullerAccount) && hasModel;
    return orderBook.canMatch(agentId, subtask.taskId).ok && meetsCapability(askCapabilityOf(agentId, capability), meta) && hasModel;
  };
}

/** Free model slots: the agent's slots less the calls it holds, and no more than it last reported. Undefined when it reports none. */
function freeSlots(agentId: string, claims: Claims, useReport: boolean): number | undefined {
  const load = loads.get(agentId);
  if (!load) return undefined;
  const byCount = load.slots - (claims.get(agentId)?.inference ?? 0);
  return Math.max(0, useReport && load.reportedFree !== undefined ? Math.min(byCount, load.reportedFree) : byCount);
}

function liveAgent(agentId: string, cap: Capability | undefined, nowMs: number): cap is Capability {
  if (!cap || activeBlacklistRecord(agentId)) return false;
  return nowMs - cap.lastSeenMs <= LOAD_FRESH_MS;
}

/** Nudge-capable, connected, recently pulling. */
function reachable(agentId: string, nowMs: number): boolean {
  const load = loads.get(agentId);
  return !!load && load.wake && nowMs - load.atMs <= LOAD_FRESH_MS && !!transport?.connected(agentId);
}

/** An agent that could run `subtask` now, given what it holds. */
function hasRoomFor(agentId: string, subtask: Subtask, claims: Claims): boolean {
  if (subtask.kind === "inference") {
    const free = freeSlots(agentId, claims, false);
    return free === undefined ? (claims.get(agentId)?.all ?? 0) === 0 : free > 0;
  }
  // Code runs one job at a time on an agent.
  return (claims.get(agentId)?.all ?? 0) === 0;
}

/**
 * /pull: may `agentId` take this subtask now? (In addition to claimRule.) A model call needs a free
 * slot, and an agent already running something leaves a fresh call to an idle eligible agent.
 * `claims` is one snapshot for the whole pull.
 */
export function mayTakeNow(agentId: string, subtask: Subtask, claims: Claims, nowMs = Date.now()): boolean {
  if (subtask.kind !== "inference") return true;
  const free = freeSlots(agentId, claims, true);
  if (free !== undefined && free <= 0) return false;
  if ((claims.get(agentId)?.all ?? 0) === 0) return true;
  const ready = readyAt.get(subtask.id);
  if (ready === undefined || nowMs - ready >= DEFER_MS) return true;
  return !idleTakerExists(subtask, claims, nowMs, agentId);
}

function idleTakerExists(subtask: Subtask, claims: Claims, nowMs: number, except: string): boolean {
  const excluded = queue.excludedAgents(subtask.id);
  for (const [id, cap] of agentCapabilities) {
    if (id === except || excluded.includes(id) || (claims.get(id)?.all ?? 0) > 0) continue;
    if (!reachable(id, nowMs) || !liveAgent(id, cap, nowMs)) continue;
    if (freeSlots(id, claims, true) === 0) continue;
    // Own-machines-only calls: the account check is async (/pull), so they are never deferred.
    if (subtask.projectMeta.onlyAccountId) continue;
    if (claimRule(id, cap, undefined, nowMs)(subtask)) return true;
  }
  return false;
}

/** /pull handed `subtaskId` out: record how long it waited to be picked up. */
export function noteClaimed(subtaskId: string, nowMs = Date.now()): void {
  const ready = readyAt.get(subtaskId);
  readyAt.delete(subtaskId);
  if (ready === undefined) return;
  pickups.push(Math.max(0, nowMs - ready));
  if (pickups.length > PICKUP_SAMPLES) pickups.splice(0, pickups.length - PICKUP_SAMPLES);
}

/** Pickup time (claimable to claimed) over the last PICKUP_SAMPLES claims, in ms. */
export function pickupStats(): { count: number; p50: number; p90: number; nudges: number } {
  const sorted = [...pickups].sort((a, b) => a - b);
  const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  return { count: sorted.length, p50: q(0.5), p90: q(0.9), nudges: nudgesSent };
}

/** Choose who to nudge for `subtask`: eligible, reachable, with room; least loaded first. */
export function nudgeTargets(subtask: Subtask, nowMs = Date.now(), claims: Claims = queue.activeClaims()): string[] {
  const excluded = queue.excludedAgents(subtask.id);
  const candidates: Array<{ id: string; busy: number; free: number; pending: boolean; at: number }> = [];
  for (const [id, cap] of agentCapabilities) {
    if (excluded.includes(id) || !reachable(id, nowMs) || !liveAgent(id, cap, nowMs)) continue;
    if (!hasRoomFor(id, subtask, claims)) continue;
    if (!claimRule(id, cap, undefined, nowMs)(subtask)) continue;
    const at = nudgedAt.get(id);
    candidates.push({ id, busy: claims.get(id)?.all ?? 0, free: freeSlots(id, claims, false) ?? 1, pending: at !== undefined && nowMs - at < NUDGE_PENDING_MS, at: at ?? 0 });
  }
  candidates.sort((a, b) => a.busy - b.busy || Number(a.pending) - Number(b.pending) || b.free - a.free || a.at - b.at);
  return candidates.slice(0, NUDGE_FANOUT).map((c) => c.id);
}

function nudge(subtaskId: string, nowMs = Date.now()): string[] {
  if (!transport || !queue.isUnclaimed(subtaskId)) return [];
  const subtask = queue.getSubtask(subtaskId);
  if (!subtask) return [];
  const sent: string[] = [];
  for (const id of nudgeTargets(subtask, nowMs)) {
    if (!transport.send(id, WORK_AVAILABLE_FRAME)) continue;
    nudgedAt.set(id, nowMs);
    nudgesSent++;
    sent.push(id);
  }
  return sent;
}

/**
 * The queue's claimable hook (SwarmQueue.onClaimable). Work runs on the next tick, outside the
 * queue's own bookkeeping; a delayed subtask is announced when it becomes claimable. A model call
 * nobody took within DEFER_MS is announced once more (busy agents with free slots included).
 */
export function onClaimable(subtask: Subtask, claimableAtMs: number): void {
  const nowMs = Date.now();
  const id = subtask.id;
  readyAt.set(id, Math.max(nowMs, claimableAtMs));
  const run = () => {
    nudge(id);
    if (subtask.kind === "inference") setTimeout(() => nudge(id), DEFER_MS + 50).unref?.();
  };
  if (claimableAtMs > nowMs) setTimeout(run, claimableAtMs - nowMs).unref?.();
  else setImmediate(run);
}

/** Drop bookkeeping for subtasks long gone and agents that stopped pulling. */
export function pruneDispatch(nowMs = Date.now()): void {
  for (const [id, at] of readyAt) if (nowMs - at > READY_KEEP_MS) readyAt.delete(id);
  for (const [id, load] of loads) if (nowMs - load.atMs > READY_KEEP_MS) loads.delete(id);
  for (const [id, at] of nudgedAt) if (nowMs - at > READY_KEEP_MS) nudgedAt.delete(id);
}
setInterval(() => pruneDispatch(), 60_000).unref?.();
