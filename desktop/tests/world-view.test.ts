import { describe, expect, it } from "vitest";
import { WORLD } from "../a11y/world-fixture";
import { RING_MAX, RING_MIN, displayName, estimateMs, filterRows, formatMs, lanDistance, lanMs, nearestPeers, nearestText, nearestToYou, nearness, regionText, ringRadius, rowsFor, sortRows, worldLayout } from "../src/lib/world-view";

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

describe("your machines on the same local network", () => {
  // codys-macbook-air answered a direct ping from this computer (codys-mac-studio) in 2 ms.
  const lanWorld = () => ({
    ...WORLD,
    agents: WORLD.agents.map((a) => (a.name === "codys-macbook-air" ? { ...a, lan: { sameNetwork: true, rttMs: 2.2 } } : a))
  });

  it("uses the measured round trip, not the coordinator estimate", () => {
    const rows = rowsFor(lanWorld());
    const air = rows.find((r) => r.agent.name === "codys-macbook-air")!;
    expect(air.estimateMs).toBe(2.2);
    expect(air.sameNetwork).toBe(true);
    expect(rows.filter((r) => r.sameNetwork)).toHaveLength(1);
  });

  it("any machine on this network counts (yours or someone else's), only when it was measured", () => {
    const other = WORLD.agents.find((a) => !a.mine)!;
    expect(lanMs({ ...other, lan: { sameNetwork: true, rttMs: 1 } })).toBe(1);
    expect(lanMs(other)).toBeNull();
    const air = WORLD.agents.find((a) => a.name === "codys-macbook-air")!;
    expect(lanMs({ ...air, lan: { sameNetwork: false, rttMs: null } })).toBeNull();
  });

  it("nearest to you: someone else's machine on this network comes first, masked, and is listed once", () => {
    const other = WORLD.agents.find((a) => !a.mine && a.status !== "stale")!;
    const w = { ...WORLD, agents: WORLD.agents.map((a) => (a.id === other.id ? { ...a, lan: { sameNetwork: true, rttMs: 3.4 } } : a)) };
    const near = nearestToYou(rowsFor(w), WORLD.selfAgentId, 5);
    expect(near[0].agent.id).toBe(other.id);
    expect(nearestText(near[0], WORLD.selfAgentId)).toBe(`${other.label} (same network)`);
    expect(new Set(near.map((r) => r.agent.id)).size).toBe(near.length);
  });

  it("nearest to you: the LAN machine first, labelled same network; others stay masked", () => {
    const rows = rowsFor(lanWorld());
    const near = nearestToYou(rows, WORLD.selfAgentId);
    expect(near[0].agent.name).toBe("codys-macbook-air");
    expect(nearestText(near[0], WORLD.selfAgentId)).toBe("codys-macbook-air (same network)");
    expect(formatMs(near[0].estimateMs)).toBe("2 ms");
    for (const r of near.slice(1)) {
      expect(r.agent.mine).toBe(false);
      expect(nearestText(r)).toMatch(/^[a-z]{3}-•••[0-9a-f]{4}/);
    }
    // Without LAN facts it is the old answer: other people's machines by the estimate.
    expect(nearestToYou(rowsFor(WORLD), WORLD.selfAgentId).map((r) => r.agent.id)).toEqual(nearestPeers(rowsFor(WORLD)).map((r) => r.agent.id));
  });

  it("this computer is never its own nearest", () => {
    const w = { ...WORLD, agents: WORLD.agents.map((a) => (a.mine ? { ...a, lan: { sameNetwork: true, rttMs: 0.1 } } : a)) };
    expect(nearestToYou(rowsFor(w), WORLD.selfAgentId)[0].agent.name).toBe("codys-macbook-air");
  });

  it("graph: LAN machines sit beside You, nearer for a shorter round trip", () => {
    const w = lanWorld();
    const layout = worldLayout(w, rowsFor(w));
    const node = layout.agents.find((n) => n.row.agent.name === "codys-macbook-air")!;
    expect(node.lan).toBe(true);
    expect(node.y).toBe(layout.you!.y);
    expect(Math.abs(node.x - layout.you!.x)).toBeCloseTo(lanDistance(2.2), 1);
    expect(lanDistance(1)).toBeLessThan(lanDistance(15));
    expect(layout.agents).toHaveLength(w.agents.length);
  });

  it("formats sub-millisecond round trips", () => {
    expect(formatMs(0.4)).toBe("<1 ms");
  });
});
