import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as W from "../../src/common/world-view.js";
import { WORLD_VIEW_BROWSER_LIB } from "../../src/portal/pages/settings-world.js";
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
