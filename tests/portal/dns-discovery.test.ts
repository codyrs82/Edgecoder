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
