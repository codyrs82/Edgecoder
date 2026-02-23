import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BLEMeshManager, modelQualityMultiplier } from "../../../src/mesh/ble/ble-mesh-manager.js";
import { MockBLETransport } from "../../../src/mesh/ble/ble-transport.js";
import { SQLiteStore } from "../../../src/db/sqlite-store.js";

let store: SQLiteStore;

beforeEach(() => {
  store = new SQLiteStore(":memory:");
});

afterEach(() => {
  store.close();
});

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

    const manager = new BLEMeshManager("agent-a", "account-a", transportA, store);
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

  it("applies model quality multiplier to credits", async () => {
    const network = new Map<string, MockBLETransport>();
    const transportA = new MockBLETransport("agent-a", network);
    const transportSmall = new MockBLETransport("agent-small", network);
    transportSmall.startAdvertising({ agentId: "agent-small", model: "tiny", modelParamSize: 0.5, memoryMB: 2048, batteryPct: 100, currentLoad: 0, deviceType: "phone" });
    transportSmall.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "agent-small",
      status: "completed" as const,
      generatedCode: "x = 1",
      output: "",
      cpuSeconds: 10.0,
      providerSignature: "sig-s"
    }));

    const manager = new BLEMeshManager("agent-a", "account-a", transportA, store);
    manager.setOffline(true);
    manager.refreshPeers();
    await manager.routeTask({
      requestId: "req-1",
      requesterId: "agent-a",
      task: "test",
      language: "python",
      requesterSignature: "sig-a"
    }, 0.5);

    const pending = manager.pendingTransactions();
    expect(pending).toHaveLength(1);
    // 0.5B model → 0.3x multiplier → 10 cpuSeconds * 1.0 baseRate * 0.3 = 3.0
    expect(pending[0].credits).toBe(3.0);
  });
});

describe("BLEMeshManager trust scoring integration", () => {
  it("refreshPeers merges SQLite trust data and routing prefers reliable peer", async () => {
    const network = new Map<string, MockBLETransport>();
    const transportA = new MockBLETransport("agent-a", network);
    const transportReliable = new MockBLETransport("reliable-peer", network);
    const transportFlaky = new MockBLETransport("flaky-peer", network);

    // Both peers advertise identical specs
    const adSpec = { model: "qwen2.5-coder:7b", modelParamSize: 7, memoryMB: 8192, batteryPct: 90, currentLoad: 0, deviceType: "laptop" as const };
    transportReliable.startAdvertising({ agentId: "reliable-peer", ...adSpec });
    transportFlaky.startAdvertising({ agentId: "flaky-peer", ...adSpec });

    // Both handle tasks
    for (const t of [transportReliable, transportFlaky]) {
      t.onTaskRequest(async (req) => ({
        requestId: req.requestId,
        providerId: t === transportReliable ? "reliable-peer" : "flaky-peer",
        status: "completed" as const,
        output: "ok",
        cpuSeconds: 1.0,
        providerSignature: "",
      }));
    }

    // Seed SQLite with trust history: reliable = 10 successes, flaky = 8 fails + 2 successes
    store.upsertBLEPeer("reliable-peer", "qwen2.5-coder:7b", 7, "laptop", -50);
    store.upsertBLEPeer("flaky-peer", "qwen2.5-coder:7b", 7, "laptop", -50);
    for (let i = 0; i < 10; i++) store.recordBLETaskResult("reliable-peer", true);
    for (let i = 0; i < 2; i++) store.recordBLETaskResult("flaky-peer", true);
    for (let i = 0; i < 8; i++) store.recordBLETaskResult("flaky-peer", false);

    const manager = new BLEMeshManager("agent-a", "account-a", transportA, store);
    manager.setOffline(true);

    // Route a task — should pick reliable-peer (lower cost due to trust)
    const resp = await manager.routeTask({
      requestId: "trust-test-1",
      requesterId: "agent-a",
      task: "test task",
      language: "python",
      requesterSignature: "",
    }, 7);

    expect(resp).not.toBeNull();
    expect(resp!.providerId).toBe("reliable-peer");
  });

  it("recordBLETaskResult updates trust and affects subsequent routing", async () => {
    const network = new Map<string, MockBLETransport>();
    const transportA = new MockBLETransport("agent-a", network);
    const transportPeer = new MockBLETransport("peer-x", network);

    transportPeer.startAdvertising({ agentId: "peer-x", model: "qwen2.5-coder:7b", modelParamSize: 7, memoryMB: 8192, batteryPct: 90, currentLoad: 0, deviceType: "laptop" });
    transportPeer.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "peer-x",
      status: "completed" as const,
      output: "ok",
      cpuSeconds: 1.0,
      providerSignature: "",
    }));

    // Seed peer in SQLite so recordBLETaskResult has a row to update
    store.upsertBLEPeer("peer-x", "qwen2.5-coder:7b", 7, "laptop", -50);

    // Record 10 failures
    for (let i = 0; i < 10; i++) store.recordBLETaskResult("peer-x", false);

    // Verify the trust data is in SQLite
    const rows = store.listBLEPeers();
    const peerRow = rows.find(r => r.agentId === "peer-x");
    expect(peerRow).toBeDefined();
    expect(peerRow!.taskFailCount).toBe(10);
    expect(peerRow!.taskSuccessCount).toBe(0);

    const manager = new BLEMeshManager("agent-a", "account-a", transportA, store);
    manager.setOffline(true);

    // Even with 100% fail rate, peer is still routable (cost increases but stays under threshold)
    const resp = await manager.routeTask({
      requestId: "fail-test-1",
      requesterId: "agent-a",
      task: "test",
      language: "python",
      requesterSignature: "",
    }, 7);

    // 7B model → modelPenalty=0, load=0, battery=0, signal=(50-30)*0.5=10, reliability=60
    // Total = 70, under COST_THRESHOLD of 200, so still routable
    expect(resp).not.toBeNull();
    expect(resp!.providerId).toBe("peer-x");
  });
});

describe("BLEMeshManager mesh token auth", () => {
  it("routeTask skips peers with mismatched mesh token hash", async () => {
    const network = new Map<string, MockBLETransport>();
    const transportA = new MockBLETransport("agent-a", network);
    const transportB = new MockBLETransport("agent-b", network);
    transportB.startAdvertising({ agentId: "agent-b", model: "qwen", modelParamSize: 7, memoryMB: 8192, batteryPct: 90, currentLoad: 0, deviceType: "laptop", meshTokenHash: "different-hash" });
    transportB.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "agent-b",
      status: "completed" as const,
      output: "ok",
      cpuSeconds: 1.0,
      providerSignature: "",
    }));

    const manager = new BLEMeshManager("agent-a", "account-a", transportA);
    manager.setOwnTokenHash("my-hash");
    manager.setOffline(true);

    const result = await manager.routeTask({
      requestId: "req-1",
      requesterId: "agent-a",
      task: "test",
      language: "python",
      requesterSignature: "",
    }, 1.5);

    expect(result).toBeNull();
  });

  it("routeTask succeeds when peer has matching mesh token hash", async () => {
    const network = new Map<string, MockBLETransport>();
    const transportA = new MockBLETransport("agent-a", network);
    const transportB = new MockBLETransport("agent-b", network);
    transportB.startAdvertising({ agentId: "agent-b", model: "qwen", modelParamSize: 7, memoryMB: 8192, batteryPct: 90, currentLoad: 0, deviceType: "laptop", meshTokenHash: "shared-hash" });
    transportB.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "agent-b",
      status: "completed" as const,
      output: "authenticated",
      cpuSeconds: 1.0,
      providerSignature: "",
    }));

    const manager = new BLEMeshManager("agent-a", "account-a", transportA, store);
    manager.setOwnTokenHash("shared-hash");
    manager.setOffline(true);

    const result = await manager.routeTask({
      requestId: "req-1",
      requesterId: "agent-a",
      task: "test",
      language: "python",
      requesterSignature: "",
    }, 1.5);

    expect(result).not.toBeNull();
    expect(result!.output).toBe("authenticated");
  });
});

describe("modelQualityMultiplier", () => {
  it("returns 1.0 for 7B+ models", () => {
    expect(modelQualityMultiplier(7)).toBe(1.0);
    expect(modelQualityMultiplier(13)).toBe(1.0);
  });

  it("returns 0.7 for 3B-7B models", () => {
    expect(modelQualityMultiplier(3)).toBe(0.7);
    expect(modelQualityMultiplier(5)).toBe(0.7);
  });

  it("returns 0.5 for 1.5B-3B models", () => {
    expect(modelQualityMultiplier(1.5)).toBe(0.5);
    expect(modelQualityMultiplier(2)).toBe(0.5);
  });

  it("returns 0.3 for sub-1.5B models", () => {
    expect(modelQualityMultiplier(0.5)).toBe(0.3);
    expect(modelQualityMultiplier(1)).toBe(0.3);
  });
});
