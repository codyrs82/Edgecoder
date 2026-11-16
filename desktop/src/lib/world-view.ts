// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The Network page's world view (the coordinator's GET /network/world, anonymized): latency
 * estimates, sorting, filtering and the hub-and-spoke graph layout. Framework-free and pure.
 *
 * Shared by the desktop app (Settings > Network, desktop/src/lib/world-view.ts) and the portal
 * (Settings > Network, src/portal/pages/settings-world.ts). Kept byte-identical in
 * src/common/world-view.ts and desktop/src/lib/world-view.ts (the desktop app does not import
 * from src/); tests/common/world-view.test.ts checks the two match. Self-contained on purpose:
 * the portal ships these functions to the browser via Function.prototype.toString, so every
 * function is a declaration and every constant it reads is exported (WORLD_VIEW_BROWSER_SCRIPT
 * in the portal lists them).
 */

// ── Types (the answer of /network/world, plus this computer's round trips) ──

export type WorldStatus = "idle" | "busy" | "stale";
export interface WorldAgent {
  /** Opaque stable id (a keyed hash), for keys only. */
  id: string;
  /** Masked label, e.g. "mac-•••3f2a". */
  label: string;
  /** Your machine: `name` is its real name. */
  mine: boolean;
  name?: string;
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
  /** The coordinator's measured round trip to this machine (WebSocket pings), ms. */
  rttMs: number | null;
  /**
   * Desktop app only: this machine is on this computer's local network, with the round trip measured
   * directly: by this computer's agent (any account; docs/security/lan-proximity.md) or, for your own
   * machines, by a ping from this computer. The better of the two.
   */
  lan?: { sameNetwork: boolean; rttMs: number | null };
  /**
   * Your machines only (desktop and portal): the same id means they connect from the same public
   * network, likely one LAN (an opaque per-answer id, no address).
   */
  lanGroup?: string;
}
export interface WorldCoordinator {
  id: string;
  url: string;
  region: string | null;
  country: string | null;
  continent: string | null;
  agents: number;
  agentsOnline: number;
  reachable: boolean;
  self: boolean;
  /** This computer's measured round trip to the coordinator, ms (null: not measured or no answer). */
  myRttMs?: number | null;
}
export interface WorldView {
  connected: boolean;
  reason?: string;
  generatedAtMs: number;
  servedBy: string;
  coordinators: WorldCoordinator[];
  links: Array<{ from: string; to: string; rttMs: number | null }>;
  agents: WorldAgent[];
  models: Array<{ model: string; agents: number; online: number }>;
  totals: { coordinators: number; agents: number; online: number; busy: number; mine: number; models: number; slots: number; slotsUsed: number };
  truncated: boolean;
  /** This computer's agent id (its entry is one of `mine`). */
  selfAgentId?: string;
}

// ── Estimates, sorting, filtering ──

/** A machine on this computer's local network (yours or anyone's), with its measured round trip. */
export function lanMs(agent: WorldAgent): number | null {
  return agent.lan?.sameNetwork && typeof agent.lan.rttMs === "number" ? agent.lan.rttMs : null;
}

/**
 * Round trip from this computer to a machine. Machines on the same local network are measured
 * directly (`lan`). Otherwise an estimate: this computer's measured round trip to
 * the machine's coordinator plus the coordinator's measured round trip to the machine. Null when
 * either half is unknown. It is an estimate: work to the machine takes that path, but the two
 * halves are measured at different moments.
 */
export function estimateMs(agent: WorldAgent, coordinators: ReadonlyMap<string, WorldCoordinator>): number | null {
  const lan = lanMs(agent);
  if (lan !== null) return Math.max(0, Math.round(lan * 10) / 10);
  const mine = coordinators.get(agent.coordinatorId)?.myRttMs;
  if (typeof mine !== "number" || typeof agent.rttMs !== "number") return null;
  return Math.round(mine + agent.rttMs);
}

export type Nearness = "near" | "mid" | "far" | "unknown";
export function nearness(ms: number | null): Nearness {
  if (ms === null) return "unknown";
  return ms < 80 ? "near" : ms < 180 ? "mid" : "far";
}

export function formatMs(ms: number | null | undefined, estimate = false): string {
  if (typeof ms !== "number") return "—";
  // A LAN round trip can be under a millisecond.
  if (ms < 1) return `${estimate ? "~" : ""}<1 ms`;
  return `${estimate ? "~" : ""}${Math.round(ms)} ms`;
}

export const CONTINENTS: Record<string, string> = { NA: "North America", SA: "South America", EU: "Europe", AF: "Africa", AS: "Asia", OC: "Oceania" };
export function continentName(code: string | null): string {
  return code ? CONTINENTS[code] ?? code : "Unknown";
}

/** "sin · SG" style region text. */
export function regionText(a: { region: string | null; country: string | null; continent: string | null }): string {
  const parts = [a.region, a.country].filter(Boolean);
  return parts.length ? parts.join(" · ") : a.continent ? continentName(a.continent) : "Unknown";
}

/** What a machine is called: its real name when it is yours, its masked label otherwise. */
export function displayName(a: WorldAgent, selfAgentId?: string): string {
  if (a.mine && a.name) return a.name === selfAgentId ? `${a.name} (this computer)` : a.name;
  return a.label;
}

export type SortKey = "latency" | "region" | "model" | "status";
export const STATUS_ORDER: Record<WorldStatus, number> = { busy: 0, idle: 1, stale: 2 };

export interface WorldRow {
  agent: WorldAgent;
  estimateMs: number | null;
  /** Your machine on the same local network: `estimateMs` was measured directly, not estimated. */
  sameNetwork: boolean;
}

export function rowsFor(view: Pick<WorldView, "agents" | "coordinators">): WorldRow[] {
  const coords = new Map(view.coordinators.map((c) => [c.id, c]));
  return view.agents.map((agent) => ({ agent, estimateMs: estimateMs(agent, coords), sameNetwork: lanMs(agent) !== null }));
}

export function primaryModel(a: WorldAgent): string {
  return a.activeModel ?? a.models[0] ?? "￿";
}

/** Sorted copy. Unknown latencies and regions go last whichever way; ties keep your machines first, then by name. */
export function sortRows(rows: readonly WorldRow[], key: SortKey, dir: "asc" | "desc" = "asc"): WorldRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const tie = (x: WorldRow, y: WorldRow) => Number(y.agent.mine) - Number(x.agent.mine) || (x.agent.name ?? x.agent.label).localeCompare(y.agent.name ?? y.agent.label);
  const cmp = (x: WorldRow, y: WorldRow): number => {
    switch (key) {
      case "latency": {
        if (x.estimateMs === null || y.estimateMs === null) return Number(x.estimateMs === null) - Number(y.estimateMs === null);
        return sign * (x.estimateMs - y.estimateMs);
      }
      case "region": {
        const rx = [x.agent.continent ?? "￿", x.agent.country ?? "￿", x.agent.region ?? "￿"].join("|");
        const ry = [y.agent.continent ?? "￿", y.agent.country ?? "￿", y.agent.region ?? "￿"].join("|");
        return sign * rx.localeCompare(ry);
      }
      case "model":
        return sign * primaryModel(x.agent).localeCompare(primaryModel(y.agent));
      case "status":
        return sign * (STATUS_ORDER[x.agent.status] - STATUS_ORDER[y.agent.status]);
    }
  };
  return [...rows].sort((x, y) => cmp(x, y) || tie(x, y));
}

export interface RowFilter {
  scope: "all" | "mine";
  /** "" for any model. */
  model: string;
}
export function filterRows(rows: readonly WorldRow[], f: RowFilter): WorldRow[] {
  return rows.filter((r) => (f.scope === "all" || r.agent.mine) && (!f.model || r.agent.models.includes(f.model) || r.agent.activeModel === f.model));
}

/** Up to `n` online machines that are not yours, nearest first (by the estimate). */
export function nearestPeers(rows: readonly WorldRow[], n = 3): WorldRow[] {
  return rows
    .filter((r) => !r.agent.mine && r.agent.status !== "stale" && r.estimateMs !== null)
    .sort((x, y) => (x.estimateMs as number) - (y.estimateMs as number))
    .slice(0, n);
}

/**
 * "Nearest to you": machines on the same local network first (yours and other people's, measured
 * directly, this computer left out), then other people's machines by the estimate. Up to `n`,
 * online only, each once.
 */
export function nearestToYou(rows: readonly WorldRow[], selfAgentId?: string, n = 3): WorldRow[] {
  const lan = rows
    .filter((r) => r.sameNetwork && r.agent.status !== "stale" && r.agent.name !== selfAgentId)
    .sort((x, y) => (x.estimateMs as number) - (y.estimateMs as number));
  const seen = new Set(lan.map((r) => r.agent.id));
  return [...lan, ...nearestPeers(rows, n + lan.length).filter((r) => !seen.has(r.agent.id))].slice(0, n);
}

/** How a "Nearest to you" entry reads: "MacBook-Pro (same network)", "mac-•••3f2a (same network)" or "lin-•••4e08 iad". */
export function nearestText(r: WorldRow, selfAgentId?: string): string {
  if (r.sameNetwork) return `${displayName(r.agent, selfAgentId)} (same network)`;
  return `${r.agent.label} ${r.agent.region ?? r.agent.country ?? ""}`.trim();
}

// ── Graph layout ──

export interface HubNode {
  id: string;
  x: number;
  y: number;
  coordinator: WorldCoordinator;
}
export interface AgentNode {
  id: string;
  x: number;
  y: number;
  r: number;
  hubId: string;
  row: WorldRow;
  /** Placed beside "You" (your machine on the same local network), not around its coordinator. */
  lan?: boolean;
}
export interface WorldLayout {
  width: number;
  height: number;
  hubs: HubNode[];
  agents: AgentNode[];
  /** Guide rings around each hub: radius and the round trip it stands for. */
  rings: Array<{ hubId: string; r: number; ms: number }>;
  you: { x: number; y: number } | null;
}

/** West to east, so the hubs sit roughly where they are. */
export const CONTINENT_X: Record<string, number> = { NA: 0, SA: 1, EU: 2, AF: 3, AS: 4, OC: 5 };

export const RING_MIN = 46;
export const RING_MAX = 138;
export const CELL = 2 * RING_MAX + 64;
export const MS_LO = 5;
export const MS_HI = 400;

/** Distance from the hub for a round trip: log scale from MS_LO (RING_MIN) to MS_HI (RING_MAX); unknown at the edge. */
export function ringRadius(ms: number | null): number {
  if (ms === null) return RING_MAX;
  const t = Math.log(Math.max(ms, MS_LO) / MS_LO) / Math.log(MS_HI / MS_LO);
  return +(RING_MIN + (RING_MAX - RING_MIN) * Math.min(1, Math.max(0, t))).toFixed(1);
}

/** Node size by model slots, a little larger for a GPU. */
export function nodeRadius(a: WorldAgent): number {
  return 5 + Math.min(a.slots, 8) * 0.9 + (a.computeClass.startsWith("gpu") ? 2 : 0);
}

/**
 * Coordinators as hubs (west to east, three to a row), each machine on a ring around its
 * coordinator at a distance set by the coordinator's round trip to it, spread evenly by region.
 * "You" sits under the hubs when this computer's round trip to any coordinator is known.
 */
export function worldLayout(view: Pick<WorldView, "coordinators">, rows: readonly WorldRow[]): WorldLayout {
  const coords = [...view.coordinators].sort((a, b) => (CONTINENT_X[a.continent ?? ""] ?? 9) - (CONTINENT_X[b.continent ?? ""] ?? 9) || a.id.localeCompare(b.id));
  const perRow = Math.max(1, Math.min(3, coords.length));
  const hubs: HubNode[] = coords.map((c, i) => ({
    id: c.id,
    x: CELL / 2 + (i % perRow) * CELL,
    y: CELL / 2 + Math.floor(i / perRow) * CELL,
    coordinator: c
  }));
  const hubById = new Map(hubs.map((h) => [h.id, h]));
  const agents: AgentNode[] = [];
  const byHub = new Map<string, WorldRow[]>();
  const lanRows = rows.filter((r) => r.sameNetwork);
  for (const r of rows) {
    if (r.sameNetwork) continue;
    if (!hubById.has(r.agent.coordinatorId)) continue;
    const list = byHub.get(r.agent.coordinatorId) ?? [];
    list.push(r);
    byHub.set(r.agent.coordinatorId, list);
  }
  for (const [hubId, list] of byHub) {
    const hub = hubById.get(hubId)!;
    const sorted = [...list].sort(
      (x, y) => (x.agent.continent ?? "~").localeCompare(y.agent.continent ?? "~") || (x.agent.region ?? "~").localeCompare(y.agent.region ?? "~") || x.agent.id.localeCompare(y.agent.id)
    );
    sorted.forEach((row, i) => {
      // Half a step off the top, so no machine sits on the ring labels or on a hub-to-hub line.
      const a = -Math.PI / 2 + (2 * Math.PI * (i + 0.5)) / sorted.length + (sorted.length % 2 ? Math.PI / 12 : 0);
      const d = ringRadius(row.agent.rttMs);
      agents.push({ id: row.agent.id, x: +(hub.x + d * Math.cos(a)).toFixed(1), y: +(hub.y + d * Math.sin(a)).toFixed(1), r: +nodeRadius(row.agent).toFixed(1), hubId, row });
    });
  }
  const rings = hubs.flatMap((h) => [20, 100].map((ms) => ({ hubId: h.id, r: ringRadius(ms), ms })));
  const rowsCount = Math.ceil(hubs.length / perRow);
  const anyMine = view.coordinators.some((c) => typeof c.myRttMs === "number");
  const width = Math.max(CELL, perRow * CELL);
  const you = anyMine || lanRows.length ? { x: width / 2, y: rowsCount * CELL + 26 } : null;
  // Your machines on the same local network sit beside "You", alternately left and right, closer
  // for a shorter round trip.
  if (you) {
    const sorted = [...lanRows].sort((x, y) => (x.estimateMs ?? 0) - (y.estimateMs ?? 0) || x.agent.id.localeCompare(y.agent.id));
    sorted.forEach((row, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      const d = lanDistance(row.estimateMs) + Math.floor(i / 2) * 64;
      const x = Math.min(width - 12, Math.max(12, you.x + side * d));
      agents.push({ id: row.agent.id, x: +x.toFixed(1), y: you.y, r: +nodeRadius(row.agent).toFixed(1), hubId: "", row, lan: true });
    });
  } else {
    // No "You" to sit beside: around their coordinators like any machine.
    for (const row of lanRows) {
      const hub = hubById.get(row.agent.coordinatorId);
      if (hub) agents.push({ id: row.agent.id, x: hub.x, y: +(hub.y + ringRadius(row.agent.rttMs)).toFixed(1), r: +nodeRadius(row.agent).toFixed(1), hubId: hub.id, row });
    }
  }
  return { width, height: rowsCount * CELL + (you ? 64 : 0), hubs, agents, rings, you };
}

/** Distance from "You" for a LAN round trip: 46 px at 1 ms or less, up to 90 px at 20 ms or more. */
export function lanDistance(ms: number | null): number {
  const m = Math.min(20, Math.max(1, ms ?? 20));
  return +(46 + (44 * Math.log(m)) / Math.log(20)).toFixed(1);
}

/** Short host for a coordinator URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
