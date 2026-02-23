import { describe, it, expect } from "vitest";
import { BLEMeshManager } from "../../../src/mesh/ble/ble-mesh-manager.js";
import { MockBLETransport } from "../../../src/mesh/ble/ble-transport.js";

describe("BLEMeshManager", () => {
  it("starts in offline=false by default", () => {
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("agent-a", network);
    const manager = new BLEMeshManager("agent-a", "account-a", transport);
    expect(manager.isOffline()).toBe(false);
  });

  it("activates mesh routing when offline", async () => {
    const network = new Map<string, MockBLETransport>();
    const transportA = new MockBLETransport("agent-a", network);
    const transportB = new MockBLETransport("agent-b", network);
    transportB.startAdvertising({ agentId: "agent-b", model: "qwen2.5-coder:7b", modelParamSize: 7, memoryMB: 8192, batteryPct: 90, currentLoad: 0, deviceType: "workstation" });
    transportB.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "agent-b",
      status: "completed" as const,
      generatedCode: "result = 42\nprint(result)",
      output: "42",
      cpuSeconds: 1.0,
      providerSignature: "sig-b"
    }));

    const manager = new BLEMeshManager("agent-a", "account-a", transportA);
    manager.setOffline(true);
    manager.refreshPeers();

    const result = await manager.routeTask({
      requestId: "req-1",
      requesterId: "agent-a",
      task: "compute 42",
      language: "python",
      requesterSignature: "sig-a"
    }, 1.5);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");
    expect(result!.generatedCode).toBe("result = 42\nprint(result)");
  });

  it("returns null when online (mesh dormant)", async () => {
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("agent-a", network);
    const manager = new BLEMeshManager("agent-a", "account-a", transport);
    manager.setOffline(false);

    const result = await manager.routeTask({
      requestId: "req-1",
      requesterId: "agent-a",
      task: "test",
      language: "python",
      requesterSignature: "sig-a"
    }, 1.5);

    expect(result).toBeNull();
  });

  it("records credit transaction in offline ledger", async () => {
    const network = new Map<string, MockBLETransport>();
    const transportA = new MockBLETransport("agent-a", network);
    const transportB = new MockBLETransport("agent-b", network);
    transportB.startAdvertising({ agentId: "agent-b", model: "big", modelParamSize: 7, memoryMB: 8192, batteryPct: 90, currentLoad: 0, deviceType: "laptop" });
    transportB.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "agent-b",
      status: "completed" as const,
      generatedCode: "x = 1",
      output: "",
      cpuSeconds: 2.0,
      providerSignature: "sig-b"
    }));

    const manager = new BLEMeshManager("agent-a", "account-a", transportA);
    manager.setOffline(true);
    manager.refreshPeers();
    await manager.routeTask({
      requestId: "req-1",
      requesterId: "agent-a",
      task: "test",
      language: "python",
      requesterSignature: "sig-a"
    }, 1.5);

    const pending = manager.pendingTransactions();
    expect(pending).toHaveLength(1);
    expect(pending[0].requesterId).toBe("agent-a");
    expect(pending[0].providerId).toBe("agent-b");
    expect(pending[0].cpuSeconds).toBe(2.0);
  });
});
