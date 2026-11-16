// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The anonymized world view of the network (GET /network/world): every coordinator, every agent on
 * each, which models they run, how busy they are and how far they are from their coordinator.
 *
 * Masking. Another person's machine is shown only as an OS family and a short keyed hash, e.g.
 * `mac-•••3f2a`: never its agent id, account, e-mail, IP address or host name. The hash is an
 * HMAC of the agent id under a key derived from the coordinator's identity key, so it is stable
 * (the same machine keeps its label across polls) but cannot be computed from a guessed agent id.
 * The caller's own machines are marked `mine` and carry their real name.
 *
 * Each coordinator builds the view of its own agents (`LocalWorld`, coordinator-to-coordinator
 * only, mesh token); the one asked merges its peers' views into the public answer. The internal
 * fields (`agentId`, `ownerTag`, `lastSeenMs`, `netTag`, `lan`) never leave `toPublicWorld`.
 *
 * LAN proximity (src/swarm/lan-proximity.ts). A machine's private LAN addresses and whether it
 * connects from the same public network as the caller are shared only with the machine's owner,
 * and only when the caller is a signed agent (the desktop app, which probes them itself): never
 * with another account, never with the portal.
 *
 * Pure functions; the route (coordinator/routes/network-world.ts) supplies the live state.
 */
import { createHash, createHmac } from "node:crypto";
import { networkTag, sanitizeLanAddresses } from "./lan-proximity.js";

export type WorldStatus = "idle" | "busy" | "stale";

/** One agent as its coordinator reports it to peer coordinators (never sent to clients as is). */
export interface LocalWorldAgent {
  /** Internal: real agent id (coordinator-to-coordinator only). */
  agentId: string;
  /** Internal: worldOwnerTag(owner account), to mark the caller's own machines. */
  ownerTag: string | null;
  /** Internal. */
  lastSeenMs: number;
  /** Internal: tag of the public network the machine connects from (lan-proximity.ts networkTag). */
  netTag?: string | null;
  /** Internal: the machine's private IPv4 addresses with prefix, for its owner only. */
  lan?: string[];
  /** Opaque stable id for UI keys (keyed hash, not reversible). */
  id: string;
  label: string;
  os: string;
  region: string | null;
  country: string | null;
  continent: string | null;
  computeClass: string;
  tier: string | null;
  vramGb: number | null;
  models: string[];
  modelsTotal: number;
  activeModel: string | null;
  status: WorldStatus;
  slots: number;
  slotsUsed: number;
  coordinatorId: string;
  rttMs: number | null;
  /** Internal (coordinator to coordinator, for best-fit routing): what scoring the agent needs. */
  perf?: WorldAgentPerf;
}

/** An agent's routing facts (src/swarm/coordinator/routing.ts agentPerf). */
export interface WorldAgentPerf {
  contextWindow: number | null;
  tokensPerSec: number | null;
  reliability: number | null;
  verified: boolean;
  freeSlots: number;
  failRate: number | null;
  tierWeight: number;
}

export interface WorldCoordinator {
  id: string;
  url: string;
  region: string | null;
  country: string | null;
  continent: string | null;
  agents: number;
  agentsOnline: number;
  /** False when the asked coordinator could not reach it for this answer. */
  reachable: boolean;
  /** True for the coordinator that answered. */
  self: boolean;
}

export interface WorldLink {
  from: string;
  to: string;
  /** Measured round trip between the two coordinators, ms (null when not measured). */
  rttMs: number | null;
}

export interface LocalWorld {
  coordinator: Omit<WorldCoordinator, "reachable" | "self">;
  /** Coordinators this one is meshed with and its measured round trip to each. */
  links: WorldLink[];
  agents: LocalWorldAgent[];
  generatedAtMs: number;
}

/** Owner-only LAN facts about one of the caller's machines (signed-agent callers only). */
export interface WorldAgentLan {
  /** It connects from the same public address (IPv4, or IPv6 /64) as the caller: likely the same network. */
  samePublicNetwork: boolean;
  /** Its private IPv4 addresses with prefix ("192.168.1.23/24"), for the desktop app to probe. */
  addresses: string[];
}

export type PublicWorldAgent = Omit<LocalWorldAgent, "agentId" | "ownerTag" | "lastSeenMs" | "perf" | "netTag" | "lan"> & {
  mine: boolean;
  name?: string;
  lan?: WorldAgentLan;
  /**
   * Your machines only (desktop and portal): machines with the same `lanGroup` connect from the same
   * public network (likely one LAN). An opaque per-answer id ("n1"), set only when two or more of
   * your machines share it. Carries no address.
   */
  lanGroup?: string;
};

export interface PublicWorld {
  generatedAtMs: number;
  servedBy: string;
  coordinators: WorldCoordinator[];
  links: WorldLink[];
  agents: PublicWorldAgent[];
  models: Array<{ model: string; agents: number; online: number }>;
  totals: { coordinators: number; agents: number; online: number; busy: number; mine: number; models: number; slots: number; slotsUsed: number };
  /** True when agents were left out to keep the answer bounded. */
  truncated: boolean;
  limits: { maxAgents: number; maxModelsPerAgent: number; maxCoordinators: number };
}

export const WORLD_MAX_AGENTS = 500;
export const WORLD_MAX_MODELS_PER_AGENT = 12;
export const WORLD_MAX_COORDINATORS = 16;
/** Agents not seen for this long are left out of the view (stale ones before that are shown as stale). */
export const WORLD_AGENT_TTL_MS = 15 * 60_000;

// ── Masking ──

/** The key the label hash uses, derived from a coordinator secret (its identity private key). */
export function worldMaskKey(secret: string): Buffer {
  return createHash("sha256").update("edgecoder-world-mask\n").update(secret).digest();
}

/** Coarse OS family, from a fixed set, so a free-form `os` string can never leak a host name. */
export function osFamily(os: string | undefined, clientType?: string): string {
  const s = `${os ?? ""} ${clientType ?? ""}`.toLowerCase();
  if (/\b(ios|iphone|ipad)/.test(s)) return "ios";
  if (/(mac|darwin|osx)/.test(s)) return "macos";
  if (/(win)/.test(s)) return "windows";
  if (/(android)/.test(s)) return "android";
  if (/(linux|ubuntu|debian|fedora|alpine|docker)/.test(s)) return "linux";
  return "other";
}

const OS_PREFIX: Record<string, string> = { macos: "mac", linux: "lin", windows: "win", ios: "ios", android: "and", other: "dev" };

/** What a masked label looks like (`mac-•••3f2a`). */
export const MASKED_LABEL_RE = /^[a-z]{3}-\u2022\u2022\u2022[0-9a-f]{4}$/;

/** Opaque id: 10 hex of HMAC(agentId). */
export function maskedId(key: Buffer, agentId: string): string {
  return createHmac("sha256", key).update(agentId).digest("hex").slice(0, 10);
}

/** `mac-•••3f2a`: the OS family prefix and the last 4 hex of the opaque id. */
export function maskedLabel(family: string, id: string): string {
  return `${OS_PREFIX[family] ?? "dev"}-•••${id.slice(-4)}`;
}

/** Tag of an owner account, shared by coordinators so a peer's agents can be marked as the caller's. */
export function worldOwnerTag(accountId: string): string {
  return createHash("sha256").update("edgecoder-world-owner\n").update(accountId).digest("hex").slice(0, 32);
}

// ── Regions ──

/** Fly.io region codes: country and continent (the platform the hosted agents and seeds run on). */
const FLY_REGIONS: Record<string, [string, string]> = {
  iad: ["US", "NA"], ord: ["US", "NA"], lax: ["US", "NA"], sjc: ["US", "NA"], sea: ["US", "NA"], dfw: ["US", "NA"], den: ["US", "NA"],
  ewr: ["US", "NA"], atl: ["US", "NA"], mia: ["US", "NA"], bos: ["US", "NA"], phx: ["US", "NA"], chi: ["US", "NA"], yyz: ["CA", "NA"],
  yul: ["CA", "NA"], qro: ["MX", "NA"], gru: ["BR", "SA"], gig: ["BR", "SA"], scl: ["CL", "SA"], eze: ["AR", "SA"], bog: ["CO", "SA"],
  lhr: ["GB", "EU"], ams: ["NL", "EU"], fra: ["DE", "EU"], cdg: ["FR", "EU"], mad: ["ES", "EU"], arn: ["SE", "EU"], waw: ["PL", "EU"],
  otp: ["RO", "EU"], sin: ["SG", "AS"], nrt: ["JP", "AS"], hkg: ["HK", "AS"], bom: ["IN", "AS"], syd: ["AU", "OC"], jnb: ["ZA", "AF"]
};

/** ISO country -> continent for the countries agents are likely in; others report no continent. */
const CONTINENT_BY_COUNTRY: Record<string, string> = Object.fromEntries(
  (
    [
      ["NA", "US CA MX GT CR PA CU DO JM PR"],
      ["SA", "BR AR CL CO PE VE EC UY PY BO"],
      ["EU", "GB IE FR DE NL BE LU CH AT IT ES PT SE NO DK FI IS PL CZ SK HU RO BG GR HR SI RS UA EE LV LT BY MD AL BA ME MK MT CY"],
      ["AS", "CN JP KR TW HK SG MY TH VN PH ID IN PK BD LK NP AE SA QA KW BH OM IL JO LB TR KZ UZ MN KH LA MM"],
      ["AF", "ZA NG KE EG MA TN DZ GH ET TZ UG RW SN CI CM AO ZM ZW BW NA MU"],
      ["OC", "AU NZ FJ PG"]
    ] as const
  ).flatMap(([c, list]) => list.split(" ").map((cc) => [cc, c]))
);

/** Region code (a Fly region, when the agent reported one) plus country and continent. */
export function regionInfo(region: string | null | undefined, countryCode: string | null | undefined): { region: string | null; country: string | null; continent: string | null } {
  const r = typeof region === "string" && /^[a-z0-9-]{2,24}$/.test(region) ? region : null;
  const fly = r ? FLY_REGIONS[r] : undefined;
  const cc = typeof countryCode === "string" && /^[A-Za-z]{2}$/.test(countryCode) ? countryCode.toUpperCase() : null;
  const country = fly?.[0] ?? cc;
  return { region: r, country, continent: fly?.[1] ?? (country ? CONTINENT_BY_COUNTRY[country] ?? null : null) };
}

// ── Building and merging ──

/** The live facts about one agent the coordinator already keeps. */
export interface AgentFacts {
  agentId: string;
  ownerAccountId: string | null;
  os: string;
  clientType?: string;
  region?: string | null;
  countryCode?: string | null;
  computeClass: string;
  tier: string | null;
  vramGb?: number | null;
  models: string[];
  activeModel: string | null;
  connected: boolean;
  claims: number;
  slots: number;
  lastSeenMs: number;
  rttMs: number | null;
  /** The public address the agent connects from (never sent anywhere; only its tag is compared). */
  sourceIp?: string | null;
  /** Private IPv4 addresses the agent reported. */
  lanAddresses?: readonly string[] | null;
}

export function localWorldAgent(key: Buffer, coordinatorId: string, a: AgentFacts): LocalWorldAgent {
  const family = osFamily(a.os, a.clientType);
  const id = maskedId(key, a.agentId);
  const models = [...new Set(a.models.filter((m) => typeof m === "string" && m && m !== "edgecoder-default"))];
  // The active model first, then by name, so the cut keeps what the agent is running.
  models.sort((x, y) => (x === a.activeModel ? -1 : y === a.activeModel ? 1 : x.localeCompare(y)));
  const slots = Math.max(1, Math.floor(a.slots || 1));
  return {
    agentId: a.agentId,
    ownerTag: worldOwnerTag(a.ownerAccountId ?? a.agentId),
    lastSeenMs: a.lastSeenMs,
    netTag: networkTag(a.sourceIp),
    lan: sanitizeLanAddresses(a.lanAddresses ?? []),
    id,
    label: maskedLabel(family, id),
    os: family,
    ...regionInfo(a.region, a.countryCode),
    computeClass: a.computeClass,
    tier: a.tier,
    vramGb: typeof a.vramGb === "number" && Number.isFinite(a.vramGb) ? a.vramGb : null,
    models: models.slice(0, WORLD_MAX_MODELS_PER_AGENT).map((m) => m.slice(0, 120)),
    modelsTotal: models.length,
    activeModel: a.activeModel ? a.activeModel.slice(0, 120) : null,
    status: !a.connected ? "stale" : a.claims > 0 ? "busy" : "idle",
    slots,
    slotsUsed: Math.min(slots, Math.max(0, a.claims)),
    coordinatorId,
    rttMs: a.connected && a.rttMs !== null && Number.isFinite(a.rttMs) ? Math.round(a.rttMs) : null
  };
}

const STATUS_ORDER: Record<WorldStatus, number> = { busy: 0, idle: 1, stale: 2 };

/**
 * Merge this coordinator's view with its peers' into the public answer for one caller.
 * `callerAccountId` null: nothing is marked as the caller's.
 */
export function toPublicWorld(
  self: LocalWorld,
  peers: Array<{ url: string; id?: string; world: LocalWorld | null; rttMs: number | null }>,
  callerAccountId: string | null,
  nowMs: number,
  /**
   * Set only for a signed agent caller (the desktop app): the caller's own machines then carry
   * `lan` (their private addresses and the same-public-network hint against `callerNetTag`).
   */
  lanFor?: { callerNetTag: string | null }
): PublicWorld {
  const callerTag = callerAccountId ? worldOwnerTag(callerAccountId) : null;
  const coordinators: WorldCoordinator[] = [{ ...self.coordinator, reachable: true, self: true }];
  const linkMap = new Map<string, WorldLink>();
  const addLink = (l: WorldLink) => {
    if (!l.from || !l.to || l.from === l.to) return;
    const k = [l.from, l.to].sort().join("\u0000");
    const prev = linkMap.get(k);
    if (!prev || (prev.rttMs === null && l.rttMs !== null)) linkMap.set(k, { from: l.from, to: l.to, rttMs: l.rttMs === null ? null : Math.round(l.rttMs) });
  };
  self.links.forEach(addLink);

  // An agent known to two coordinators (it moved) is shown where it was seen last.
  const byAgent = new Map<string, LocalWorldAgent>();
  const take = (a: LocalWorldAgent) => {
    if (nowMs - a.lastSeenMs > WORLD_AGENT_TTL_MS) return;
    const prev = byAgent.get(a.agentId);
    if (!prev || a.lastSeenMs > prev.lastSeenMs) byAgent.set(a.agentId, a);
  };
  self.agents.forEach(take);

  for (const p of peers.slice(0, WORLD_MAX_COORDINATORS - 1)) {
    const id = p.world?.coordinator.id ?? p.id ?? p.url;
    if (coordinators.some((c) => c.id === id)) continue;
    if (p.world) {
      coordinators.push({ ...p.world.coordinator, url: p.world.coordinator.url || p.url, reachable: true, self: false });
      p.world.links.forEach(addLink);
      p.world.agents.forEach(take);
    } else {
      coordinators.push({ id, url: p.url, region: null, country: null, continent: null, agents: 0, agentsOnline: 0, reachable: false, self: false });
    }
    addLink({ from: self.coordinator.id, to: id, rttMs: p.rttMs });
  }
  const known = new Set(coordinators.map((c) => c.id));
  const links = [...linkMap.values()].filter((l) => known.has(l.from) && known.has(l.to));

  const all = [...byAgent.values()].map((a) => {
    const mine = callerTag !== null && (a.ownerTag === callerTag || a.agentId === callerAccountId);
    return { a, mine };
  });
  all.sort(
    (x, y) =>
      Number(y.mine) - Number(x.mine) ||
      STATUS_ORDER[x.a.status] - STATUS_ORDER[y.a.status] ||
      (x.a.rttMs ?? Infinity) - (y.a.rttMs ?? Infinity) ||
      x.a.id.localeCompare(y.a.id)
  );
  const kept = all.slice(0, WORLD_MAX_AGENTS);
  // Your machines that share a public network, numbered per answer (no tag or address leaves here).
  const tagCount = new Map<string, number>();
  for (const { a, mine } of kept) if (mine && a.netTag) tagCount.set(a.netTag, (tagCount.get(a.netTag) ?? 0) + 1);
  const groupOf = new Map<string, string>();
  for (const [tag, n] of tagCount) if (n >= 2) groupOf.set(tag, `n${groupOf.size + 1}`);
  const agents: PublicWorldAgent[] = kept.map(({ a, mine }) => {
    const { agentId, ownerTag: _tag, lastSeenMs: _seen, perf: _perf, netTag, lan, ...rest } = a;
    if (!mine) return { ...rest, mine: false };
    const out: PublicWorldAgent = { ...rest, mine: true, name: agentId };
    const group = netTag ? groupOf.get(netTag) : undefined;
    if (group) out.lanGroup = group;
    if (lanFor) {
      const samePublicNetwork = !!lanFor.callerNetTag && netTag === lanFor.callerNetTag;
      const addresses = sanitizeLanAddresses(lan ?? []);
      if (samePublicNetwork || addresses.length) out.lan = { samePublicNetwork, addresses };
    }
    return out;
  });

  // Counts per coordinator and per model are over every agent, not only the ones kept.
  for (const c of coordinators) {
    if (!c.reachable) continue;
    const on = all.filter(({ a }) => a.coordinatorId === c.id);
    c.agents = on.length;
    c.agentsOnline = on.filter(({ a }) => a.status !== "stale").length;
  }
  const modelCounts = new Map<string, { agents: number; online: number }>();
  for (const { a } of all) {
    for (const m of a.models) {
      const e = modelCounts.get(m) ?? { agents: 0, online: 0 };
      e.agents++;
      if (a.status !== "stale") e.online++;
      modelCounts.set(m, e);
    }
  }
  const models = [...modelCounts.entries()]
    .map(([model, e]) => ({ model, ...e }))
    .sort((x, y) => y.online - x.online || y.agents - x.agents || x.model.localeCompare(y.model))
    .slice(0, 200);
  const online = all.filter(({ a }) => a.status !== "stale");
  return {
    generatedAtMs: nowMs,
    servedBy: self.coordinator.id,
    coordinators,
    links,
    agents,
    models,
    totals: {
      coordinators: coordinators.length,
      agents: all.length,
      online: online.length,
      busy: all.filter(({ a }) => a.status === "busy").length,
      mine: all.filter(({ mine }) => mine).length,
      models: models.filter((m) => m.online > 0).length,
      slots: online.reduce((n, { a }) => n + a.slots, 0),
      slotsUsed: online.reduce((n, { a }) => n + a.slotsUsed, 0)
    },
    truncated: all.length > kept.length,
    limits: { maxAgents: WORLD_MAX_AGENTS, maxModelsPerAgent: WORLD_MAX_MODELS_PER_AGENT, maxCoordinators: WORLD_MAX_COORDINATORS }
  };
}

/**
 * A peer coordinator's /network/world/local answer, checked field by field: anything malformed is
 * dropped rather than passed on to clients. Returns null when the shape is not a LocalWorld.
 */
/** A peer's `perf` for one agent, checked field by field (absent when malformed). */
function parsePerf(raw: unknown): { perf?: WorldAgentPerf } {
  if (!raw || typeof raw !== "object") return {};
  const p = raw as Record<string, unknown>;
  const num = (v: unknown, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  return {
    perf: {
      contextWindow: num(p.contextWindow, 10_000_000),
      tokensPerSec: num(p.tokensPerSec, 10_000),
      reliability: num(p.reliability, 1),
      verified: p.verified === true,
      freeSlots: Math.floor(num(p.freeSlots, 64) ?? 0),
      failRate: num(p.failRate, 1),
      tierWeight: num(p.tierWeight, 1_000) ?? 1,
    },
  };
}

export function parseLocalWorld(raw: unknown): LocalWorld | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const c = r.coordinator as Record<string, unknown> | undefined;
  if (!c || typeof c.id !== "string" || !c.id || c.id.length > 200) return null;
  const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.length <= max ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const coordinator = {
    id: c.id,
    url: str(c.url, 500) ?? "",
    region: str(c.region, 24),
    country: str(c.country, 2),
    continent: str(c.continent, 2),
    agents: Math.max(0, Math.floor(num(c.agents) ?? 0)),
    agentsOnline: Math.max(0, Math.floor(num(c.agentsOnline) ?? 0))
  };
  const links = (Array.isArray(r.links) ? r.links : [])
    .slice(0, 64)
    .map((l) => l as Record<string, unknown>)
    .filter((l) => typeof l?.from === "string" && typeof l?.to === "string")
    .map((l) => ({ from: String(l.from).slice(0, 200), to: String(l.to).slice(0, 200), rttMs: num(l.rttMs) }));
  const agents: LocalWorldAgent[] = [];
  for (const item of (Array.isArray(r.agents) ? r.agents : []).slice(0, WORLD_MAX_AGENTS * 2)) {
    const a = item as Record<string, unknown>;
    if (!a || typeof a.agentId !== "string" || typeof a.id !== "string" || !/^[0-9a-f]{4,32}$/.test(a.id)) continue;
    // A peer's label must have the masked shape; anything else (a name, say) is replaced, never passed on.
    const os = typeof a.os === "string" && a.os in OS_PREFIX ? a.os : "other";
    const label = typeof a.label === "string" && MASKED_LABEL_RE.test(a.label) ? a.label : maskedLabel(os, a.id);
    const status = a.status === "busy" || a.status === "idle" || a.status === "stale" ? a.status : "stale";
    const slots = Math.max(1, Math.min(64, Math.floor(num(a.slots) ?? 1)));
    const models = (Array.isArray(a.models) ? a.models : []).filter((m): m is string => typeof m === "string" && m.length > 0 && m.length <= 200).slice(0, WORLD_MAX_MODELS_PER_AGENT);
    agents.push({
      agentId: a.agentId.slice(0, 128),
      ownerTag: str(a.ownerTag, 64),
      lastSeenMs: num(a.lastSeenMs) ?? 0,
      netTag: typeof a.netTag === "string" && /^[0-9a-f]{32}$/.test(a.netTag) ? a.netTag : null,
      lan: sanitizeLanAddresses(a.lan),
      id: a.id,
      label,
      os,
      region: str(a.region, 24),
      country: str(a.country, 2),
      continent: str(a.continent, 2),
      computeClass: str(a.computeClass, 32) ?? "cpu",
      tier: str(a.tier, 64),
      vramGb: num(a.vramGb),
      models,
      modelsTotal: Math.max(models.length, Math.floor(num(a.modelsTotal) ?? 0)),
      activeModel: str(a.activeModel, 200),
      status,
      slots,
      slotsUsed: Math.max(0, Math.min(slots, Math.floor(num(a.slotsUsed) ?? 0))),
      coordinatorId: coordinator.id,
      rttMs: num(a.rttMs),
      ...parsePerf(a.perf)
    });
  }
  return { coordinator, links, agents, generatedAtMs: num(r.generatedAtMs) ?? 0 };
}
