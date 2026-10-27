import { describe, it, expect } from "vitest";

// Extracted coordinator selection logic for testability
function selectCoordinator(
  coordinators: Array<{
    nodeId: string;
    dnsHostname: string;
    dnsStatus: string;
    dnsIp: string | null;
    active: boolean;
  }>
): { coordinatorUrl: string; coordinatorNodeId: string; dnsStatus: string } | null {
  const eligible = coordinators.filter(
    (c) => c.active && c.dnsStatus === "active" && c.dnsIp
  );
  if (eligible.length === 0) return null;
  const selected = eligible[0];
  return {
    coordinatorUrl: `https://${selected.dnsHostname}`,
    coordinatorNodeId: selected.nodeId,
    dnsStatus: selected.dnsStatus,
  };
}

describe("coordinator discovery logic", () => {
  it("returns the only active coordinator", () => {
    const coordinators = [
      {
        nodeId: "coord-1",
        dnsHostname: "coord-1.coord.edgecoder.io",
        dnsStatus: "active",
        dnsIp: "1.2.3.4",
        active: true,
      },
    ];
    const result = selectCoordinator(coordinators);
    expect(result).toEqual({
      coordinatorUrl: "https://coord-1.coord.edgecoder.io",
      coordinatorNodeId: "coord-1",
      dnsStatus: "active",
    });
  });

  it("returns null when no coordinators available", () => {
    const result = selectCoordinator([]);
    expect(result).toBeNull();
  });

  it("skips NAT coordinators", () => {
    const coordinators = [
      {
        nodeId: "coord-nat",
        dnsHostname: "coord-nat.coord.edgecoder.io",
        dnsStatus: "nat",
        dnsIp: null,
        active: true,
      },
    ];
    const result = selectCoordinator(coordinators);
    expect(result).toBeNull();
  });

  it("skips inactive coordinators", () => {
    const coordinators = [
      {
        nodeId: "coord-inactive",
        dnsHostname: "coord-inactive.coord.edgecoder.io",
        dnsStatus: "active",
        dnsIp: "1.2.3.4",
        active: false,
      },
    ];
    const result = selectCoordinator(coordinators);
    expect(result).toBeNull();
  });

  it("returns first coordinator when multiple available", () => {
    const coordinators = [
      {
        nodeId: "coord-1",
        dnsHostname: "coord-1.coord.edgecoder.io",
        dnsStatus: "active",
        dnsIp: "1.2.3.4",
        active: true,
      },
      {
        nodeId: "coord-2",
        dnsHostname: "coord-2.coord.edgecoder.io",
        dnsStatus: "active",
        dnsIp: "5.6.7.8",
        active: true,
      },
    ];
    const result = selectCoordinator(coordinators);
    expect(result?.coordinatorNodeId).toBe("coord-1");
  });
});

// #35: configured discovery list with fallback.
import { createCoordinatorPicker, DEFAULT_DISCOVERY_URL, discoveryConfigured, parseDiscoveryUrls } from "../../src/portal/coordinator-discovery.js";

describe("portal coordinator discovery config (#35)", () => {
  it("parses COORDINATOR_DISCOVERY_URLS in order, trimming and de-duplicating", () => {
    expect(parseDiscoveryUrls({ COORDINATOR_DISCOVERY_URLS: " https://a.example/, https://b.example ,https://a.example" })).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("still honours the legacy single COORDINATOR_DISCOVERY_URL", () => {
    expect(parseDiscoveryUrls({ COORDINATOR_DISCOVERY_URL: "https://legacy.example/" })).toEqual(["https://legacy.example"]);
    expect(discoveryConfigured({ COORDINATOR_DISCOVERY_URL: "https://legacy.example" })).toBe(true);
  });

  it("falls back to the EU seed when nothing is configured", () => {
    expect(parseDiscoveryUrls({})).toEqual([DEFAULT_DISCOVERY_URL]);
    expect(DEFAULT_DISCOVERY_URL).toBe("https://edgecoder-seed-eu.fly.dev");
    expect(discoveryConfigured({})).toBe(false);
  });

  it("first URL down, second healthy: picks the second and caches it for 60 s", async () => {
    let t = 0;
    const probed: string[] = [];
    const pick = createCoordinatorPicker({
      urls: ["https://down.example", "https://up.example"],
      probe: async (u) => {
        probed.push(u);
        if (u.includes("down")) throw new Error("ECONNREFUSED");
        return true;
      },
      now: () => t,
    });
    expect(await pick()).toBe("https://up.example");
    expect(probed).toEqual(["https://down.example", "https://up.example"]);
    t = 59_000;
    expect(await pick()).toBe("https://up.example");
    expect(probed).toHaveLength(2);
    t = 61_000;
    await pick();
    expect(probed).toHaveLength(4);
  });

  it("returns null when none is healthy", async () => {
    const pick = createCoordinatorPicker({ urls: ["https://a.example"], probe: async () => false });
    expect(await pick()).toBeNull();
  });
});
