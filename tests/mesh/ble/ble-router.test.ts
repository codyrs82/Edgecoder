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

  it("accepts any model size (no hard rejection)", () => {
    const router = new BLERouter();
    // A small model is still routable — just higher cost
    router.updatePeer(makePeer({ agentId: "tiny", modelParamSize: 0.5, currentLoad: 0, rssi: -40 }));
    const best = router.selectBestPeer(7);
    expect(best).not.toBeNull();
    expect(best?.agentId).toBe("tiny");
  });

  it("prefers larger models via graduated cost", () => {
    const router = new BLERouter();
    const small = makePeer({ agentId: "small", modelParamSize: 1.5, rssi: -50 });
    const large = makePeer({ agentId: "large", modelParamSize: 7, rssi: -50 });
    expect(router.computeCost(large)).toBeLessThan(router.computeCost(small));
  });

  it("penalizes unreliable peers", () => {
    const router = new BLERouter();
    const reliable = makePeer({ agentId: "reliable", taskSuccessCount: 10, taskFailCount: 0 });
    const unreliable = makePeer({ agentId: "unreliable", taskSuccessCount: 2, taskFailCount: 8 });
    expect(router.computeCost(reliable)).toBeLessThan(router.computeCost(unreliable));
  });

  it("gives benefit of doubt to new peers", () => {
    const router = new BLERouter();
    const newPeer = makePeer({ agentId: "new" });
    const reliable = makePeer({ agentId: "reliable", taskSuccessCount: 10, taskFailCount: 0 });
    expect(router.computeCost(newPeer)).toBe(router.computeCost(reliable));
  });

  it("selectBestPeer prefers reliable peer over unreliable", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "flaky", taskSuccessCount: 1, taskFailCount: 9 }));
    router.updatePeer(makePeer({ agentId: "solid", taskSuccessCount: 9, taskFailCount: 1 }));
    const best = router.selectBestPeer(1.5);
    expect(best?.agentId).toBe("solid");
  });

  it("selectBestPeer skips peers with mismatched token hash", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "same-mesh", meshTokenHash: "aaa" }));
    router.updatePeer(makePeer({ agentId: "diff-mesh", meshTokenHash: "bbb" }));
    const best = router.selectBestPeer(1.5, "aaa");
    expect(best?.agentId).toBe("same-mesh");
  });

  it("selectBestPeer returns null when no peers match token hash", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "other", meshTokenHash: "bbb" }));
    const best = router.selectBestPeer(1.5, "aaa");
    expect(best).toBeNull();
  });

  it("selectBestPeer allows all peers when ownTokenHash is undefined", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "a", meshTokenHash: "aaa" }));
    router.updatePeer(makePeer({ agentId: "b", meshTokenHash: "bbb" }));
    const best = router.selectBestPeer(1.5);
    expect(best).not.toBeNull();
  });
});

describe("BLERouter selectBestPeers", () => {
  it("returns peers sorted by cost ascending", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "busy", currentLoad: 3, rssi: -50 }));
    router.updatePeer(makePeer({ agentId: "idle", currentLoad: 0, rssi: -40 }));
    router.updatePeer(makePeer({ agentId: "medium", currentLoad: 1, rssi: -50 }));
    const peers = router.selectBestPeers(10);
    expect(peers[0].agentId).toBe("idle");
    expect(peers[peers.length - 1].agentId).toBe("busy");
  });

  it("respects limit parameter", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "a", rssi: -40 }));
    router.updatePeer(makePeer({ agentId: "b", rssi: -50 }));
    router.updatePeer(makePeer({ agentId: "c", rssi: -60 }));
    const peers = router.selectBestPeers(2);
    expect(peers).toHaveLength(2);
  });

  it("filters by token hash", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "match", meshTokenHash: "aaa" }));
    router.updatePeer(makePeer({ agentId: "no-match", meshTokenHash: "bbb" }));
    const peers = router.selectBestPeers(10, "aaa");
    expect(peers).toHaveLength(1);
    expect(peers[0].agentId).toBe("match");
  });

  it("excludes peers over cost threshold", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "good", currentLoad: 0, rssi: -40 }));
    router.updatePeer(makePeer({ agentId: "bad", modelParamSize: 0.1, currentLoad: 10, rssi: -90 }));
    const peers = router.selectBestPeers(10);
    expect(peers).toHaveLength(1);
    expect(peers[0].agentId).toBe("good");
  });
});
