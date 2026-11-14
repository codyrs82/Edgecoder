import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { MockBLETransport } from "../../../src/mesh/ble/ble-transport.js";
import { BLEMeshManager } from "../../../src/mesh/ble/ble-mesh-manager.js";
import { BLETaskRequest, BLETaskResponse } from "../../../src/common/types.js";
import { SQLiteStore } from "../../../src/db/sqlite-store.js";
import { serveWithCosign, requesterOptions, keysFor } from "./helpers/cosign.js";
import { bleTxV3FieldsFromWire, verifyBleTxV3 } from "../../../src/credits/ble-tx-v3.js";
import { CreditEngine } from "../../../src/credits/engine.js";
import { applyBleSyncBatch, createInMemoryBleTransfer } from "../../../src/credits/ble-sync.js";

let store: SQLiteStore;

beforeEach(() => {
  store = new SQLiteStore(":memory:");
});

afterEach(() => {
  store.close();
});

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
    serveWithCosign(laptopTransport, "macbook", async (req) => ({
      requestId: req.requestId,
      providerId: "macbook",
      status: "completed" as const,
      generatedCode: "def factorial(n):\n    result = 1\n    for i in range(2, n+1):\n        result *= i\n    return result\nprint(factorial(10))",
      output: "3628800",
      cpuSeconds: 3.2,
      providerSignature: "laptop-sig"
    }));

    // Phone goes offline and needs to route a task
    const phoneMesh = new BLEMeshManager("iphone", "user-account", phoneTransport, store, requesterOptions("iphone"));
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
    // #63: the signed reward accounts are kept in the ledger
    expect(pending[0].requesterAccountId).toBe("user-account");
    expect(pending[0].providerAccountId).toBe("macbook");
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
    serveWithCosign(tinyTransport, "tiny-device", async (req) => ({
      requestId: req.requestId,
      providerId: "tiny-device",
      status: "completed" as const,
      generatedCode: "print('hi')",
      output: "hi",
      cpuSeconds: 5.0,
      providerSignature: "tiny-sig"
    }));

    const mesh = new BLEMeshManager("phone", "account", phoneTransport, store, requesterOptions("phone"));
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

  it("peers with same mesh token hash can exchange tasks", async () => {
    const TOKEN_HASH = createHash("sha256").update("shared-secret").digest("hex");
    const network = new Map<string, MockBLETransport>();
    const phoneTransport = new MockBLETransport("phone", network);
    const laptopTransport = new MockBLETransport("laptop", network);

    laptopTransport.startAdvertising({
      agentId: "laptop",
      model: "qwen2.5-coder:7b",
      modelParamSize: 7,
      memoryMB: 16384,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "workstation",
      meshTokenHash: TOKEN_HASH,
    });
    laptopTransport.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "laptop",
      status: "completed" as const,
      output: "authenticated-result",
      cpuSeconds: 1.0,
      providerSignature: "",
    }));

    const mesh = new BLEMeshManager("phone", "account", phoneTransport, store);
    mesh.setOwnTokenHash(TOKEN_HASH);
    mesh.setOffline(true);

    const result = await mesh.routeTask({
      requestId: "auth-test",
      requesterId: "phone",
      task: "test",
      language: "python",
      requesterSignature: "",
    }, 1.5);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");
    expect(result!.output).toBe("authenticated-result");
  });

  it("inbound auth: laptop rejects task from unauthenticated phone (worker-runner pattern)", async () => {
    const LAPTOP_HASH = createHash("sha256").update("coordinator-A").digest("hex");
    const PHONE_HASH = createHash("sha256").update("coordinator-B").digest("hex");
    const network = new Map<string, MockBLETransport>();
    const phoneTransport = new MockBLETransport("phone", network);
    const laptopTransport = new MockBLETransport("laptop", network);

    // Phone advertises with a different coordinator hash
    phoneTransport.startAdvertising({
      agentId: "phone",
      model: "qwen2.5-coder:1.5b",
      modelParamSize: 1.5,
      memoryMB: 4096,
      batteryPct: 90,
      currentLoad: 0,
      deviceType: "phone",
      meshTokenHash: PHONE_HASH,
    });

    // Laptop registers an inbound handler that replicates worker-runner.ts auth check
    laptopTransport.startAdvertising({
      agentId: "laptop",
      model: "qwen2.5-coder:7b",
      modelParamSize: 7,
      memoryMB: 16384,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "workstation",
      meshTokenHash: LAPTOP_HASH,
    });
    laptopTransport.startScanning();

    laptopTransport.onTaskRequest(async (req: BLETaskRequest): Promise<BLETaskResponse> => {
      // Replicate the auth check from worker-runner.ts onTaskRequest
      const ownHash = LAPTOP_HASH;
      if (ownHash) {
        const peers = laptopTransport.discoveredPeers();
        const requesterPeer = peers.find(p => p.agentId === req.requesterId);
        if (!requesterPeer || requesterPeer.meshTokenHash !== ownHash) {
          return {
            requestId: req.requestId,
            providerId: "laptop",
            status: "failed",
            output: "mesh_token_mismatch",
            cpuSeconds: 0,
            providerSignature: "",
          };
        }
      }
      return {
        requestId: req.requestId,
        providerId: "laptop",
        status: "completed",
        output: "should-not-reach",
        cpuSeconds: 1.0,
        providerSignature: "",
      };
    });

    // Phone sends a direct task request to laptop (bypassing router)
    const resp = await phoneTransport.sendTaskRequest("laptop", {
      requestId: "unauth-req",
      requesterId: "phone",
      task: "steal compute",
      language: "python",
      requesterSignature: "",
    });

    expect(resp.status).toBe("failed");
    expect(resp.output).toBe("mesh_token_mismatch");
  });

  it("inbound auth: laptop accepts task from authenticated phone (same coordinator)", async () => {
    const SHARED_HASH = createHash("sha256").update("same-coordinator").digest("hex");
    const network = new Map<string, MockBLETransport>();
    const phoneTransport = new MockBLETransport("phone", network);
    const laptopTransport = new MockBLETransport("laptop", network);

    phoneTransport.startAdvertising({
      agentId: "phone",
      model: "qwen2.5-coder:1.5b",
      modelParamSize: 1.5,
      memoryMB: 4096,
      batteryPct: 90,
      currentLoad: 0,
      deviceType: "phone",
      meshTokenHash: SHARED_HASH,
    });

    laptopTransport.startAdvertising({
      agentId: "laptop",
      model: "qwen2.5-coder:7b",
      modelParamSize: 7,
      memoryMB: 16384,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "workstation",
      meshTokenHash: SHARED_HASH,
    });
    laptopTransport.startScanning();

    laptopTransport.onTaskRequest(async (req: BLETaskRequest): Promise<BLETaskResponse> => {
      const ownHash = SHARED_HASH;
      if (ownHash) {
        const peers = laptopTransport.discoveredPeers();
        const requesterPeer = peers.find(p => p.agentId === req.requesterId);
        if (!requesterPeer || requesterPeer.meshTokenHash !== ownHash) {
          return {
            requestId: req.requestId,
            providerId: "laptop",
            status: "failed",
            output: "mesh_token_mismatch",
            cpuSeconds: 0,
            providerSignature: "",
          };
        }
      }
      return {
        requestId: req.requestId,
        providerId: "laptop",
        status: "completed",
        output: "authenticated-work-done",
        cpuSeconds: 2.0,
        providerSignature: "",
      };
    });

    const resp = await phoneTransport.sendTaskRequest("laptop", {
      requestId: "auth-req",
      requesterId: "phone",
      task: "do work",
      language: "python",
      requesterSignature: "",
    });

    expect(resp.status).toBe("completed");
    expect(resp.output).toBe("authenticated-work-done");
  });

  it("peers with different mesh token hashes cannot exchange tasks", async () => {
    const network = new Map<string, MockBLETransport>();
    const phoneTransport = new MockBLETransport("phone", network);
    const laptopTransport = new MockBLETransport("laptop", network);

    laptopTransport.startAdvertising({
      agentId: "laptop",
      model: "qwen2.5-coder:7b",
      modelParamSize: 7,
      memoryMB: 16384,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "workstation",
      meshTokenHash: "coordinator-A-hash",
    });
    laptopTransport.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "laptop",
      status: "completed" as const,
      output: "should-not-reach",
      cpuSeconds: 1.0,
      providerSignature: "",
    }));

    const mesh = new BLEMeshManager("phone", "account", phoneTransport, store);
    mesh.setOwnTokenHash("coordinator-B-hash");
    mesh.setOffline(true);

    const result = await mesh.routeTask({
      requestId: "cross-mesh-test",
      requesterId: "phone",
      task: "test",
      language: "python",
      requesterSignature: "",
    }, 1.5);

    expect(result).toBeNull();
  });

  it("failover: routes to second peer when first fails", async () => {
    const network = new Map<string, MockBLETransport>();
    const phoneTransport = new MockBLETransport("phone", network);
    const flakyTransport = new MockBLETransport("flaky", network);
    const reliableTransport = new MockBLETransport("reliable", network);

    flakyTransport.startAdvertising({
      agentId: "flaky",
      model: "qwen2.5-coder:7b",
      modelParamSize: 7,
      memoryMB: 16384,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "workstation",
    });
    reliableTransport.startAdvertising({
      agentId: "reliable",
      model: "qwen2.5-coder:7b",
      modelParamSize: 7,
      memoryMB: 16384,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "workstation",
    });

    flakyTransport.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "flaky",
      status: "failed" as const,
      output: "ble_timeout",
      cpuSeconds: 0,
      providerSignature: "",
    }));
    serveWithCosign(reliableTransport, "reliable", async (req) => ({
      requestId: req.requestId,
      providerId: "reliable",
      status: "completed" as const,
      generatedCode: "print('ok')",
      output: "ok",
      cpuSeconds: 2.0,
      providerSignature: "rel-sig",
    }));

    const mesh = new BLEMeshManager("phone", "account", phoneTransport, store, requesterOptions("phone"));
    mesh.setOffline(true);
    mesh.refreshPeers();

    const result = await mesh.routeTask({
      requestId: "failover-test",
      requesterId: "phone",
      task: "failover task",
      language: "python",
      requesterSignature: "sig",
    }, 7);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");
    expect(result!.output).toBe("ok");

    // Credit should go to the reliable peer, not the flaky one
    const pending = mesh.pendingTransactions();
    expect(pending).toHaveLength(1);
    expect(pending[0].providerId).toBe("reliable");
    expect(pending[0].cpuSeconds).toBe(2.0);
  });

  it("desktop<->desktop co-signed tx syncs through /credits/ble-sync as applied; any 1-milli tamper is invalid_signature (#63)", async () => {
    const network = new Map<string, MockBLETransport>();
    const phoneTransport = new MockBLETransport("phone", network);
    const laptopTransport = new MockBLETransport("laptop", network);
    laptopTransport.startAdvertising({
      agentId: "laptop",
      model: "qwen2.5-coder:3b",
      modelParamSize: 3,
      memoryMB: 16384,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "workstation",
    });
    serveWithCosign(laptopTransport, "laptop", async (req) => ({
      requestId: req.requestId,
      providerId: "laptop",
      status: "completed" as const,
      output: "signed-output",
      cpuSeconds: 2.537,
      providerSignature: "",
    }), "laptop-owner");

    const mesh = new BLEMeshManager("phone", "phone-owner", phoneTransport, store, requesterOptions("phone"));
    mesh.setOffline(true);
    await mesh.routeTask({ requestId: "signed-req", requesterId: "phone", task: "compute signed result", language: "python", requesterSignature: "" }, 3);

    const [tx] = mesh.exportSyncBatch();
    expect(tx).toBeDefined();
    // 2537 cpu millis x 0.7 (3B model) = 1775.9 -> 1776 credit millis
    expect(tx.credits).toBe(1.776);
    expect(tx.cpuSeconds).toBe(2.537);
    const fields = bleTxV3FieldsFromWire(tx)!;
    expect(verifyBleTxV3(fields, tx.requesterSignature, keysFor("phone").publicKeyPem)).toBe(true);
    expect(verifyBleTxV3(fields, tx.providerSignature, keysFor("laptop").publicKeyPem)).toBe(true);

    const accounts: Record<string, string> = { phone: "phone-owner", laptop: "laptop-owner" };
    const setup = () => {
      const engine = new CreditEngine();
      engine.adjust("phone-owner", 10, "seed");
      return {
        engine,
        deps: {
          getPublicKeyPem: (id: string) => keysFor(id).publicKeyPem,
          rewardAccountForAgent: async (id: string) => accounts[id] ?? id,
          transfer: createInMemoryBleTransfer(engine),
        },
      };
    };
    for (const change of [{ credits: 1.777 }, { credits: 1.775 }, { cpuSeconds: 2.538 }]) {
      const { engine, deps } = setup();
      const out = await applyBleSyncBatch([{ ...tx, ...change }], deps);
      expect(out.skipped).toEqual([{ txId: tx.txId, reason: "invalid_signature" }]);
      expect(engine.balance("laptop-owner")).toBe(0);
    }
    const { engine, deps } = setup();
    const out = await applyBleSyncBatch([tx], deps);
    expect(out.applied).toEqual([tx.txId]);
    expect(engine.balance("laptop-owner")).toBeCloseTo(1.776, 9);
    expect(engine.balance("phone-owner")).toBeCloseTo(10 - 1.776, 9);
  });
});
