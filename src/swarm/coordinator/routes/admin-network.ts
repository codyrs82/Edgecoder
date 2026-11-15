// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * GET /admin/network: the live state of this coordinator's part of the network for the portal's
 * admin page (Settings > Network): agents with their account, models, slots and claims; the queue;
 * dispatch and model-call latency; gaps (models asked for that nobody holds, models with no free
 * slot, agents gone quiet); and a 24 h time series sampled every 15 s.
 *
 * Gate: the admin token (x-admin-token, authorizeAdmin), exactly like /admin/revenue. The route is
 * registered in its own plugin with the same onRequest check, so it cannot be reached without it
 * (coordinator.ts skips the mesh-token check for every /admin/* path).
 *
 * Observation is additive: an onSend hook watches /inference/submit and /inference/chunks answers
 * (it never changes them), and a 15 s sampler reads state the coordinator already keeps. All of it
 * is in memory and bounded (src/swarm/network-observer.ts).
 */
import { z } from "zod";
import type { CoordinatorApp } from "../app.js";
import { queue, reservations, identity, CC } from "../context.js";
import { pgStore } from "../../../db/store.js";
import { agentCapabilities, activeBlacklistRecord, AGENT_CONNECTED_WINDOW_MS } from "../agent-state.js";
import { authorizeAdmin } from "../auth.js";
import { agentContextWindow, agentLoadReport, agentSocketConnected, freeModelSlots, pickupStats } from "../dispatch.js";
import { effectiveHardware, hardwareVerifier } from "../economy.js";
import { routableModels } from "../../model-catalog.js";
import { inferenceCancelledForCapacity } from "./inference.js";
import { bestFitConfig, complexityWeights, noteRoutedChunk, recentDecisions } from "../routing.js";
import {
  InferenceTracker,
  RingBuffer,
  SAMPLE_CAPACITY,
  SAMPLE_INTERVAL_MS,
  SERIES_RANGES,
  downsample,
  seriesBucketMs,
  type CallOutcome,
  type NetworkSample,
  type SeriesRange
} from "../../network-observer.js";

/** Latency and model counts are reported over this recent window. */
export const LATENCY_WINDOW_MS = 15 * 60_000;
/** Gaps (models asked for with no capacity) are reported over this window. */
export const GAP_WINDOW_MS = 60 * 60_000;
/** Account lookups (agent -> owner account) are cached this long. */
const ACCOUNT_TTL_MS = 60_000;

export const inferenceTracker = new InferenceTracker();
export const networkSamples = new RingBuffer<NetworkSample>(SAMPLE_CAPACITY);

type Capability = NonNullable<ReturnType<typeof agentCapabilities.get>>;

function isConnected(cap: Capability, nowMs: number): boolean {
  return nowMs - cap.lastSeenMs < AGENT_CONNECTED_WINDOW_MS;
}

/** Live, routable agents: connected and not blacklisted. */
function liveAgents(nowMs: number): Array<[string, Capability]> {
  return [...agentCapabilities.entries()].filter(([id, cap]) => isConnected(cap, nowMs) && !activeBlacklistRecord(id));
}

function callOutcome(taskId: string, subtaskId: string): CallOutcome {
  if (inferenceCancelledForCapacity(taskId)) return "no_capacity";
  const result = queue.getResult(subtaskId);
  if (!result) return undefined;
  if (result.error === "no_capacity") return "no_capacity";
  return result.ok ? "ok" : "failed";
}

/** Gauges every sample and the snapshot share. */
function gauges(nowMs: number) {
  const claims = queue.activeClaims();
  let busyAgents = 0;
  let totalSlots = 0;
  let freeSlots = 0;
  for (const [id] of liveAgents(nowMs)) {
    if ((claims.get(id)?.all ?? 0) > 0) busyAgents++;
    totalSlots += agentLoadReport(id)?.slots ?? 1;
    freeSlots += freeModelSlots(id, claims);
  }
  let claimed = 0;
  for (const c of claims.values()) claimed += c.all;
  let waitingInference = 0;
  for (const n of queue.waitingInferenceByModel().values()) waitingInference += n;
  return { claims, connectedAgents: liveAgents(nowMs).length, busyAgents, totalSlots, freeSlots, queued: queue.status().queued, claimed, waitingInference };
}

/** Take one sample: settle calls that ended, read gauges and the interval's counts. */
export function takeNetworkSample(nowMs = Date.now()): NetworkSample {
  inferenceTracker.sweep(callOutcome, nowMs);
  const g = gauges(nowMs);
  const counts = inferenceTracker.takeInterval();
  const pickup = pickupStats();
  const ttft = inferenceTracker.ttft.percentiles(nowMs - 5 * 60_000);
  const sample: NetworkSample = {
    atMs: nowMs,
    connectedAgents: g.connectedAgents,
    busyAgents: g.busyAgents,
    totalSlots: g.totalSlots,
    freeSlots: g.freeSlots,
    queued: g.queued,
    claimed: g.claimed,
    waitingInference: g.waitingInference,
    ...counts,
    pickupP50: pickup.count ? pickup.p50 : null,
    pickupP90: pickup.count ? pickup.p90 : null,
    ttftP50: ttft.count ? ttft.p50 : null,
    ttftP90: ttft.count ? ttft.p90 : null
  };
  networkSamples.push(sample);
  return sample;
}

const accountCache = new Map<string, { accountId: string | null; atMs: number }>();

/** Owner account per agent (agent_ownership), cached; null when not linked or not known here. */
export async function accountsFor(agentIds: string[], nowMs: number): Promise<Map<string, string | null>> {
  for (const id of accountCache.keys()) if (!agentCapabilities.has(id)) accountCache.delete(id);
  const out = new Map<string, string | null>();
  const misses: string[] = [];
  for (const id of agentIds) {
    const hit = accountCache.get(id);
    if (hit && nowMs - hit.atMs < ACCOUNT_TTL_MS) out.set(id, hit.accountId);
    else misses.push(id);
  }
  if (misses.length && pgStore) {
    const lookups = Promise.all(
      misses.map(async (id) => {
        const accountId = (await pgStore!.getAgentOwnership(id).catch(() => null))?.accountId ?? null;
        accountCache.set(id, { accountId, atMs: nowMs });
        out.set(id, accountId);
      })
    );
    // A slow database leaves the rest unknown for this answer rather than holding the page.
    await Promise.race([lookups, new Promise((r) => setTimeout(r, 2_000).unref?.())]);
  }
  for (const id of agentIds) if (!out.has(id)) out.set(id, accountCache.get(id)?.accountId ?? null);
  return out;
}

/** The whole snapshot. `range` picks the series window (default 1 h). */
export async function networkSnapshot(range: SeriesRange = "1h", nowMs = Date.now()) {
  const g = gauges(nowMs);
  const claims = g.claims;
  const accounts = await accountsFor([...agentCapabilities.keys()], nowMs);
  const agents = [...agentCapabilities.entries()].map(([agentId, cap]) => {
    const load = agentLoadReport(agentId);
    const blacklist = activeBlacklistRecord(agentId);
    const hw = effectiveHardware(agentId, cap);
    const verification = hardwareVerifier.get(agentId);
    const held = claims.get(agentId);
    const connected = isConnected(cap, nowMs);
    return {
      agentId,
      accountId: accounts.get(agentId) ?? null,
      ownerEmail: cap.ownerEmail ?? null,
      os: cap.os,
      clientType: cap.clientType,
      version: cap.version,
      mode: cap.mode,
      provider: cap.localModelProvider,
      countryCode: cap.countryCode ?? null,
      vpnDetected: cap.vpnDetected ?? null,
      computeClass: hw?.computeClass ?? cap.computeClass,
      tier: hw?.tier ?? null,
      claimedTier: cap.hardwareClass?.tier ?? null,
      verification: verification ? verification.status : null,
      modelsInstalled: routableModels(cap),
      modelsReported: cap.modelsReported === true,
      activeModel: cap.activeModel ?? null,
      slots: load?.slots ?? 1,
      slotsReported: load !== undefined,
      freeSlots: connected && !blacklist ? freeModelSlots(agentId, claims) : 0,
      contextWindow: agentContextWindow(agentId) ?? null,
      claims: held?.all ?? 0,
      inferenceClaims: held?.inference ?? 0,
      lastSeenMs: cap.lastSeenMs,
      lastPullMs: load?.atMs ?? null,
      connected,
      socketConnected: agentSocketConnected(agentId),
      wake: load?.wake ?? false,
      reserved: reservations.isHeld(agentId, nowMs),
      blacklisted: Boolean(blacklist),
      blacklistReason: blacklist?.reason ?? null,
      status: blacklist ? "blacklisted" : !connected ? "stale" : (held?.all ?? 0) > 0 ? "busy" : "idle"
    };
  });

  // Models: holders among live agents, free slots, calls waiting and recent calls.
  const waitingByModel = queue.waitingInferenceByModel();
  const recent = inferenceTracker.models.counts(nowMs - LATENCY_WINDOW_MS);
  const gapCounts = inferenceTracker.models.counts(nowMs - GAP_WINDOW_MS);
  const dayCounts = inferenceTracker.models.counts(nowMs - SERIES_RANGES["24h"]);
  const byModel = new Map<string, { agents: number; idleAgents: number; slots: number; freeSlots: number }>();
  for (const a of agents) {
    if (a.status === "stale" || a.status === "blacklisted") continue;
    for (const m of new Set(a.modelsInstalled)) {
      const e = byModel.get(m) ?? { agents: 0, idleAgents: 0, slots: 0, freeSlots: 0 };
      e.agents++;
      if (a.claims === 0) e.idleAgents++;
      e.slots += a.slots;
      e.freeSlots += a.freeSlots;
      byModel.set(m, e);
    }
  }
  const modelNames = new Set([...byModel.keys(), ...waitingByModel.keys(), ...dayCounts.keys()]);
  modelNames.delete("");
  const models = [...modelNames]
    .map((model) => {
      const e = byModel.get(model) ?? { agents: 0, idleAgents: 0, slots: 0, freeSlots: 0 };
      const c = recent.get(model);
      const d = dayCounts.get(model);
      return {
        model,
        ...e,
        waiting: waitingByModel.get(model) ?? 0,
        callsWindow: c?.submitted ?? 0,
        completedWindow: c?.completed ?? 0,
        failedWindow: c?.failed ?? 0,
        calls24h: d?.submitted ?? 0,
        noAgentHasModel24h: d?.noAgentHasModel ?? 0,
        noCapacity24h: d?.noCapacity ?? 0
      };
    })
    .sort((a, b) => b.agents - a.agents || b.calls24h - a.calls24h || a.model.localeCompare(b.model));

  const missingModels = [...gapCounts.entries()]
    .filter(([, c]) => c.noAgentHasModel + c.noCapacity > 0)
    .map(([model, c]) => ({ model, noAgentHasModel: c.noAgentHasModel, noCapacity: c.noCapacity, holders: byModel.get(model)?.agents ?? 0 }))
    .sort((a, b) => b.noAgentHasModel + b.noCapacity - (a.noAgentHasModel + a.noCapacity));
  const saturatedModels = models.filter((m) => m.agents > 0 && m.freeSlots === 0).map((m) => ({ model: m.model, agents: m.agents, slots: m.slots, waiting: m.waiting }));
  const staleAgents = agents
    .filter((a) => a.status === "stale")
    .map((a) => ({ agentId: a.agentId, accountId: a.accountId, lastSeenMs: a.lastSeenMs }))
    .sort((a, b) => b.lastSeenMs - a.lastSeenMs);

  const pickup = pickupStats();
  const series = downsample(networkSamples.toArray(), range, nowMs);
  const lastFive = networkSamples.toArray().filter((s) => s.atMs > nowMs - 5 * 60_000);
  const perMin = (k: "started" | "completed") => (lastFive.length ? Math.round((lastFive.reduce((a, s) => a + s[k], 0) / Math.max(1, (lastFive.length * SAMPLE_INTERVAL_MS) / 60_000)) * 10) / 10 : 0);

  return {
    coordinator: {
      peerId: identity.peerId,
      url: CC.COORDINATOR_PUBLIC_URL,
      region: CC.INFRA_HOST_REGION || process.env.FLY_REGION || null,
      uptimeSeconds: Math.floor(process.uptime()),
      generatedAtMs: nowMs,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      samplesKept: networkSamples.size
    },
    totals: {
      agentsKnown: agents.length,
      agentsConnected: g.connectedAgents,
      agentsBusy: g.busyAgents,
      agentsStale: staleAgents.length,
      agentsBlacklisted: agents.filter((a) => a.blacklisted).length,
      totalSlots: g.totalSlots,
      freeSlots: g.freeSlots,
      startedPerMin: perMin("started"),
      completedPerMin: perMin("completed")
    },
    agents,
    queue: {
      queued: g.queued,
      claimed: g.claimed,
      unclaimed: Math.max(0, g.queued - g.claimed),
      waitingInference: g.waitingInference,
      waitingByModel: [...waitingByModel.entries()].map(([model, waiting]) => ({ model, waiting })).sort((a, b) => b.waiting - a.waiting)
    },
    dispatch: { pickup: { count: pickup.count, p50: pickup.p50, p90: pickup.p90 }, nudges: pickup.nudges },
    latency: {
      windowMs: LATENCY_WINDOW_MS,
      pickup: { count: pickup.count, p50: pickup.p50, p90: pickup.p90 },
      ttft: inferenceTracker.ttft.percentiles(nowMs - LATENCY_WINDOW_MS),
      duration: inferenceTracker.duration.percentiles(nowMs - LATENCY_WINDOW_MS)
    },
    models,
    gaps: { windowMs: GAP_WINDOW_MS, missingModels, saturatedModels, staleAgents },
    // Best-fit routing (model "auto"): recent decisions, estimate against what happened.
    routing: { decisions: recentDecisions(50), config: bestFitConfig, complexityWeights },
    series: { range, bucketMs: seriesBucketMs(range), points: series }
  };
}

export type NetworkSnapshot = Awaited<ReturnType<typeof networkSnapshot>>;

/** Read what /inference/submit and /inference/chunks answered; never changes the answer. */
export function observeInference(url: string | undefined, status: number, body: unknown, payload: unknown, nowMs = Date.now()): void {
  if (url !== "/inference/submit" && url !== "/inference/chunks") return;
  const b = (body ?? {}) as { model?: unknown; subtaskId?: unknown; done?: unknown; error?: unknown };
  const text = typeof payload === "string" ? payload : Buffer.isBuffer(payload) ? payload.toString("utf8") : "";
  if (url === "/inference/submit") {
    const model = typeof b.model === "string" ? b.model : "";
    if (status === 409 && text.includes('"no_agent_has_model"')) {
      inferenceTracker.refusedNoModel(model, nowMs);
      return;
    }
    if (status !== 200 || !text) return;
    const r = JSON.parse(text) as { taskId?: unknown; subtaskId?: unknown; model?: unknown };
    // model "auto" was resolved: count the model that runs.
    if (typeof r.taskId === "string" && typeof r.subtaskId === "string") inferenceTracker.submitted(r.taskId, r.subtaskId, typeof r.model === "string" ? r.model : model, nowMs);
    return;
  }
  if (status !== 200 || !text.includes('"ok"') || typeof b.subtaskId !== "string") return;
  const error = typeof b.error === "string" && b.error ? b.error : undefined;
  inferenceTracker.chunk(b.subtaskId, b.done === true, error, nowMs);
  noteRoutedChunk(b.subtaskId, queue.getClaim(b.subtaskId)?.claimedBy, b.done === true, error, nowMs);
}

const querySchema = z.object({ range: z.enum(["1h", "6h", "24h"]).default("1h") });

export function registerAdminNetworkRoutes(app: CoordinatorApp): void {
  app.addHook("onSend", async (req, reply, payload) => {
    try {
      observeInference(req.routeOptions?.url, reply.statusCode, req.body, payload);
    } catch {
      // Observation must never affect the answer.
    }
    return payload;
  });

  const timer = setInterval(() => {
    try {
      takeNetworkSample();
    } catch (err) {
      app.log.warn({ err }, "network_sample_failed");
    }
  }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
  app.addHook("onClose", async () => clearInterval(timer));

  // Its own plugin with the admin gate, like routes/admin.ts (coordinator.ts lets /admin/* past the mesh check).
  app.register(async (admin) => {
    admin.addHook("onRequest", async (req, reply) => {
      if (!authorizeAdmin(req, reply)) return reply;
    });
    admin.get("/admin/network", async (req, reply) => {
      if (!authorizeAdmin(req, reply)) return;
      const parsed = querySchema.safeParse(req.query ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_range", allowed: Object.keys(SERIES_RANGES) });
      reply.header("cache-control", "no-store");
      return networkSnapshot(parsed.data.range);
    });
  });
}
