import { describe, expect, test } from "vitest";
import { CreditEngine } from "../../src/credits/engine.js";
import {
  applyBleSyncBatch,
  bleSyncAllowV1,
  bleSyncAllowV2,
  bleTxSignedPayloadV2,
  createBleSyncSchema,
  createInMemoryBleTransfer,
  isBleSyncAuthorized,
  verifyBleTxSignatures,
  type BleSyncTx
} from "../../src/credits/ble-sync.js";
import { signBleTransactionV3 } from "../../src/mesh/ble/offline-ledger.js";
import { createPeerKeys, signPayload } from "../../src/mesh/peer.js";

const requesterKeys = createPeerKeys();
const providerKeys = createPeerKeys();
const keys: Record<string, string> = {
  "agent-req": requesterKeys.publicKeyPem,
  "agent-prov": providerKeys.publicKeyPem
};

function makeTx(overrides: Partial<BleSyncTx> = {}, sign: { req?: boolean; prov?: boolean } = { req: true, prov: true }): BleSyncTx {
  const base: BleSyncTx = {
    txId: "tx-1",
    requesterId: "agent-req",
    providerId: "agent-prov",
    requesterAccountId: "agent-req",
    providerAccountId: "agent-prov",
    credits: 5,
    cpuSeconds: 5,
    taskHash: "hash-abc",
    timestamp: Date.now(),
    requesterSignature: "",
    providerSignature: "",
    ...overrides
  };
  return {
    ...base,
    requesterSignature: sign.req ? signBleTransactionV3(base, requesterKeys.privateKeyPem) : "",
    providerSignature: sign.prov ? signBleTransactionV3(base, providerKeys.privateKeyPem) : ""
  };
}

function setup(requesterBalance = 100, synced = new Set<string>()) {
  const engine = new CreditEngine();
  if (requesterBalance) engine.adjust("agent-req", requesterBalance, "seed");
  const deps = {
    getPublicKeyPem: (id: string) => keys[id],
    rewardAccountForAgent: async (id: string) => id,
    transfer: createInMemoryBleTransfer(engine, synced)
  };
  return { engine, deps, synced };
}

describe("/credits/ble-sync auth (#41)", () => {
  test("no mesh token configured and no agent signature -> unauthorized", () => {
    expect(isBleSyncAuthorized(null, false, true)).toBe(false); // empty MESH_AUTH_TOKEN never counts
    expect(isBleSyncAuthorized(null, true, false)).toBe(false);
    expect(isBleSyncAuthorized("rejected", true, true)).toBe(false);
    expect(isBleSyncAuthorized(null, true, true)).toBe(true);
    expect(isBleSyncAuthorized({ agentId: "a" }, false, false)).toBe(true);
  });

  test("both valid v3 signatures -> applied, balances moved", async () => {
    const { engine, deps } = setup(100);
    const out = await applyBleSyncBatch([makeTx()], deps);
    expect(out.applied).toEqual(["tx-1"]);
    expect(engine.balance("agent-req")).toBe(95);
    expect(engine.balance("agent-prov")).toBe(5);
  });

  test("only one of the two signatures -> signature_required, balances unchanged", async () => {
    const { engine, deps } = setup(100);
    const out = await applyBleSyncBatch([makeTx({}, { req: true, prov: false }), makeTx({ txId: "tx-2" }, { req: false, prov: true })], deps);
    expect(out.applied).toEqual([]);
    expect(out.skipped.map((s) => s.reason)).toEqual(["signature_required", "signature_required"]);
    expect(engine.balance("agent-req")).toBe(100);
    expect(engine.balance("agent-prov")).toBe(0);
  });

  test("unregistered key -> signature_required", async () => {
    const { deps } = setup(100);
    const out = await applyBleSyncBatch([makeTx({ providerId: "unknown" })], deps);
    expect(out.skipped[0].reason).toBe("signature_required");
  });

  test("tampered credits -> skipped invalid_signature", async () => {
    const { engine, deps } = setup(100);
    const tx = { ...makeTx(), credits: 50 };
    const out = await applyBleSyncBatch([tx], deps);
    expect(out.skipped).toEqual([{ txId: "tx-1", reason: "invalid_signature" }]);
    expect(engine.balance("agent-prov")).toBe(0);
  });

  test("#63: credits changed by one milli-unit (either direction) -> invalid_signature", async () => {
    const { engine, deps } = setup(100);
    const out = await applyBleSyncBatch(
      [{ ...makeTx(), credits: 5.001 }, { ...makeTx({ txId: "tx-2" }), credits: 4.999 }, { ...makeTx({ txId: "tx-3" }), cpuSeconds: 5.001 }],
      deps
    );
    expect(out.applied).toEqual([]);
    expect(out.skipped.map((s) => s.reason)).toEqual(["invalid_signature", "invalid_signature", "invalid_signature"]);
    expect(engine.balance("agent-prov")).toBe(0);
  });

  test("#63: every signed field is covered by both signatures", async () => {
    const { deps } = setup(100);
    const base = makeTx();
    const mutations: Array<Partial<BleSyncTx>> = [
      { txId: "tx-other" },
      { requesterId: "agent-prov" },
      { providerId: "agent-req" },
      { providerAccountId: "attacker" },
      { taskHash: "hash-xyz" }
    ];
    for (const m of mutations) {
      const out = await applyBleSyncBatch([{ ...base, ...m }], deps);
      // Swapped ids may hit signature_required (unknown key) before verification; everything else is invalid_signature.
      expect(["invalid_signature", "signature_required"], JSON.stringify(m)).toContain(out.skipped[0].reason);
      expect(out.applied).toEqual([]);
    }
    // Only requesterAccountId is checked after the signature (ownership), and it is signed too:
    const out = await applyBleSyncBatch([{ ...base, requesterAccountId: "victim-account" }], deps);
    expect(out.skipped[0].reason).toBe("invalid_signature");
  });

  test("#63: a newline in a signed string field -> invalid_payload (never verified)", async () => {
    const { deps } = setup(100);
    const signed = makeTx();
    const out = await applyBleSyncBatch([{ ...signed, taskHash: "hash\nabc" }], deps);
    expect(out.skipped).toEqual([{ txId: "tx-1", reason: "invalid_payload" }]);
    expect(verifyBleTxSignatures({ ...signed, txId: "a\nb" }, requesterKeys.publicKeyPem, providerKeys.publicKeyPem)).toBe("invalid_payload");
    // The canonical signer itself refuses such a field.
    expect(() => signBleTransactionV3({ ...signed, txId: "a\nb" }, requesterKeys.privateKeyPem)).toThrow(/newline/);
  });

  test("#63: v2 float-JSON signatures are rejected unless BLE_SYNC_ALLOW_V2 is on (never in production)", async () => {
    const base = makeTx({}, { req: false, prov: false });
    const v2 = bleTxSignedPayloadV2(base);
    const tx: BleSyncTx = {
      ...base,
      requesterSignature: signPayload(v2, requesterKeys.privateKeyPem),
      providerSignature: signPayload(v2, providerKeys.privateKeyPem)
    };
    const strict = setup(100);
    expect((await applyBleSyncBatch([tx], strict.deps)).skipped[0].reason).toBe("invalid_signature");
    const compat = setup(100);
    const out = await applyBleSyncBatch([tx], { ...compat.deps, legacy: { v2: true } });
    expect(out.applied).toEqual(["tx-1"]);
    expect(bleSyncAllowV2({ NODE_ENV: "development", BLE_SYNC_ALLOW_V2: "1" })).toBe(true);
    expect(bleSyncAllowV2({ NODE_ENV: "production", BLE_SYNC_ALLOW_V2: "1" })).toBe(false);
    expect(bleSyncAllowV2({ NODE_ENV: "development" })).toBe(false);
  });

  test("requesterAccountId must match the requester's reward account", async () => {
    const { deps } = setup(100);
    // Signed with a foreign account id: signatures verify, ownership check fails.
    const out = await applyBleSyncBatch([makeTx({ requesterAccountId: "victim-account" })], deps);
    expect(out.skipped[0].reason).toBe("account_mismatch");
  });

  test("insufficient balance -> skipped, never negative", async () => {
    const { engine, deps } = setup(10);
    const out = await applyBleSyncBatch([makeTx({ credits: 50 })], deps);
    expect(out.skipped).toEqual([{ txId: "tx-1", reason: "insufficient" }]);
    expect(engine.balance("agent-req")).toBe(10);
    expect(engine.balance("agent-prov")).toBe(0);
  });

  test("same txId twice (incl. simulated restart sharing the dedupe store) -> second skipped", async () => {
    const synced = new Set<string>();
    const first = setup(100, synced);
    expect((await applyBleSyncBatch([makeTx()], first.deps)).applied).toEqual(["tx-1"]);
    expect((await applyBleSyncBatch([makeTx()], first.deps)).skipped[0].reason).toBe("duplicate");
    const restarted = setup(100, synced);
    const out = await applyBleSyncBatch([makeTx()], restarted.deps);
    expect(out.skipped[0].reason).toBe("duplicate");
    expect(restarted.engine.balance("agent-prov")).toBe(0);
  });

  test("schema rejects zero, negative and over-max credits (route maps to 400)", () => {
    const schema = createBleSyncSchema(100);
    const tx = makeTx();
    expect(schema.safeParse({ transactions: [tx] }).success).toBe(true);
    expect(schema.safeParse({ transactions: [{ ...tx, credits: 0 }] }).success).toBe(false);
    expect(schema.safeParse({ transactions: [{ ...tx, credits: -5 }] }).success).toBe(false);
    expect(schema.safeParse({ transactions: [{ ...tx, credits: 101 }] }).success).toBe(false);
  });

  test("v1 payloads only allowed with BLE_SYNC_ALLOW_V1=1 outside production", () => {
    expect(bleSyncAllowV1({ NODE_ENV: "development", BLE_SYNC_ALLOW_V1: "1" })).toBe(true);
    expect(bleSyncAllowV1({ NODE_ENV: "production", BLE_SYNC_ALLOW_V1: "1" })).toBe(false);
    expect(bleSyncAllowV1({ NODE_ENV: "development" })).toBe(false);
  });
});
