import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CreditEngine } from "../../../src/credits/engine.js";
import { applyBleSyncBatch, createInMemoryBleTransfer } from "../../../src/credits/ble-sync.js";
import { bleTxV3FieldsFromTx, toMillis, verifyBleTxV3 } from "../../../src/credits/ble-tx-canonical.js";
import { BLE_COSIGN_MSG_TYPE, BleProviderCoSigner, parseBleCoSignRequest } from "../../../src/mesh/ble/ble-cosign.js";
import { BLEMeshManager, computeBleCredits } from "../../../src/mesh/ble/ble-mesh-manager.js";
import { MockBLETransport } from "../../../src/mesh/ble/ble-transport.js";
import { SQLiteStore } from "../../../src/db/sqlite-store.js";
import { createPeerKeys } from "../../../src/mesh/peer.js";
import { attachMockProvider } from "./cosign-test-helper.js";

const providerKeys = createPeerKeys();

function makeSigner(opts: Partial<ConstructorParameters<typeof BleProviderCoSigner>[0]> = {}) {
  return new BleProviderCoSigner({
    agentId: "prov",
    accountId: "prov",
    privateKeyPem: providerKeys.privateKeyPem,
    modelParamSize: () => 7,
    ...opts
  });
}

function fieldsFor(cpuSeconds: number, credits: number, overrides: Record<string, unknown> = {}) {
  return {
    ...bleTxV3FieldsFromTx({
      txId: "tx-1",
      requesterId: "req",
      requesterAccountId: "req",
      providerId: "prov",
      providerAccountId: "prov",
      taskHash: "hash-1",
      cpuSeconds,
      credits
    }),
    timestamp: 1_700_000_000_000,
    ...overrides
  };
}

describe("BleProviderCoSigner (#63 provider-side checks)", () => {
  it("signs a transaction matching what it served, idempotently for the same txId", () => {
    const signer = makeSigner();
    signer.recordServed({ requestId: "r1", requesterId: "req", taskHash: "hash-1", cpuSeconds: 4 });
    const req = { type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(4, computeBleCredits(4, 7)) } as const;
    const res = signer.handle(req);
    expect(res.status).toBe("signed");
    expect(verifyBleTxV3(req.tx, res.providerSignature!, providerKeys.publicKeyPem)).toBe(true);
    // Replay of the same txId -> same signature, no second charge.
    expect(signer.handle(req)).toEqual(res);
    // A different txId for the same served task -> already co-signed.
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: { ...req.tx, txId: "tx-2" } }).reason).toBe("already_cosigned");
  });

  it("rejects unknown tasks, cpu mismatch, inflated or deflated credits and wrong provider", () => {
    const signer = makeSigner();
    signer.recordServed({ requestId: "r1", requesterId: "req", taskHash: "hash-1", cpuSeconds: 4 });
    const ok = computeBleCredits(4, 7); // 4.0
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(4, ok, { taskHash: "other" }) }).reason).toBe("unknown_task");
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(4, ok, { requesterId: "someone" }) }).reason).toBe("unknown_task");
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(5, ok) }).reason).toBe("cpu_mismatch");
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(4, ok * 2) }).reason).toBe("credit_mismatch");
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(4, ok / 2) }).reason).toBe("credit_mismatch");
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(4, ok, { providerId: "other" }) }).reason).toBe("provider_mismatch");
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(4, ok, { providerAccountId: "other" }) }).reason).toBe("provider_mismatch");
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(4, ok, { txId: "a\nb" }) }).reason).toBe("invalid_payload");
    // Still signable after all those rejections (nothing was consumed).
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(4, ok) }).status).toBe("signed");
  });

  it("tolerates rounding noise but not more (max(2 milli, 1%))", () => {
    const signer = makeSigner();
    signer.recordServed({ requestId: "r1", requesterId: "req", taskHash: "hash-1", cpuSeconds: 10 });
    const expected = toMillis(computeBleCredits(10, 7)); // 10000 milli -> 1% = 100
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: { ...fieldsFor(10, 10), creditMillis: expected + 100 } }).status).toBe("signed");
    const signer2 = makeSigner();
    signer2.recordServed({ requestId: "r1", requesterId: "req", taskHash: "hash-1", cpuSeconds: 10 });
    expect(signer2.handle({ type: BLE_COSIGN_MSG_TYPE, tx: { ...fieldsFor(10, 10), creditMillis: expected + 101 } }).reason).toBe("credit_mismatch");
  });

  it("uses its own model multiplier, not the requester's claim", () => {
    const signer = makeSigner({ modelParamSize: () => 0.5 }); // 0.3x
    signer.recordServed({ requestId: "r1", requesterId: "req", taskHash: "hash-1", cpuSeconds: 10 });
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(10, 10) }).reason).toBe("credit_mismatch");
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(10, 3) }).status).toBe("signed");
  });

  it("served tasks expire", () => {
    let now = 1_000_000;
    const signer = makeSigner({ now: () => now, ttlMs: 1000 });
    signer.recordServed({ requestId: "r1", requesterId: "req", taskHash: "hash-1", cpuSeconds: 4 });
    now += 2000;
    expect(signer.handle({ type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(4, 4) }).reason).toBe("unknown_task");
  });

  it("parseBleCoSignRequest rejects malformed wire messages", () => {
    expect(parseBleCoSignRequest({ type: "task" })).toBeNull();
    expect(parseBleCoSignRequest({ type: BLE_COSIGN_MSG_TYPE })).toBeNull();
    expect(parseBleCoSignRequest({ type: BLE_COSIGN_MSG_TYPE, tx: { ...fieldsFor(4, 4), creditMillis: "4000" } })).toBeNull();
    expect(parseBleCoSignRequest({ type: BLE_COSIGN_MSG_TYPE, tx: { ...fieldsFor(4, 4), txId: "x\ny" } })).toBeNull();
    const ok = parseBleCoSignRequest({ type: BLE_COSIGN_MSG_TYPE, tx: fieldsFor(4, 4) });
    expect(ok?.tx.creditMillis).toBe(4000);
  });
});

describe("desktop <-> desktop offline transaction (#63 acceptance)", () => {
  function setupPair() {
    const network = new Map<string, MockBLETransport>();
    const reqTransport = new MockBLETransport("laptop-a", network);
    const provTransport = new MockBLETransport("laptop-b", network);
    provTransport.startAdvertising({ agentId: "laptop-b", model: "qwen2.5-coder:7b", modelParamSize: 7, memoryMB: 16384, batteryPct: 100, currentLoad: 0, deviceType: "laptop" });
    const provider = attachMockProvider(provTransport, { agentId: "laptop-b", modelParamSize: 7, cpuSeconds: 3.2, output: "done" });
    const requesterKeys = createPeerKeys();
    const store = new SQLiteStore(":memory:");
    const failures: string[] = [];
    const manager = new BLEMeshManager("laptop-a", "laptop-a", reqTransport, store, {
      privateKeyPem: requesterKeys.privateKeyPem,
      onCoSignFailure: (f) => failures.push(f.reason)
    });
    manager.setOffline(true);
    const pubkeys: Record<string, string> = { "laptop-a": requesterKeys.publicKeyPem, "laptop-b": provider.keys.publicKeyPem };
    return { manager, provider, store, failures, pubkeys, reqTransport, provTransport };
  }

  it("co-signed tx is recorded, flushed and applied by /credits/ble-sync", async () => {
    const { manager, provider, store, failures, pubkeys } = setupPair();
    const task = "write fizzbuzz";
    const resp = await manager.routeTask({ requestId: "req-1", requesterId: "laptop-a", task, language: "python", requesterSignature: "" }, 7);
    expect(resp?.status).toBe("completed");
    expect(failures).toEqual([]);
    expect(provider.coSignRequests).toHaveLength(1);

    const pending = manager.pendingTransactions();
    expect(pending).toHaveLength(1);
    const tx = pending[0];
    expect(tx.taskHash).toBe(createHash("sha256").update(task).digest("hex"));
    expect(tx.credits).toBe(3.2);
    expect(tx.cpuSeconds).toBe(3.2);
    expect(tx.requesterAccountId).toBe("laptop-a");
    expect(tx.providerAccountId).toBe("laptop-b");
    const fields = bleTxV3FieldsFromTx(tx);
    expect(verifyBleTxV3(fields, tx.requesterSignature, pubkeys["laptop-a"])).toBe(true);
    expect(verifyBleTxV3(fields, tx.providerSignature, pubkeys["laptop-b"])).toBe(true);
    // The SQLite row keeps the signed account ids (what worker-runner flushes).
    const row = store.listUnsyncedBLECredits()[0];
    expect(row.requesterAccountId).toBe("laptop-a");
    expect(row.providerAccountId).toBe("laptop-b");

    // Coordinator side.
    const engine = new CreditEngine();
    engine.adjust("laptop-a", 10, "seed");
    const deps = { getPublicKeyPem: (id: string) => pubkeys[id], rewardAccountForAgent: async (id: string) => id, transfer: createInMemoryBleTransfer(engine) };
    const out = await applyBleSyncBatch(manager.exportSyncBatch(), deps);
    expect(out.applied).toEqual([tx.txId]);
    expect(engine.balance("laptop-a")).toBeCloseTo(6.8, 9);
    expect(engine.balance("laptop-b")).toBeCloseTo(3.2, 9);

    // Tampering with any field after co-signing -> invalid_signature.
    for (const mutated of [
      { ...tx, credits: tx.credits + 0.001 },
      { ...tx, credits: tx.credits - 0.001 },
      { ...tx, cpuSeconds: tx.cpuSeconds + 0.001 },
      { ...tx, providerAccountId: "attacker" },
      { ...tx, taskHash: "0" + tx.taskHash.slice(1) },
      { ...tx, txId: tx.txId + "-2" }
    ]) {
      const res = await applyBleSyncBatch([mutated], deps);
      expect(res.skipped.map((s) => s.reason), JSON.stringify(mutated)).toEqual(["invalid_signature"]);
    }
    expect(engine.balance("laptop-b")).toBeCloseTo(3.2, 9);
  });

  it("nothing is recorded when the provider refuses to co-sign", async () => {
    const { manager, failures, provTransport } = setupPair();
    // Provider that serves tasks but has no co-sign handler at all.
    provTransport.onCoSignRequest(() => ({ type: BLE_COSIGN_MSG_TYPE, txId: "", status: "rejected", reason: "credit_mismatch" }));
    const resp = await manager.routeTask({ requestId: "req-2", requesterId: "laptop-a", task: "t", language: "python", requesterSignature: "" }, 7);
    expect(resp?.status).toBe("completed");
    expect(manager.pendingTransactions()).toHaveLength(0);
    expect(failures).toEqual(["credit_mismatch"]);
  });

  it("nothing is recorded when the requester has no signing key", async () => {
    const network = new Map<string, MockBLETransport>();
    const reqTransport = new MockBLETransport("a", network);
    const provTransport = new MockBLETransport("b", network);
    provTransport.startAdvertising({ agentId: "b", model: "m", modelParamSize: 7, memoryMB: 1, batteryPct: 100, currentLoad: 0, deviceType: "laptop" });
    attachMockProvider(provTransport, { agentId: "b", modelParamSize: 7, cpuSeconds: 1 });
    const failures: string[] = [];
    const manager = new BLEMeshManager("a", "a", reqTransport, new SQLiteStore(":memory:"), { onCoSignFailure: (f) => failures.push(f.reason) });
    manager.setOffline(true);
    const resp = await manager.routeTask({ requestId: "r", requesterId: "a", task: "t", language: "python", requesterSignature: "" }, 7);
    expect(resp?.status).toBe("completed");
    expect(manager.pendingTransactions()).toHaveLength(0);
    expect(failures).toEqual(["no_signing_key"]);
  });

  it("a provider cannot be charged twice for one served task", async () => {
    const { manager, provider } = setupPair();
    await manager.routeTask({ requestId: "req-1", requesterId: "laptop-a", task: "same", language: "python", requesterSignature: "" }, 7);
    expect(manager.pendingTransactions()).toHaveLength(1);
    // Second co-sign attempt for the same served task with a new txId is refused.
    const first = provider.coSignRequests[0] as { tx: Record<string, unknown> };
    const res = provider.coSigner.handle({ type: BLE_COSIGN_MSG_TYPE, tx: { ...(first.tx as any), txId: "fresh-id" } });
    expect(res.status).toBe("rejected");
    expect(res.reason).toBe("already_cosigned");
  });
});
