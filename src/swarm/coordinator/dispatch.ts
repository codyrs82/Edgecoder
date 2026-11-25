// Copyright (c) 2025 EdgeCoder
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
 *
 * 3. Preference. Best-fit routing (best-fit.ts) may name the agent a model call suits best (its
 *    session's cache, its speed). For a short while (preferAgent's `ms`, BEST_FIT_PREFER_MS) other
 *    agents leave the call to it while it is live and has room, and it is nudged first; after that
 *    anyone eligible may take it, as before.
 *
 * 4. Model affinity. An agent known not to have the call's model loaded (its memory telemetry lists
 *    its loaded models, the model is not among them, and it has not served it within WARM_MS) leaves
 *    a fresh call for DEFER_MS to one that has it warm: loaded, or served within WARM_MS. An agent
 *    that reports no telemetry (the Fly CPU hosts) is never assumed cold, so it is not held back,
 *    and it counts as warm for a model it just ran. The preferred agent is exempt: whoever chose it
 *    (locality.ts, best fit) already weighed the cold load.
 *
 * 5. Locality against warm models (run 3, C3: the nearest host took 10.5% of calls under load).
 *    A cold load is paid once; the model then stays warm there for WARM_MS and serves that region's
 *    next calls, while distance is paid on every call, over several round trips. coldLoadKm turns a
 *    load into the distance it is worth on that footing, so a near host with the model installed
 *    loses to a far warm one only when its load clearly exceeds the extra round trips (a 1.5b load,
 *    ~1.6 s, is worth 14,000 km: about 4 x 200 ms twice over). It counts only against a warm host
 *    that is idle: once the warm hosts are running calls, warming a second host near the buyer adds
 *    capacity where the demand is. Nudges put a known-cold agent last (an agent that reports nothing
 *    is not assumed cold), and the locality choice stays first in line for nudges after its hold.
 *
 * 6. Silence (run 3, C4: Auto placed two calls on a Mac 45 s after it was last heard from).
 *    Agents are heard every few seconds (idle pulls every 1-3 s, a lease heartbeat every 15 s while
 *    busy). One silent for AGENT_SILENT_MS is not counted on for new work (agentRoutable), well before
 *    the 2-minute connected window ends or its socket is seen to close.
 */

import type { Subtask } from "../../common/types.js";
import { meetsCapability } from "../../economy/order-book.js";
import { contextNeeded } from "../../inference-api/ollama.js";
import type { ChatMessage } from "../../inference-api/types.js";
import { ownerOnlyModels, subtaskModelEligible } from "../model-catalog.js";
import { agentMayClaim } from "../sandbox-enforcement.js";
import { queue, reservations } from "./context.js";
import { agentCapabilities, activeBlacklistRecord } from "./agent-state.js";
import { askCapabilityOf, orderBook } from "./economy.js";
import { peerGrantAllowsClaim } from "./grants.js";
import { restrictedClaimAllowed } from "./restricted.js";
import { circuitBlocks, loadedModelsOf, memoryAdmits, modelLoadedOn } from "./memory-admission.js";
import { agentFlapping, agentSocketLost, noteAgentHttpAlive } from "./agent-liveness.js";
import { KM_PER_RTT_MS } from "../../common/geo-regions.js";

/** Agents nudged per claimable subtask. */
export const NUDGE_FANOUT = 2;
/** How long a busy agent's pull leaves a new model call to a nudged idle agent. */
export const DEFER_MS = 1_500;
/** A report (pull) older than this does not count: the agent is not taking work now. */
const LOAD_FRESH_MS = 60_000;
/** A model an agent ran this recently is still loaded there (Ollama's default keep_alive is 5 min). */
export const WARM_MS = 5 * 60_000;
/** An agent nudged this recently, that has not pulled since, is not counted on to come twice. */
const NUDGE_PENDING_MS = 2_000;
const READY_KEEP_MS = 10 * 60_000;
/** An agent not heard from (pull, heartbeat, result, register) this long gets no new work (C4). */
export const AGENT_SILENT_MS = 30_000;
/** Round trips between the buyer's side and the host that one call pays for distance (claim, first token, result, reply). */
export const LOCALITY_CALL_ROUND_TRIPS = 4;
/** A cold load outweighs distance only when it is this many times the extra round trips it saves. */
export const COLD_LOAD_CLEAR_FACTOR = 2;
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
  /** Context window (tokens) it serves model calls with; undefined = not reported (any size). */
  contextWindow?: number;
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
/** agentId -> its last /pull, whatever it reported (#523: an agent that never pulls is not capacity). */
const lastPullAt = new Map<string, number>();
/** subtaskId -> when it became claimable (for deferral and pickup time). */
const readyAt = new Map<string, number>();
/** agentId -> when it was last nudged and has not pulled since. */
const nudgedAt = new Map<string, number>();
const pickups: number[] = [];
/** subtaskId -> the agent best-fit routing prefers, until when. */
const preferred = new Map<string, { agentId: string; untilMs: number }>();
/** agentId -> model -> when it last claimed a call for that model. */
const served = new Map<string, Map<string, number>>();
let nudgesSent = 0;

/**
 * The distance (km) a cold load of `loadMs` is worth against locality: the load counts only past
 * COLD_LOAD_CLEAR_FACTOR times the round trips a call pays for distance (see 5. above).
 */
export function coldLoadKm(loadMs: number): number {
  return (Math.max(0, loadMs) * KM_PER_RTT_MS) / (LOCALITY_CALL_ROUND_TRIPS * COLD_LOAD_CLEAR_FACTOR);
}

/**
 * The agent can be counted on for new work now: heard from (heartbeat, register, or pull) within
 * AGENT_SILENT_MS and its socket not seen to close since (agent-liveness.ts). Best fit's candidates (routing.ts) and dispatch use it.
 */
export function agentRoutable(agentId: string, lastSeenMs: number, nowMs = Date.now()): boolean {
  const heardMs = Math.max(lastSeenMs, lastPullAt.get(agentId) ?? 0);
  return nowMs - heardMs <= AGENT_SILENT_MS && !agentSocketLost(agentId, nowMs);
}

/**
 * Run 6: routable, and not flapping (agent-liveness.ts agentFlapping: it keeps dropping out and has
 * not been steady since). New placements (best fit, completion admission, locality) use this.
 */
export function agentDependable(agentId: string, lastSeenMs: number, nowMs = Date.now()): boolean {
  return agentRoutable(agentId, lastSeenMs, nowMs) && !agentFlapping(agentId, nowMs);
}

/** /pull handed `agentId` a call for `model`: the model is warm there for WARM_MS. */
export function noteModelServed(agentId: string, model: string | undefined, nowMs = Date.now()): void {
  if (!model) return;
  let m = served.get(agentId);
  if (!m) served.set(agentId, (m = new Map()));
  m.set(model, nowMs);
}

/** The model is warm on the agent: loaded (telemetry) or served within WARM_MS. */
export function modelWarmOn(agentId: string, model: string, nowMs = Date.now()): boolean {
  if (modelLoadedOn(agentId, model, nowMs)) return true;
  const at = served.get(agentId)?.get(model);
  return at !== undefined && nowMs - at <= WARM_MS;
}

/**
 * The model is known to be cold on the agent: it reports what it has loaded, the model is not among
 * it, and it has not served it lately. False when not known (no telemetry): no cold-load is assumed.
 */
export function modelKnownCold(agentId: string, model: string, nowMs = Date.now()): boolean {
  return loadedModelsOf(agentId, nowMs) !== undefined && !modelWarmOn(agentId, model, nowMs);
}

export function setNudgeTransport(t: NudgeTransport | undefined): void {
  transport = t;
}

/** What an agent says about its capacity when it pulls. */
export function noteAgentPull(agentId: string, report: { inferenceSlots?: number; freeInferenceSlots?: number; contextWindow?: number; wake?: boolean }, nowMs = Date.now()): void {
  nudgedAt.delete(agentId);
  lastPullAt.set(agentId, nowMs);
  noteAgentHttpAlive(agentId, nowMs);
  if (report.inferenceSlots === undefined && !report.wake && report.contextWindow === undefined) {
    loads.delete(agentId);
    return;
  }
  loads.set(agentId, {
    slots: Math.max(1, Math.min(16, report.inferenceSlots ?? 1)),
    reportedFree: report.freeInferenceSlots,
    wake: report.wake === true,
    contextWindow: report.contextWindow,
    atMs: nowMs
  });
}

export function forgetAgentLoad(agentId: string): void {
  loads.delete(agentId);
  nudgedAt.delete(agentId);
  served.delete(agentId);
}

/**
 * The claim rule /pull applies (besides the queue's own exclusions): sandbox, peer grant, model,
 * reservation or own-machine placement, market match, capability and restricted models. `pullerAccount` undefined
 * means "not known here" (nudge targeting): an own-machines-only job is then not ruled out.
 */
export function claimRule(agentId: string, capability: Capability | undefined, pullerAccount: string | undefined, nowMs = Date.now()): (subtask: Subtask) => boolean {
  const lease = reservations.activeForAgent(agentId, nowMs);
  return (subtask) => {
    if (!agentMayClaim(capability, subtask)) return false;
    // Security research tier: a restricted model runs only where its admitted call allows (restricted.ts).
    if (!restrictedClaimAllowed(agentId, capability, pullerAccount, lease, subtask, nowMs)) return false;
    // A model call longer than the window the agent serves with goes to an agent with a bigger one.
    if (subtask.kind === "inference" && !fitsContextWindow(agentId, subtask)) return false;
    // A subtask granted to us by its origin: only while enough of the grant is left to run it.
    if (!peerGrantAllowsClaim(subtask, nowMs)) return false;
    // #54: a job that names a model goes only to an agent that reported it (inference: installed;
    // code: its active model, which is what code work runs on).
    const meta = subtask.projectMeta;
    const hasModel = subtaskModelEligible(capability, subtask);
    // The owner's own call ("My machines") may also run a model the agent keeps off the network
    // (too big for its memory budget); only for the account that owns it, checked below.
    const ownerHasModel = hasModel || (Boolean(meta.onlyAccountId) && !meta.reservationId && subtaskModelEligible(capability, subtask, { owner: true }));
    // Host approval (src/portal/host-requests.ts): an agent whose owner is not an approved host
    // runs only its owner's own work ("My machines"): no other account's job, no lease.
    if (capability?.hostApproved === false) return Boolean(meta.onlyAccountId) && !meta.reservationId && (pullerAccount === undefined || meta.onlyAccountId === pullerAccount) && ownerHasModel;
    // A reserved agent takes only its lease's jobs; a job for a lease or for its owner's own machines goes nowhere else.
    if (lease) return meta.reservationId === lease.id && hasModel;
    if (meta.reservationId) return false;
    if (meta.onlyAccountId) return (pullerAccount === undefined || meta.onlyAccountId === pullerAccount) && ownerHasModel;
    return orderBook.canMatch(agentId, subtask.taskId).ok && meetsCapability(askCapabilityOf(agentId, capability), meta) && hasModel;
  };
}

/** Context window an agent reported (undefined: not reported, takes any size). */
export function agentContextWindow(agentId: string): number | undefined {
  return loads.get(agentId)?.contextWindow;
}

/** Tokens a model call needs (src/inference-api/ollama.ts contextNeeded), parsed once per subtask. */
const neededTokens = new Map<string, number>();
export function inferenceTokensNeeded(subtask: Pick<Subtask, "id" | "input">): number {
  let n = neededTokens.get(subtask.id);
  if (n === undefined) {
    try {
      const input = JSON.parse(subtask.input) as { messages?: ChatMessage[]; tools?: unknown[]; maxTokens?: number };
      n = Array.isArray(input.messages) ? contextNeeded(input.messages, input.tools, input.maxTokens) : 0;
    } catch {
      n = 0;
    }
    neededTokens.set(subtask.id, n);
  }
  return n;
}

function fitsContextWindow(agentId: string, subtask: Subtask): boolean {
  const window = agentContextWindow(agentId);
  return window === undefined || inferenceTokensNeeded(subtask) <= window;
}

/** Free model slots: the agent's slots less the calls it holds, and no more than it last reported. Undefined when it reports none. */
function freeSlots(agentId: string, claims: Claims, useReport: boolean): number | undefined {
  const load = loads.get(agentId);
  if (!load) return undefined;
  const byCount = load.slots - (claims.get(agentId)?.inference ?? 0);
  return Math.max(0, useReport && load.reportedFree !== undefined ? Math.min(byCount, load.reportedFree) : byCount);
}

/**
 * Model calls this agent could start now (/inference/models freeSlots): its slots less the calls it
 * holds, capped by its last report. An agent that reports no slots counts 1 while it holds nothing.
 */
export function freeModelSlots(agentId: string, claims: Claims): number {
  return freeSlots(agentId, claims, true) ?? ((claims.get(agentId)?.all ?? 0) === 0 ? 1 : 0);
}

function liveAgent(agentId: string, cap: Capability | undefined, nowMs: number): cap is Capability {
  if (!cap || activeBlacklistRecord(agentId)) return false;
  // #524: its socket closed and it has not been heard from since: gone, whatever lastSeenMs says.
  // C4: silent for AGENT_SILENT_MS: not counted on either.
  return agentRoutable(agentId, cap.lastSeenMs, nowMs);
}

/** Nudge-capable, connected, recently pulling. */
function reachable(agentId: string, nowMs: number): boolean {
  const load = loads.get(agentId);
  return !!load && load.wake && nowMs - load.atMs <= LOAD_FRESH_MS && !!transport?.connected(agentId);
}

/**
 * The owner's own call on a model this agent keeps off the network (claimRule has checked the
 * account): memory admission skips the budget headroom for it (memoryAdmits ownerOnly).
 */
export function ownerOnlyCall(agentId: string, subtask: Subtask): boolean {
  const meta = subtask.projectMeta;
  return subtask.kind === "inference" && Boolean(meta?.onlyAccountId) && !meta?.reservationId && Boolean(subtask.requestedModel) && ownerOnlyModels(agentCapabilities.get(agentId)).includes(subtask.requestedModel!);
}

/** An agent that could run `subtask` now, given what it holds. */
function hasRoomFor(agentId: string, subtask: Subtask, claims: Claims, nowMs = Date.now()): boolean {
  if (circuitBlocks(agentId, claims.get(agentId)?.all ?? 0, nowMs)) return false;
  if (subtask.kind === "inference") {
    if (!memoryAdmits(agentId, subtask.requestedModel, claims.get(agentId)?.inference ?? 0, nowMs, { ownerOnly: ownerOnlyCall(agentId, subtask) })) return false;
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
/**
 * Run 8 (CPU ramp): calls waiting in the backlog ("every coordinator busy: backlog shared by agents")
 * were handed to whichever agent pulled next, judged only on its free slot: hosts that had just run
 * out of CPU credit took them and ran them to the 180 s timeout. The admission routes/inference.ts
 * registers here judges each network model call again at claim time, for the agent pulling it.
 */
export type ClaimAdmission = (agentId: string, subtask: Subtask, nowMs: number) => boolean;
let claimAdmission: ClaimAdmission | undefined;
export function setClaimAdmission(fn: ClaimAdmission | undefined): void {
  claimAdmission = fn;
}

export function mayTakeNow(agentId: string, subtask: Subtask, claims: Claims, nowMs = Date.now()): boolean {
  // Circuit breaker (memory-admission.ts): an agent that keeps failing cools down first, then takes
  // one call at a time (half open) until one succeeds.
  if (circuitBlocks(agentId, claims.get(agentId)?.all ?? 0, nowMs)) return false;
  if (subtask.kind !== "inference") return true;
  // Host memory: the model must be loaded there (with a free slot for it) or fit its budget headroom
  // (not for the owner's own call on a model the agent keeps off the network: only pressure counts).
  if (!memoryAdmits(agentId, subtask.requestedModel, claims.get(agentId)?.inference ?? 0, nowMs, { ownerOnly: ownerOnlyCall(agentId, subtask) })) return false;
  const free = freeSlots(agentId, claims, true);
  if (free !== undefined && free <= 0) return false;
  // Run 8: the admission placement applies (held-back hosts, completion in the time left), also for a
  // call taken from the backlog (routes/inference.ts setClaimAdmission).
  if (claimAdmission && !claimAdmission(agentId, subtask, nowMs)) return false;
  if (leftForPreferred(agentId, subtask, claims, nowMs)) return false;
  const ready = readyAt.get(subtask.id);
  const fresh = ready !== undefined && nowMs - ready < DEFER_MS;
  // Model affinity: an agent that would have to load the model leaves a fresh call briefly to one
  // that has it warm (no load / unload thrash). Not the preferred agent: locality or best fit chose
  // it with the cold load weighed, and deferring it would hand the call to the warm one regardless.
  if (fresh && subtask.requestedModel && preferredAgentFor(subtask.id, nowMs) !== agentId && modelKnownCold(agentId, subtask.requestedModel, nowMs) && loadedTakerExists(subtask, claims, nowMs, agentId)) return false;
  if ((claims.get(agentId)?.all ?? 0) === 0) return true;
  if (!fresh) return true;
  return !idleTakerExists(subtask, claims, nowMs, agentId);
}

/**
 * Another live agent has the call's model warm, room for it, and would be admitted. When `except`
 * holds nothing, a warm agent that is already running something does not count: it leaves fresh
 * calls to idle agents itself (idleTakerExists), so both would wait out DEFER_MS.
 */
function loadedTakerExists(subtask: Subtask, claims: Claims, nowMs: number, except: string): boolean {
  const model = subtask.requestedModel;
  if (!model) return false;
  const excluded = queue.excludedAgents(subtask.id);
  const selfIdle = (claims.get(except)?.all ?? 0) === 0;
  for (const [id, cap] of agentCapabilities) {
    if (id === except || excluded.includes(id) || !modelWarmOn(id, model, nowMs)) continue;
    if (selfIdle && (claims.get(id)?.all ?? 0) > 0) continue;
    if (!reachable(id, nowMs) || !liveAgent(id, cap, nowMs)) continue;
    if (!hasRoomFor(id, subtask, claims, nowMs)) continue;
    if (subtask.projectMeta.onlyAccountId) continue;
    if (claimRule(id, cap, undefined, nowMs)(subtask)) return true;
  }
  return false;
}

/** Soft preference: keep `subtaskId` for `agentId` for `ms` (other agents leave it while that agent can take it). */
export function preferAgent(subtaskId: string, agentId: string, ms: number, nowMs = Date.now()): void {
  if (!(ms > 0)) return;
  preferred.set(subtaskId, { agentId, untilMs: nowMs + ms });
  // Agents turned away meanwhile are told again as soon as the call is open to all.
  setTimeout(() => nudge(subtaskId), ms + 50).unref?.();
}

/** The agent a subtask is kept for right now, if any. */
export function preferredAgentFor(subtaskId: string, nowMs = Date.now()): string | undefined {
  const p = preferred.get(subtaskId);
  return p && nowMs < p.untilMs ? p.agentId : undefined;
}

/** Another agent is preferred for this call, and it is live, not excluded and has room for it. */
function leftForPreferred(agentId: string, subtask: Subtask, claims: Claims, nowMs: number): boolean {
  const pref = preferredAgentFor(subtask.id, nowMs);
  if (!pref || pref === agentId) return false;
  if (queue.excludedAgents(subtask.id).includes(pref)) return false;
  return liveAgent(pref, agentCapabilities.get(pref), nowMs) && hasRoomFor(pref, subtask, claims, nowMs);
}

function idleTakerExists(subtask: Subtask, claims: Claims, nowMs: number, except: string): boolean {
  const excluded = queue.excludedAgents(subtask.id);
  for (const [id, cap] of agentCapabilities) {
    if (id === except || excluded.includes(id) || (claims.get(id)?.all ?? 0) > 0) continue;
    if (!reachable(id, nowMs) || !liveAgent(id, cap, nowMs)) continue;
    if (freeSlots(id, claims, true) === 0) continue;
    if (!hasRoomFor(id, subtask, claims, nowMs)) continue;
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
  preferred.delete(subtaskId);
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
  const candidates: Array<{ id: string; busy: number; free: number; pending: boolean; at: number; cold: boolean }> = [];
  for (const [id, cap] of agentCapabilities) {
    if (excluded.includes(id) || !reachable(id, nowMs) || !liveAgent(id, cap, nowMs)) continue;
    if (!hasRoomFor(id, subtask, claims, nowMs)) continue;
    if (!claimRule(id, cap, undefined, nowMs)(subtask)) continue;
    const at = nudgedAt.get(id);
    candidates.push({ id, busy: claims.get(id)?.all ?? 0, free: freeSlots(id, claims, false) ?? 1, pending: at !== undefined && nowMs - at < NUDGE_PENDING_MS, at: at ?? 0, cold: !!subtask.requestedModel && modelKnownCold(id, subtask.requestedModel, nowMs) });
  }
  // Agents known to be cold last (no load / unload thrash; one that reports nothing is not assumed
  // cold, C3), then the least loaded.
  candidates.sort((a, b) => Number(a.cold) - Number(b.cold) || a.busy - b.busy || Number(a.pending) - Number(b.pending) || b.free - a.free || a.at - b.at);
  // The preferred agent (best fit, locality) is nudged first, also when its hold has just ended
  // (the nudge at its end): it is still the one the call suits best.
  const pref = preferred.get(subtask.id)?.agentId;
  const at = pref ? candidates.findIndex((c) => c.id === pref) : -1;
  if (at > 0) candidates.unshift(...candidates.splice(at, 1));
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
  for (const [id, p] of preferred) if (nowMs >= p.untilMs) preferred.delete(id);
  for (const id of neededTokens.keys()) if (!queue.getSubtask(id)) neededTokens.delete(id);
  for (const [id, load] of loads) if (nowMs - load.atMs > READY_KEEP_MS) loads.delete(id);
  for (const [id, at] of lastPullAt) if (nowMs - at > READY_KEEP_MS) lastPullAt.delete(id);
  for (const [id, at] of nudgedAt) if (nowMs - at > READY_KEEP_MS) nudgedAt.delete(id);
  for (const [id, m] of served) {
    for (const [model, at] of m) if (nowMs - at > WARM_MS) m.delete(model);
    if (!m.size) served.delete(id);
  }
}
setInterval(() => pruneDispatch(), 60_000).unref?.();

/** What an agent last reported with its pull (admin network view); undefined when it reports nothing. */
export function agentLoadReport(agentId: string): { slots: number; reportedFree?: number; wake: boolean; contextWindow?: number; atMs: number } | undefined {
  const load = loads.get(agentId);
  return load ? { ...load } : undefined;
}

/** When the agent last pulled (any report, or none); undefined when it has not in READY_KEEP_MS. */
export function agentLastPullMs(agentId: string): number | undefined {
  return lastPullAt.get(agentId);
}

/** An authenticated mesh WebSocket is open for the agent (admin network view). */
export function agentSocketConnected(agentId: string): boolean {
  return transport?.connected(agentId) ?? false;
}
