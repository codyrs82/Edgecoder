import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { decodeOpReturnCheckpoint, type BitcoinAnchorProvider } from "../../src/economy/bitcoin-rpc.js";
import type { AnchorStore } from "../../src/economy/anchoring.js";
import type { BitcoinAnchorRecord } from "../../src/common/types.js";
import {
  RECEIPT_ANCHOR_EPOCH_PREFIX,
  anchorEpoch,
  closeEpoch,
  proofForReceipt,
  verifyEpochSignature
} from "../../src/receipts/epochs.js";
import {
  countersignAsCoordinator,
  hashResultOutput,
  merkleRoot,
  receiptLeafHash,
  signReceiptAsAgent,
  verifyMerkleProof,
  type WorkReceipt
} from "../../src/receipts/receipt.js";
import { MemoryReceiptStore } from "../../src/receipts/store.js";

const agent = createPeerKeys("agent-1");
const coordA = createPeerKeys("coord-a");
const coordB = createPeerKeys("coord-b");
const TXID = "ab".repeat(32);

function receiptFor(coord: typeof coordA, subtaskId: string, finishedAtMs: number): WorkReceipt {
  const claim = signReceiptAsAgent(
    {
      taskId: "task",
      subtaskId,
      agentId: agent.peerId,
      agentPublicKeyPem: agent.publicKeyPem,
      startedAtMs: finishedAtMs - 100,
      finishedAtMs,
      resultHash: hashResultOutput(subtaskId)
    },
    agent.privateKeyPem
  );
  return countersignAsCoordinator(
    claim,
    { coordinatorId: coord.peerId, coordinatorPublicKeyPem: coord.publicKeyPem, computeClass: "cpu", credits: 1, msat: 30_000, msatPerCredit: 30_000 },
    coord.privateKeyPem
  );
}

function mockProvider() {
  const broadcasts: string[] = [];
  const provider: BitcoinAnchorProvider = {
    async broadcastOpReturn(dataHex) {
      broadcasts.push(dataHex);
      return { txid: TXID };
    },
    async getConfirmations() {
      return { confirmed: false, confirmations: 0 };
    },
    async healthCheck() {
      return { reachable: true, provider: "mock" };
    },
    async sendToMany() {
      throw new Error("n/a");
    }
  };
  return { provider, broadcasts };
}

function anchorMemStore(): AnchorStore & { rows: Map<string, BitcoinAnchorRecord> } {
  const rows = new Map<string, BitcoinAnchorRecord>();
  return {
    rows,
    async upsertBitcoinAnchor(r) {
      rows.set(r.anchorId, { ...r });
    },
    async latestAnchorByCheckpoint(h) {
      return [...rows.values()].filter((r) => r.checkpointHash === h).sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? null;
    },
    async listPendingAnchors() {
      return [...rows.values()].filter((r) => r.status === "pending");
    }
  };
}

describe("closeEpoch", () => {
  it("closes only this coordinator's unassigned receipts, chains epochs and signs them", async () => {
    const store = new MemoryReceiptStore();
    const mine = [receiptFor(coordA, "a1", 1_000), receiptFor(coordA, "a2", 2_000), receiptFor(coordA, "a3", 3_000)];
    const theirs = receiptFor(coordB, "b1", 1_500);
    for (const r of [...mine, theirs]) await store.append(r);

    const first = await closeEpoch(store, { coordinatorId: coordA.peerId, coordinatorPrivateKeyPem: coordA.privateKeyPem, untilMs: 5_000, now: () => 5_000 });
    expect(first).not.toBeNull();
    expect(first!.epoch.count).toBe(3);
    expect(first!.epoch.previousRoot).toBeNull();
    expect(first!.epoch.merkleRoot).toBe(merkleRoot(mine.map(receiptLeafHash)));
    expect(first!.epoch.fromMs).toBe(1_000);
    expect(first!.epoch.toMs).toBe(5_000);
    expect(verifyEpochSignature(first!.epoch, coordA.publicKeyPem)).toBe(true);
    expect(verifyEpochSignature(first!.epoch, coordB.publicKeyPem)).toBe(false);
    expect(await store.epochIdForReceipt(theirs.receiptId)).toBeNull();
    expect(await store.latestEpoch(coordA.peerId)).toMatchObject({ epochId: first!.epoch.epochId });

    // Nothing new: no empty epoch.
    expect(await closeEpoch(store, { coordinatorId: coordA.peerId, coordinatorPrivateKeyPem: coordA.privateKeyPem, untilMs: 6_000 })).toBeNull();

    // A late receipt (finished before the previous toMs) and a new one go into the next epoch, chained to the first.
    const late = receiptFor(coordA, "a-late", 4_000);
    const next = receiptFor(coordA, "a4", 7_000);
    await store.append(late);
    await store.append(next);
    const second = await closeEpoch(store, { coordinatorId: coordA.peerId, coordinatorPrivateKeyPem: coordA.privateKeyPem, untilMs: 8_000, now: () => 8_000 });
    expect(second!.epoch.count).toBe(2);
    expect(second!.epoch.previousRoot).toBe(first!.epoch.merkleRoot);
    expect(second!.epoch.fromMs).toBe(5_000);
    expect(second!.epoch.epochId).not.toBe(first!.epoch.epochId);
  });

  it("receipts finished at or after untilMs wait for the next epoch", async () => {
    const store = new MemoryReceiptStore();
    await store.append(receiptFor(coordA, "early", 1_000));
    await store.append(receiptFor(coordA, "boundary", 2_000));
    const closed = await closeEpoch(store, { coordinatorId: coordA.peerId, coordinatorPrivateKeyPem: coordA.privateKeyPem, untilMs: 2_000 });
    expect(closed!.epoch.count).toBe(1);
  });

  it("produces inclusion proofs that verify against the epoch root", async () => {
    const store = new MemoryReceiptStore();
    const receipts = [receiptFor(coordA, "p1", 1_000), receiptFor(coordA, "p2", 1_100), receiptFor(coordA, "p3", 1_200)];
    for (const r of receipts) await store.append(r);
    expect(await proofForReceipt(store, receipts[0])).toBeNull();
    const closed = await closeEpoch(store, { coordinatorId: coordA.peerId, coordinatorPrivateKeyPem: coordA.privateKeyPem, untilMs: 2_000 });
    for (const r of receipts) {
      const proof = await proofForReceipt(store, r);
      expect(proof).not.toBeNull();
      expect(proof!.epochId).toBe(closed!.epoch.epochId);
      expect(verifyMerkleProof(proof!.leaf, proof!.proof, closed!.epoch.merkleRoot)).toBe(true);
    }
  });
});

describe("anchorEpoch", () => {
  it("writes the root into an EC OP_RETURN through the provider and records the txid", async () => {
    const store = new MemoryReceiptStore();
    await store.append(receiptFor(coordA, "x1", 1_000));
    const closed = await closeEpoch(store, { coordinatorId: coordA.peerId, coordinatorPrivateKeyPem: coordA.privateKeyPem, untilMs: 2_000 });
    const { provider, broadcasts } = mockProvider();
    const result = await anchorEpoch(closed!.epoch, { provider, network: "signet" }, store);
    expect(result.txRef).toBe(TXID);
    expect(broadcasts).toHaveLength(1);
    expect(decodeOpReturnCheckpoint(broadcasts[0])).toEqual({ version: 1, checkpointHash: closed!.epoch.merkleRoot });
    const stored = await store.getEpoch(closed!.epoch.epochId);
    expect(stored).toMatchObject({ anchorTxRef: TXID, anchorNetwork: "signet" });
    expect(await store.latestEpoch(coordA.peerId)).toMatchObject({ anchorTxRef: TXID });

    // Already anchored: no second broadcast.
    const again = await anchorEpoch(stored!, { provider, network: "signet" }, store);
    expect(again.txRef).toBe(TXID);
    expect(broadcasts).toHaveLength(1);
  });

  it("goes through anchorCheckpoint (one broadcast per root) when an anchor store is given", async () => {
    const store = new MemoryReceiptStore();
    await store.append(receiptFor(coordA, "y1", 1_000));
    const closed = await closeEpoch(store, { coordinatorId: coordA.peerId, coordinatorPrivateKeyPem: coordA.privateKeyPem, untilMs: 2_000 });
    const { provider, broadcasts } = mockProvider();
    const anchors = anchorMemStore();
    const policy = { dailyBudgetSats: 1_000_000, maxFeeSats: 20_000, mainnetEnabled: false };
    const result = await anchorEpoch(closed!.epoch, { provider, network: "signet", store: anchors, policy, now: () => 1_000 }, store);
    expect(result.txRef).toBe(TXID);
    const rows = [...anchors.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      epochId: `${RECEIPT_ANCHOR_EPOCH_PREFIX}${closed!.epoch.epochId}`,
      checkpointHash: closed!.epoch.merkleRoot,
      status: "pending",
      txRef: TXID
    });
    // Same root again (epoch without anchorTxRef): anchorCheckpoint returns the existing record, no re-broadcast.
    await anchorEpoch(closed!.epoch, { provider, network: "signet", store: anchors, policy, now: () => 1_000 });
    expect(broadcasts).toHaveLength(1);
  });

  it("surfaces provider failures", async () => {
    const store = new MemoryReceiptStore();
    await store.append(receiptFor(coordA, "z1", 1_000));
    const closed = await closeEpoch(store, { coordinatorId: coordA.peerId, coordinatorPrivateKeyPem: coordA.privateKeyPem, untilMs: 2_000 });
    const provider: BitcoinAnchorProvider = {
      ...mockProvider().provider,
      async broadcastOpReturn() {
        throw new Error("node_down");
      }
    };
    await expect(anchorEpoch(closed!.epoch, { provider, network: "signet" }, store)).rejects.toThrow("node_down");
    expect((await store.getEpoch(closed!.epoch.epochId))!.anchorTxRef).toBeUndefined();
  });
});
