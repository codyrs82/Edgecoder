// Copyright (c) 2025 EdgeCoder, LLC
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
 *   (agent, TTFT, total time, cost) for Settings > Network's "Routing decisions" panel.
 */

import type { UsageRecord } from "../../economy/usage.js";
import type { JobDescriptor } from "../../inference-api/job-descriptor.js";
import { complexityWeightsFromEnv, type ComplexityWeights } from "../../inference-api/job-complexity.js";
import type { LocalWorld } from "../network-world.js";
import { routableModels } from "../model-catalog.js";
import { activeBlacklistRecord, agentCapabilities, AGENT_CONNECTED_WINDOW_MS } from "./agent-state.js";
import { bestFit, bestFitConfigFromEnv, routedLine, type AgentView, type BestFitConfig, type BestFitResult, type NetworkView, type SessionMemo } from "./best-fit.js";
import { FALLBACK_BTC_USD, queue, reservations, identity, usageListeners } from "./context.js";
import { agentContextWindow, agentLoadReport, freeModelSlots, pickupStats } from "./dispatch.js";
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
    freeSlots: freeModelSlots(agentId, claims),
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
    const models = routableModels(cap);
    if (!models.length) continue;
    const perf = agentPerf(agentId, claims);
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

// ── Resolution ───────────────────────────────────────────────────────────────────────────

export interface Resolution {
  result: BestFitResult;
  /** The chosen agent is on a peer coordinator: its URL (the caller may be sent there). */
  elsewhere?: { coordinatorId: string; url: string };
}

/** Score `job` on the live network. `peers`: also consider peer coordinators' agents. */
export async function resolveAuto(job: JobDescriptor, opts: { peers?: boolean; computeClass?: string } = {}, nowMs = Date.now()): Promise<Resolution> {
  const views = opts.peers && bestFitConfig.peers ? await peerViews(nowMs) : [];
  // Security research tier: a restricted model is never chosen by auto, for anyone (restricted.ts).
  const agents = withoutRestrictedModels([...localAgentViews(nowMs, rttSource), ...peerAgentViews(views, nowMs)]);
  const view: NetworkView = {
    // A class the client named limits the choice to it.
    agents: opts.computeClass ? agents.filter((a) => a.computeClass === opts.computeClass) : agents,
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

export interface RoutingDecision extends RoutingSummary {
  atMs: number;
  taskId: string;
  subtaskId: string;
  sessionKey: string;
  /** Agent best-fit preferred (internal; the panel shows the label). */
  preferredAgentId: string | null;
  actual: { agent?: string; ranOnPreferred?: boolean; ttftMs?: number; totalMs?: number; cSats?: number; ok?: boolean };
}

const decisions: RoutingDecision[] = [];
const bySubtask = new Map<string, RoutingDecision>();
const byTask = new Map<string, RoutingDecision>();

export function recordDecision(taskId: string, subtaskId: string, job: JobDescriptor, r: BestFitResult, nowMs = Date.now()): RoutingDecision {
  const d: RoutingDecision = { ...routingSummary(job, r), atMs: nowMs, taskId, subtaskId, sessionKey: job.sessionKey, preferredAgentId: r.chosen?.agentId ?? null, actual: {} };
  decisions.push(d);
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
      d.actual.ranOnPreferred = agentId === d.preferredAgentId;
      // The session's prefix is now cached there.
      if (d.model && d.computeClass) rememberSession(d.sessionKey, { agentId, model: d.model, computeClass: d.computeClass, atMs: nowMs });
    }
  }
  if (done) {
    d.actual.totalMs = nowMs - d.atMs;
    d.actual.ok = !error;
  }
}

/** The call settled: its cost (context.ts saveUsage). */
function noteRoutedUsage(r: UsageRecord): void {
  if (r.kind !== "inference") return;
  const d = byTask.get(r.id);
  if (!d) return;
  d.actual.cSats = Math.round(r.costMsat) / 1000;
  if (d.actual.ok === undefined) d.actual.ok = r.ok;
}
usageListeners.push(noteRoutedUsage);

/** Recent decisions, newest first (admin network view). */
export function recentDecisions(limit = 50): Array<Omit<RoutingDecision, "sessionKey" | "preferredAgentId">> {
  return decisions
    .slice(-limit)
    .reverse()
    .map(({ sessionKey: _s, preferredAgentId: _p, ...rest }) => ({ ...rest, actual: { ...rest.actual } }));
}

/** Tests: forget sessions, outcomes and decisions. */
export function resetRouting(): void {
  sessions.clear();
  outcomes.clear();
  decisions.length = 0;
  bySubtask.clear();
  byTask.clear();
}
