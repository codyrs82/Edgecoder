import { describe, it, expect } from "vitest";
import { MockBLETransport } from "../../../src/mesh/ble/ble-transport.js";
import { BLEMeshManager } from "../../../src/mesh/ble/ble-mesh-manager.js";

describe("BLE mesh e2e (mock transport)", () => {
  it("full flow: discover -> route task -> get result -> record credit transaction", async () => {
    const network = new Map<string, MockBLETransport>();
    const phoneTransport = new MockBLETransport("iphone", network);
    const laptopTransport = new MockBLETransport("macbook", network);

    // Laptop advertises as a capable peer
    laptopTransport.startAdvertising({
      agentId: "macbook",
      model: "qwen2.5-coder:7b",
      modelParamSize: 7,
      memoryMB: 16384,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "workstation"
    });

    // Laptop handles incoming tasks
    laptopTransport.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "macbook",
      status: "completed" as const,
      generatedCode: "def factorial(n):\n    result = 1\n    for i in range(2, n+1):\n        result *= i\n    return result\nprint(factorial(10))",
      output: "3628800",
      cpuSeconds: 3.2,
      providerSignature: "laptop-sig"
    }));

    // Phone goes offline and needs to route a task
    const phoneMesh = new BLEMeshManager("iphone", "user-account", phoneTransport);
    phoneMesh.setOffline(true);
    phoneMesh.refreshPeers();

    // Phone routes task to best BLE peer
    const response = await phoneMesh.routeTask({
      requestId: "factorial-req",
      requesterId: "iphone",
      task: "Write python code to compute factorial of 10 and print it",
      language: "python",
      requesterSignature: "phone-sig"
    }, 1.5);

    // Verify task completed
    expect(response).not.toBeNull();
    expect(response!.status).toBe("completed");
    expect(response!.output).toBe("3628800");
    expect(response!.providerId).toBe("macbook");

    // Verify credit transaction recorded
    const pending = phoneMesh.pendingTransactions();
    expect(pending).toHaveLength(1);
    expect(pending[0].requesterId).toBe("iphone");
    expect(pending[0].providerId).toBe("macbook");
    expect(pending[0].requesterAccountId).toBe("user-account");
    expect(pending[0].cpuSeconds).toBe(3.2);
    expect(pending[0].credits).toBeGreaterThan(0);

    // Simulate coming back online -- export batch for sync
    const batch = phoneMesh.exportSyncBatch();
    expect(batch).toHaveLength(1);

    // Mark synced
    phoneMesh.markSynced(batch.map((tx) => tx.txId));
    expect(phoneMesh.pendingTransactions()).toHaveLength(0);
  });

  it("dormant when online -- returns null", async () => {
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("device", network);
    const mesh = new BLEMeshManager("device", "account", transport);
    mesh.setOffline(false);

    const result = await mesh.routeTask({
      requestId: "req",
      requesterId: "device",
      task: "test",
      language: "python",
      requesterSignature: "sig"
    }, 1);

    expect(result).toBeNull();
  });

  it("queues task when no suitable peer available", async () => {
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("device", network);
    const mesh = new BLEMeshManager("device", "account", transport);
    mesh.setOffline(true);

    // No peers advertising
    const result = await mesh.routeTask({
      requestId: "req",
      requesterId: "device",
      task: "test",
      language: "python",
      requesterSignature: "sig"
    }, 7);

    expect(result).toBeNull();
    expect(mesh.pendingTransactions()).toHaveLength(0);
  });

  it("applies model quality multiplier to credit calculation", async () => {
    const network = new Map<string, MockBLETransport>();
    const phoneTransport = new MockBLETransport("phone", network);
    const tinyTransport = new MockBLETransport("tiny-device", network);

    // Tiny device with a small model -- still serves tasks, just earns less
    tinyTransport.startAdvertising({
      agentId: "tiny-device",
      model: "qwen2.5-coder:0.5b",
      modelParamSize: 0.5,
      memoryMB: 2048,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "phone"
    });
    tinyTransport.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "tiny-device",
      status: "completed" as const,
      generatedCode: "print('hi')",
      output: "hi",
      cpuSeconds: 5.0,
      providerSignature: "tiny-sig"
    }));

    const mesh = new BLEMeshManager("phone", "account", phoneTransport);
    mesh.setOffline(true);
    mesh.refreshPeers();

    await mesh.routeTask({
      requestId: "req-1",
      requesterId: "phone",
      task: "say hi",
      language: "python",
      requesterSignature: "sig"
    }, 0.5);

    const pending = mesh.pendingTransactions();
    expect(pending).toHaveLength(1);
    // 0.5B model -> 0.3x multiplier -> 5.0 cpuSeconds * 1.0 baseRate * 0.3 = 1.5 credits
    expect(pending[0].credits).toBe(1.5);
  });
});
