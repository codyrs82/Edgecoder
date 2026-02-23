import { describe, it, expect } from "vitest";
import { BLEMeshManager } from "../../../src/mesh/ble/ble-mesh-manager.js";
import { MockBLETransport } from "../../../src/mesh/ble/ble-transport.js";

describe("BLE model re-advertisement", () => {
  it("updates advertisement when model changes", () => {
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("agent-a", network);
    transport.startAdvertising({
      agentId: "agent-a",
      model: "qwen2.5-coder:1.5b",
      modelParamSize: 1.5,
      memoryMB: 4096,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "laptop",
    });

    const manager = new BLEMeshManager("agent-a", "account-a", transport);
    manager.onModelChanged("qwen2.5-coder:7b", 7);

    const ad = transport.currentAdvertisement();
    expect(ad).not.toBeNull();
    expect(ad!.model).toBe("qwen2.5-coder:7b");
    expect(ad!.modelParamSize).toBe(7);
    expect(ad!.currentLoad).toBe(0);
  });

  it("sets currentLoad to -1 during swap then resets", () => {
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
    expect(transport.currentAdvertisement()!.currentLoad).toBe(-1);

    manager.onModelChanged("new-model", 3);
    expect(transport.currentAdvertisement()!.currentLoad).toBe(0);
    expect(transport.currentAdvertisement()!.model).toBe("new-model");
  });
});
