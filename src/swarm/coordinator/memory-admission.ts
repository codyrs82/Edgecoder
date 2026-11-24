// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coordinator-side host protection: no amount of network load may push an agent's machine into
 * memory exhaustion (2026-11-16 load test: a 48 GB Mac loaded ~10 models, ~120 GB, and was
 * force-restarted by its watchdog).
 *
 * Agents report their memory with each heartbeat and register (src/swarm/memory-budget.ts
 * MemoryTelemetry: total, available, pressure, budget, loaded models, the served models' footprint
 * and slots). From that:
 *
 *  - Admission: a model call for M goes to an agent only when M is loaded there (and it holds fewer
 *    calls than M's slots), or the agent's budget headroom (budget - loaded - loads dispatched in
 *    the last PENDING_LOAD_MS that have not shown up as loaded yet) fits M. An agent under warning
 *    or critical memory pressure, or one that says it paused for memory, has no capacity.
 *  - Affinity: dispatch.ts leaves a call for M briefly to an agent that has M loaded (no load /
 *    unload thrash); best-fit adds a cold-load wait for agents that would have to load M.
 *  - Refusals: an agent that hands a call back for memory ("memory_..." errors) gets no more calls
 *    for that model for REFUSAL_COOLDOWN_MS: work is never pushed onto an agent that said no.
 *  - Circuit breaker: consecutive failures or timeouts within CIRCUIT_WINDOW_MS (CIRCUIT_FAILURES,
 *    more for a many-slot host: half its slots, up to CIRCUIT_MAX_FAILURES, so one upstream burst
 *    across a 16-slot cloud host's parallel calls does not trip it) open the agent's circuit for a
 *    cool-down (60 s, doubling per trip up to CIRCUIT_MAX_COOLDOWN_MS); no work of any kind is
 *    dispatched to it meanwhile, and best fit does not place on it. A failure reported while the
 *    circuit is open (a call it held from before) does not count again. After the cool-down the
 *    circuit is half open: one call at a time (the probe). The probe's success closes it and resets
 *    the doubling; its failure opens it again at once for the next, longer cool-down. A trip count
 *    quiet for CIRCUIT_TRIP_RESET_MS after its cool-down starts over. Listeners (onCircuitTrip) hear
 *    each trip, so calls waiting for the agent can go elsewhere at once.
 *
 * Agents that report no telemetry (older releases) are admitted as before.
 */

import { estimateModelBytes, type MemoryTelemetry, type PressureLevel } from "../memory-budget.js";
import { isCloudModel } from "../../cloud-host/catalog.js";
import { agentSocketLost } from "./agent-liveness.js";

/** Telemetry older than this is ignored (the agent is then treated like one that reports none). */
export const MEMORY_FRESH_MS = 2 * 60_000;
/** A load dispatched to an agent counts against its headroom this long, or until it shows as loaded. */
export const PENDING_LOAD_MS = 30_000;
/** No calls for a model an agent refused for memory, for this long. */
export const REFUSAL_COOLDOWN_MS = 60_000;
export const CIRCUIT_FAILURES = 3;
/** The most consecutive failures any host needs to trip (a 16-slot host needs 8). */
export const CIRCUIT_MAX_FAILURES = 8;
export const CIRCUIT_WINDOW_MS = 5 * 60_000;
export const CIRCUIT_BASE_COOLDOWN_MS = 60_000;
export const CIRCUIT_MAX_COOLDOWN_MS = 5 * 60_000;
/** A tripped agent quiet this long after its cool-down starts its doubling over. */
export const CIRCUIT_TRIP_RESET_MS = 15 * 60_000;

interface MemoryRecord {
  t: MemoryTelemetry;
  atMs: number;
  /** Highest pressure and loaded bytes seen (admin view, load-test reports). */
  peakPressure: PressureLevel;
  peakUsedBytes: number;
  overBudget: boolean;
  /** When the agent reported critical pressure or loaded models past its budget (load-test reports). */
  incidents: MemoryIncident[];
}

export interface MemoryIncident {
  atMs: number;
  kind: "critical" | "over_budget";
  usedBytes: number;
  budgetBytes: number;
}
/** Incidents kept per agent; one of a kind per INCIDENT_GAP_MS (a long spell is one entry per gap). */
const MAX_INCIDENTS = 50;
const INCIDENT_GAP_MS = 15_000;

interface Circuit {
  failures: number[];
  trips: number;
  openUntilMs: number;
  /** When it last opened (0: never). */
  openedAtMs: number;
}

/** Parallel model slots of an agent, for its trip threshold (set by the coordinator: dispatch.ts agentLoadReport). */
let slotsOf: (agentId: string) => number | undefined = () => undefined;
export function setCircuitSlotsLookup(fn: (agentId: string) => number | undefined): void {
  slotsOf = fn;
}

/** Consecutive failures that trip this agent's circuit: CIRCUIT_FAILURES, or half its slots (at most CIRCUIT_MAX_FAILURES). */
export function circuitThreshold(agentId: string): number {
  const slots = slotsOf(agentId) ?? 1;
  return Math.max(CIRCUIT_FAILURES, Math.min(CIRCUIT_MAX_FAILURES, Math.ceil(slots / 2)));
}

const tripListeners = new Set<(agentId: string, openUntilMs: number) => void>();
/** Hear each trip (the circuit just opened). Returns a function that stops listening. */
export function onCircuitTrip(fn: (agentId: string, openUntilMs: number) => void): () => void {
  tripListeners.add(fn);
  return () => tripListeners.delete(fn);
}

const memory = new Map<string, MemoryRecord>();
/** agentId -> model -> pending loads (dispatch times). */
const pendingLoads = new Map<string, Map<string, number[]>>();
/** `${agentId}\u0000${model}` -> refused until. */
const refusals = new Map<string, number>();
const circuits = new Map<string, Circuit>();

const RANK: Record<PressureLevel, number> = { normal: 0, warning: 1, critical: 2 };

/** Reset all state (tests). */
export function resetMemoryAdmission(): void {
  memory.clear();
  pendingLoads.clear();
  refusals.clear();
  circuits.clear();
}

/** Store an agent's memory report (signed heartbeat or register). */
export function noteAgentMemory(agentId: string, t: MemoryTelemetry | undefined, nowMs = Date.now()): void {
  if (!t) return;
  const prev = memory.get(agentId);
  const peakPressure = prev && RANK[prev.peakPressure] > RANK[t.pressure] ? prev.peakPressure : t.pressure;
  const over = t.budgetBytes > 0 && t.usedBytes > t.budgetBytes;
  const incidents = prev?.incidents ?? [];
  const add = (kind: MemoryIncident["kind"]) => {
    const last = [...incidents].reverse().find((i) => i.kind === kind);
    if (last && nowMs - last.atMs < INCIDENT_GAP_MS) return;
    incidents.push({ atMs: nowMs, kind, usedBytes: t.usedBytes, budgetBytes: t.budgetBytes });
    if (incidents.length > MAX_INCIDENTS) incidents.splice(0, incidents.length - MAX_INCIDENTS);
  };
  if (t.pressure === "critical") add("critical");
  if (over) add("over_budget");
  memory.set(agentId, {
    t,
    atMs: nowMs,
    peakPressure,
    peakUsedBytes: Math.max(prev?.peakUsedBytes ?? 0, t.usedBytes),
    overBudget: Boolean(prev?.overBudget) || over,
    incidents,
  });
  // A pending load that now shows as loaded no longer counts twice.
  const pend = pendingLoads.get(agentId);
  if (pend) for (const l of t.loadedModels) pend.delete(l.name);
}

/** The agent's telemetry, when fresh. */
export function agentMemory(agentId: string, nowMs = Date.now()): MemoryTelemetry | undefined {
  const r = memory.get(agentId);
  return r && nowMs - r.atMs <= MEMORY_FRESH_MS ? r.t : undefined;
}

/** Admin view: the latest report (fresh or not) with peaks since the coordinator started. */
export function agentMemoryRecord(agentId: string): { telemetry: MemoryTelemetry; atMs: number; peakPressure: PressureLevel; peakUsedBytes: number; overBudget: boolean; incidents: MemoryIncident[] } | undefined {
  const r = memory.get(agentId);
  return r ? { telemetry: r.t, atMs: r.atMs, peakPressure: r.peakPressure, peakUsedBytes: r.peakUsedBytes, overBudget: r.overBudget, incidents: [...r.incidents] } : undefined;
}

/** Under memory pressure (warning or critical) or paused for memory: no capacity until it recovers. */
export function memoryLimited(agentId: string, nowMs = Date.now()): boolean {
  const t = agentMemory(agentId, nowMs);
  return !!t && (t.pressure !== "normal" || t.paused === true);
}

export function modelLoadedOn(agentId: string, model: string, nowMs = Date.now()): boolean {
  return !!agentMemory(agentId, nowMs)?.loadedModels.some((m) => m.name === model);
}

/** Loaded models the agent reported (undefined: no fresh telemetry). */
export function loadedModelsOf(agentId: string, nowMs = Date.now()): string[] | undefined {
  return agentMemory(agentId, nowMs)?.loadedModels.map((m) => m.name);
}

function prunePending(agentId: string, nowMs: number): Map<string, number[]> | undefined {
  const pend = pendingLoads.get(agentId);
  if (!pend) return undefined;
  for (const [model, times] of pend) {
    const live = times.filter((at) => nowMs - at < PENDING_LOAD_MS);
    if (live.length) pend.set(model, live);
    else pend.delete(model);
  }
  if (pend.size === 0) pendingLoads.delete(agentId);
  return pendingLoads.get(agentId);
}

/** Bytes `model` takes on the agent: its own estimate, else a conservative 8k x 1 slot estimate. */
export function modelBytesOn(t: MemoryTelemetry | undefined, model: string): number {
  const own = t?.models.find((m) => m.name === model);
  if (own && own.bytes > 0) return own.bytes;
  return estimateModelBytes(model, { numCtx: 8192, slots: 1 }).totalBytes;
}

/** Budget headroom left for a new load, after loaded models and pending loads. Undefined without telemetry. */
export function memoryHeadroom(agentId: string, nowMs = Date.now()): number | undefined {
  const t = agentMemory(agentId, nowMs);
  if (!t) return undefined;
  let pending = 0;
  const pend = prunePending(agentId, nowMs);
  if (pend) for (const model of pend.keys()) pending += modelBytesOn(t, model);
  return t.budgetBytes - t.usedBytes - pending;
}

/** The agent handed a call back for memory: no calls for that model for a while. */
export function noteRefusal(agentId: string, model: string | undefined, nowMs = Date.now()): void {
  refusals.set(`${agentId}\u0000${model ?? ""}`, nowMs + REFUSAL_COOLDOWN_MS);
}

function refused(agentId: string, model: string, nowMs: number): boolean {
  const until = refusals.get(`${agentId}\u0000${model}`) ?? refusals.get(`${agentId}\u0000`);
  return until !== undefined && nowMs < until;
}

/**
 * May a call for `model` go to this agent now, by memory? `heldInference` = model calls it holds.
 * No fresh telemetry: yes (older agents), unless it refused the model recently.
 * `ownerOnly`: the owner's own call on a model the agent keeps off the network (too big for its
 * budget): the owner chose to run it there, so no headroom check; critical pressure still refuses.
 */
export function memoryAdmits(agentId: string, model: string | undefined, heldInference: number, nowMs = Date.now(), opts: { ownerOnly?: boolean } = {}): boolean {
  if (model && refused(agentId, model, nowMs)) return false;
  // A cloud model runs on a hosted API (src/cloud-host/): it takes no memory on the host.
  if (model && isCloudModel(model)) return true;
  const t = agentMemory(agentId, nowMs);
  if (!t) return true;
  if (opts.ownerOnly) return t.pressure !== "critical";
  if (t.pressure !== "normal" || t.paused) return false;
  if (!model) return true;
  const served = t.models.find((m) => m.name === model);
  if (t.loadedModels.some((m) => m.name === model)) {
    const slots = served?.slots;
    return slots === undefined || heldInference < slots;
  }
  // A load already on its way counts as loaded (its slots are what the agent will serve with).
  if (pendingLoads.get(agentId)?.get(model)?.some((at) => nowMs - at < PENDING_LOAD_MS)) {
    return served?.slots === undefined || heldInference < served.slots;
  }
  const headroom = memoryHeadroom(agentId, nowMs) ?? Number.POSITIVE_INFINITY;
  return headroom >= modelBytesOn(t, model);
}

/** A call for `model` was handed to the agent: if it is not loaded there, its load counts against headroom for a while. */
export function noteDispatched(agentId: string, model: string | undefined, nowMs = Date.now()): void {
  if (!model || modelLoadedOn(agentId, model, nowMs) || !agentMemory(agentId, nowMs)) return;
  let pend = pendingLoads.get(agentId);
  if (!pend) pendingLoads.set(agentId, (pend = new Map()));
  pend.set(model, [...(pend.get(model) ?? []), nowMs]);
}

/** Cooled down after a trip, no success since, not yet quiet long enough to start over. */
function halfOpen(c: Circuit | undefined, nowMs: number): boolean {
  return !!c && c.trips > 0 && c.openUntilMs > 0 && nowMs >= c.openUntilMs && nowMs - c.openUntilMs < CIRCUIT_TRIP_RESET_MS;
}

function trip(agentId: string, c: Circuit, nowMs: number): void {
  c.trips += 1;
  c.openedAtMs = nowMs;
  c.openUntilMs = nowMs + Math.min(CIRCUIT_MAX_COOLDOWN_MS, CIRCUIT_BASE_COOLDOWN_MS * 2 ** (c.trips - 1));
  c.failures = [];
  for (const fn of tripListeners) {
    try {
      fn(agentId, c.openUntilMs);
    } catch {
      // a listener's failure never blocks the breaker
    }
  }
}

/** An agent's result: success closes its circuit; failures and timeouts count toward opening it. */
export function noteAgentOutcome(agentId: string, ok: boolean, nowMs = Date.now()): void {
  let c = circuits.get(agentId);
  if (ok) {
    if (c) {
      c.failures = [];
      c.trips = 0;
      c.openUntilMs = 0;
      c.openedAtMs = 0;
    }
    return;
  }
  if (!c) circuits.set(agentId, (c = { failures: [], trips: 0, openUntilMs: 0, openedAtMs: 0 }));
  // Already open: a call it held from before the trip (or a wait the open circuit itself caused) is not a new failure.
  if (nowMs < c.openUntilMs) return;
  // Half open: the probe failed, so the circuit opens again now, for longer.
  if (halfOpen(c, nowMs)) return trip(agentId, c, nowMs);
  if (c.trips > 0 && c.openUntilMs > 0 && nowMs - c.openUntilMs >= CIRCUIT_TRIP_RESET_MS) {
    c.trips = 0;
    c.openUntilMs = 0;
  }
  c.failures = [...c.failures.filter((at) => nowMs - at <= CIRCUIT_WINDOW_MS), nowMs];
  if (c.failures.length >= circuitThreshold(agentId)) trip(agentId, c, nowMs);
}

/** A result error that is the agent saying no for memory (not a failure of the agent). */
export function isMemoryRefusal(error: string | undefined): boolean {
  return typeof error === "string" && /^memory_/.test(error);
}

/** Feed a /result into refusals and the circuit breaker. */
export function noteAgentResult(agentId: string, model: string | undefined, ok: boolean, error: string | undefined, nowMs = Date.now()): void {
  if (!ok && isMemoryRefusal(error)) {
    noteRefusal(agentId, model, nowMs);
    return;
  }
  // A call the agent declined before running it (too long for its window, a frontier model), or one
  // whose output cap ended inside the model's reasoning (the caller's max_tokens, src/cloud-host/backend.ts): neutral.
  if (!ok && typeof error === "string" && /^(context_too_long|frontier_models_are_not_network_work|reasoning_only)/.test(error)) return;
  noteAgentOutcome(agentId, ok, nowMs);
}

/** The agent's circuit is open: nothing is dispatched to it until the cool-down ends. */
export function circuitOpen(agentId: string, nowMs = Date.now()): boolean {
  const c = circuits.get(agentId);
  return !!c && nowMs < c.openUntilMs;
}

/** Half open (cooled down after a trip, no success yet): it takes one call at a time, the probe. */
export function circuitHalfOpen(agentId: string, nowMs = Date.now()): boolean {
  return halfOpen(circuits.get(agentId), nowMs);
}

/** No new call for the agent now: its circuit is open, or half open with its probe call running (`held`: calls it holds). */
export function circuitBlocks(agentId: string, held: number, nowMs = Date.now()): boolean {
  return circuitOpen(agentId, nowMs) || (held > 0 && circuitHalfOpen(agentId, nowMs));
}

/** The circuit was open at some point since `sinceMs` (a wait for the agent then was the breaker's doing, not the agent's). */
export function circuitOpenSince(agentId: string, sinceMs: number, nowMs = Date.now()): boolean {
  const c = circuits.get(agentId);
  return !!c && c.openUntilMs > 0 && c.openUntilMs > sinceMs && c.openedAtMs <= nowMs;
}

export function circuitState(agentId: string, nowMs = Date.now()): { open: boolean; halfOpen: boolean; openUntilMs: number | null; trips: number; recentFailures: number } {
  const c = circuits.get(agentId);
  return { open: circuitOpen(agentId, nowMs), halfOpen: halfOpen(c, nowMs), openUntilMs: c && nowMs < c.openUntilMs ? c.openUntilMs : null, trips: c?.trips ?? 0, recentFailures: c?.failures.filter((at) => nowMs - at <= CIRCUIT_WINDOW_MS).length ?? 0 };
}

/**
 * No capacity for any new call, by memory or circuit (best-fit, /inference/models), or because its
 * socket closed and it has not been heard from since (#524, agent-liveness.ts).
 */
export function agentUnavailable(agentId: string, nowMs = Date.now()): boolean {
  return memoryLimited(agentId, nowMs) || circuitOpen(agentId, nowMs) || agentSocketLost(agentId, nowMs);
}

/** Drop records of agents gone quiet. */
export function pruneMemoryAdmission(nowMs = Date.now()): void {
  for (const [id, r] of memory) if (nowMs - r.atMs > 6 * 60 * 60_000) memory.delete(id);
  for (const id of pendingLoads.keys()) prunePending(id, nowMs);
  for (const [k, until] of refusals) if (nowMs >= until) refusals.delete(k);
  for (const [id, c] of circuits) if (nowMs >= c.openUntilMs && !halfOpen(c, nowMs) && c.failures.every((at) => nowMs - at > CIRCUIT_WINDOW_MS)) circuits.delete(id);
}
setInterval(() => pruneMemoryAdmission(), 60_000).unref?.();
