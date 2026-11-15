// The Network page's world view (GET /v1/ide/network/world): latency estimates, sorting,
// filtering and the hub-and-spoke graph layout. Framework-free, so it is unit-tested directly.
import type { WorldAgent, WorldCoordinator, WorldStatus, WorldView } from "./api";

/**
 * Estimated round trip from this computer to a machine: this computer's measured round trip to
 * the machine's coordinator plus the coordinator's measured round trip to the machine. Null when
 * either half is unknown. It is an estimate: work to the machine takes that path, but the two
 * halves are measured at different moments.
 */
export function estimateMs(agent: WorldAgent, coordinators: ReadonlyMap<string, WorldCoordinator>): number | null {
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
  return `${estimate ? "~" : ""}${Math.round(ms)} ms`;
}

const CONTINENTS: Record<string, string> = { NA: "North America", SA: "South America", EU: "Europe", AF: "Africa", AS: "Asia", OC: "Oceania" };
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
const STATUS_ORDER: Record<WorldStatus, number> = { busy: 0, idle: 1, stale: 2 };

export interface WorldRow {
  agent: WorldAgent;
  estimateMs: number | null;
}

export function rowsFor(view: Pick<WorldView, "agents" | "coordinators">): WorldRow[] {
  const coords = new Map(view.coordinators.map((c) => [c.id, c]));
  return view.agents.map((agent) => ({ agent, estimateMs: estimateMs(agent, coords) }));
}

function primaryModel(a: WorldAgent): string {
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
const CONTINENT_X: Record<string, number> = { NA: 0, SA: 1, EU: 2, AF: 3, AS: 4, OC: 5 };

export const RING_MIN = 46;
export const RING_MAX = 138;
const CELL = 2 * RING_MAX + 64;
const MS_LO = 5;
const MS_HI = 400;

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
  for (const r of rows) {
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
  const you = anyMine ? { x: width / 2, y: rowsCount * CELL + 26 } : null;
  return { width, height: rowsCount * CELL + (you ? 64 : 0), hubs, agents, rings, you };
}

/** Short host for a coordinator URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
