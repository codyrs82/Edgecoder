import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as W from "../../src/common/world-view.js";
import { WORLD_VIEW_BROWSER_LIB } from "../../src/portal/pages/settings-world.js";
import * as FIXTURES from "../portal/fixtures/world-view.js";
import { WORLD } from "../portal/fixtures/world-view.js";

/*
 * src/common/world-view.ts is the desktop's Network page logic, shared with the portal: the desktop
 * keeps a byte-identical copy (it does not import from src/), and the portal ships the functions
 * to the browser via Function.prototype.toString. Both must stay the same code.
 */
describe("world-view: one module for the desktop and the portal", () => {
  it("desktop/src/lib/world-view.ts is byte-identical with src/common/world-view.ts", () => {
    const shared = readFileSync(new URL("../../src/common/world-view.ts", import.meta.url), "utf8");
    const desktop = readFileSync(new URL("../../desktop/src/lib/world-view.ts", import.meta.url), "utf8");
    expect(desktop).toBe(shared);
  });

  it("the browser copy is self-contained and computes what the module does", () => {
    const lib = new Function(`${WORLD_VIEW_BROWSER_LIB}; return { rowsFor, sortRows, filterRows, nearestPeers, worldLayout, displayName, ringRadius };`)() as typeof W;
    const rows = W.rowsFor(WORLD);
    expect(JSON.parse(JSON.stringify(lib.rowsFor(WORLD)))).toEqual(JSON.parse(JSON.stringify(rows)));
    for (const key of ["latency", "region", "model", "status"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        expect(lib.sortRows(lib.rowsFor(WORLD), key, dir).map((r) => r.agent.id)).toEqual(W.sortRows(rows, key, dir).map((r) => r.agent.id));
      }
    }
    expect(lib.filterRows(rows, { scope: "mine", model: "" }).length).toBe(1);
    expect(JSON.parse(JSON.stringify(lib.worldLayout(WORLD, rows)))).toEqual(JSON.parse(JSON.stringify(W.worldLayout(WORLD, rows))));
    expect(lib.nearestPeers(rows).map((r) => r.agent.id)).toEqual(W.nearestPeers(rows).map((r) => r.agent.id));
    expect(lib.ringRadius(20)).toBe(W.ringRadius(20));
  });
});

describe("world-view layout helper", () => {
  const rows = W.rowsFor(WORLD);
  const layout = W.worldLayout(WORLD, rows);

  it("puts the coordinators west to east and every machine around its own coordinator", () => {
    expect(layout.hubs.map((h) => h.coordinator.region)).toEqual(["ord", "cdg"]);
    expect(layout.hubs[0].x).toBeLessThan(layout.hubs[1].x);
    expect(layout.agents).toHaveLength(WORLD.agents.length);
    for (const node of layout.agents) {
      const hub = layout.hubs.find((h) => h.id === node.hubId)!;
      expect(node.hubId).toBe(node.row.agent.coordinatorId);
      const d = Math.hypot(node.x - hub.x, node.y - hub.y);
      expect(d).toBeCloseTo(W.ringRadius(node.row.agent.rttMs), 0);
      expect(d).toBeGreaterThanOrEqual(W.RING_MIN - 0.5);
      expect(d).toBeLessThanOrEqual(W.RING_MAX + 0.5);
    }
  });

  it("draws the 20 ms and 100 ms rings per hub, nearer machines closer in", () => {
    expect(layout.rings.map((r) => r.ms)).toEqual([20, 100, 20, 100]);
    expect(W.ringRadius(20)).toBeLessThan(W.ringRadius(100));
    expect(W.ringRadius(null)).toBe(W.RING_MAX);
    expect(W.ringRadius(1)).toBe(W.RING_MIN);
    expect(W.ringRadius(10_000)).toBe(W.RING_MAX);
  });

  it("places You under the hubs only when a round trip from here is known", () => {
    expect(layout.you).not.toBeNull();
    expect(layout.height).toBeGreaterThan(W.CELL);
    const unmeasured = { ...WORLD, coordinators: WORLD.coordinators.map((c) => ({ ...c, myRttMs: null })) };
    const l2 = W.worldLayout(unmeasured, W.rowsFor(unmeasured));
    expect(l2.you).toBeNull();
    expect(l2.height).toBe(W.CELL);
  });

  it("names your machine and masks everyone else's", () => {
    const mine = WORLD.agents.find((a) => a.mine)!;
    const other = WORLD.agents.find((a) => !a.mine)!;
    expect(W.displayName(mine)).toBe(mine.name);
    expect(W.displayName(other)).toBe(other.label);
    expect(W.displayName({ ...other, name: "leaked" })).toBe(other.label);
  });

  it("estimates latency as my round trip to the coordinator plus its round trip to the machine", () => {
    const near = W.nearestPeers(rows);
    expect(near.length).toBeGreaterThan(0);
    const coords = new Map(WORLD.coordinators.map((c) => [c.id, c]));
    expect(near[0].estimateMs).toBe((coords.get(near[0].agent.coordinatorId)!.myRttMs as number) + (near[0].agent.rttMs as number));
  });
});

describe("pulses: activity to dots", () => {
  const { ACTIVE_WORLD, SERVING } = FIXTURES;
  const coords = ACTIVE_WORLD.coordinators.map((c) => ({ ...c, myRttMs: c.myRttMs ?? null }));
  const view = { ...ACTIVE_WORLD, coordinators: coords };
  const layout = W.worldLayout(view, W.rowsFor(view));

  it("speeds come from a few fixed steps, faster for busier lines", () => {
    expect([0, 4, 5, 19, 20, 59, 60, 10_000, Number.NaN].map(W.pulsePeriod)).toEqual([3000, 3000, 2000, 2000, 1400, 1400, 900, 900, 3000]);
    for (const p of [0, 3, 12, 40, 500]) expect(W.PULSE_PERIODS).toContain(W.pulsePeriod(p));
  });

  it("a machine gets a dot per reply streaming, one for a call starting, none when idle; capped per line", () => {
    expect(W.machinePulseCount({ callsNow: 0, streaming: 0, callsPerMin: 50 })).toBe(0);
    expect(W.machinePulseCount({ callsNow: 1, streaming: 0, callsPerMin: 0 })).toBe(1);
    expect(W.machinePulseCount({ callsNow: 2, streaming: 2, callsPerMin: 0 })).toBe(2);
    expect(W.machinePulseCount({ callsNow: 3, streaming: 3, callsPerMin: 30 })).toBe(4);
    expect(W.machinePulseCount({ callsNow: 64, streaming: 64, callsPerMin: 9_999 })).toBe(W.PULSE_MAX_PER_LANE);
    expect(W.meshPulseCount(0)).toBe(0);
    expect(W.meshPulseCount(1)).toBe(1);
    expect(W.meshPulseCount(12)).toBe(2);
    expect(W.meshPulseCount(1e6)).toBe(W.PULSE_MAX_PER_LANE);
    expect([W.pulseLevel(0, 100), W.pulseLevel(1, 0), W.pulseLevel(2, 0), W.pulseLevel(1, 60)]).toEqual([0, 1, 2, 3]);
  });

  it("streaming replies travel machine → coordinator; your path is You → ord → the serving machine", () => {
    const lanes = W.pulseLanes(view, layout);
    const node = layout.agents.find((n) => n.id === SERVING)!;
    const hub = layout.hubs.find((h) => h.id === FIXTURES.ORD)!;
    const spoke = lanes.find((l) => l.id === `spoke:${SERVING}`)!;
    expect(spoke).toMatchObject({ x1: node.x, y1: node.y, x2: hub.x, y2: hub.y, count: 2, periodMs: 2000, yours: true });
    // A call starting (no tokens yet) is one slow dot toward the machine.
    const cdgBusy = lanes.find((l) => l.id === `spoke:${ACTIVE_WORLD.agents[4].id}`)!;
    expect(cdgBusy).toMatchObject({ count: 1, periodMs: 3000, yours: false });
    expect(cdgBusy.x2).toBe(layout.agents.find((n) => n.id === ACTIVE_WORLD.agents[4].id)!.x);
    // Idle machines have no lane at all.
    expect(lanes.filter((l) => l.kind === "spoke")).toHaveLength(2);
    // Your reply streams from ord to you; the cdg line is quiet and only breathes.
    const youOrd = lanes.find((l) => l.id === `you:${FIXTURES.ORD}`)!;
    expect(youOrd).toMatchObject({ x1: hub.x, y1: hub.y, x2: layout.you!.x, y2: layout.you!.y, count: 1, yours: true, heartbeat: false });
    expect(lanes.find((l) => l.id === `you:${FIXTURES.CDG}`)).toMatchObject({ count: 0, yours: false, heartbeat: true });
    // Work across the mesh goes both ways.
    expect(lanes.find((l) => l.kind === "mesh")).toMatchObject({ count: 2, twoWay: true, faint: false, heartbeat: false, periodMs: 2000 });
  });

  it("a quiet network is calm: no dots, the lines only breathe", () => {
    const quiet = { ...view, links: view.links.map((l) => ({ ...l, workPerMin: 0, gossipPerMin: 0 })), agents: view.agents.map((a) => ({ ...a, status: a.status === "busy" ? ("idle" as const) : a.status, activity: { callsNow: 0, streaming: 0, callsPerMin: 0 } })), yourRequests: [] };
    const lanes = W.pulseLanes(quiet, W.worldLayout(quiet, W.rowsFor(quiet)));
    expect(W.pulseDotCount(lanes)).toBe(0);
    expect(lanes.filter((l) => l.heartbeat).map((l) => l.kind).sort()).toEqual(["mesh", "you", "you"]);
    // Gossip alone is one faint dot, not work.
    const gossip = { ...quiet, links: quiet.links.map((l) => ({ ...l, gossipPerMin: 20 })) };
    expect(W.pulseLanes(gossip, W.worldLayout(gossip, W.rowsFor(gossip))).find((l) => l.kind === "mesh")).toMatchObject({ count: 1, faint: true, heartbeat: false, level: 0 });
  });

  it("caps the dots on the whole graph, your own lines first", () => {
    const agents = Array.from({ length: 80 }, (_, i) => ({ ...ACTIVE_WORLD.agents[0], id: `b${String(i).padStart(9, "0")}`, label: `lin-•••${String(i).padStart(4, "0")}`, status: "busy" as const, activity: { callsNow: 4, streaming: 4, callsPerMin: 60 } }));
    const busy = { ...view, agents, yourRequests: [{ coordinator: FIXTURES.ORD, machineKey: agents[79].id, state: "streaming" as const }] };
    const lanes = W.pulseLanes(busy, W.worldLayout(busy, W.rowsFor(busy)));
    expect(W.pulseDotCount(lanes)).toBe(W.PULSE_MAX_DOTS);
    expect(lanes.find((l) => l.id === `spoke:${agents[79].id}`)!.count).toBe(W.PULSE_MAX_PER_LANE);
    expect(lanes.find((l) => l.id === `you:${FIXTURES.ORD}`)!.count).toBe(1);
    expect(W.pulseDotCount(W.pulseLanes(busy, W.worldLayout(busy, W.rowsFor(busy)), 10))).toBe(10);
  });

  it("dots keep their place on the wall clock across redraws", () => {
    const lane = { periodMs: 2000, count: 4 };
    expect(W.pulseBegin(lane, 0, 0)).toBe("-0.000s");
    expect(W.pulseBegin(lane, 1, 0)).toBe("-0.500s");
    expect(W.pulseBegin(lane, 0, 1_800_000_000_750)).toBe("-0.750s");
    // A redraw one period later starts every dot at the same phase.
    expect(W.pulseBegin(lane, 3, 1_800_000_002_750)).toBe(W.pulseBegin(lane, 3, 1_800_000_000_750));
    expect(W.heartbeatBegin(W.HEARTBEAT_MS * 3 + 1500)).toBe("-1.500s");
  });
});

describe("your path and the words for it", () => {
  const { ACTIVE_WORLD, SERVING } = FIXTURES;

  it("yourPath: the coordinator and machine of each of your requests; unknown ones left out", () => {
    const p = W.yourPath({ ...ACTIVE_WORLD, yourRequests: [...ACTIVE_WORLD.yourRequests!, { coordinator: "ghost", machineKey: SERVING, state: "streaming" }, { coordinator: FIXTURES.CDG, machineKey: "not-in-view", state: "starting" }, { coordinator: FIXTURES.CDG, machineKey: null, state: "queued" }] });
    expect(p.machines).toEqual([SERVING]);
    expect(p.coordinators).toEqual({ [FIXTURES.ORD]: { count: 1, streaming: true }, [FIXTURES.CDG]: { count: 2, streaming: false } });
    expect(p.requests).toHaveLength(3);
    expect(W.yourPath(WORLD)).toEqual({ requests: [], coordinators: {}, machines: [] });
  });

  it("the details line and the screen-reader summary", () => {
    const serving = ACTIVE_WORLD.agents[1];
    expect(W.activityText(serving)).toBe("Serving 2 calls now · 14 calls in the last minute");
    expect(W.activityText(ACTIVE_WORLD.agents[0])).toBe("Not serving any calls now · 1 call in the last minute");
    expect(W.activityText({ ...WORLD.agents[0], activity: undefined })).toBe("Not serving any calls now · none in the last minute");
    expect(W.activitySummary(ACTIVE_WORLD)).toBe("2 machines busy; your request is running on lin-•••f468; 12 calls a minute crossing between coordinators.");
    expect(W.activitySummary({ ...ACTIVE_WORLD, yourRequests: [{ coordinator: FIXTURES.ORD, machineKey: null, state: "queued" }], links: [] })).toBe("2 machines busy; your request is waiting for a machine.");
    expect(W.activitySummary(WORLD)).toBe("1 machine busy.");
  });

  it("the browser copy computes the same pulses", () => {
    const lib = new Function(`${WORLD_VIEW_BROWSER_LIB}; return { rowsFor, worldLayout, pulseLanes, activitySummary, activityText, pulseBegin };`)() as typeof W;
    const layout = W.worldLayout(ACTIVE_WORLD, W.rowsFor(ACTIVE_WORLD));
    expect(JSON.parse(JSON.stringify(lib.pulseLanes(ACTIVE_WORLD, lib.worldLayout(ACTIVE_WORLD, lib.rowsFor(ACTIVE_WORLD)))))).toEqual(JSON.parse(JSON.stringify(W.pulseLanes(ACTIVE_WORLD, layout))));
    expect(lib.activitySummary(ACTIVE_WORLD)).toBe(W.activitySummary(ACTIVE_WORLD));
    expect(lib.activityText(ACTIVE_WORLD.agents[1])).toBe(W.activityText(ACTIVE_WORLD.agents[1]));
    expect(lib.pulseBegin({ periodMs: 1400, count: 3 }, 2, 123_456)).toBe(W.pulseBegin({ periodMs: 1400, count: 3 }, 2, 123_456));
  });
});

describe("map labels: short names, placed without collisions", () => {
  const { OWNER_WORLD, OWNER_MINE } = FIXTURES;
  const layout = W.worldLayout(OWNER_WORLD, W.rowsFor(OWNER_WORLD));
  const shown = layout.labels.filter((l) => l.visible);

  it("shortens your machines' desktop names for the map, keeping the full name; masked labels stay", () => {
    expect(W.shortMachineName("desktop-macbook-pro-crs-local-51738927")).toBe("macbook-pro-crs");
    expect(W.shortMachineName("desktop-mac-example-local-a8fba2b6")).toBe("mac-example");
    expect(W.shortMachineName("codys-mac-studio")).toBe("codys-mac-studio");
    expect(W.shortMachineName("Codys-MacBook-Air.local")).toBe("Codys-MacBook-Air");
    expect(W.shortMachineName("desktop-local-1234abcd")).toBe("local-1234abcd");
    const long = W.shortMachineName("desktop-a-very-long-workstation-name-in-the-lab-local-0011aabb");
    expect(long.length).toBe(W.LABEL_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
    const mine = layout.labels.find((l) => l.full === OWNER_MINE[0])!;
    expect(mine.text).toBe("macbook-pro-crs");
    const other = OWNER_WORLD.agents.find((a) => !a.mine)!;
    expect(W.mapLabelText(other)).toBe(other.label);
    expect(W.mapLabelText({ ...other, name: "leaked" })).toBe(other.label);
  });

  it("no two shown labels overlap, and none covers a hub, a node, a ring label or the coordinator line", () => {
    expect(layout.labels).toHaveLength(OWNER_WORLD.agents.length);
    expect(shown.length).toBeGreaterThanOrEqual(10);
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(W.boxesOverlap(shown[i].box, shown[j].box), `${shown[i].text} / ${shown[j].text}`).toBe(false);
    const [ord, cdg] = layout.hubs;
    for (const l of shown) {
      for (const h of layout.hubs) expect(W.boxHitsCircle(l.box, h.x, h.y, W.HUB_R), `${l.text} on ${h.coordinator.region}`).toBe(false);
      for (const n of layout.agents) if (n.id !== l.id) expect(W.boxHitsCircle(l.box, n.x, n.y, n.r), `${l.text} on a node`).toBe(false);
      expect(W.boxHitsSegment(l.box, ord.x, ord.y, cdg.x, cdg.y, W.MESH_BAND), `${l.text} on the line`).toBe(false);
      for (const r of layout.rings) expect(W.boxesOverlap(l.box, W.textBox(r.ms + " ms", r.lx, r.ly, "start", W.RING_FONT)), `${l.text} on ${r.ms} ms`).toBe(false);
      expect(l.box.x).toBeGreaterThanOrEqual(0);
      expect(l.box.x + l.box.w).toBeLessThanOrEqual(layout.width);
    }
    // Your machines are all named on the map.
    for (const name of OWNER_MINE) expect(shown.some((l) => l.full === name)).toBe(true);
  });

  it("no machine sits on the coordinator line or on another machine", () => {
    const [ord, cdg] = layout.hubs;
    for (const n of layout.agents) {
      expect(W.boxHitsSegment({ x: n.x, y: n.y, w: 0, h: 0 }, ord.x, ord.y, cdg.x, cdg.y, n.r + 3), n.row.agent.label).toBe(false);
      for (const m of layout.agents) if (m !== n) expect(Math.hypot(m.x - n.x, m.y - n.y)).toBeGreaterThan(m.r + n.r);
    }
  });

  it("hides the lower-priority name when only one fits: yours, then busy, then the rest", () => {
    const hub = { id: "h", x: -1000, y: 10, coordinator: OWNER_WORLD.coordinators[0] };
    const node = (id: string, over: Partial<W.WorldAgent>) => ({ id, x: 20, y: 10, r: 4, hubId: "h", row: { agent: { ...OWNER_WORLD.agents[3], id, label: "lin-•••" + id, ...over }, estimateMs: 50, sameNetwork: false } });
    // A strip one label tall: only the spot right of the node fits, once.
    const strip = (agents: ReturnType<typeof node>[]) => W.placeLabels({ width: 120, height: 20, hubs: [hub], agents, rings: [], you: null }, []);
    const other = node("aaaa", {});
    const busy = node("bbbb", { status: "busy" });
    const mine = node("cccc", { mine: true, name: "desktop-x-local-1" });
    expect(strip([other, busy]).map((l) => [l.id, l.visible])).toEqual([["aaaa", false], ["bbbb", true]]);
    expect(strip([busy, mine]).map((l) => [l.id, l.visible])).toEqual([["bbbb", false], ["cccc", true]]);
    // A hidden name keeps a position, for hover and focus.
    const hidden = strip([other, busy])[0];
    expect(hidden.text).toBe("lin-•••aaaa");
    expect(Number.isFinite(hidden.x) && Number.isFinite(hidden.y)).toBe(true);
  });

  it("names only your machines when the map is crowded", () => {
    const many = { ...OWNER_WORLD, agents: Array.from({ length: 30 }, (_, i) => ({ ...OWNER_WORLD.agents[i % 12], id: "m" + String(i).padStart(3, "0") })) };
    const l = W.worldLayout(many, W.rowsFor(many));
    expect(l.labels.filter((x) => x.visible).every((x) => many.agents.find((a) => a.id === x.id)!.mine)).toBe(true);
  });

  it("is deterministic: the same answer, in any order, places the same", () => {
    const again = W.worldLayout(OWNER_WORLD, W.rowsFor(OWNER_WORLD));
    expect(JSON.stringify(again.labels)).toBe(JSON.stringify(layout.labels));
    const shuffled = { ...OWNER_WORLD, agents: [...OWNER_WORLD.agents].reverse() };
    const l2 = W.worldLayout(shuffled, W.rowsFor(shuffled));
    const byId = (ls: W.MapLabel[]) => Object.fromEntries(ls.map((x) => [x.id, x]));
    expect(byId(l2.labels)).toEqual(byId(layout.labels));
    const lib = new Function(`${WORLD_VIEW_BROWSER_LIB}; return { rowsFor, worldLayout };`)() as typeof W;
    expect(JSON.parse(JSON.stringify(lib.worldLayout(OWNER_WORLD, lib.rowsFor(OWNER_WORLD))))).toEqual(JSON.parse(JSON.stringify(layout)));
  });

  it("spreads machines evenly over the directions left free", () => {
    const even = W.spreadAngles(4, []);
    expect(even.map((a) => +a.toFixed(3))).toEqual([-Math.PI / 2 + Math.PI / 4, Math.PI / 4 - 0, (3 * Math.PI) / 4, (5 * Math.PI) / 4].map((a) => +a.toFixed(3)));
    const clear = W.spreadAngles(6, [[0, 0.3]]);
    for (const a of clear) {
      const off = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
      expect(off).toBeGreaterThanOrEqual(0.3 - 1e-3);
    }
  });
});
