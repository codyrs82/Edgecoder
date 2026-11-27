// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Settings > Network for every signed-in user (src/portal/pages/settings-world.ts):
 *
 *   GET /portal/api/network/world   the network's world view, the signed-in account's machines named
 *
 * The coordinator builds the view (src/swarm/coordinator/routes/network-world.ts): every coordinator
 * and every machine, other people's masked (an OS family and a keyed hash), the caller's own marked
 * `mine` with their real name. The portal asks with its service token and the account bound from
 * the session (acct-<user>, never from the request), the same answer the desktop app gets through
 * its agent.
 *
 * Defense in depth: the answer is rebuilt field by field from an allowlist, so nothing the
 * coordinator adds later reaches the browser unreviewed; a machine not marked `mine` never carries
 * a name, and its label must look masked or it is replaced.
 *
 * Activity (the graph's pulses) is allowlisted the same way: each machine's counts (`activity`: calls
 * now, streaming, calls in the last minute), each mesh link's work and gossip per minute, and
 * `yourRequests`, the signed-in account's own calls in flight (coordinator, masked machine id,
 * state). Nothing else about requests passes: no account, no other user's call.
 *
 * "Your round trip" is measured by the browser itself (the coordinators' CORS allows only the
 * desktop app's origins, and the portal's connect-src is 'self'): each coordinator gets a
 * `pingUrl`, its public /identity on an https origin, which the page loads as an image and times
 * (img-src allows https:, no credentials, nothing is read back). See settings-world.ts.
 */

import type { FastifyInstance } from "fastify";
import { coordinatorRequest } from "../coordinator-request.js";
import { MASKED_LABEL_RE } from "../../swarm/network-world.js";

export interface NetworkWorldRoutesDeps {
  PORTAL_SERVICE_TOKEN: string;
  EXTERNAL_HTTP_TIMEOUT_MS: number;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string } | null | undefined>;
}

const MAX_COORDINATORS_ASKED = 4;
const MAX_AGENTS = 500;
const MAX_COORDINATORS = 16;
const MAX_MODELS = 64;
const MAX_MODELS_PER_AGENT = 12;
const MAX_YOUR_REQUESTS = 20;
const MAX_CALLS_PER_MIN = 10_000;
const MAX_LINK_PER_MIN = 100_000;
const MASKED_ID_RE = /^[0-9a-f]{4,32}$/;

type Json = Record<string, unknown>;

const str = (v: unknown, max = 256): string | null => (typeof v === "string" && v.length <= max ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => {
  const n = num(v);
  return n !== null && n >= 0 ? Math.round(n) : 0;
};
const capped = (v: unknown, max: number): number => Math.min(max, count(v));
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** https origin + /identity, or null: the only URL the browser is told to load. */
export function pingUrlFor(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return `${u.origin}/identity`;
  } catch {
    return null;
  }
}

const FALLBACK_LABEL = "machine-•••";

/** Rebuild one machine from the allowlist. Another account's machine carries no name. */
function cleanAgent(raw: unknown): Json | null {
  const a = obj(raw);
  const id = str(a.id, 128);
  const coordinatorId = str(a.coordinatorId);
  if (!id || !coordinatorId) return null;
  const mine = a.mine === true;
  const label = str(a.label, 64);
  const status = a.status === "busy" || a.status === "idle" || a.status === "stale" ? a.status : "stale";
  const models = arr(a.models).map((m) => str(m, 128)).filter((m): m is string => m !== null).slice(0, MAX_MODELS_PER_AGENT);
  const out: Json = {
    id,
    label: label && MASKED_LABEL_RE.test(label) ? label : FALLBACK_LABEL,
    mine,
    os: str(a.os, 32) ?? "",
    region: str(a.region, 64),
    country: str(a.country, 8),
    continent: str(a.continent, 8),
    computeClass: str(a.computeClass, 32) ?? "cpu",
    tier: str(a.tier, 64),
    vramGb: num(a.vramGb),
    models,
    modelsTotal: Math.max(count(a.modelsTotal), models.length),
    activeModel: str(a.activeModel, 128),
    status,
    slots: Math.max(1, count(a.slots)),
    slotsUsed: count(a.slotsUsed),
    coordinatorId,
    rttMs: num(a.rttMs),
    activity: cleanActivity(a.activity, status)
  };
  if (mine) {
    const name = str(a.name, 128);
    if (name) out.name = name;
  }
  return out;
}

/** A machine's counts only; a machine not seen lately is doing nothing. */
function cleanActivity(raw: unknown, status: string): Json {
  const v = obj(raw);
  const callsNow = status === "stale" ? 0 : capped(v.callsNow, 64);
  return { callsNow, streaming: Math.min(callsNow, capped(v.streaming, 64)), callsPerMin: capped(v.callsPerMin, MAX_CALLS_PER_MIN) };
}

/** The signed-in account's own calls in flight: a known coordinator, a masked machine id, a state. */
function cleanYourRequests(raw: unknown, coordinatorIds: ReadonlySet<string>): Json[] {
  const out: Json[] = [];
  for (const item of arr(raw).slice(0, MAX_YOUR_REQUESTS)) {
    const r = obj(item);
    const coordinator = str(r.coordinator);
    const state = r.state === "queued" || r.state === "starting" || r.state === "streaming" ? r.state : null;
    if (!coordinator || !coordinatorIds.has(coordinator) || !state) continue;
    const key = str(r.machineKey, 32);
    out.push({ coordinator, machineKey: state !== "queued" && key && MASKED_ID_RE.test(key) ? key : null, state });
  }
  return out;
}

function cleanCoordinator(raw: unknown): Json | null {
  const c = obj(raw);
  const id = str(c.id);
  const url = str(c.url, 2048);
  if (!id || !url) return null;
  return {
    id,
    url,
    region: str(c.region, 64),
    country: str(c.country, 8),
    continent: str(c.continent, 8),
    agents: count(c.agents),
    agentsOnline: count(c.agentsOnline),
    reachable: c.reachable !== false,
    self: c.self === true,
    // The signed registry's listing, for the label on the Network page.
    registryStatus: REGISTRY_STATUSES.has(c.registryStatus as string) ? (c.registryStatus as string) : null,
    myRttMs: null,
    pingUrl: c.reachable === false ? null : pingUrlFor(url)
  };
}

const REGISTRY_STATUSES: ReadonlySet<string> = new Set(["platform", "probation", "active", "suspended"]);

/** The coordinator's /network/world answer, rebuilt from the allowlist. */
export function cleanWorld(raw: unknown): Json {
  const w = obj(raw);
  const agents = arr(w.agents).slice(0, MAX_AGENTS).map(cleanAgent).filter((a): a is Json => a !== null);
  const coordinators = arr(w.coordinators).slice(0, MAX_COORDINATORS).map(cleanCoordinator).filter((c): c is Json => c !== null);
  const ids = new Set(coordinators.map((c) => c.id as string));
  const links = arr(w.links)
    .map(obj)
    .map((l) => ({ from: str(l.from), to: str(l.to), rttMs: num(l.rttMs), workPerMin: capped(l.workPerMin, MAX_LINK_PER_MIN), gossipPerMin: capped(l.gossipPerMin, MAX_LINK_PER_MIN) }))
    .filter((l) => l.from && l.to && ids.has(l.from) && ids.has(l.to))
    .slice(0, MAX_COORDINATORS * MAX_COORDINATORS);
  const models = arr(w.models)
    .map(obj)
    .map((m) => ({ model: str(m.model, 128), agents: count(m.agents), online: count(m.online) }))
    .filter((m) => m.model)
    .slice(0, MAX_MODELS);
  const t = obj(w.totals);
  return {
    connected: true,
    generatedAtMs: num(w.generatedAtMs) ?? Date.now(),
    servedBy: str(w.servedBy) ?? "",
    coordinators,
    links,
    agents,
    models,
    totals: {
      coordinators: count(t.coordinators) || coordinators.length,
      agents: count(t.agents),
      online: count(t.online),
      busy: count(t.busy),
      mine: agents.filter((a) => a.mine).length,
      models: count(t.models),
      slots: count(t.slots),
      slotsUsed: count(t.slotsUsed)
    },
    yourRequests: cleanYourRequests(w.yourRequests, ids),
    truncated: w.truncated === true
  };
}

export function registerNetworkWorldRoutes(app: FastifyInstance, deps: NetworkWorldRoutesDeps): void {
  app.get("/portal/api/network/world", async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    reply.header("cache-control", "no-store");
    const accountId = `acct-${user.userId}`;
    const bases = [...new Set((await deps.discoverCoordinatorUrlsForPortal()).map((u) => u.replace(/\/$/, "")))].slice(0, MAX_COORDINATORS_ASKED);
    let rateLimited: number | null = null;
    // Any coordinator answers for the whole network (it merges its peers' views); the first that does wins.
    for (const base of bases) {
      try {
        const res = await coordinatorRequest(`${base}/network/world?accountId=${encodeURIComponent(accountId)}`, {
          method: "GET",
          headers: deps.PORTAL_SERVICE_TOKEN ? { "x-portal-service-token": deps.PORTAL_SERVICE_TOKEN } : {},
          headersTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS,
          bodyTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS
        });
        const text = await res.body.text();
        if (res.statusCode === 429) {
          rateLimited = Number(res.headers["retry-after"]) || 15;
          continue;
        }
        if (res.statusCode !== 200 || text.length > 4 * 1024 * 1024) continue;
        return reply.send(cleanWorld(JSON.parse(text)));
      } catch {
        // Try the next coordinator.
      }
    }
    if (rateLimited !== null) return reply.code(429).header("retry-after", String(rateLimited)).send({ connected: false, reason: "rate_limited" });
    return reply.code(502).send({ connected: false, reason: bases.length ? "coordinator_unreachable" : "no_coordinator" });
  });
}
