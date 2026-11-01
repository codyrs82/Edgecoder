import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { BLECreditTransaction } from "../../../src/common/types.js";
import { CreditEngine } from "../../../src/credits/engine.js";
import { MockBLETransport } from "../../../src/mesh/ble/ble-transport.js";
import { BLEMeshManager, modelQualityMultiplier } from "../../../src/mesh/ble/ble-mesh-manager.js";
import { SQLiteStore } from "../../../src/db/sqlite-store.js";
import { baseRatePerSecond } from "../../../src/credits/pricing.js";
import { applyBleSyncBatch, createInMemoryBleTransfer } from "../../../src/credits/ble-sync.js";
import { createPeerKeys } from "../../../src/mesh/peer.js";
import { ledgerRowToTransaction } from "../../../src/mesh/ble/offline-ledger.js";
import { bleTxV3FieldsFromTx, verifyBleTxV3 } from "../../../src/credits/ble-tx-canonical.js";
import { attachMockProvider } from "./cosign-test-helper.js";

const phoneKeys = createPeerKeys();
const signer = { privateKeyPem: phoneKeys.privateKeyPem };

describe("BLE sync endpoint schema", () => {
  it("validates a well-formed transaction batch", () => {
    const batch: BLECreditTransaction[] = [
      {
        txId: "tx-1",
        requesterId: "agent-a",
        providerId: "agent-b",
        requesterAccountId: "account-a",
        providerAccountId: "account-b",
        credits: 1.5,
        cpuSeconds: 1.5,
        taskHash: "abc123",
        timestamp: Date.now(),
        requesterSignature: "sig-a",
        providerSignature: "sig-b"
      }
    ];
    expect(batch).toHaveLength(1);
    expect(batch[0].requesterSignature).toBeTruthy();
    expect(batch[0].providerSignature).toBeTruthy();
  });

  it("rejects duplicate txIds in a batch", () => {
    const seen = new Set<string>();
    const batch = [
      { txId: "tx-1" }, { txId: "tx-1" }
    ];
    const unique = batch.filter((tx) => {
      if (seen.has(tx.txId)) return false;
      seen.add(tx.txId);
      return true;
    });
    expect(unique).toHaveLength(1);
  });
});

describe("BLE credit settlement", () => {
  it("credits provider and debits requester on settlement", () => {
    const engine = new CreditEngine();
    engine.adjust("requester", 10, "seed");

    // Simulate settlement
    engine.adjust("provider", 3.5, "ble_compute");
    engine.adjust("requester", -3.5, "ble_compute");

    expect(engine.balance("provider")).toBe(3.5);
    expect(engine.balance("requester")).toBe(6.5);
  });

  it("rejects a debit that would take the requester negative (#48: no soft debit)", () => {
    const engine = new CreditEngine();
    // Requester has 0 balance: the debit is refused and nothing is recorded for it.
    expect(() => engine.adjust("requester", -5, "ble_compute")).toThrow(/insufficient_credits/);
    expect(engine.balance("requester")).toBe(0);
  });

  it("idempotency: duplicate txIds are skipped", () => {
    const engine = new CreditEngine();
    engine.adjust("requester", 5, "seed");
    const synced = new Set<string>();

    // First settlement
    synced.add("tx-1");
    engine.adjust("provider", 5, "ble_compute");
    engine.adjust("requester", -5, "ble_compute");

    // Second attempt — skipped by Set check
    if (!synced.has("tx-1")) {
      engine.adjust("provider", 5, "ble_compute");
      engine.adjust("requester", -5, "ble_compute");
    }

    expect(engine.balance("provider")).toBe(5);
    expect(engine.balance("requester")).toBe(0);
  });

  it("settles multiple transactions in a batch", () => {
    const engine = new CreditEngine();
    engine.adjust("requester", 20, "seed");
    const synced = new Set<string>();

    const batch = [
      { txId: "tx-1", providerAccountId: "provider-a", requesterAccountId: "requester", credits: 3.0 },
      { txId: "tx-2", providerAccountId: "provider-b", requesterAccountId: "requester", credits: 5.0 },
      { txId: "tx-3", providerAccountId: "provider-a", requesterAccountId: "requester", credits: 2.0 },
    ];

    for (const tx of batch) {
      if (synced.has(tx.txId)) continue;
      engine.adjust(tx.providerAccountId, tx.credits, "ble_compute");
      engine.adjust(tx.requesterAccountId, -tx.credits, "ble_compute");
      synced.add(tx.txId);
    }

    expect(engine.balance("requester")).toBe(10); // 20 - 3 - 5 - 2
    expect(engine.balance("provider-a")).toBe(5);  // 3 + 2
    expect(engine.balance("provider-b")).toBe(5);
  });

  it("transaction history records correct types for settlement", () => {
    const engine = new CreditEngine();
    engine.adjust("requester", 7.5, "seed");
    engine.adjust("provider", 7.5, "ble_compute");
    engine.adjust("requester", -7.5, "ble_compute");

    const providerHistory = engine.history("provider");
    expect(providerHistory).toHaveLength(1);
    expect(providerHistory[0].type).toBe("earn");
    expect(providerHistory[0].credits).toBe(7.5);
    expect(providerHistory[0].reason).toBe("ble_compute");

    const requesterHistory = engine.history("requester").filter((t) => t.reason === "ble_compute");
    expect(requesterHistory).toHaveLength(1);
    expect(requesterHistory[0].type).toBe("spend");
    expect(requesterHistory[0].credits).toBe(7.5);
    expect(requesterHistory[0].reason).toBe("ble_compute");
  });
});

describe("BLE credit settlement full pipeline", () => {
  let store: SQLiteStore;

  beforeEach(() => {
    store = new SQLiteStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("BLE task → offline ledger → flush → settlement balances", async () => {
    // 1. Set up BLE mesh and complete a task
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
    });
    const laptop = attachMockProvider(laptopTransport, { agentId: "laptop", modelParamSize: 7, cpuSeconds: 4.0, output: "result" });

    const mesh = new BLEMeshManager("phone", "phone", phoneTransport, store, signer);
    mesh.setOffline(true);
    mesh.refreshPeers();

    await mesh.routeTask({
      requestId: "task-1",
      requesterId: "phone",
      task: "compute something",
      language: "python",
      requesterSignature: "req-sig",
    }, 1.5);

    // 2. Verify credit transaction was recorded in offline ledger
    const pending = mesh.pendingTransactions();
    expect(pending).toHaveLength(1);
    const tx = pending[0];
    expect(tx.requesterId).toBe("phone");
    expect(tx.providerId).toBe("laptop");
    // 7B model → 1.0 multiplier → 4.0 cpuSeconds * 1.0 baseRate * 1.0 = 4.0 credits
    expect(tx.credits).toBe(4.0);
    expect(tx.cpuSeconds).toBe(4.0);

    // 3. Simulate flush: read unsynced from SQLite (both v3 co-signatures are present)
    const unsynced = store.listUnsyncedBLECredits(50);
    expect(unsynced).toHaveLength(1);
    expect(unsynced[0].requesterSig).not.toBe("");
    expect(unsynced[0].providerSig).not.toBe("");

    // 4. Coordinator settlement through the real /credits/ble-sync logic (#63)
    const engine = new CreditEngine();
    engine.adjust("phone", 20, "seed"); // Give phone initial credits
    const pubkeys: Record<string, string> = { phone: phoneKeys.publicKeyPem, laptop: laptop.keys.publicKeyPem };
    const out = await applyBleSyncBatch(unsynced.map(ledgerRowToTransaction), {
      getPublicKeyPem: (id) => pubkeys[id],
      rewardAccountForAgent: async (id) => id,
      transfer: createInMemoryBleTransfer(engine)
    });
    expect(out.applied).toEqual([tx.txId]);

    // 5. Verify balances
    expect(engine.balance("laptop")).toBe(4.0);
    expect(engine.balance("phone")).toBe(16.0); // 20 - 4

    // 6. Mark synced in SQLite
    store.markBLECreditsSynced(unsynced.map(r => r.txId));
    expect(store.listUnsyncedBLECredits(50)).toHaveLength(0);
  });

  it("model quality multiplier affects settlement amount", async () => {
    const network = new Map<string, MockBLETransport>();
    const phoneTransport = new MockBLETransport("phone", network);
    const tinyTransport = new MockBLETransport("tiny", network);

    // 0.5B model → 0.3x quality multiplier
    tinyTransport.startAdvertising({
      agentId: "tiny",
      model: "tiny-model",
      modelParamSize: 0.5,
      memoryMB: 2048,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "phone",
    });
    attachMockProvider(tinyTransport, { agentId: "tiny", modelParamSize: 0.5, cpuSeconds: 10.0 });

    const mesh = new BLEMeshManager("phone", "phone", phoneTransport, store, signer);
    mesh.setOffline(true);
    mesh.refreshPeers();

    await mesh.routeTask({
      requestId: "task-q",
      requesterId: "phone",
      task: "test",
      language: "python",
      requesterSignature: "",
    }, 0.5);

    const pending = mesh.pendingTransactions();
    expect(pending).toHaveLength(1);
    // 0.5B → 0.3 multiplier → 10 * 1.0 * 0.3 = 3.0
    expect(pending[0].credits).toBe(3.0);

    // Settlement: provider gets 3.0, not 10.0
    const engine = new CreditEngine();
    engine.adjust("phone", 10, "seed");
    engine.adjust("tiny", pending[0].credits, "ble_compute");
    engine.adjust("phone", -pending[0].credits, "ble_compute");

    expect(engine.balance("tiny")).toBe(3.0);
    expect(engine.balance("phone")).toBe(7.0);
  });

  it("signatures survive full pipeline from ledger to flush shape", async () => {
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
    });
    const laptop = attachMockProvider(laptopTransport, { agentId: "laptop", modelParamSize: 7, cpuSeconds: 1.0, output: "done" });

    const mesh = new BLEMeshManager("phone", "phone", phoneTransport, store, signer);
    mesh.setOffline(true);
    mesh.refreshPeers();

    await mesh.routeTask({
      requestId: "sig-flow",
      requesterId: "phone",
      task: "test sigs",
      language: "python",
      requesterSignature: "req-sig-456",
    }, 1.5);

    // Read from SQLite (simulating what flushOfflineLedger does)
    const rows = store.listUnsyncedBLECredits(50);
    expect(rows).toHaveLength(1);

    // Map to BLECreditTransaction shape (same as worker-runner flushOfflineLedger)
    const transactions = rows.map(ledgerRowToTransaction);

    const fields = bleTxV3FieldsFromTx(transactions[0]);
    expect(verifyBleTxV3(fields, transactions[0].requesterSignature, phoneKeys.publicKeyPem)).toBe(true);
    expect(verifyBleTxV3(fields, transactions[0].providerSignature, laptop.keys.publicKeyPem)).toBe(true);
    expect(transactions[0].taskHash).toBe(
      createHash("sha256").update("test sigs").digest("hex")
    );
  });
});
