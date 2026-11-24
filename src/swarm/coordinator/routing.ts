// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Network best-fit routing on the coordinator: the live side of best-fit.ts.
 *
 * - Builds the NetworkView from this coordinator's agents (class, tier weight, models, slots, free
 *   slots, context window, measured tok/s, verifier reliability, recent failures, RTT) and, when
 *   asked, its peers' (their /network/world/local views, with the same `perf` facts).
 * - Remembers each session's last agent (session affinity), keyed by the job descriptor's session
 *   key, from the first piece of each routed reply.
 * - Keeps the last ROUTING_LOG_SIZE decisions with the estimate and, once known, what happened
 *   (agent, TTFT, total time, cost) for Settings > Network's "Routing decisions" panel. They are
 *   written to Postgres and read back at start (routing-history.ts), so a deploy keeps the table.
 * - Leaves the requester's own agents out of every auto call (self-dealing: withoutRequesterAgents).
 */

import type { UsageRecord } from "../../economy/usage.js";
import type { JobDescriptor } from "../../inference-api/job-descriptor.js";
import type { CoordinatorChoice } from "../../common/coordinator-choice.js";
import { classFamily } from "../../inference-api/auto-route.js";
import { complexityWeightsFromEnv, type ComplexityWeights } from "../../inference-api/job-complexity.js";
import { worldOwnerTag, type LocalWorld } from "../network-world.js";
import { routableModels } from "../model-catalog.js";
import { accountsFor } from "./agent-accounts.js";
import { activeBlacklistRecord, agentCapabilities, AGENT_CONNECTED_WINDOW_MS } from "./agent-state.js";
import { autoMayUseCloudModel } from "../../cloud-host/catalog.js";
import { bestFit, bestFitConfigFromEnv, routedLine, type AgentView, type BestFitConfig, type BestFitResult, type NetworkView, type SessionMemo } from "./best-fit.js";
import { FALLBACK_BTC_USD, queue, reservations, identity, usageListeners } from "./context.js";
import { agentContextWindow, agentLoadReport, freeModelSlots, pickupStats } from "./dispatch.js";
import { agentUnavailable, loadedModelsOf, memoryAdmits, modelLoadedOn } from "./memory-admission.js";
import { effectiveHardware, hardwareVerifier } from "./economy.js";
import { mutable } from "./mutable-state.js";
import { restrictedCatalog } from "./restricted.js";

export const bestFitConfig: BestFitConfig = bestFitConfigFromEnv();
export const complexityWeights: ComplexityWeights = complexityWeightsFromEnv();

export const ROUTING_LOG_SIZE = 200;
const MAX_SESSIONS = 20_000;
const MAX_OUTCOMES = 5_000;
/** How long the peers' views may take before routing goes ahead without them. */
const PEER_VIEW_WAIT_MS = 300;

// ── Agent facts ──────────────────────────────────────────────────────────────────────────

/** Recent model-call failures per agent (moving average, alpha 0.2). */
const outcomes = new Map<string, { failRate: number; n: number }>();

export function noteAgentOutcome(agentId: string, ok: boolean): void {
  const o = outcomes.get(agentId) ?? { failRate: 0, n: 0 };
  o.failRate = o.n === 0 ? (ok ? 0 : 1) : o.failRate + 0.2 * ((ok ? 0 : 1) - o.failRate);
  o.n++;
  outcomes.delete(agentId);
  outcomes.set(agentId, o);
  while (outcomes.size > MAX_OUTCOMES) outcomes.delete(outcomes.keys().next().value as string);
}

export function agentFailRate(agentId: string): number | undefined {
  const o = outcomes.get(agentId);
  return o && o.n >= 2 ? Math.round(o.failRate * 1000) / 1000 : undefined;
}

/** What peers need to score this agent (sent in /network/world/local as `perf`). */
export interface AgentPerf {
  contextWindow: number | null;
  tokensPerSec: number | null;
  reliability: number | null;
  verified: boolean;
  freeSlots: number;
  failRate: number | null;
  tierWeight: number;
}

export function agentPerf(agentId: string, claims = queue.activeClaims()): AgentPerf {
  const cap = agentCapabilities.get(agentId);
  const rec = hardwareVerifier.get(agentId);
  return {
    contextWindow: agentContextWindow(agentId) ?? null,
    tokensPerSec: rec?.evidence.tokensPerSec ?? null,
    reliability: hardwareVerifier.reliability(agentId) ?? null,
    verified: rec?.status === "verified" || rec?.status === "base",
    // No capacity while under memory pressure or with its circuit open (memory-admission.ts).
    freeSlots: agentUnavailable(agentId) ? 0 : freeModelSlots(agentId, claims),
    failRate: agentFailRate(agentId) ?? null,
    tierWeight: effectiveHardware(agentId, cap)?.creditsPerSecond ?? 1,
  };
}

/**
 * This coordinator's agents that a network call can be placed on now: online, not blacklisted,
 * not held by a reservation, owner approved as a host, holding at least one model.
 */
export function localAgentViews(nowMs = Date.now(), rttOf: (agentId: string) => number | null = () => null): AgentView[] {
  const claims = queue.activeClaims();
  const out: AgentView[] = [];
  for (const [agentId, cap] of agentCapabilities) {
    if (activeBlacklistRecord(agentId) || cap.hostApproved === false || reservations.isHeld(agentId, nowMs)) continue;
    // Cloud hosts (src/cloud-host/) are reached by naming a cloud model. Best fit sees them only
    // with the models the owner let Auto use (AUTO_CLOUD_MODELS, catalog autoEligible; default
    // none), and places on them only top-tier jobs (best-fit.ts): each call spends the platform's
    // provider budget (docs/cloud-host.md).
    const cloudHost = effectiveHardware(agentId, cap)?.computeClass === "cloud";
    if (cloudHost && bestFitConfig.autoCloudModels.length === 0) continue;
    // Host memory (memory-admission.ts): only models it can load or has loaded, and no free slot
    // while it is under memory pressure or its circuit is open.
    const held = claims.get(agentId)?.inference ?? 0;
    const models = cloudHost
      ? routableModels(cap).filter((m) => autoMayUseCloudModel(m, bestFitConfig.autoCloudModels))
      : routableModels(cap).filter((m) => memoryAdmits(agentId, m, held, nowMs) || modelLoadedOn(agentId, m, nowMs));
    if (!models.length) continue;
    const perf = agentPerf(agentId, claims);
    const loadedModels = loadedModelsOf(agentId, nowMs);
    const hw = effectiveHardware(agentId, cap);
    out.push({
      agentId,
      label: `agent-${agentId.slice(-6)}`,
      coordinatorId: identity.peerId,
      local: true,
      computeClass: hw?.computeClass ?? cap.computeClass ?? "cpu",
      tierWeight: perf.tierWeight,
      models,
      activeModel: cap.activeModel ?? null,
      ...(loadedModels ? { loadedModels } : {}),
      slots: agentLoadReport(agentId)?.slots ?? cap.maxConcurrentTasks ?? 1,
      freeSlots: perf.freeSlots,
      ...(perf.contextWindow !== null ? { contextWindow: perf.contextWindow } : {}),
      ...(perf.tokensPerSec !== null ? { tokensPerSec: perf.tokensPerSec } : {}),
      ...(perf.reliability !== null ? { reliability: perf.reliability } : {}),
      verified: perf.verified,
      ...(perf.failRate !== null ? { failRate: perf.failRate } : {}),
      rttMs: rttOf(agentId),
      stale: nowMs - cap.lastSeenMs > AGENT_CONNECTED_WINDOW_MS,
    });
  }
  return out;
}

/** Agents of peer coordinators from their world views (only those that sent `perf`). */
export function peerAgentViews(worlds: Array<{ world: LocalWorld; linkRttMs: number | null }>, nowMs = Date.now()): AgentView[] {
  const out: AgentView[] = [];
  for (const { world, linkRttMs } of worlds) {
    if (world.coordinator.id === identity.peerId) continue;
    for (const a of world.agents) {
      const perf = a.perf;
      if (!perf || a.status === "stale" || !a.models.length) continue;
      out.push({
        agentId: a.agentId,
        label: a.label,
        coordinatorId: world.coordinator.id,
        local: false,
        computeClass: a.computeClass,
        tierWeight: perf.tierWeight,
        models: a.models,
        activeModel: a.activeModel,
        slots: a.slots,
        freeSlots: perf.freeSlots,
        ...(perf.contextWindow !== null ? { contextWindow: perf.contextWindow } : {}),
        ...(perf.tokensPerSec !== null ? { tokensPerSec: perf.tokensPerSec } : {}),
        ...(perf.reliability !== null ? { reliability: perf.reliability } : {}),
        verified: perf.verified,
        ...(perf.failRate !== null ? { failRate: perf.failRate } : {}),
        rttMs: a.rttMs,
        linkRttMs,
        stale: nowMs - a.lastSeenMs > AGENT_CONNECTED_WINDOW_MS,
        ownerTag: a.ownerTag ?? null,
      });
    }
  }
  return out;
}

// ── Peer views (registered by routes/network-world.ts, which owns the peer fetches) ─────────

export type PeerWorldSource = (nowMs: number) => Promise<Array<{ world: LocalWorld; linkRttMs: number | null }>>;
let peerSource: PeerWorldSource | undefined;
let rttSource: (agentId: string) => number | null = () => null;
export function setPeerWorldSource(source: PeerWorldSource | undefined, rtt?: (agentId: string) => number | null): void {
  peerSource = source;
  if (rtt) rttSource = rtt;
}
/** This coordinator's measured round trip to one of its agents (null: not measured). */
export function agentRttMs(agentId: string): number | null {
  return rttSource(agentId);
}

/** A typical call's duration here (p50 of recent calls), registered by routes/admin-network.ts. */
let callP50Source: () => number | null = () => null;
export function setCallDurationSource(source: () => number | null): void {
  callP50Source = source;
}
/** What /inference/models tells the portal about queueing here: pickup p90 and call duration p50 (ms). */
export function coordinatorLoadSignals(): { pickupP90Ms: number | null; callP50Ms: number | null } {
  const p = pickupStats();
  let callP50Ms: number | null = null;
  try {
    callP50Ms = callP50Source();
  } catch {
    callP50Ms = null;
  }
  return { pickupP90Ms: p.count ? Math.round(p.p90) : null, callP50Ms: callP50Ms === null ? null : Math.round(callP50Ms) };
}

async function peerViews(nowMs: number): Promise<Array<{ world: LocalWorld; linkRttMs: number | null }>> {
  if (!peerSource) return [];
  const timeout = new Promise<[]>((r) => setTimeout(() => r([]), PEER_VIEW_WAIT_MS).unref?.());
  return Promise.race([peerSource(nowMs).catch(() => []), timeout]);
}

// ── Sessions ─────────────────────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionMemo>();

export function sessionMemo(key: string, nowMs = Date.now()): SessionMemo | undefined {
  const s = sessions.get(key);
  if (s && nowMs - s.atMs > bestFitConfig.sessionTtlMs) {
    sessions.delete(key);
    return undefined;
  }
  return s;
}

export function rememberSession(key: string, memo: SessionMemo): void {
  sessions.delete(key);
  sessions.set(key, memo);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
}

/** Agents as best-fit may use them: restricted models taken out (an agent left with none is dropped). */
export function withoutRestrictedModels(agents: AgentView[]): AgentView[] {
  if (restrictedCatalog.size === 0) return agents;
  const out: AgentView[] = [];
  for (const a of agents) {
    const models = a.models.filter((m) => !restrictedCatalog.tierOf(m));
    if (!models.length) continue;
    out.push({ ...a, models, activeModel: a.activeModel && restrictedCatalog.tierOf(a.activeModel) ? null : a.activeModel });
  }
  return out;
}

/**
 * Agents as best-fit may use them for `requesterAccountId`: the requester's own agents are left
 * out. A call placed on your own machine bills you and pays you back less the fee, so it only costs
 * the fee (self-dealing); your own machines are for target "mine", which is free. Local agents are
 * matched by owner account (`owners`), peers' by the owner tag their coordinator reports.
 */
export function withoutRequesterAgents(agents: AgentView[], requesterAccountId: string | undefined, owners: ReadonlyMap<string, string | null>): AgentView[] {
  if (!requesterAccountId) return agents;
  const tag = worldOwnerTag(requesterAccountId);
  return agents.filter((a) => (a.local ? owners.get(a.agentId) !== requesterAccountId && a.agentId !== requesterAccountId : a.ownerTag !== tag));
}

/** Owner accounts of this coordinator's agents: agent_ownership, cached a minute, waited on at most 300 ms. */
export type AgentOwnerSource = (agentIds: string[], nowMs: number) => Promise<ReadonlyMap<string, string | null>>;
let ownerSource: AgentOwnerSource = (ids, nowMs) => accountsFor(ids, nowMs, OWNER_LOOKUP_WAIT_MS);
const OWNER_LOOKUP_WAIT_MS = 300;
export function setAgentOwnerSource(source: AgentOwnerSource): void {
  ownerSource = source;
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────

export interface Resolution {
  result: BestFitResult;
  /** The chosen agent is on a peer coordinator: its URL (the caller may be sent there). */
  elsewhere?: { coordinatorId: string; url: string };
}

/** Score `job` on the live network. `peers`: also consider peer coordinators' agents. */
export async function resolveAuto(job: JobDescriptor, opts: { peers?: boolean; computeClass?: string; requesterAccountId?: string } = {}, nowMs = Date.now()): Promise<Resolution> {
  const views = opts.peers && bestFitConfig.peers ? await peerViews(nowMs) : [];
  const local = localAgentViews(nowMs, rttSource);
  const owners = opts.requesterAccountId ? await ownerSource(local.map((a) => a.agentId), nowMs).catch(() => new Map<string, string | null>()) : new Map<string, string | null>();
  // Security research tier: a restricted model is never chosen by auto, for anyone (restricted.ts).
  // Never the requester's own machines (self-dealing).
  const agents = withoutRequesterAgents(withoutRestrictedModels([...local, ...peerAgentViews(views, nowMs)]), opts.requesterAccountId, owners);
  const view: NetworkView = {
    // A class the client named limits the choice to it ("gpu" is the GPU family: gpu and gpu.dc).
    agents: opts.computeClass ? agents.filter((a) => classFamily(opts.computeClass!).includes(a.computeClass)) : agents,
    pickupP50Ms: pickupStats().p50,
    waitingByModel: Object.fromEntries(queue.waitingInferenceByModel()),
    btcUsd: mutable.latestRateEpoch?.btcUsd ?? FALLBACK_BTC_USD,
  };
  const result = bestFit(job, view, bestFitConfig, sessionMemo(job.sessionKey, nowMs), nowMs);
  const c = result.chosen;
  if (c && !c.local) {
    const w = views.find((v) => v.world.coordinator.id === c.coordinatorId);
    if (w?.world.coordinator.url) return { result, elsewhere: { coordinatorId: c.coordinatorId, url: w.world.coordinator.url } };
  }
  return { result };
}

/** What /inference/submit answers about a routed call. */
export function routingSummary(job: JobDescriptor, r: BestFitResult) {
  const c = r.chosen;
  return {
    model: c?.model ?? null,
    computeClass: c?.computeClass ?? null,
    agent: c?.agentLabel ?? null,
    coordinatorId: c?.coordinatorId ?? null,
    job: job.job,
    jobInferred: job.jobInferred,
    quality: job.quality,
    latency: job.latency,
    complexity: { score: job.complexity.score, level: job.complexity.level, estimated: job.complexity.estimated, ...(job.complexity.hinted !== undefined ? { hinted: job.complexity.hinted } : {}), signals: job.complexity.signals.slice(0, 6) },
    requirements: r.requirements,
    weights: r.weights,
    score: c?.score ?? null,
    parts: c?.parts ?? null,
    estimate: c ? { waitMs: c.estimate.waitMs, ttftMs: c.estimate.ttftMs, totalMs: c.estimate.totalMs, cSats: c.estimate.cSats } : null,
    affinity: r.affinity,
    alternatives: r.candidates.filter((x) => x !== c).slice(0, 4).map((x) => ({ model: x.model, computeClass: x.computeClass, score: x.score })),
    reason: r.reason,
    line: routedLine(r),
  };
}
export type RoutingSummary = ReturnType<typeof routingSummary>;

// ── Decision log ─────────────────────────────────────────────────────────────────────────

/** Best-fit fields a pinned-model call (recordPlacement) does not have. */
type BestFitOnly = "job" | "jobInferred" | "quality" | "latency" | "complexity" | "requirements" | "weights" | "affinity";

export interface RoutingDecision extends Omit<RoutingSummary, BestFitOnly>, Partial<Pick<RoutingSummary, BestFitOnly>> {
  atMs: number;
  /** A call that named its model: only the portal's coordinator choice was decided. */
  pinned?: true;
  /** Why the portal sent the call to this coordinator (latency-aware choice; common/coordinator-choice.ts). */
  coordinatorChoice?: CoordinatorChoice;
  taskId: string;
  subtaskId: string;
  sessionKey: string;
  /** Agent best-fit preferred (internal; the panel shows the label). */
  preferredAgentId: string | null;
  actual: { agent?: string; ranOnPreferred?: boolean; ttftMs?: number; totalMs?: number; cSats?: number; ok?: boolean };
}

/** A decision as stored (routing-history.ts) and shown: without the session key and the agent id. */
export type StoredRoutingDecision = Omit<RoutingDecision, "sessionKey" | "preferredAgentId">;

const decisions: RoutingDecision[] = [];
const bySubtask = new Map<string, RoutingDecision>();
const byTask = new Map<string, RoutingDecision>();

/** Told when a decision is made or its outcome changes (routing-history.ts writes it to Postgres). */
let decisionSink: ((d: RoutingDecision) => void) | undefined;
export function setDecisionSink(sink: ((d: RoutingDecision) => void) | undefined): void {
  decisionSink = sink;
}
const changed = (d: RoutingDecision) => {
  try {
    decisionSink?.(d);
  } catch {
    // persistence never breaks routing
  }
};

export function storedDecision(d: RoutingDecision): StoredRoutingDecision {
  const { sessionKey: _s, preferredAgentId: _p, ...rest } = d;
  return { ...rest, actual: { ...rest.actual } };
}

/**
 * Put stored decisions (oldest first) in front of the ones made since start, so the panel shows the
 * calls before a restart; keeps the newest ROUTING_LOG_SIZE. Their outcomes are final (no session,
 * no preferred agent). Returns how many were added.
 */
export function restoreDecisions(stored: readonly StoredRoutingDecision[]): number {
  const firstLive = decisions[0]?.atMs ?? Infinity;
  const known = new Set(decisions.map((d) => d.taskId));
  const older = stored
    .filter((d) => d && typeof d.taskId === "string" && Number.isFinite(d.atMs) && d.atMs <= firstLive && !known.has(d.taskId))
    .map((d): RoutingDecision => ({ ...d, actual: { ...(d.actual ?? {}) }, sessionKey: "", preferredAgentId: null }));
  const room = Math.max(0, ROUTING_LOG_SIZE - decisions.length);
  const add = older.slice(-room);
  if (!add.length) return 0;
  decisions.unshift(...add);
  return add.length;
}

export function recordDecision(taskId: string, subtaskId: string, job: JobDescriptor, r: BestFitResult, nowMs = Date.now(), coordinatorChoice?: CoordinatorChoice): RoutingDecision {
  const d: RoutingDecision = { ...routingSummary(job, r), atMs: nowMs, taskId, subtaskId, sessionKey: job.sessionKey, preferredAgentId: r.chosen?.agentId ?? null, actual: {}, ...(coordinatorChoice ? { coordinatorChoice } : {}) };
  return logDecision(d);
}

/**
 * A network call that named its model, sent here by the portal's latency-aware coordinator choice:
 * logged with that choice so the admin Network page shows which coordinator took it and why.
 */
export function recordPlacement(taskId: string, subtaskId: string, call: { model: string; computeClass: string | null }, coordinatorChoice: CoordinatorChoice, nowMs = Date.now()): RoutingDecision {
  const line = `${call.model} (named) sent to ${coordinatorChoice.chosen}: ${coordinatorChoice.reason}`.slice(0, 300);
  return logDecision({
    model: call.model,
    computeClass: call.computeClass,
    agent: null,
    coordinatorId: identity.peerId,
    score: null,
    parts: null,
    estimate: null,
    alternatives: [],
    reason: `coordinator: ${coordinatorChoice.reason}`.slice(0, 300),
    line,
    pinned: true,
    coordinatorChoice,
    atMs: nowMs,
    taskId,
    subtaskId,
    sessionKey: "",
    preferredAgentId: null,
    actual: {},
  });
}

function logDecision(d: RoutingDecision): RoutingDecision {
  const { taskId, subtaskId } = d;
  decisions.push(d);
  changed(d);
  bySubtask.set(subtaskId, d);
  byTask.set(taskId, d);
  while (decisions.length > ROUTING_LOG_SIZE) {
    const old = decisions.shift()!;
    bySubtask.delete(old.subtaskId);
    byTask.delete(old.taskId);
  }
  return d;
}

/** A piece of a routed reply was accepted from `agentId` (admin-network observeInference). */
export function noteRoutedChunk(subtaskId: string, agentId: string | undefined, done: boolean, error: string | undefined, nowMs = Date.now()): void {
  const d = bySubtask.get(subtaskId);
  if (agentId && done) noteAgentOutcome(agentId, !error);
  if (!d) return;
  if (d.actual.ttftMs === undefined) {
    d.actual.ttftMs = nowMs - d.atMs;
    if (agentId) {
      d.actual.agent = `agent-${agentId.slice(-6)}`;
      if (!d.pinned) d.actual.ranOnPreferred = agentId === d.preferredAgentId;
      // The session's prefix is now cached there.
      if (d.sessionKey && d.model && d.computeClass) rememberSession(d.sessionKey, { agentId, model: d.model, computeClass: d.computeClass, atMs: nowMs });
    }
  }
  if (done) {
    d.actual.totalMs = nowMs - d.atMs;
    d.actual.ok = !error;
    changed(d);
  }
}

/** The call settled: its cost (context.ts saveUsage). */
function noteRoutedUsage(r: UsageRecord): void {
  if (r.kind !== "inference") return;
  const d = byTask.get(r.id);
  if (!d) return;
  d.actual.cSats = Math.round(r.costMsat) / 1000;
  if (d.actual.ok === undefined) d.actual.ok = r.ok;
  changed(d);
}
usageListeners.push(noteRoutedUsage);

/** Recent decisions, newest first (admin network view). */
export function recentDecisions(limit = 50): StoredRoutingDecision[] {
  return decisions.slice(-limit).reverse().map(storedDecision);
}

/** Tests: forget sessions, outcomes and decisions. */
export function resetRouting(): void {
  sessions.clear();
  outcomes.clear();
  decisions.length = 0;
  bySubtask.clear();
  byTask.clear();
}
