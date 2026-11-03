import { describe, expect, test } from "vitest";
import { CreditEngine } from "../../src/credits/engine.js";
import {
  applyBleSyncBatch,
  bleSyncAllowV1,
  createBleSyncSchema,
  createInMemoryBleTransfer,
  isBleSyncAuthorized,
  type BleSyncTx
} from "../../src/credits/ble-sync.js";
import { signBleTransaction } from "../../src/mesh/ble/offline-ledger.js";
import { bleTxSignedPayloadV2 } from "../../src/credits/ble-sync.js";
import { signPayload } from "../../src/mesh/peer.js";
import { createPeerKeys } from "../../src/mesh/peer.js";

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
    requesterSignature: sign.req ? signBleTransaction(base, requesterKeys.privateKeyPem) : "",
    providerSignature: sign.prov ? signBleTransaction(base, providerKeys.privateKeyPem) : ""
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

  test("requesterAccountId must match the requester's reward account", async () => {
    const { deps } = setup(100);
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

  test("tampering any signed field, credits by one milli included -> invalid_signature (#63)", async () => {
    const tampered: Array<Partial<BleSyncTx>> = [
      { credits: 5.001 },
      { credits: 4.999 },
      { cpuSeconds: 5.001 },
      { txId: "tx-other" },
      { taskHash: "hash-abd" },
      { requesterId: "agent-prov" },
      { providerId: "agent-req" }
    ];
    for (const change of tampered) {
      const { engine, deps } = setup(100);
      const out = await applyBleSyncBatch([{ ...makeTx(), ...change }], deps);
      expect(out.skipped.map((s) => s.reason), JSON.stringify(change)).toEqual(["invalid_signature"]);
      expect(engine.balance("agent-prov")).toBe(0);
    }
  });

  test("tampered account ids are caught by the signature before the account check (#63)", async () => {
    const { deps } = setup(100);
    for (const change of [{ requesterAccountId: "agent-req2" }, { providerAccountId: "agent-prov2" }]) {
      const out = await applyBleSyncBatch([{ ...makeTx(), ...change }], deps);
      expect(out.skipped[0].reason).toBe("invalid_signature");
    }
  });

  test("providerAccountId must match the provider's reward account (#63)", async () => {
    const { deps } = setup(100);
    const out = await applyBleSyncBatch([makeTx({ providerAccountId: "someone-else" })], deps);
    expect(out.skipped[0].reason).toBe("account_mismatch");
  });

  test("newline in a field or sub-milli amounts -> invalid_field (#63)", async () => {
    const { deps } = setup(100);
    const withNewline = { ...makeTx(), txId: "tx\n1" };
    const subMilli = { ...makeTx(), credits: 5.0004 };
    const out = await applyBleSyncBatch([withNewline, subMilli], deps);
    expect(out.skipped.map((s) => s.reason)).toEqual(["invalid_field", "invalid_field"]);
  });

  test("settles the exact signed milli amount", async () => {
    const { engine, deps } = setup(100);
    const out = await applyBleSyncBatch([makeTx({ credits: 0.003, cpuSeconds: 0.01 })], deps);
    expect(out.applied).toEqual(["tx-1"]);
    expect(engine.balance("agent-prov")).toBeCloseTo(0.003, 9);
  });

  test("legacy v2 JSON signatures are refused unless the compat flag allows them", async () => {
    const base = makeTx({}, { req: false, prov: false });
    const v2 = {
      ...base,
      requesterSignature: signPayload(bleTxSignedPayloadV2(base), requesterKeys.privateKeyPem),
      providerSignature: signPayload(bleTxSignedPayloadV2(base), providerKeys.privateKeyPem)
    };
    const strict = setup(100);
    expect((await applyBleSyncBatch([v2], strict.deps)).skipped[0].reason).toBe("invalid_signature");
    const compat = setup(100);
    expect((await applyBleSyncBatch([v2], { ...compat.deps, allowV1: true })).applied).toEqual(["tx-1"]);
  });

  test("v1 payloads only allowed with BLE_SYNC_ALLOW_V1=1 outside production", () => {
    expect(bleSyncAllowV1({ NODE_ENV: "development", BLE_SYNC_ALLOW_V1: "1" })).toBe(true);
    expect(bleSyncAllowV1({ NODE_ENV: "production", BLE_SYNC_ALLOW_V1: "1" })).toBe(false);
    expect(bleSyncAllowV1({ NODE_ENV: "development" })).toBe(false);
  });
});
