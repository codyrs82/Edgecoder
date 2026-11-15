import { describe, expect, it } from "vitest";
import { WORLD } from "../a11y/world-fixture";
import { RING_MAX, RING_MIN, displayName, estimateMs, filterRows, nearestPeers, nearness, regionText, ringRadius, rowsFor, sortRows, worldLayout } from "../src/lib/world-view";

const coords = new Map(WORLD.coordinators.map((c) => [c.id, c]));
const byLabel = (l: string) => WORLD.agents.find((a) => a.label.endsWith(l))!;

describe("latency estimate", () => {
  it("is my round trip to the machine's coordinator plus the coordinator's to the machine", () => {
    expect(estimateMs(byLabel("3f2a"), coords)).toBe(38 + 18);
    expect(estimateMs(byLabel("f6b2"), coords)).toBe(112 + 158);
  });
  it("is unknown when either half is", () => {
    expect(estimateMs(byLabel("0d4e"), coords)).toBeNull();
    const noMine = new Map([...coords].map(([k, c]) => [k, { ...c, myRttMs: null }]));
    expect(estimateMs(byLabel("3f2a"), noMine)).toBeNull();
  });
  it("buckets near, mid and far", () => {
    expect([nearness(41), nearness(120), nearness(270), nearness(null)]).toEqual(["near", "mid", "far", "unknown"]);
  });
});

describe("rows", () => {
  const rows = rowsFor(WORLD);
  it("sort by latency puts unknown last in both directions", () => {
    expect(sortRows(rows, "latency").at(-1)!.agent.label).toContain("0d4e");
    expect(sortRows(rows, "latency", "desc").at(-1)!.agent.label).toContain("0d4e");
  });
  it("filters to my machines and by model", () => {
    expect(filterRows(rows, { scope: "mine", model: "" }).map((r) => r.agent.name)).toEqual(["codys-mac-studio", "codys-macbook-air"]);
    expect(filterRows(rows, { scope: "all", model: "deepseek-r1:32b" })).toHaveLength(1);
  });
  it("nearest peers leave out my machines and stale ones", () => {
    const near = nearestPeers(rows);
    expect(near.map((r) => r.estimateMs)).toEqual([41, 56, 100]);
    expect(near.every((r) => !r.agent.mine)).toBe(true);
  });
  it("names mine, masks others", () => {
    expect(displayName(byLabel("c41d"), "codys-mac-studio")).toBe("codys-mac-studio (this computer)");
    expect(displayName(byLabel("9e07"), "codys-mac-studio")).toBe("codys-macbook-air");
    expect(displayName(byLabel("3f2a"))).toBe(byLabel("3f2a").label);
    expect(regionText(byLabel("3f2a"))).toBe("ord · US");
  });
});

describe("graph layout", () => {
  it("one hub per coordinator, west to east, machines around their own coordinator", () => {
    const layout = worldLayout(WORLD, rowsFor(WORLD));
    expect(layout.hubs.map((h) => h.coordinator.region)).toEqual(["iad", "fra"]);
    expect(layout.hubs[0].x).toBeLessThan(layout.hubs[1].x);
    expect(layout.agents).toHaveLength(WORLD.agents.length);
    for (const n of layout.agents) {
      const hub = layout.hubs.find((h) => h.id === n.hubId)!;
      const d = Math.hypot(n.x - hub.x, n.y - hub.y);
      expect(d).toBeGreaterThanOrEqual(RING_MIN - 0.5);
      expect(d).toBeLessThanOrEqual(RING_MAX + 0.5);
      expect(n.x).toBeGreaterThan(0);
      expect(n.x).toBeLessThan(layout.width);
    }
    expect(layout.you).not.toBeNull();
  });
  it("closer machines sit nearer their hub", () => {
    expect(ringRadius(3)).toBeLessThan(ringRadius(60));
    expect(ringRadius(60)).toBeLessThan(ringRadius(300));
    expect(ringRadius(null)).toBe(RING_MAX);
  });
});
