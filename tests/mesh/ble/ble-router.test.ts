import { describe, it, expect } from "vitest";
import { BLERouter } from "../../../src/mesh/ble/ble-router.js";
import { BLEPeerEntry } from "../../../src/common/types.js";

function makePeer(overrides: Partial<BLEPeerEntry> = {}): BLEPeerEntry {
  return {
    agentId: "peer-1",
    meshTokenHash: "abc123",
    accountId: "account-1",
    model: "qwen2.5-coder:1.5b",
    modelParamSize: 1.5,
    memoryMB: 4096,
    batteryPct: 80,
    currentLoad: 0,
    deviceType: "laptop",
    rssi: -50,
    lastSeenMs: Date.now(),
    ...overrides
  };
}

describe("BLERouter", () => {
  it("adds and lists peers", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "a" }));
    router.updatePeer(makePeer({ agentId: "b" }));
    expect(router.listPeers()).toHaveLength(2);
  });

  it("evicts stale peers", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "old", lastSeenMs: Date.now() - 70_000 }));
    router.updatePeer(makePeer({ agentId: "fresh" }));
    router.evictStale();
    expect(router.listPeers()).toHaveLength(1);
    expect(router.listPeers()[0].agentId).toBe("fresh");
  });

  it("computes lower cost for idle powerful peer", () => {
    const router = new BLERouter();
    const powerful = makePeer({ agentId: "big", modelParamSize: 7, currentLoad: 0, rssi: -40 });
    const weak = makePeer({ agentId: "small", modelParamSize: 0.5, currentLoad: 2, rssi: -80 });
    const costBig = router.computeCost(powerful, 3);
    const costSmall = router.computeCost(weak, 3);
    expect(costBig).toBeLessThan(costSmall);
  });

  it("penalizes low battery on phones", () => {
    const router = new BLERouter();
    const phoneLow = makePeer({ agentId: "phone-low", deviceType: "phone", batteryPct: 10 });
    const phoneHigh = makePeer({ agentId: "phone-high", deviceType: "phone", batteryPct: 90 });
    expect(router.computeCost(phoneLow, 1)).toBeGreaterThan(router.computeCost(phoneHigh, 1));
  });

  it("selectBestPeer returns lowest cost peer", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "busy", currentLoad: 5, rssi: -80 }));
    router.updatePeer(makePeer({ agentId: "idle", currentLoad: 0, rssi: -40 }));
    const best = router.selectBestPeer(1.5);
    expect(best?.agentId).toBe("idle");
  });

  it("returns null when all costs exceed threshold", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "bad", modelParamSize: 0.1, currentLoad: 10, rssi: -90 }));
    const best = router.selectBestPeer(7);
    expect(best).toBeNull();
  });
});
