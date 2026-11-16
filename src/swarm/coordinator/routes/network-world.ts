// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The world view of the network, anonymized (src/swarm/network-world.ts):
 *
 *   GET /network/world        every coordinator and every agent on it, other people's machines
 *                             masked, the caller's own marked `mine`. For a signed agent (the
 *                             desktop app through its agent's forwarder: GET /forward/network/world)
 *                             or the portal (service token + ?accountId=, which the portal binds
 *                             from the session). Not public: the global gate admits a signed agent
 *                             on this path only (auth.ts AGENT_GET_PATTERNS).
 *   GET /network/world/local  this coordinator's own agents, for peer coordinators (mesh token).
 *
 * The coordinator asked merges its peers' local views (fetched with the mesh token, cached
 * WORLD_PEER_CACHE_MS) rather than the app asking every coordinator: an agent's signature is known
 * only to the coordinator it registered with, and the coordinators already trust each other.
 *
 * Activity (the graph's pulses): each machine's calls now, streaming and taken in the last minute
 * (world-activity.ts counts claims), each mesh link's work and gossip in the last minute, and the
 * model calls queued or running here tagged by requester, which only the merge sees: the public
 * answer carries the caller's own (`yourRequests`) and no one else's.
 *
 * Bounded and rate-limited: at most WORLD_MAX_AGENTS agents and WORLD_MAX_COORDINATORS
 * coordinators per answer, WORLD_RATE_PER_MIN answers per caller per minute.
 */
import { request } from "undici";
import { z } from "zod";
import type { CoordinatorApp } from "../app.js";
import { identity, coordinatorKeys, mesh, MESH_AUTH_TOKEN, CC, queue, requestOrigin } from "../context.js";
import { networkTag } from "../../lan-proximity.js";
import { agentCapabilities, activeBlacklistRecord, AGENT_CONNECTED_WINDOW_MS } from "../agent-state.js";
import { agentAccount, agentSignatureAtGate, hasMeshToken, hasPortalServiceToken, requireMeshToken } from "../auth.js";
import { agentLoadReport } from "../dispatch.js";
import { effectiveHardware } from "../economy.js";
import { isApprovedCoordinator } from "../peers.js";
import { parsePeerUrlPins } from "../../../mesh/peer-trust.js";
import { routableModels } from "../../model-catalog.js";
import { meshRtt } from "./mesh.js";
import { accountsFor } from "./admin-network.js";
import { agentPerf, setPeerWorldSource } from "../routing.js";
import { inferenceStreams } from "./inference.js";
import { agentCalls, meshGossip, meshWork } from "../world-activity.js";
import {
  WORLD_AGENT_TTL_MS,
  WORLD_MAX_COORDINATORS,
  WORLD_MAX_LOCAL_REQUESTS,
  localWorldAgent,
  maskedId,
  parseLocalWorld,
  worldOwnerTag,
  regionInfo,
  toPublicWorld,
  worldMaskKey,
  type LocalWorld,
  type LocalWorldRequest,
  type PublicWorld
} from "../../network-world.js";

/** This coordinator's own view is rebuilt at most this often. */
export const WORLD_LOCAL_CACHE_MS = 5_000;
/** A peer coordinator's view is fetched at most this often. */
export const WORLD_PEER_CACHE_MS = 15_000;
export const WORLD_PEER_TIMEOUT_MS = 3_000;
export const WORLD_RATE_PER_MIN = 30;

const maskKey = worldMaskKey(coordinatorKeys.privateKeyPem);

function coordinatorRegion(): string | null {
  return CC.INFRA_HOST_REGION || process.env.COORDINATOR_REGION || process.env.FLY_REGION || null;
}

/** Pinned peers from MESH_PEER_ALLOWLIST (`peerId:fp@url`): operator configuration, so they are listed even before they register. */
const ALLOWLIST_PINS = (() => {
  try {
    return parsePeerUrlPins(CC.MESH_PEER_ALLOWLIST);
  } catch {
    return new Map<string, string>();
  }
})();

/**
 * Coordinators this one is meshed with: the peer table (approved, not itself, not an agent) plus the
 * pinned allowlist entries, one per URL. A pinned URL wins over an announced one.
 */
export function peerCoordinators(pins: ReadonlyMap<string, string> = ALLOWLIST_PINS): Array<{ peerId: string; url: string }> {
  const candidates = new Map<string, string>();
  for (const p of mesh.listPeers()) {
    if (agentCapabilities.has(p.peerId) || !isApprovedCoordinator(p.peerId)) continue;
    candidates.set(p.peerId, p.coordinatorUrl);
  }
  for (const [peerId, url] of pins) candidates.set(peerId, url);
  const seen = new Set<string>();
  const out: Array<{ peerId: string; url: string }> = [];
  for (const [peerId, raw] of candidates) {
    if (peerId === identity.peerId) continue;
    let url: string;
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      url = u.origin;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ peerId, url });
    if (out.length >= WORLD_MAX_COORDINATORS - 1) break;
  }
  return out;
}

/** Round trip to a peer coordinator: its mesh socket's pings, else the last timed view fetch. */
const peerFetchMs = new Map<string, { ms: number; atMs: number }>();
function linkRtt(peerId: string, nowMs: number): number | null {
  const ws = meshRtt.rttMs(peerId, nowMs);
  if (ws !== null) return ws;
  const f = peerFetchMs.get(peerId);
  return f && nowMs - f.atMs < 5 * 60_000 ? f.ms : null;
}

let localCache: { atMs: number; value: Promise<LocalWorld> } | null = null;

/** This coordinator's agents as the world view sees them (internal fields included). */
export async function buildLocalWorld(nowMs = Date.now()): Promise<LocalWorld> {
  const claims = queue.activeClaims();
  const entries = [...agentCapabilities.entries()].filter(([id, cap]) => !activeBlacklistRecord(id) && nowMs - cap.lastSeenMs <= WORLD_AGENT_TTL_MS);
  const owners = await accountsFor(entries.map(([id]) => id), nowMs);
  // Model calls queued or running here: who asked (as a tag) and on which machine, and how many each
  // machine is streaming a reply for now.
  const streamingBy = new Map<string, number>();
  const requests: LocalWorldRequest[] = [];
  for (const c of queue.inferenceCalls()) {
    const streaming = c.claimedBy !== null && inferenceStreams.hasContent(c.subtaskId) && !inferenceStreams.isDone(c.subtaskId);
    if (streaming) streamingBy.set(c.claimedBy!, (streamingBy.get(c.claimedBy!) ?? 0) + 1);
    const account = c.projectId.startsWith("inference:") ? c.projectId.slice("inference:".length) : "";
    if (!account || requests.length >= WORLD_MAX_LOCAL_REQUESTS) continue;
    requests.push({
      tag: worldOwnerTag(account),
      machine: c.claimedBy ? maskedId(maskKey, c.claimedBy) : null,
      state: c.claimedBy === null ? "queued" : streaming ? "streaming" : "starting"
    });
  }
  const agents = entries.map(([agentId, cap]) => {
    const hw = effectiveHardware(agentId, cap);
    const agent = localWorldAgent(maskKey, identity.peerId, {
      agentId,
      ownerAccountId: owners.get(agentId) ?? null,
      os: cap.os,
      clientType: cap.clientType,
      region: cap.region ?? null,
      countryCode: cap.countryCode ?? null,
      computeClass: hw?.computeClass ?? cap.computeClass,
      tier: hw?.tier ?? null,
      vramGb: cap.hardwareClass?.vramGb ?? null,
      models: routableModels(cap),
      activeModel: cap.activeModel ?? null,
      connected: nowMs - cap.lastSeenMs < AGENT_CONNECTED_WINDOW_MS,
      claims: claims.get(agentId)?.all ?? 0,
      slots: agentLoadReport(agentId)?.slots ?? cap.maxConcurrentTasks ?? 1,
      lastSeenMs: cap.lastSeenMs,
      rttMs: meshRtt.rttMs(agentId, nowMs),
      sourceIp: cap.sourceIp ?? null,
      lanAddresses: cap.lanAddresses ?? null,
      streaming: streamingBy.get(agentId) ?? 0,
      callsPerMin: agentCalls.count(agentId, nowMs)
    });
    // For peers' best-fit routing (stripped from every public answer).
    return { ...agent, perf: agentPerf(agentId, claims) };
  });
  const region = regionInfo(coordinatorRegion(), null);
  return {
    coordinator: {
      id: identity.peerId,
      url: CC.COORDINATOR_PUBLIC_URL,
      ...region,
      agents: agents.length,
      agentsOnline: agents.filter((a) => a.status !== "stale").length
    },
    links: peerCoordinators().map((p) => ({
      from: identity.peerId,
      to: p.peerId,
      rttMs: linkRtt(p.peerId, nowMs),
      workPerMin: meshWork.count(p.peerId, nowMs),
      gossipPerMin: meshGossip.count(p.peerId, nowMs)
    })),
    agents,
    requests,
    generatedAtMs: nowMs
  };
}

/** Tests: rebuild this coordinator's view on the next ask. */
export function clearWorldLocalCache(): void {
  localCache = null;
}

function cachedLocalWorld(nowMs: number): Promise<LocalWorld> {
  if (localCache && nowMs - localCache.atMs < WORLD_LOCAL_CACHE_MS) return localCache.value;
  const value = buildLocalWorld(nowMs);
  localCache = { atMs: nowMs, value };
  value.catch(() => {
    if (localCache?.value === value) localCache = null;
  });
  return value;
}

export type PeerFetch = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<{ status: number; json: unknown }>;

const undiciFetch: PeerFetch = async (url, headers, timeoutMs) => {
  const res = await request(url, { method: "GET", headers, headersTimeout: timeoutMs, bodyTimeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.body.text();
  // A peer's view is bounded by its own limits; refuse anything far past them.
  if (text.length > 4 * 1024 * 1024) return { status: 502, json: null };
  return { status: res.statusCode, json: text ? JSON.parse(text) : null };
};
let peerFetch: PeerFetch = undiciFetch;
/** Tests: replace how peer views are fetched. */
export function setWorldPeerFetch(f: PeerFetch | null): void {
  peerFetch = f ?? undiciFetch;
  peerCache.clear();
}

const peerCache = new Map<string, { atMs: number; value: Promise<LocalWorld | null> }>();

function fetchPeerWorld(peer: { peerId: string; url: string }, nowMs: number): Promise<LocalWorld | null> {
  const hit = peerCache.get(peer.peerId);
  if (hit && nowMs - hit.atMs < WORLD_PEER_CACHE_MS) return hit.value;
  const value = (async () => {
    const started = performance.now();
    try {
      const r = await peerFetch(`${peer.url}/network/world/local`, MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : {}, WORLD_PEER_TIMEOUT_MS);
      if (r.status !== 200) return null;
      peerFetchMs.set(peer.peerId, { ms: Math.round(performance.now() - started), atMs: Date.now() });
      const world = parseLocalWorld(r.json);
      // The answer must be the coordinator the mesh knows at that URL.
      return world && world.coordinator.id === peer.peerId ? world : null;
    } catch {
      return null;
    }
  })();
  peerCache.set(peer.peerId, { atMs: nowMs, value });
  for (const id of peerCache.keys()) if (!peerCoordinators().some((p) => p.peerId === id)) peerCache.delete(id);
  return value;
}

/** The public world view for one caller (null account: nothing is marked as theirs). */
export async function worldView(callerAccountId: string | null, nowMs = Date.now(), lanFor?: { callerNetTag: string | null }): Promise<PublicWorld> {
  const peers = peerCoordinators();
  const [self, ...views] = await Promise.all([cachedLocalWorld(nowMs), ...peers.map((p) => fetchPeerWorld(p, nowMs))]);
  return toPublicWorld(
    self,
    peers.map((p, i) => ({ url: p.url, id: p.peerId, world: views[i], rttMs: linkRtt(p.peerId, nowMs) })),
    callerAccountId,
    nowMs,
    lanFor
  );
}

/** Fixed one-minute window per caller; the map is bounded. */
export class WorldRateLimiter {
  private readonly windows = new Map<string, { startMs: number; count: number }>();
  constructor(private readonly perMinute = WORLD_RATE_PER_MIN, private readonly maxKeys = 5_000) {}
  /** Seconds to wait, or 0 when the request may go ahead. */
  take(key: string, nowMs: number): number {
    const w = this.windows.get(key);
    if (!w || nowMs - w.startMs >= 60_000) {
      this.windows.delete(key);
      this.windows.set(key, { startMs: nowMs, count: 1 });
      while (this.windows.size > this.maxKeys) this.windows.delete(this.windows.keys().next().value as string);
      return 0;
    }
    if (w.count >= this.perMinute) return Math.max(1, Math.ceil((w.startMs + 60_000 - nowMs) / 1000));
    w.count++;
    return 0;
  }
}

export const worldRateLimiter = new WorldRateLimiter();

const portalQuery = z.object({ accountId: z.string().min(1).max(128).optional() });

/** Peers' views for best-fit routing (cached like the world view's), with the link round trip. */
async function peerWorldsForRouting(nowMs: number): Promise<Array<{ world: LocalWorld; linkRttMs: number | null }>> {
  const peers = peerCoordinators();
  const views = await Promise.all(peers.map((p) => fetchPeerWorld(p, nowMs)));
  const out: Array<{ world: LocalWorld; linkRttMs: number | null }> = [];
  views.forEach((world, i) => {
    if (world) out.push({ world, linkRttMs: linkRtt(peers[i].peerId, nowMs) });
  });
  return out;
}

export function registerNetworkWorldRoutes(app: CoordinatorApp): void {
  setPeerWorldSource(peerWorldsForRouting, (agentId) => meshRtt.rttMs(agentId, Date.now()));
  queue.onClaimed((agentId) => agentCalls.record(agentId));

  app.get("/network/world/local", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    reply.header("cache-control", "no-store");
    return cachedLocalWorld(Date.now());
  });

  app.get("/network/world", async (req, reply) => {
    const headers = ((req as any).headers ?? {}) as Record<string, unknown>;
    let account: string | null;
    let callerKey: string;
    // LAN facts about the caller's own machines go only to a signed agent (the desktop app).
    let lanFor: { callerNetTag: string | null } | undefined;
    if (headers["x-portal-service-token"] !== undefined && hasPortalServiceToken(headers)) {
      const q = portalQuery.safeParse(req.query ?? {});
      if (!q.success) return reply.code(400).send({ error: "invalid_account" });
      account = q.data.accountId ?? null;
      callerKey = `portal:${account ?? ""}`;
    } else if (headers["x-agent-id"] !== undefined) {
      const signer = agentSignatureAtGate(headers, "GET", String(req.url ?? "").split("?")[0]);
      if (!signer) return reply.code(401).send({ error: "agent_signature_required" });
      account = await agentAccount(signer);
      callerKey = `agent:${signer}`;
      // The address this request came from; else the one the signer registered from.
      lanFor = { callerNetTag: networkTag(requestOrigin(req).clientIp) ?? networkTag(agentCapabilities.get(signer)?.sourceIp) };
    } else if (hasMeshToken(headers)) {
      account = null;
      callerKey = "mesh";
    } else {
      return reply.code(401).send({ error: "agent_signature_required" });
    }
    const wait = worldRateLimiter.take(callerKey, Date.now());
    if (wait > 0) return reply.code(429).header("retry-after", String(wait)).send({ error: "rate_limited", retryAfterSec: wait });
    reply.header("cache-control", "no-store");
    return worldView(account, Date.now(), account ? lanFor : undefined);
  });
}
