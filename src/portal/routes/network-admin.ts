// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { moduleLogger } from "../../common/logger.js";

const logger = moduleLogger("portal-network-admin");

/*
 * Settings > Network's API (GET /portal/api/admin/network), system admins only. The portal asks
 * every known coordinator for GET /admin/network with the coordinator admin token (server-side;
 * the token never reaches the browser), merges the answers into one view of the network, and joins
 * each agent to the account it is logged into and that account's email from the portal database
 * (agent node enrollment -> owner; account acct-<userId> -> portal user).
 */

export type SeriesRange = "1h" | "6h" | "24h" | "7d";
const RANGES: readonly SeriesRange[] = ["1h", "6h", "24h", "7d"];
/** A coordinator (or region) with fewer connected agents than this is shown as a gap. */
export const FEW_AGENTS = 2;

type Pct = { count: number; p50: number; p90: number };
type SlotCount = { free: number; total: number };
/** A series point: numbers, plus (#340) keyed maps of counts or of slots. */
type SampleValue = number | null | Record<string, number> | Record<string, SlotCount>;
type Sample = { atMs: number } & Record<string, SampleValue>;

/** What one coordinator's GET /admin/network returns (src/swarm/coordinator/routes/admin-network.ts), loosely. */
export interface CoordinatorSnapshot {
  coordinator: { peerId: string; url?: string; region?: string | null; uptimeSeconds?: number; generatedAtMs: number; samplesKept?: number };
  totals: { startedPerMin?: number; completedPerMin?: number; [k: string]: unknown };
  agents: Array<{
    agentId: string;
    accountId: string | null;
    ownerEmail?: string | null;
    countryCode?: string | null;
    /** Hosting region the agent reported (newer coordinators); null or absent: unknown. */
    region?: string | null;
    status: string;
    connected: boolean;
    blacklisted: boolean;
    slots: number;
    freeSlots: number;
    claims: number;
    lastSeenMs: number;
    modelsInstalled: string[];
    [k: string]: unknown;
  }>;
  queue: { queued: number; claimed: number; unclaimed: number; waitingInference: number; waitingByModel: Array<{ model: string; waiting: number }> };
  dispatch: { pickup: Pct; nudges: number };
  latency: { windowMs: number; pickup: Pct; ttft: Pct; duration: Pct };
  models: Array<{ model: string; agents: number; idleAgents: number; slots: number; freeSlots: number; waiting: number; callsWindow: number; completedWindow: number; failedWindow: number; calls24h: number; noAgentHasModel24h: number; noCapacity24h: number }>;
  gaps: { windowMs: number; missingModels: Array<{ model: string; noAgentHasModel: number; noCapacity: number }>; saturatedModels: unknown[]; staleAgents: unknown[]; memoryLimitedAgents?: unknown[] };
  series: { range: SeriesRange; bucketMs: number; points: Sample[] };
  /** Best-fit routing (model "auto"; newer coordinators): recent decisions, newest first. */
  routing?: { decisions?: Array<Record<string, unknown> & { atMs: number }>; config?: unknown };
}

/** Routing decisions across coordinators, newest first, each marked with the coordinator that made it. */
export function mergeRoutingDecisions(snapshots: Array<{ url: string; snapshot: CoordinatorSnapshot }>, limit = 60): Array<Record<string, unknown> & { atMs: number; coordinator: string }> {
  const all: Array<Record<string, unknown> & { atMs: number; coordinator: string }> = [];
  for (const r of snapshots) {
    for (const d of r.snapshot.routing?.decisions ?? []) {
      if (d && typeof d.atMs === "number") all.push({ ...d, coordinator: r.url.replace(/^https?:\/\//, "") });
    }
  }
  return all.sort((a, b) => b.atMs - a.atMs).slice(0, limit);
}

export type CoordinatorResult = { url: string; ok: true; snapshot: CoordinatorSnapshot } | { url: string; ok: false; error: string; status?: number };

/** Agent -> owner (portal node enrollment) and user -> email, from the portal database. */
export interface OwnerDirectory {
  nodeOwners: Map<string, { userId: string; email: string }>;
  userEmails: Map<string, string>;
}

const userIdOfAccount = (accountId: string | null | undefined) => (accountId && accountId.startsWith("acct-") ? accountId.slice(5) : undefined);

/** Combine percentiles from several sources: p50 weighted by count, p90 the worst. */
function combinePct(parts: Pct[]): Pct {
  const withData = parts.filter((p) => p && p.count > 0);
  const count = withData.reduce((a, p) => a + p.count, 0);
  if (!count) return { count: 0, p50: 0, p90: 0 };
  return { count, p50: Math.round(withData.reduce((a, p) => a + p.p50 * p.count, 0) / count), p90: Math.max(...withData.map((p) => p.p90)) };
}

const P50_KEYS = new Set(["pickupP50", "ttftP50"]);
const P90_KEYS = new Set(["pickupP90", "ttftP90"]);

const isSlot = (v: unknown): v is SlotCount => typeof v === "object" && v !== null && typeof (v as SlotCount).free === "number" && typeof (v as SlotCount).total === "number";
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Merge series by bucket start: counts and gauges add up, p50s average, p90s take the worst. Keyed
 * maps (#340: unmet requests by model, slots by model, agents by region) add up per key, and
 * saturatedModels is counted again from the merged slots (a model full on both coordinators is one
 * model). With `labels` (one per list), each point also gets agentsByCoordinator: that list's
 * connectedAgents under its label.
 */
export function mergeSeries(seriesList: Sample[][], labels?: string[]): Sample[] {
  type Acc = { sum: Record<string, number>; p50: Record<string, number[]>; p90: Record<string, number>; maps: Record<string, Record<string, number>>; slots: Record<string, Record<string, SlotCount>> };
  const byAt = new Map<number, Acc>();
  seriesList.forEach((points, i) => {
    for (const p of points) {
      const e = byAt.get(p.atMs) ?? { sum: {}, p50: {}, p90: {}, maps: {}, slots: {} };
      for (const [k, v] of Object.entries(p)) {
        if (k === "atMs" || v === null || v === undefined) continue;
        if (typeof v === "object") {
          for (const [key, x] of Object.entries(v)) {
            if (typeof x === "number") {
              const m = (e.maps[k] ??= {});
              m[key] = round1((m[key] ?? 0) + x);
            } else if (isSlot(x)) {
              const m = (e.slots[k] ??= {});
              const t = (m[key] ??= { free: 0, total: 0 });
              t.free = round1(t.free + x.free);
              t.total = round1(t.total + x.total);
            }
          }
          if (!Object.keys(v).length) e.maps[k] ??= {};
          continue;
        }
        if (typeof v !== "number") continue;
        if (P50_KEYS.has(k)) (e.p50[k] ??= []).push(v);
        else if (P90_KEYS.has(k)) e.p90[k] = Math.max(e.p90[k] ?? 0, v);
        else e.sum[k] = (e.sum[k] ?? 0) + v;
      }
      const label = labels?.[i];
      if (label !== undefined && typeof p.connectedAgents === "number") {
        const m = (e.maps.agentsByCoordinator ??= {});
        m[label] = (m[label] ?? 0) + p.connectedAgents;
      }
      byAt.set(p.atMs, e);
    }
  });
  return [...byAt.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([atMs, e]) => {
      const out: Sample = { atMs, ...e.sum };
      for (const k of P50_KEYS) out[k] = e.p50[k]?.length ? Math.round(e.p50[k]!.reduce((a, b) => a + b, 0) / e.p50[k]!.length) : null;
      for (const k of P90_KEYS) out[k] = e.p90[k] ?? null;
      for (const [k, m] of Object.entries(e.maps)) out[k] = m;
      for (const [k, m] of Object.entries(e.slots)) out[k] = m;
      const slots = e.slots.modelSlots;
      if (slots) out.saturatedModels = Object.entries(slots).filter(([m, v]) => m !== OTHER_KEY && v.total > 0 && v.free === 0).length;
      return out;
    });
}

/** An agent's memory report and circuit as the coordinator's /admin/network gives them (newer coordinators). */
type AgentMemory = { pressure?: string; loadedModels?: Array<{ name: string; bytes: number }> } | null | undefined;
const memoryOf = (a: Record<string, unknown>): AgentMemory => (a.memory && typeof a.memory === "object" ? (a.memory as AgentMemory) : undefined);
const circuitOf = (a: Record<string, unknown>): { open?: boolean } | undefined => (a.circuit && typeof a.circuit === "object" ? (a.circuit as { open?: boolean }) : undefined);
const isMemoryLimited = (a: Record<string, unknown>): boolean => a.memoryLimited === true || circuitOf(a)?.open === true;

/** The coordinators' name for "every other model" in a capped map (network-observer.ts OTHER_MODEL). */
const OTHER_KEY = "(other)";

/** One view of the network from every coordinator's snapshot, with agents joined to accounts. */
export function mergeNetworkSnapshots(results: CoordinatorResult[], owners: OwnerDirectory, range: SeriesRange, nowMs = Date.now()) {
  const ok = results.filter((r): r is Extract<CoordinatorResult, { ok: true }> => r.ok);
  // The same coordinator reached by two URLs counts once.
  const seenPeers = new Set<string>();
  const snapshots = ok.filter((r) => {
    if (seenPeers.has(r.snapshot.coordinator.peerId)) return false;
    seenPeers.add(r.snapshot.coordinator.peerId);
    return true;
  });
  const label = (r: { url: string; snapshot: CoordinatorSnapshot }) => r.url.replace(/^https?:\/\//, "");

  // Agents: an agent known to two coordinators is shown where it was seen last.
  type Agent = CoordinatorSnapshot["agents"][number] & { coordinator: string; coordinatorRegion: string | null; userId: string | null; email: string | null; emailSource: string | null };
  const agents = new Map<string, Agent>();
  for (const r of snapshots) {
    for (const a of r.snapshot.agents) {
      const prev = agents.get(a.agentId);
      if (prev && prev.lastSeenMs >= a.lastSeenMs) continue;
      const node = owners.nodeOwners.get(a.agentId);
      const accountUser = userIdOfAccount(a.accountId);
      const userId = node?.userId ?? accountUser ?? null;
      const email = node?.email ?? (accountUser ? owners.userEmails.get(accountUser) : undefined) ?? a.ownerEmail ?? null;
      const emailSource = node ? "enrollment" : accountUser && owners.userEmails.has(accountUser) ? "account" : a.ownerEmail ? "coordinator" : null;
      agents.set(a.agentId, { ...a, coordinator: label(r), coordinatorRegion: r.snapshot.coordinator.region ?? null, userId, email, emailSource });
    }
  }
  const agentList = [...agents.values()].sort((a, b) => Number(b.connected) - Number(a.connected) || b.lastSeenMs - a.lastSeenMs);
  const live = agentList.filter((a) => a.connected && !a.blacklisted);

  // Models: summed across coordinators.
  const models = new Map<string, CoordinatorSnapshot["models"][number]>();
  for (const r of snapshots) {
    for (const m of r.snapshot.models) {
      const e = models.get(m.model);
      if (!e) {
        models.set(m.model, { ...m });
        continue;
      }
      for (const k of ["agents", "idleAgents", "slots", "freeSlots", "waiting", "callsWindow", "completedWindow", "failedWindow", "calls24h", "noAgentHasModel24h", "noCapacity24h"] as const) e[k] += m[k] ?? 0;
    }
  }
  const modelList = [...models.values()].sort((a, b) => b.agents - a.agents || b.calls24h - a.calls24h || a.model.localeCompare(b.model));

  // Gaps.
  const missing = new Map<string, { model: string; noAgentHasModel: number; noCapacity: number; holders: number }>();
  for (const r of snapshots) {
    for (const g of r.snapshot.gaps.missingModels) {
      const e = missing.get(g.model) ?? { model: g.model, noAgentHasModel: 0, noCapacity: 0, holders: models.get(g.model)?.agents ?? 0 };
      e.noAgentHasModel += g.noAgentHasModel;
      e.noCapacity += g.noCapacity;
      missing.set(g.model, e);
    }
  }
  const byCoordinator = snapshots.map((r) => ({ coordinator: label(r), region: r.snapshot.coordinator.region ?? null, connected: live.filter((a) => a.coordinator === label(r)).length }));
  // Regions: where the agent says it runs (AGENT_REGION / FLY_REGION), else its coordinator's region
  // (ord, cdg). Country codes stay in the agents table; they come from the portal's IP lookup and are
  // often missing, which is what showed as "Region unknown".
  const byRegion = new Map<string, { region: string; agents: number; reported: number }>();
  for (const a of live) {
    const region = a.region || a.coordinatorRegion || "unknown";
    const e = byRegion.get(region) ?? { region, agents: 0, reported: 0 };
    e.agents++;
    if (a.region) e.reported++;
    byRegion.set(region, e);
  }

  const sum = (f: (s: CoordinatorSnapshot) => number) => snapshots.reduce((acc, r) => acc + (f(r.snapshot) || 0), 0);
  const pickup = combinePct(snapshots.map((r) => r.snapshot.latency.pickup));
  const ttft = combinePct(snapshots.map((r) => r.snapshot.latency.ttft));
  const duration = combinePct(snapshots.map((r) => r.snapshot.latency.duration));
  const waitingByModel = new Map<string, number>();
  for (const r of snapshots) for (const w of r.snapshot.queue.waitingByModel) waitingByModel.set(w.model, (waitingByModel.get(w.model) ?? 0) + w.waiting);

  return {
    generatedAtMs: nowMs,
    range,
    coordinators: results.map((r) =>
      r.ok
        ? { url: r.url, ok: true as const, peerId: r.snapshot.coordinator.peerId, region: r.snapshot.coordinator.region ?? null, uptimeSeconds: r.snapshot.coordinator.uptimeSeconds ?? null, generatedAtMs: r.snapshot.coordinator.generatedAtMs, samplesKept: r.snapshot.coordinator.samplesKept ?? null, agents: r.snapshot.agents.length, latency: r.snapshot.latency, queue: { queued: r.snapshot.queue.queued, waitingInference: r.snapshot.queue.waitingInference } }
        : { url: r.url, ok: false as const, error: r.error, status: r.status ?? null }
    ),
    kpis: {
      agentsOnline: live.length,
      agentsBusy: live.filter((a) => a.claims > 0).length,
      totalSlots: live.reduce((a, x) => a + x.slots, 0),
      freeSlots: live.reduce((a, x) => a + x.freeSlots, 0),
      queued: sum((s) => s.queue.queued),
      claimed: sum((s) => s.queue.claimed),
      waitingInference: sum((s) => s.queue.waitingInference),
      pickupP90: pickup.p90,
      ttftP90: ttft.p90,
      callsPerMin: Math.round(sum((s) => Number(s.totals.startedPerMin ?? 0)) * 10) / 10,
      completedPerMin: Math.round(sum((s) => Number(s.totals.completedPerMin ?? 0)) * 10) / 10,
      nudges: sum((s) => s.dispatch.nudges),
      agentsMemoryLimited: live.filter(isMemoryLimited).length
    },
    agents: agentList,
    queue: { waitingByModel: [...waitingByModel.entries()].map(([model, waiting]) => ({ model, waiting })).sort((a, b) => b.waiting - a.waiting) },
    latency: { pickup, ttft, duration, windowMs: snapshots[0]?.snapshot.latency.windowMs ?? null },
    models: modelList,
    gaps: {
      windowMs: snapshots[0]?.snapshot.gaps.windowMs ?? null,
      missingModels: [...missing.values()].sort((a, b) => b.noAgentHasModel + b.noCapacity - (a.noAgentHasModel + a.noCapacity)),
      saturatedModels: modelList.filter((m) => m.agents > 0 && m.freeSlots === 0).map((m) => ({ model: m.model, agents: m.agents, slots: m.slots, waiting: m.waiting })),
      staleAgents: agentList.filter((a) => a.status === "stale").map((a) => ({ agentId: a.agentId, email: a.email, coordinator: a.coordinator, lastSeenMs: a.lastSeenMs })),
      // Live agents with no capacity for memory (pressure, paused) or an open circuit (coordinator memory-admission.ts).
      memoryLimitedAgents: live.filter(isMemoryLimited).map((a) => ({ agentId: a.agentId, email: a.email, coordinator: a.coordinator, pressure: memoryOf(a)?.pressure ?? null, circuitOpen: circuitOf(a)?.open === true, loadedModels: (memoryOf(a)?.loadedModels ?? []).map((m) => m.name) })),
      thinCoordinators: byCoordinator.filter((c) => c.connected < FEW_AGENTS),
      coordinators: byCoordinator,
      unreachableCoordinators: results.filter((r) => !r.ok).map((r) => r.url),
      regions: [...byRegion.values()].sort((a, b) => b.agents - a.agents || a.region.localeCompare(b.region))
    },
    series: { range, bucketMs: snapshots[0]?.snapshot.series.bucketMs ?? null, points: mergeSeries(snapshots.map((r) => r.snapshot.series.points ?? []), snapshots.map((r) => coordinatorKey(label(r), r.snapshot.coordinator.region))) },
    routing: { decisions: mergeRoutingDecisions(snapshots), config: snapshots.find((r) => r.snapshot.routing?.config)?.snapshot.routing?.config ?? null }
  };
}

/** A coordinator's key in agentsByCoordinator: its host's first label, with its region ("coordinator · ord"). */
function coordinatorKey(label: string, region: string | null | undefined): string {
  const host = /^[0-9[]/.test(label) ? label : (label.split(".")[0] ?? label);
  return region ? `${host} · ${region}` : host;
}

export type MergedNetwork = ReturnType<typeof mergeNetworkSnapshots>;

export interface NetworkAdminRoutesDeps {
  /** The coordinators' ADMIN_API_TOKEN (portal COORDINATOR_ADMIN_TOKEN); unset = 503. */
  coordinatorAdminToken: string;
  EXTERNAL_HTTP_TIMEOUT_MS: number;
  /** Every coordinator to ask (configured discovery list and control plane, URL policy applied). */
  coordinatorUrls: () => Promise<string[]>;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean } | null>;
  buildAccessContext: (user: { userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean }) => Promise<{ isSystemAdmin: boolean }>;
  /** Owners of these agents (node enrollments) and emails of these users, from the portal database. */
  lookupOwners: (agentIds: string[], userIds: string[]) => Promise<OwnerDirectory>;
}

export async function fetchSnapshot(url: string, range: SeriesRange, token: string, timeoutMs: number): Promise<CoordinatorResult> {
  const base = url.replace(/\/+$/, "");
  try {
    const res = await request(`${base}/admin/network?range=${range}`, {
      method: "GET",
      headers: { "x-admin-token": token },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.statusCode !== 200) {
      await res.body.dump().catch(() => undefined);
      return { url: base, ok: false, error: res.statusCode === 401 ? "admin_token_rejected" : res.statusCode === 404 ? "route_not_deployed" : "coordinator_error", status: res.statusCode };
    }
    const snapshot = (await res.body.json()) as CoordinatorSnapshot;
    if (!snapshot?.coordinator?.peerId || !Array.isArray(snapshot.agents)) return { url: base, ok: false, error: "unexpected_answer" };
    return { url: base, ok: true, snapshot };
  } catch (error) {
    logger.warn({ url: base, error: error instanceof Error ? error.message : String(error) }, "coordinator network snapshot failed");
    return { url: base, ok: false, error: "coordinator_unreachable" };
  }
}

/**
 * Every coordinator's snapshot, merged and joined to owners (the page's view; production alerting's
 * capacity rules read it too, src/portal/alerts.ts). Null when no coordinator is configured.
 */
export async function loadMergedNetwork(
  deps: Pick<NetworkAdminRoutesDeps, "coordinatorUrls" | "coordinatorAdminToken" | "EXTERNAL_HTTP_TIMEOUT_MS" | "lookupOwners">,
  range: SeriesRange,
  onOwnerLookupError?: (error: string) => void
): Promise<MergedNetwork | null> {
  const urls = [...new Set((await deps.coordinatorUrls()).map((u) => u.replace(/\/+$/, "")))];
  if (!urls.length) return null;
  const results = await Promise.all(urls.map((u) => fetchSnapshot(u, range, deps.coordinatorAdminToken, deps.EXTERNAL_HTTP_TIMEOUT_MS)));
  const agentIds = new Set<string>();
  const userIds = new Set<string>();
  for (const r of results) {
    if (!r.ok) continue;
    for (const a of r.snapshot.agents) {
      agentIds.add(a.agentId);
      const u = userIdOfAccount(a.accountId);
      if (u) userIds.add(u);
    }
  }
  let owners: OwnerDirectory = { nodeOwners: new Map(), userEmails: new Map() };
  try {
    owners = await deps.lookupOwners([...agentIds], [...userIds]);
  } catch (error) {
    onOwnerLookupError?.(error instanceof Error ? error.message : String(error));
  }
  return mergeNetworkSnapshots(results, owners, range);
}

export function registerNetworkAdminRoutes(app: FastifyInstance, deps: NetworkAdminRoutesDeps): void {
  app.get("/portal/api/admin/network", async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    if (!(await deps.buildAccessContext(user)).isSystemAdmin) return reply.code(403).send({ error: "admin_only" });
    if (!deps.coordinatorAdminToken) return reply.code(503).send({ error: "coordinator_admin_token_not_configured", detail: "Set COORDINATOR_ADMIN_TOKEN on the portal (the coordinators' ADMIN_API_TOKEN)." });
    const q = (req.query ?? {}) as { range?: string };
    const range = (RANGES as readonly string[]).includes(q.range ?? "") ? (q.range as SeriesRange) : "1h";
    const merged = await loadMergedNetwork(deps, range, (error) => req.log.warn({ error }, "network_owner_lookup_failed"));
    if (!merged) return reply.code(503).send({ error: "no_coordinator" });
    reply.header("cache-control", "no-store");
    return reply.send(merged);
  });

  // Blacklisted agents across coordinators (an agent that is blacklisted can't register, so it is not
  // in /admin/network's agent list), with a Lift button on Settings > Network.
  app.get("/portal/api/admin/blacklist", async (req, reply) => {
    const gate = await adminGate(req, reply);
    if (!gate) return;
    const results = await Promise.all(gate.urls.map((u) => fetchBlacklist(u, deps.coordinatorAdminToken, deps.EXTERNAL_HTTP_TIMEOUT_MS)));
    let owners: OwnerDirectory = { nodeOwners: new Map(), userEmails: new Map() };
    const agentIds = [...new Set(results.flatMap((r) => (r.ok ? r.records.map((x) => x.agentId) : [])))];
    try {
      if (agentIds.length) owners = await deps.lookupOwners(agentIds, []);
    } catch (error) {
      req.log.warn({ error: error instanceof Error ? error.message : String(error) }, "blacklist_owner_lookup_failed");
    }
    reply.header("cache-control", "no-store");
    return reply.send(mergeBlacklists(results, owners));
  });

  app.post("/portal/api/admin/blacklist/:agentId/lift", async (req, reply) => {
    const gate = await adminGate(req, reply);
    if (!gate) return;
    const agentId = String((req.params as { agentId?: string }).agentId ?? "");
    if (!/^[A-Za-z0-9._:@-]{1,200}$/.test(agentId)) return reply.code(400).send({ error: "invalid_agent_id" });
    const reason = `lifted by ${gate.email} from the portal`;
    // Every coordinator that has it (they share the record by gossip; lifting on each is idempotent: 404 = not there).
    const results = await Promise.all(gate.urls.map((u) => liftOn(u, agentId, reason, deps.coordinatorAdminToken, deps.EXTERNAL_HTTP_TIMEOUT_MS)));
    const lifted = results.filter((r) => r.status === 200).length;
    req.log.info({ agentId, by: gate.email, lifted }, "admin_blacklist_lift");
    return reply.code(lifted > 0 ? 200 : results.every((r) => r.status === 404) ? 404 : 502).send({ ok: lifted > 0, agentId, lifted, coordinators: results });
  });

  async function adminGate(req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): Promise<{ email: string; urls: string[] } | null> {
    const user = await deps.getCurrentUser(req as never);
    if (!user) {
      reply.code(401).send({ error: "not_authenticated" });
      return null;
    }
    if (!(await deps.buildAccessContext(user)).isSystemAdmin) {
      reply.code(403).send({ error: "admin_only" });
      return null;
    }
    if (!deps.coordinatorAdminToken) {
      reply.code(503).send({ error: "coordinator_admin_token_not_configured", detail: "Set COORDINATOR_ADMIN_TOKEN on the portal (the coordinators' ADMIN_API_TOKEN)." });
      return null;
    }
    const urls = [...new Set((await deps.coordinatorUrls()).map((u) => u.replace(/\/+$/, "")))];
    if (!urls.length) {
      reply.code(503).send({ error: "no_coordinator" });
      return null;
    }
    return { email: user.email, urls };
  }
}

/** One record of a coordinator's GET /admin/security/blacklist (src/swarm/coordinator/routes/security.ts). */
export interface BlacklistRow {
  agentId: string;
  reasonCode: string;
  reason: string;
  reportedBy: string | null;
  automatic: boolean;
  timestampMs: number;
  expiresAtMs: number | null;
}
export type BlacklistResult = { url: string; ok: true; records: BlacklistRow[] } | { url: string; ok: false; error: string; status?: number };

async function fetchBlacklist(url: string, token: string, timeoutMs: number): Promise<BlacklistResult> {
  try {
    const res = await request(`${url}/admin/security/blacklist`, { method: "GET", headers: { "x-admin-token": token }, headersTimeout: timeoutMs, bodyTimeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
    if (res.statusCode !== 200) {
      await res.body.dump().catch(() => undefined);
      return { url, ok: false, error: res.statusCode === 401 ? "admin_token_rejected" : res.statusCode === 404 ? "route_not_deployed" : "coordinator_error", status: res.statusCode };
    }
    const body = (await res.body.json()) as { records?: BlacklistRow[] };
    return { url, ok: true, records: Array.isArray(body.records) ? body.records : [] };
  } catch (error) {
    logger.warn({ url, error: error instanceof Error ? error.message : String(error) }, "coordinator blacklist fetch failed");
    return { url, ok: false, error: "coordinator_unreachable" };
  }
}

async function liftOn(url: string, agentId: string, reason: string, token: string, timeoutMs: number): Promise<{ url: string; status: number }> {
  try {
    const res = await request(`${url}/admin/security/blacklist/${encodeURIComponent(agentId)}/lift`, {
      method: "POST",
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: JSON.stringify({ reason }),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs)
    });
    await res.body.dump().catch(() => undefined);
    return { url, status: res.statusCode };
  } catch {
    return { url, status: 0 };
  }
}

/** One row per agent (newest record wins), with the coordinators that hold it and the owner's email. */
export function mergeBlacklists(results: BlacklistResult[], owners: OwnerDirectory) {
  const byAgent = new Map<string, BlacklistRow & { coordinators: string[]; ownerEmail: string | null }>();
  for (const r of results) {
    if (!r.ok) continue;
    for (const rec of r.records) {
      const host = r.url.replace(/^https?:\/\//, "");
      const e = byAgent.get(rec.agentId);
      if (!e) {
        byAgent.set(rec.agentId, { ...rec, coordinators: [host], ownerEmail: owners.nodeOwners.get(rec.agentId)?.email ?? null });
        continue;
      }
      e.coordinators.push(host);
      if (rec.timestampMs > e.timestampMs) Object.assign(e, { ...rec, coordinators: e.coordinators, ownerEmail: e.ownerEmail });
    }
  }
  return {
    agents: [...byAgent.values()].sort((a, b) => b.timestampMs - a.timestampMs),
    coordinators: results.map((r) => (r.ok ? { url: r.url, ok: true as const, count: r.records.length } : { url: r.url, ok: false as const, error: r.error }))
  };
}
