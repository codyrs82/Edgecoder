// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { BitcoinNetwork } from "../common/types.js";
import { signPayload, verifyPayload } from "../mesh/peer.js";
import { anchorCheckpoint, type AnchorPolicy, type AnchorStore } from "../economy/anchoring.js";
import { encodeCheckpointForOpReturn, type BitcoinAnchorProvider } from "../economy/bitcoin-rpc.js";
import {
  canonicalJson,
  merkleProofForLeaf,
  merkleRoot,
  receiptLeafHash,
  sha256Hex,
  type MerkleProof,
  type WorkReceipt
} from "./receipt.js";
import type { ReceiptEpoch, ReceiptStore } from "./store.js";

/*
 * Architecture step 2 (continued): receipts are batched into epochs. Each epoch is a
 * Merkle tree over the canonical receipts of one coordinator, chained to the previous
 * epoch by `previousRoot`, signed by the coordinator and anchored as an OP_RETURN
 * through the same Bitcoin provider the stats checkpoints use.
 */

/** Prefix for the anchor record's epochId so receipt anchors are distinguishable from issuance/stats ones. */
export const RECEIPT_ANCHOR_EPOCH_PREFIX = "receipts:";

export function canonicalEpochBody(epoch: Omit<ReceiptEpoch, "epochId" | "signature" | "anchorTxRef" | "anchorNetwork">): string {
  return canonicalJson({
    coordinatorId: epoch.coordinatorId,
    fromMs: epoch.fromMs,
    toMs: epoch.toMs,
    count: epoch.count,
    merkleRoot: epoch.merkleRoot,
    previousRoot: epoch.previousRoot,
    closedAtMs: epoch.closedAtMs
  });
}

export function verifyEpochSignature(epoch: ReceiptEpoch, coordinatorPublicKeyPem: string): boolean {
  const body = canonicalEpochBody(epoch);
  if (sha256Hex(body) !== epoch.epochId) return false;
  return verifyPayload(body, epoch.signature, coordinatorPublicKeyPem);
}

export interface CloseEpochInput {
  coordinatorId: string;
  coordinatorPrivateKeyPem: string;
  /** Informational lower bound of the window; defaults to the previous epoch's toMs (or 0). */
  sinceMs?: number;
  /** Receipts finished at or after this instant stay for the next epoch. Defaults to now. */
  untilMs?: number;
  now?: () => number;
  /** Upper bound on receipts per epoch (the rest roll into the next close). */
  maxReceipts?: number;
}

export interface ClosedEpoch {
  epoch: ReceiptEpoch;
  receiptIds: string[];
}

/**
 * Close an epoch over every receipt of `coordinatorId` not yet in an epoch and finished
 * before `untilMs`. Resolves null when there is nothing to close (no empty epochs are
 * signed or anchored). Receipts are marked with the epochId in the store.
 */
export async function closeEpoch(store: ReceiptStore, input: CloseEpochInput): Promise<ClosedEpoch | null> {
  const now = input.now ?? Date.now;
  const untilMs = input.untilMs ?? now();
  const receipts = await store.listUnassigned(input.coordinatorId, untilMs, input.maxReceipts);
  if (receipts.length === 0) return null;
  const previous = await store.latestEpoch(input.coordinatorId);
  const leaves = receipts.map(receiptLeafHash);
  const body: Omit<ReceiptEpoch, "epochId" | "signature"> = {
    coordinatorId: input.coordinatorId,
    fromMs: input.sinceMs ?? previous?.toMs ?? Math.min(...receipts.map((r) => r.finishedAtMs)),
    toMs: untilMs,
    count: receipts.length,
    merkleRoot: merkleRoot(leaves),
    previousRoot: previous?.merkleRoot ?? null,
    closedAtMs: now()
  };
  const canonical = canonicalEpochBody(body);
  const epoch: ReceiptEpoch = {
    epochId: sha256Hex(canonical),
    ...body,
    signature: signPayload(canonical, input.coordinatorPrivateKeyPem)
  };
  const receiptIds = receipts.map((r) => r.receiptId);
  await store.persistEpoch(epoch, receiptIds);
  return { epoch, receiptIds };
}

export interface EpochAnchorTarget {
  provider: BitcoinAnchorProvider;
  network: BitcoinNetwork;
  /**
   * When present the broadcast goes through anchorCheckpoint (one broadcast per root,
   * daily budget, mainnet opt-in, crash-safe "broadcasting" row), exactly like the
   * stats checkpoints. Without a store the provider is called directly.
   */
  store?: AnchorStore;
  policy?: AnchorPolicy;
  now?: () => number;
}

export interface EpochAnchorResult {
  epoch: ReceiptEpoch;
  txRef: string;
  /** OP_RETURN payload ("EC" + version + 32-byte root) in hex. */
  dataHex: string;
}

/**
 * Write the epoch's Merkle root into an OP_RETURN and record the txid on the epoch.
 * Already-anchored epochs (anchorTxRef set) are returned as-is.
 */
export async function anchorEpoch(
  epoch: ReceiptEpoch,
  target: EpochAnchorTarget,
  receiptStore?: ReceiptStore
): Promise<EpochAnchorResult> {
  const dataHex = encodeCheckpointForOpReturn(epoch.merkleRoot);
  if (epoch.anchorTxRef) return { epoch, txRef: epoch.anchorTxRef, dataHex };
  let txRef: string;
  if (target.store) {
    const record = await anchorCheckpoint(
      { provider: target.provider, store: target.store, network: target.network, policy: target.policy, now: target.now },
      { epochId: `${RECEIPT_ANCHOR_EPOCH_PREFIX}${epoch.epochId}`, checkpointHash: epoch.merkleRoot }
    );
    txRef = record.txRef;
  } else {
    txRef = (await target.provider.broadcastOpReturn(dataHex)).txid;
  }
  const anchored: ReceiptEpoch = { ...epoch, anchorTxRef: txRef, anchorNetwork: target.network };
  if (receiptStore) await receiptStore.persistEpoch(anchored);
  return { epoch: anchored, txRef, dataHex };
}

export interface ReceiptInclusionProof {
  receiptId: string;
  leaf: string;
  epochId: string;
  merkleRoot: string;
  proof: MerkleProof;
  anchorTxRef?: string;
  anchorNetwork?: string;
}

/** Inclusion proof for a receipt that was closed into an epoch; null while it is still open. */
export async function proofForReceipt(store: ReceiptStore, receipt: WorkReceipt): Promise<ReceiptInclusionProof | null> {
  const epochId = await store.epochIdForReceipt(receipt.receiptId);
  if (!epochId) return null;
  const epoch = await store.getEpoch(epochId);
  if (!epoch) return null;
  const leaves = (await store.listByEpoch(epochId)).map(receiptLeafHash);
  const leaf = receiptLeafHash(receipt);
  return {
    receiptId: receipt.receiptId,
    leaf,
    epochId,
    merkleRoot: epoch.merkleRoot,
    proof: merkleProofForLeaf(leaves, leaf),
    anchorTxRef: epoch.anchorTxRef,
    anchorNetwork: epoch.anchorNetwork
  };
}
