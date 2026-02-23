import { describe, it, expect } from "vitest";
import { BLEMeshManager, modelQualityMultiplier } from "../../src/mesh/ble/ble-mesh-manager.js";
import { MockBLETransport } from "../../src/mesh/ble/ble-transport.js";
import { BLERouter } from "../../src/mesh/ble/ble-router.js";

describe("model swap E2E with BLE re-advertisement", () => {
  it("model change on device A is visible to device B's router", () => {
    const network = new Map<string, MockBLETransport>();

    const transportA = new MockBLETransport("agent-a", network);
    transportA.startAdvertising({
      agentId: "agent-a",
      model: "qwen2.5-coder:1.5b",
      modelParamSize: 1.5,
      memoryMB: 8192,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "laptop",
    });

    const managerA = new BLEMeshManager("agent-a", "account-a", transportA);

    const transportB = new MockBLETransport("agent-b", network);
    const routerB = new BLERouter();
    for (const peer of transportB.discoveredPeers()) {
      routerB.updatePeer(peer);
    }

    const peerBefore = routerB.listPeers().find((p) => p.agentId === "agent-a");
    expect(peerBefore?.modelParamSize).toBe(1.5);

    managerA.onModelChanged("qwen2.5-coder:7b", 7);

    for (const peer of transportB.discoveredPeers()) {
      routerB.updatePeer(peer);
    }

    const peerAfter = routerB.listPeers().find((p) => p.agentId === "agent-a");
    expect(peerAfter?.model).toBe("qwen2.5-coder:7b");
    expect(peerAfter?.modelParamSize).toBe(7);
  });

  it("model swap changes quality multiplier for credit calculation", () => {
    expect(modelQualityMultiplier(1.5)).toBe(0.5);
    expect(modelQualityMultiplier(7)).toBe(1.0);
  });

  it("device is unavailable during swap (currentLoad = -1)", () => {
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("agent-a", network);
    transport.startAdvertising({
      agentId: "agent-a",
      model: "old",
      modelParamSize: 1.5,
      memoryMB: 4096,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "laptop",
    });

    const manager = new BLEMeshManager("agent-a", "account-a", transport);

    manager.onModelSwapStart();

    const transportB = new MockBLETransport("agent-b", network);
    const routerB = new BLERouter();
    for (const peer of transportB.discoveredPeers()) {
      routerB.updatePeer(peer);
    }

    const peerDuringSwap = routerB.listPeers().find((p) => p.agentId === "agent-a");
    expect(peerDuringSwap?.currentLoad).toBe(-1);

    manager.onModelChanged("new-model", 7);

    for (const peer of transportB.discoveredPeers()) {
      routerB.updatePeer(peer);
    }

    const peerAfterSwap = routerB.listPeers().find((p) => p.agentId === "agent-a");
    expect(peerAfterSwap?.currentLoad).toBe(0);
    expect(peerAfterSwap?.model).toBe("new-model");
  });
});
