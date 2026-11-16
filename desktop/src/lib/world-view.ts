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
 *
 * Pulses (the graph's activity): `pulseLanes` turns the answer's activity counts into travelling
 * dots along the lines, capped (PULSE_MAX_DOTS in all, PULSE_MAX_PER_LANE per line) and quantized
 * to a few speeds so a refresh rarely changes one; `pulseBegin` places each dot on the wall clock,
 * so a redrawn graph carries on where the last one was instead of starting over. `yourPath` is the
 * route of the caller's own requests (You, coordinator, machine). Nothing here implies traffic the
 * answer does not report.
 */

// ── Types (the answer of /network/world, plus this computer's round trips) ──

export type WorldStatus = "idle" | "busy" | "stale";
/** What a machine is doing now: counts only, never who it is serving. */
export interface WorldActivity {
  /** Calls it is running now. */
  callsNow: number;
  /** Of those, model calls streaming a reply. */
  streaming: number;
  /** Calls it took in the last minute. */
  callsPerMin: number;
}
export type WorldRequestState = "queued" | "starting" | "streaming";
/** One of your own requests in flight: the coordinator it is on and the machine running it. */
export interface WorldYourRequest {
  coordinator: string;
  /** The machine's `id` (masked); null while the request waits for a machine. */
  machineKey: string | null;
  state: WorldRequestState;
}
export interface WorldLink {
  from: string;
  to: string;
  rttMs: number | null;
  /** Work (task offers, claims, results, calls sent elsewhere) across the link in the last minute. */
  workPerMin?: number;
  /** Other mesh messages across the link in the last minute. */
  gossipPerMin?: number;
}
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
   * Your machines only, desktop app only: this computer pinged it directly over the local network
   * (it connects from the same public address and sits in one of this computer's subnets).
   */
  lan?: { sameNetwork: boolean; rttMs: number | null };
  /**
   * Your machines only (desktop and portal): the same id means they connect from the same public
   * network, likely one LAN (an opaque per-answer id, no address).
   */
  lanGroup?: string;
  /** Absent from coordinators older than the pulses. */
  activity?: WorldActivity;
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
  links: WorldLink[];
  agents: WorldAgent[];
  models: Array<{ model: string; agents: number; online: number }>;
  totals: { coordinators: number; agents: number; online: number; busy: number; mine: number; models: number; slots: number; slotsUsed: number };
  truncated: boolean;
  /** Your own requests in flight (absent from older coordinators). */
  yourRequests?: WorldYourRequest[];
  /** This computer's agent id (its entry is one of `mine`). */
  selfAgentId?: string;
}

// ── Estimates, sorting, filtering ──

/** One of your machines this computer reached directly over the local network, with its measured round trip. */
export function lanMs(agent: WorldAgent): number | null {
  return agent.mine && agent.lan?.sameNetwork && typeof agent.lan.rttMs === "number" ? agent.lan.rttMs : null;
}

/**
 * Round trip from this computer to a machine. Your own machines on the same local network are
 * measured directly (`lan`). Otherwise an estimate: this computer's measured round trip to
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
 * "Nearest to you": your own machines on the same local network first (measured directly, this
 * computer left out), then other people's machines by the estimate. Up to `n`, online only.
 */
export function nearestToYou(rows: readonly WorldRow[], selfAgentId?: string, n = 3): WorldRow[] {
  const lan = rows
    .filter((r) => r.sameNetwork && r.agent.status !== "stale" && r.agent.name !== selfAgentId)
    .sort((x, y) => (x.estimateMs as number) - (y.estimateMs as number));
  return [...lan, ...nearestPeers(rows, n)].slice(0, n);
}

/** How a "Nearest to you" entry reads: "MacBook-Pro (same network)" or "lin-•••4e08 iad". */
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
  /** Guide rings around each hub: radius, the round trip it stands for, and where its label sits (lx, ly). */
  rings: Array<{ hubId: string; r: number; ms: number; lx: number; ly: number }>;
  you: { x: number; y: number } | null;
  /** Each machine's name on the map, in `agents` order (placeLabels). */
  labels: MapLabel[];
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
 *
 * The machines around a hub keep clear of its lines (to the other coordinators and to "You") and
 * of its ring labels: spreadAngles leaves a gap around each, so no machine sits on a line. Then
 * placeLabels places every machine's name where it does not cover another name, a node, a hub or
 * a coordinator line (`labels`). All of it is deterministic: the same answer lays out the same.
 */
export function worldLayout(view: Pick<WorldView, "coordinators"> & Partial<Pick<WorldView, "links">>, rows: readonly WorldRow[]): WorldLayout {
  const coords = [...view.coordinators].sort((a, b) => (CONTINENT_X[a.continent ?? ""] ?? 9) - (CONTINENT_X[b.continent ?? ""] ?? 9) || a.id.localeCompare(b.id));
  const perRow = Math.max(1, Math.min(3, coords.length));
  const hubs: HubNode[] = coords.map((c, i) => ({
    id: c.id,
    x: CELL / 2 + (i % perRow) * CELL,
    y: CELL / 2 + Math.floor(i / perRow) * CELL,
    coordinator: c
  }));
  const hubById = new Map(hubs.map((h) => [h.id, h]));
  const links = (view.links ?? []).filter((l) => hubById.has(l.from) && hubById.has(l.to) && l.from !== l.to);
  const rowsCount = Math.ceil(hubs.length / perRow);
  const anyMine = view.coordinators.some((c) => typeof c.myRttMs === "number");
  const width = Math.max(CELL, perRow * CELL);
  const lanRows = rows.filter((r) => r.sameNetwork);
  const you = anyMine || lanRows.length ? { x: width / 2, y: rowsCount * CELL + 26 } : null;
  const agents: AgentNode[] = [];
  const byHub = new Map<string, WorldRow[]>();
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
    // Directions to keep clear: the ring labels (top, a little right), each coordinator line, the line to "You".
    const blocked: Array<[number, number]> = [[-Math.PI / 2 + 0.2, 0.26]];
    for (const l of links) {
      const other = l.from === hubId ? hubById.get(l.to) : l.to === hubId ? hubById.get(l.from) : undefined;
      if (other) blocked.push([Math.atan2(other.y - hub.y, other.x - hub.x), LINE_CLEAR]);
    }
    if (you && typeof hub.coordinator.myRttMs === "number") blocked.push([Math.atan2(you.y - hub.y, you.x - hub.x), LINE_CLEAR]);
    const angles = spreadAngles(sorted.length, blocked);
    sorted.forEach((row, i) => {
      const a = angles[i];
      const d = ringRadius(row.agent.rttMs);
      agents.push({ id: row.agent.id, x: +(hub.x + d * Math.cos(a)).toFixed(1), y: +(hub.y + d * Math.sin(a)).toFixed(1), r: +nodeRadius(row.agent).toFixed(1), hubId, row });
    });
  }
  const rings = hubs.flatMap((h) =>
    [20, 100].map((ms) => {
      const r = ringRadius(ms);
      return { hubId: h.id, r, ms, lx: h.x + 4, ly: +(h.y - r - 3).toFixed(1) };
    })
  );
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
  const layout: WorldLayout = { width, height: rowsCount * CELL + (you ? 64 : 0), hubs, agents, rings, you, labels: [] };
  layout.labels = placeLabels(layout, links);
  return layout;
}

/** Distance from "You" for a LAN round trip: 46 px at 1 ms or less, up to 90 px at 20 ms or more. */
export function lanDistance(ms: number | null): number {
  const m = Math.min(20, Math.max(1, ms ?? 20));
  return +(46 + (44 * Math.log(m)) / Math.log(20)).toFixed(1);
}

// ── Map labels: short names, placed so they do not collide ──

/** Font sizes on the map (px in the graph's viewBox), as the renderers' CSS sets them. */
export const LABEL_FONT = 10.5;
export const SMALL_FONT = 11;
export const RING_FONT = 10;
/** Average glyph width as a share of the font size: a deterministic estimate, no DOM measuring. */
export const LABEL_CHAR_EM = 0.6;
/** A map label longer than this is cut with "…" (the full name is in the tooltip and the panel). */
export const LABEL_MAX_CHARS = 22;
/** Above this many machines only your own are named on the map; the rest show on hover or focus. */
export const LABEL_ALL_MAX = 24;
/** The hub circle's radius. */
export const HUB_R = 26;
/** Half-width of the band along a coordinator-to-coordinator line that no machine name may cross. */
export const MESH_BAND = 5;
/** Angle (radians, each side) a hub keeps free of machines around each of its lines. */
export const LINE_CLEAR = 0.26;
/** Smallest angle between two machines around a hub before the gaps around its lines shrink. */
export const MIN_STEP = 0.16;
/** Where a name may go around its node, most preferred first before the outward sort: right, left, below, above, then diagonals. */
export const LABEL_DIRS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface MapLabel {
  /** The machine's id (its node's). */
  id: string;
  /** What the map shows: your machine's short name, or the masked label. */
  text: string;
  /** The full name, for the tooltip. */
  full: string;
  /** Text anchor point and baseline (SVG x, y, text-anchor). */
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  box: LabelBox;
  /** False: it would cover something, or the map is crowded; shown only on hover, focus or selection. */
  visible: boolean;
  /** Placement order: 0 your machines, 1 busy machines, 2 the rest (lower places first and hides last). */
  tier: number;
}

/**
 * Your machine's name, short enough for the map: "desktop-macbook-pro-crs-local-51738927" reads
 * "macbook-pro-crs" (the app's "desktop-" prefix and "-local-<hash>" suffix go), and anything
 * still longer than LABEL_MAX_CHARS is cut with "…".
 */
export function shortMachineName(name: string): string {
  let s = name.replace(/^desktop-/i, "").replace(/-local-[0-9a-z]+$/i, "").replace(/\.local$/i, "");
  if (!s) s = name;
  return s.length > LABEL_MAX_CHARS ? s.slice(0, LABEL_MAX_CHARS - 1) + "…" : s;
}

/** A machine's name on the map: yours shortened, everyone else's masked label as it is. */
export function mapLabelText(a: WorldAgent): string {
  return a.mine && a.name ? shortMachineName(a.name) : a.label;
}

/** Estimated box of a line of text at (x, baseline y). */
export function textBox(text: string, x: number, y: number, anchor: "start" | "middle" | "end", font: number): LabelBox {
  const w = Math.max(1, text.length) * font * LABEL_CHAR_EM + 2;
  const h = font * 1.1;
  const left = anchor === "start" ? x - 1 : anchor === "end" ? x - w + 1 : x - w / 2;
  return { x: +left.toFixed(1), y: +(y - font * 0.82).toFixed(1), w: +w.toFixed(1), h: +h.toFixed(1) };
}

export function boxesOverlap(a: LabelBox, b: LabelBox, pad = 0): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

export function boxHitsCircle(b: LabelBox, cx: number, cy: number, r: number): boolean {
  const nx = Math.max(b.x, Math.min(cx, b.x + b.w));
  const ny = Math.max(b.y, Math.min(cy, b.y + b.h));
  return (nx - cx) * (nx - cx) + (ny - cy) * (ny - cy) < r * r;
}

/** Does the segment, `half` px thick each side, cross the box? (Clip against the box grown by `half`.) */
export function boxHitsSegment(b: LabelBox, x1: number, y1: number, x2: number, y2: number, half: number): boolean {
  const xmin = b.x - half, xmax = b.x + b.w + half, ymin = b.y - half, ymax = b.y + b.h + half;
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - xmin, xmax - x1, y1 - ymin, ymax - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/**
 * `n` angles around a hub, spread evenly from the top (clockwise) over the directions left free
 * by `blocked` ([centre, half-width] in radians). When the machines would sit closer than
 * MIN_STEP the gaps shrink, down to none (an even spread all round).
 */
export function spreadAngles(n: number, blocked: ReadonlyArray<[number, number]>): number[] {
  if (n <= 0) return [];
  const TAU = 2 * Math.PI;
  const total = blocked.reduce((s, b) => s + 2 * b[1], 0);
  const k = total > 0 ? Math.max(0, Math.min(1, (TAU - n * MIN_STEP) / total)) : 0;
  // Blocked intervals as offsets from the top, clockwise, in [0, TAU).
  const iv: Array<[number, number]> = [];
  for (const b of blocked) {
    const w = b[1] * k;
    if (!(w > 0)) continue;
    const lo = (((b[0] - w + Math.PI / 2) % TAU) + TAU) % TAU;
    const hi = lo + 2 * w;
    if (hi > TAU) {
      iv.push([lo, TAU]);
      iv.push([0, hi - TAU]);
    } else iv.push([lo, hi]);
  }
  iv.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const free: Array<[number, number]> = [];
  let at = 0;
  for (const v of iv) {
    if (v[0] > at) free.push([at, v[0]]);
    at = Math.max(at, v[1]);
  }
  if (at < TAU) free.push([at, TAU]);
  const len = free.reduce((s, f) => s + f[1] - f[0], 0);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let t = len > 0 ? ((i + 0.5) * len) / n : ((i + 0.5) * TAU) / n;
    let a = -Math.PI / 2 + t;
    if (len > 0) {
      for (const f of free) {
        const span = f[1] - f[0];
        if (t <= span) {
          a = -Math.PI / 2 + f[0] + t;
          break;
        }
        t -= span;
      }
    }
    out.push(+a.toFixed(4));
  }
  return out;
}

/**
 * Where each machine's name goes. Fixed first: the hubs, the coordinator names under them, the
 * ring labels, the coordinator lines and their round trips, "You". Then the machines in order (your
 * own, then busy ones, then the rest; nearer first, then by id), each trying the spots around its
 * node (LABEL_DIRS, those facing away from its hub first) and taking the first whose box covers no
 * name already placed, no node, no hub, no ring label, no coordinator line and stays on the map.
 * A name with no free spot is hidden (`visible: false`, at its first spot for hover and focus), so
 * lower-priority names hide first. Above LABEL_ALL_MAX machines only yours are placed.
 */
export function placeLabels(layout: Pick<WorldLayout, "width" | "height" | "hubs" | "agents" | "rings" | "you">, links: ReadonlyArray<Pick<WorldLink, "from" | "to" | "rttMs">>): MapLabel[] {
  const hubById: Record<string, HubNode> = {};
  layout.hubs.forEach((h) => (hubById[h.id] = h));
  const fixed: LabelBox[] = [];
  const circles: Array<[number, number, number, string]> = [];
  const segs: Array<[number, number, number, number]> = [];
  for (const ring of layout.rings) fixed.push(textBox(ring.ms + " ms", ring.lx, ring.ly, "start", RING_FONT));
  for (const h of layout.hubs) {
    circles.push([h.x, h.y, HUB_R + 2, ""]);
    fixed.push(textBox(hostOf(h.coordinator.url), h.x, h.y + RING_MAX + 22, "middle", SMALL_FONT));
  }
  for (const l of links) {
    const a = hubById[l.from], b = hubById[l.to];
    if (!a || !b) continue;
    segs.push([a.x, a.y, b.x, b.y]);
    fixed.push(textBox(formatMs(l.rttMs), (a.x + b.x) / 2, (a.y + b.y) / 2 - 8, "middle", SMALL_FONT));
  }
  const you = layout.you;
  if (you) {
    circles.push([you.x, you.y, 12, ""]);
    fixed.push(textBox("You", you.x, you.y + 26, "middle", SMALL_FONT));
    for (const h of layout.hubs) {
      if (typeof h.coordinator.myRttMs === "number") fixed.push(textBox(formatMs(h.coordinator.myRttMs), (you.x + h.x) / 2 + 6, (you.y + h.y) / 2 + 40, "start", SMALL_FONT));
    }
    for (const n of layout.agents) if (n.lan) fixed.push(textBox(formatMs(n.row.estimateMs), (you.x + n.x) / 2, you.y - 8, "middle", LABEL_FONT));
  }
  for (const n of layout.agents) circles.push([n.x, n.y, n.r + (n.row.agent.mine ? 4 : 0) + 1, n.id]);

  const tierOf = (a: WorldAgent) => (a.mine ? 0 : a.status === "busy" || activityOf(a).callsNow > 0 ? 1 : 2);
  const order = layout.agents.slice().sort((x, y) => {
    const ex = x.row.estimateMs, ey = y.row.estimateMs;
    return (
      tierOf(x.row.agent) - tierOf(y.row.agent) ||
      (ex === null ? Infinity : ex) - (ey === null ? Infinity : ey) ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
    );
  });
  const crowded = layout.agents.length > LABEL_ALL_MAX;
  const placed: LabelBox[] = [];
  const byId: Record<string, MapLabel> = {};
  for (const n of order) {
    const a = n.row.agent;
    const text = mapLabelText(a);
    const tier = tierOf(a);
    const outer = n.r + (a.mine ? 4 : 0) + 3;
    // Away from the hub (or from "You") first; ties keep LABEL_DIRS order.
    const from = n.lan && you ? you : hubById[n.hubId];
    const ox = from ? n.x - from.x : 0, oy = from ? n.y - from.y : 0;
    const olen = Math.hypot(ox, oy);
    const dirs = LABEL_DIRS.map((d, i) => {
      const dl = Math.hypot(d[0], d[1]);
      const score = olen > 0 ? -Math.round(((d[0] * ox + d[1] * oy) / (dl * olen)) * 1000) : 0;
      return { d, i, score };
    }).sort((p, q) => p.score - q.score || p.i - q.i);
    const font = LABEL_FONT;
    const cands = dirs.map(({ d }) => {
      const k = d[0] !== 0 && d[1] !== 0 ? 0.72 : 1;
      const cx = n.x + d[0] * outer * k, cy = n.y + d[1] * outer * k;
      const anchor: "start" | "middle" | "end" = d[0] > 0 ? "start" : d[0] < 0 ? "end" : "middle";
      const h = font * 1.1;
      const top = d[1] === 0 ? cy - h / 2 : d[1] > 0 ? cy : cy - h;
      const y = +(top + font * 0.82).toFixed(1);
      const x = +cx.toFixed(1);
      return { x, y, anchor, box: textBox(text, x, y, anchor, font) };
    });
    const free = (b: LabelBox) =>
      b.x >= 0 && b.y >= 0 && b.x + b.w <= layout.width && b.y + b.h <= layout.height &&
      !placed.some((p) => boxesOverlap(b, p, 2)) &&
      !fixed.some((p) => boxesOverlap(b, p, 1)) &&
      !circles.some((c) => c[3] !== n.id && boxHitsCircle(b, c[0], c[1], c[2])) &&
      !segs.some((s) => boxHitsSegment(b, s[0], s[1], s[2], s[3], MESH_BAND));
    let pick = null as (typeof cands)[number] | null;
    if (!crowded || a.mine) for (const c of cands) if (free(c.box)) { pick = c; break; }
    const at = pick || cands[0];
    if (pick) placed.push(pick.box);
    byId[n.id] = { id: n.id, text, full: a.mine && a.name ? a.name : a.label, x: at.x, y: at.y, anchor: at.anchor, box: at.box, visible: !!pick, tier };
  }
  return layout.agents.map((n) => byId[n.id]);
}

/** Short host for a coordinator URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ── Activity and pulses ──

/** Moving dots on the whole graph at once, at most. */
export const PULSE_MAX_DOTS = 60;
/** Dots on one line at once, at most. */
export const PULSE_MAX_PER_LANE = 4;
/** The few travel times a dot may take (ms), fastest first: a busier line moves faster. */
export const PULSE_PERIODS = [900, 1400, 2000, 3000];
/** A quiet mesh or "You" line breathes once in this long (liveness, not traffic). */
export const HEARTBEAT_MS = 8000;

/** A machine's activity; an older coordinator's answer (no `activity`) falls back to its slots in use. */
export function activityOf(a: WorldAgent): WorldActivity {
  if (a.status === "stale") return { callsNow: 0, streaming: 0, callsPerMin: a.activity ? a.activity.callsPerMin : 0 };
  if (a.activity) return a.activity;
  return { callsNow: a.status === "busy" ? Math.max(1, a.slotsUsed) : 0, streaming: 0, callsPerMin: 0 };
}

/** Travel time for a line carrying `perMin` events a minute: one of PULSE_PERIODS. */
export function pulsePeriod(perMin: number): number {
  const n = Number.isFinite(perMin) ? perMin : 0;
  return n >= 60 ? PULSE_PERIODS[0] : n >= 20 ? PULSE_PERIODS[1] : n >= 5 ? PULSE_PERIODS[2] : PULSE_PERIODS[3];
}

/** Static intensity of a line (0 quiet .. 3 busiest): its thickness and opacity, and all reduced motion shows. */
export function pulseLevel(count: number, perMin: number): number {
  if (count <= 0) return 0;
  if (count >= 3 || perMin >= 60) return 3;
  if (count >= 2 || perMin >= 20) return 2;
  return 1;
}

/** Dots on a machine's line: one per reply streaming (else one for the call starting), one more when it is busy all minute. */
export function machinePulseCount(act: WorldActivity): number {
  if (act.callsNow <= 0) return 0;
  const base = act.streaming > 0 ? act.streaming : 1;
  return Math.min(PULSE_MAX_PER_LANE, base + (act.callsPerMin >= 30 ? 1 : 0));
}

/** Dots on a mesh line: none without work; one per ten calls a minute, up to the lane cap. */
export function meshPulseCount(workPerMin: number): number {
  if (!(workPerMin > 0)) return 0;
  return Math.min(PULSE_MAX_PER_LANE, 1 + Math.floor(workPerMin / 10));
}

export interface YourPath {
  /** Your requests in flight, as the answer listed them. */
  requests: WorldYourRequest[];
  /** Coordinators your requests are on, with how many and whether a reply is streaming. */
  coordinators: Record<string, { count: number; streaming: boolean }>;
  /** Machines (masked ids, in this view) running your requests. */
  machines: string[];
}

/** Where your own requests are: You → coordinator → machine. Machines not in the view are left out. */
export function yourPath(view: Pick<WorldView, "agents" | "coordinators" | "yourRequests">): YourPath {
  const known: Record<string, boolean> = {};
  view.coordinators.forEach((c) => (known[c.id] = true));
  const onView: Record<string, boolean> = {};
  view.agents.forEach((a) => (onView[a.id] = true));
  const requests = (view.yourRequests || []).filter((r) => known[r.coordinator]);
  const coordinators: Record<string, { count: number; streaming: boolean }> = {};
  const machines: string[] = [];
  for (const r of requests) {
    const c = coordinators[r.coordinator] || { count: 0, streaming: false };
    c.count++;
    if (r.state === "streaming") c.streaming = true;
    coordinators[r.coordinator] = c;
    if (r.machineKey && onView[r.machineKey] && machines.indexOf(r.machineKey) < 0) machines.push(r.machineKey);
  }
  return { requests, coordinators, machines };
}

export type PulseKind = "spoke" | "mesh" | "you";
export interface PulseLane {
  /** Stable key across refreshes ("spoke:<machine id>", "mesh:<a>|<b>", "you:<coordinator id>"). */
  id: string;
  kind: PulseKind;
  /** Dots travel from (x1, y1) to (x2, y2); on a two-way lane every other dot goes back. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  twoWay: boolean;
  /** Dots on the line now (0: none, after the cap too). */
  count: number;
  periodMs: number;
  /** Static intensity, 0..3. */
  level: number;
  /** Your own request is on this line. */
  yours: boolean;
  /** Background mesh chatter only: drawn faint. */
  faint: boolean;
  /** Quiet but up: the line breathes now and then (no dot). */
  heartbeat: boolean;
}

/**
 * The pulses to draw on a laid-out graph:
 *   machine lines   while a machine runs calls: toward the coordinator while a reply streams, else
 *                   one dot toward the machine (the call going in);
 *   "You" lines     while your requests are on that coordinator: toward you while a reply streams;
 *   mesh lines      work both ways, scaled by work a minute; gossip alone is one faint dot; a quiet
 *                   line only breathes.
 * Capped at `maxDots` in all: your own lines first, then the busiest.
 */
export function pulseLanes(view: Pick<WorldView, "agents" | "coordinators" | "links" | "yourRequests">, layout: WorldLayout, maxDots?: number): PulseLane[] {
  const cap = typeof maxDots === "number" ? maxDots : PULSE_MAX_DOTS;
  const path = yourPath(view);
  const hubs: Record<string, HubNode> = {};
  layout.hubs.forEach((h) => (hubs[h.id] = h));
  const lanes: PulseLane[] = [];
  for (const node of layout.agents) {
    const hub = hubs[node.hubId];
    if (!hub) continue;
    const act = activityOf(node.row.agent);
    const count = machinePulseCount(act);
    if (count === 0) continue;
    const out = act.streaming > 0;
    lanes.push({
      id: "spoke:" + node.id, kind: "spoke",
      x1: out ? node.x : hub.x, y1: out ? node.y : hub.y, x2: out ? hub.x : node.x, y2: out ? hub.y : node.y,
      twoWay: false, count, periodMs: out ? pulsePeriod(act.callsPerMin) : PULSE_PERIODS[3],
      level: pulseLevel(count, act.callsPerMin), yours: path.machines.indexOf(node.id) >= 0, faint: false, heartbeat: false
    });
  }
  for (const link of view.links) {
    const a = hubs[link.from], b = hubs[link.to];
    if (!a || !b) continue;
    const work = link.workPerMin || 0;
    const gossip = link.gossipPerMin || 0;
    const count = meshPulseCount(work);
    const up = a.coordinator.reachable && b.coordinator.reachable;
    lanes.push({
      id: "mesh:" + [link.from, link.to].sort().join("|"), kind: "mesh",
      x1: a.x, y1: a.y, x2: b.x, y2: b.y, twoWay: count > 1,
      count: count > 0 ? count : gossip > 0 && up ? 1 : 0,
      periodMs: count > 0 ? pulsePeriod(work) : PULSE_PERIODS[3],
      level: pulseLevel(count, work), yours: false, faint: count === 0, heartbeat: count === 0 && gossip === 0 && up
    });
  }
  if (layout.you) {
    for (const hub of layout.hubs) {
      const mine = path.coordinators[hub.id];
      const linked = typeof hub.coordinator.myRttMs === "number";
      if (!mine && !linked) continue;
      const count = mine ? Math.min(PULSE_MAX_PER_LANE, mine.count) : 0;
      const toYou = !!mine && mine.streaming;
      lanes.push({
        id: "you:" + hub.id, kind: "you",
        x1: toYou ? hub.x : layout.you.x, y1: toYou ? hub.y : layout.you.y, x2: toYou ? layout.you.x : hub.x, y2: toYou ? layout.you.y : hub.y,
        twoWay: false, count, periodMs: toYou ? PULSE_PERIODS[1] : PULSE_PERIODS[2],
        level: pulseLevel(count, 0), yours: count > 0, faint: false, heartbeat: count === 0 && hub.coordinator.reachable
      });
    }
  }
  // The cap: your own lines first, then the busiest; a lane past it keeps its static level only.
  const order = lanes.slice().sort((x, y) => Number(y.yours) - Number(x.yours) || Number(x.faint) - Number(y.faint) || y.count - x.count || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  let left = Math.max(0, cap);
  for (const lane of order) {
    const take = Math.min(lane.count, left);
    lane.count = take;
    left -= take;
  }
  return lanes;
}

/** Dots a set of lanes draws in all. */
export function pulseDotCount(lanes: readonly PulseLane[]): number {
  return lanes.reduce((n, l) => n + l.count, 0);
}

/**
 * SVG `begin` for dot `index` of a lane, so it sits where the wall clock says: a graph drawn at
 * `clockMs` (its SVG timeline starting then) shows every dot at the same phase as the one before it.
 */
export function pulseBegin(lane: Pick<PulseLane, "periodMs" | "count">, index: number, clockMs: number): string {
  const p = lane.periodMs;
  const offset = (((clockMs % p) + (index * p) / Math.max(1, lane.count)) % p + p) % p;
  return "-" + (offset / 1000).toFixed(3) + "s";
}

/** Same for a heartbeat line (one breath every HEARTBEAT_MS, on the wall clock). */
export function heartbeatBegin(clockMs: number): string {
  return "-" + ((((clockMs % HEARTBEAT_MS) + HEARTBEAT_MS) % HEARTBEAT_MS) / 1000).toFixed(3) + "s";
}

export function plural(n: number, one: string): string {
  return n + " " + one + (n === 1 ? "" : "s");
}

/** The details panel's line: "Serving 2 calls now · 14 calls in the last minute". */
export function activityText(a: WorldAgent): string {
  const act = activityOf(a);
  const now = act.callsNow > 0 ? "Serving " + plural(act.callsNow, "call") + " now" : "Not serving any calls now";
  return now + " · " + (act.callsPerMin > 0 ? plural(act.callsPerMin, "call") + " in the last minute" : "none in the last minute");
}

/** For screen readers: "3 machines busy; your request is running on mac-•••30e5". */
export function activitySummary(view: Pick<WorldView, "agents" | "coordinators" | "links" | "yourRequests">, selfAgentId?: string): string {
  const busy = view.agents.filter((a) => activityOf(a).callsNow > 0).length;
  const parts = [busy === 0 ? "No machines busy" : plural(busy, "machine") + " busy"];
  const path = yourPath(view);
  const byId: Record<string, WorldAgent> = {};
  view.agents.forEach((a) => (byId[a.id] = a));
  const running = path.requests.filter((r) => r.machineKey && byId[r.machineKey]);
  const names: string[] = [];
  running.forEach((r) => {
    const n = displayName(byId[r.machineKey as string], selfAgentId);
    if (names.indexOf(n) < 0) names.push(n);
  });
  const waiting = path.requests.length - running.length;
  if (running.length === 1) parts.push("your request is running on " + names[0]);
  else if (running.length > 1) parts.push(running.length + " of your requests are running, on " + names.slice(0, 3).join(", ") + (names.length > 3 ? " and " + (names.length - 3) + " more" : ""));
  if (waiting > 0) parts.push(path.requests.length === 1 ? "your request is waiting for a machine" : waiting === 1 ? "1 of your requests is waiting for a machine" : waiting + " of your requests are waiting for a machine");
  const work = view.links.reduce((n, l) => n + (l.workPerMin || 0), 0);
  if (work > 0) parts.push(plural(work, "call") + " a minute crossing between coordinators");
  return parts.join("; ") + ".";
}
