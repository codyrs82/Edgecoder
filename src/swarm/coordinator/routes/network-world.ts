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
import { identity, coordinatorKeys, mesh, CC, queue, requestOrigin, registryTrust, MESH_PEER_ALLOWLIST } from "../context.js";
import { networkTag } from "../../lan-proximity.js";
import { agentCapabilities, activeBlacklistRecord, AGENT_CONNECTED_WINDOW_MS } from "../agent-state.js";
import { agentAccount, agentSignatureAtGate, hasMeshToken, isPortalCaller } from "../auth.js";
import { peerRequestHeaders, requirePeerCredential } from "../peer-auth.js";
import { agentLoadReport } from "../dispatch.js";
import { agentSocketLost } from "../agent-liveness.js";
import { effectiveHardware } from "../economy.js";
import { isApprovedCoordinator } from "../peers.js";
import { parsePeerUrlPins } from "../../../mesh/peer-trust.js";
import { routableModels } from "../../model-catalog.js";
import { meshRtt } from "./mesh.js";
import { RttTracker } from "../../agent-rtt.js";
import { coordinatorPlace, startCoordinatorRegionLookup } from "../coordinator-region.js";
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
  type CoordinatorPlace,
  toPublicWorld,
  withRegistryStatus,
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
/**
 * Routing uses a peer's last good view up to this old while a fresh one is being fetched or the
 * fetch failed (run 4: a slow or failed fetch left a coordinator routing without its peers for a
 * whole cache period, so Auto saw its own CPU hosts full and sent simple calls to the cloud while the
 * peer's hosts were idle).
 */
export const WORLD_PEER_ROUTING_STALE_MS = 60_000;
export const WORLD_RATE_PER_MIN = 30;
export const WORLD_PEER_PROBE_TIMEOUT_MS = 5_000;

const maskKey = worldMaskKey(coordinatorKeys.privateKeyPem);

/** Pinned peers from MESH_PEER_ALLOWLIST (`peerId:fp@url`): operator configuration, so they are listed even before they register. */
const ALLOWLIST_PINS = (() => {
  try {
    return parsePeerUrlPins(CC.MESH_PEER_ALLOWLIST);
  } catch {
    return new Map<string, string>();
  }
})();

/** Allowlist pins, plus the registry's trusted members at their verified URL (the allowlist wins). */
function worldPins(): Map<string, string> {
  return new Map([...registryTrust.urlPins(), ...ALLOWLIST_PINS]);
}

/**
 * Coordinators this one is meshed with: the peer table (approved, not itself, not an agent, not
 * suspended in the registry unless allowlisted) plus the pinned allowlist entries and trusted
 * registry members, one per URL. A pinned URL wins over an announced one.
 */
export function peerCoordinators(pins: ReadonlyMap<string, string> = worldPins()): Array<{ peerId: string; url: string }> {
  const candidates = new Map<string, string>();
  for (const p of mesh.listPeers()) {
    if (agentCapabilities.has(p.peerId) || !isApprovedCoordinator(p.peerId)) continue;
    if (registryTrust.listing(p.peerId) === "suspended" && !MESH_PEER_ALLOWLIST.has(p.peerId)) continue;
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

/**
 * Round trip to a peer coordinator: its mesh socket's pings, else the timed /identity probe
 * (probePeers: every peer, including one admitted by its signature alone, which holds no mesh
 * socket here and whose view may never be asked for), else the last timed view fetch.
 */
const peerFetchMs = new Map<string, { ms: number; atMs: number }>();
export const peerProbeRtt = new RttTracker(1_000);
function linkRtt(peerId: string, nowMs: number): number | null {
  const ws = meshRtt.rttMs(peerId, nowMs);
  if (ws !== null) return Math.round(ws);
  const probed = peerProbeRtt.rttMs(peerId, nowMs);
  if (probed !== null) return Math.round(probed);
  const f = peerFetchMs.get(peerId);
  return f && nowMs - f.atMs < 5 * 60_000 ? f.ms : null;
}

/** Where each peer says it is (its GET /identity), for the world view when its own view is missing. */
const peerPlace = new Map<string, CoordinatorPlace>();

export type PeerProbeFetch = (url: string, timeoutMs: number) => Promise<{ status: number; json: unknown }>;
const undiciProbeFetch: PeerProbeFetch = async (url, timeoutMs) => {
  const res = await request(url, { method: "GET", headers: { accept: "application/json" }, headersTimeout: timeoutMs, bodyTimeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.body.text();
  if (text.length > 64 * 1024) return { status: 502, json: null };
  return { status: res.statusCode, json: text ? JSON.parse(text) : null };
};
let probeFetch: PeerProbeFetch = undiciProbeFetch;
/** Tests: replace how peers' /identity is fetched (null: the real one). Clears what was probed. */
export function setPeerProbeFetch(f: PeerProbeFetch | null): void {
  probeFetch = f ?? undiciProbeFetch;
  peerPlace.clear();
  peerProbeRtt.clear();
}

/**
 * Time one peer's public GET /identity, twice: the first may open the connection (TCP and TLS),
 * the second runs on the warm one, so its time is the network round trip. The answer must name
 * the peer id the mesh knows at that URL; its region (and country) is kept for the world view.
 */
export async function probePeer(peer: { peerId: string; url: string }, now: () => number = () => performance.now()): Promise<number | null> {
  const url = `${peer.url}/identity`;
  try {
    await probeFetch(url, WORLD_PEER_PROBE_TIMEOUT_MS);
    const started = now();
    const r = await probeFetch(url, WORLD_PEER_PROBE_TIMEOUT_MS);
    const ms = Math.max(0, now() - started);
    const j = (r.json ?? {}) as Record<string, unknown>;
    if (r.status !== 200 || j.peerId !== peer.peerId) return null;
    peerProbeRtt.record(peer.peerId, ms, Date.now());
    const place = regionInfo(typeof j.region === "string" ? j.region.toLowerCase() : null, typeof j.country === "string" ? j.country : null);
    if (place.region || place.country) peerPlace.set(peer.peerId, place);
    return Math.round(ms);
  } catch {
    return null;
  }
}

/** Probe every peer coordinator once (in parallel). */
export async function probePeers(): Promise<void> {
  await Promise.all(peerCoordinators().map((p) => probePeer(p)));
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
      // #524: a closed socket with nothing heard since is stale at once (peers and the portal stop counting it).
      connected: nowMs - cap.lastSeenMs < AGENT_CONNECTED_WINDOW_MS && !agentSocketLost(agentId, nowMs),
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
  return {
    coordinator: {
      id: identity.peerId,
      url: CC.COORDINATOR_PUBLIC_URL,
      ...coordinatorPlace(),
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
  peerLastGood.clear();
}

const peerCache = new Map<string, { atMs: number; value: Promise<LocalWorld | null>; settled?: { world: LocalWorld | null } }>();
/** Each peer's last good view and when it was fetched (routing's fallback). */
const peerLastGood = new Map<string, { atMs: number; world: LocalWorld }>();

function fetchPeerWorld(peer: { peerId: string; url: string }, nowMs: number): Promise<LocalWorld | null> {
  const hit = peerCache.get(peer.peerId);
  if (hit && nowMs - hit.atMs < WORLD_PEER_CACHE_MS) return hit.value;
  const value = (async () => {
    const started = performance.now();
    try {
      const url = `${peer.url}/network/world/local`;
      const r = await peerFetch(url, peerRequestHeaders("GET", url), WORLD_PEER_TIMEOUT_MS);
      if (r.status !== 200) return null;
      peerFetchMs.set(peer.peerId, { ms: Math.round(performance.now() - started), atMs: Date.now() });
      const world = parseLocalWorld(r.json);
      // The answer must be the coordinator the mesh knows at that URL.
      return world && world.coordinator.id === peer.peerId ? world : null;
    } catch {
      return null;
    }
  })();
  const entry: { atMs: number; value: Promise<LocalWorld | null>; settled?: { world: LocalWorld | null } } = { atMs: nowMs, value };
  void value.then((world) => {
    entry.settled = { world };
    if (world) peerLastGood.set(peer.peerId, { atMs: nowMs, world });
  });
  peerCache.set(peer.peerId, entry);
  for (const id of peerCache.keys()) if (!peerCoordinators().some((p) => p.peerId === id)) peerCache.delete(id);
  for (const id of peerLastGood.keys()) if (!peerCoordinators().some((p) => p.peerId === id)) peerLastGood.delete(id);
  return value;
}

/**
 * A peer's view for routing: the cached one when it is in; else (being fetched, or the fetch failed)
 * its last good view up to WORLD_PEER_ROUTING_STALE_MS old, at once; else the fetch.
 */
function peerWorldForRouting(peer: { peerId: string; url: string }, nowMs: number): Promise<LocalWorld | null> | LocalWorld | null {
  const value = fetchPeerWorld(peer, nowMs);
  const settled = peerCache.get(peer.peerId)?.settled;
  if (settled?.world) return settled.world;
  const last = peerLastGood.get(peer.peerId);
  if (last && nowMs - last.atMs <= WORLD_PEER_ROUTING_STALE_MS) return last.world;
  return value;
}

/**
 * The public world view for one caller (null account: nothing is marked as theirs). A peer whose
 * fetch failed this time but answered within WORLD_PEER_ROUTING_STALE_MS keeps its last view (one
 * slow answer does not grey it out); otherwise it is listed unreachable, with the region it gave
 * at /identity or in its last good view.
 */
export async function worldView(callerAccountId: string | null, nowMs = Date.now(), lanFor?: { callerNetTag: string | null }): Promise<PublicWorld> {
  const peers = peerCoordinators();
  const [self, ...views] = await Promise.all([cachedLocalWorld(nowMs), ...peers.map((p) => fetchPeerWorld(p, nowMs))]);
  const world = toPublicWorld(
    self,
    peers.map((p, i) => {
      const last = peerLastGood.get(p.peerId);
      const world = views[i] ?? (last && nowMs - last.atMs <= WORLD_PEER_ROUTING_STALE_MS ? last.world : null);
      const c = last?.world.coordinator;
      const place = peerPlace.get(p.peerId) ?? (c && (c.region || c.country) ? { region: c.region, country: c.country, continent: c.continent } : null);
      return { url: p.url, id: p.peerId, world, rttMs: linkRtt(p.peerId, nowMs), place };
    }),
    callerAccountId,
    nowMs,
    lanFor
  );
  // The Network page labels each coordinator: platform, probation, active or suspended.
  return withRegistryStatus(world, (id) => registryTrust.listing(id));
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
  const views = await Promise.all(peers.map((p) => peerWorldForRouting(p, nowMs)));
  const out: Array<{ world: LocalWorld; linkRttMs: number | null }> = [];
  views.forEach((world, i) => {
    if (world) out.push({ world, linkRttMs: linkRtt(peers[i].peerId, nowMs) });
  });
  return out;
}

export function registerNetworkWorldRoutes(app: CoordinatorApp): void {
  setPeerWorldSource(peerWorldsForRouting, (agentId) => meshRtt.rttMs(agentId, Date.now()));
  queue.onClaimed((agentId) => agentCalls.record(agentId));
  // Background work only in a running coordinator (never under the test runner): the region lookup
  // when none is configured, and the peer probes.
  app.addHook("onReady", async () => {
    if (process.env.VITEST) return;
    startCoordinatorRegionLookup({ enabled: CC.COORDINATOR_REGION_LOOKUP, log: app.log });
    if (CC.WORLD_PEER_PROBE_MS > 0) {
      const first = setTimeout(() => void probePeers(), 5_000);
      first.unref?.();
      const timer = setInterval(() => void probePeers(), CC.WORLD_PEER_PROBE_MS);
      timer.unref?.();
    }
  });

  app.get("/network/world/local", async (req, reply) => {
    if (!requirePeerCredential(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    reply.header("cache-control", "no-store");
    return cachedLocalWorld(Date.now());
  });

  app.get("/network/world", async (req, reply) => {
    const headers = ((req as any).headers ?? {}) as Record<string, unknown>;
    let account: string | null;
    let callerKey: string;
    // LAN facts about the caller's own machines go only to a signed agent (the desktop app).
    let lanFor: { callerNetTag: string | null } | undefined;
    if (isPortalCaller(headers)) {
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
