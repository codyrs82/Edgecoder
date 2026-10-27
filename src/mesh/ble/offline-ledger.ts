// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { BLECreditTransaction } from "../../common/types.js";
import type { SQLiteStore } from "../../db/sqlite-store.js";
import { bleTxSignedPayloadV2 } from "../../credits/ble-sync.js";
import { signPayload } from "../peer.js";

/**
 * #41: BLE credit payload v2. Requester AND provider must each sign this exact
 * payload (it binds txId, requester account and credits); the coordinator
 * rejects transactions missing either signature.
 */
export function bleTransactionSigningPayload(
  tx: Pick<BLECreditTransaction, "txId" | "requesterId" | "requesterAccountId" | "providerId" | "taskHash" | "cpuSeconds" | "credits">
): string {
  return bleTxSignedPayloadV2(tx);
}

export function signBleTransactionV2(
  tx: Pick<BLECreditTransaction, "txId" | "requesterId" | "requesterAccountId" | "providerId" | "taskHash" | "cpuSeconds" | "credits">,
  privateKeyPem: string
): string {
  return signPayload(bleTxSignedPayloadV2(tx), privateKeyPem);
}

export class OfflineLedger {
  private readonly store: SQLiteStore | null;

  constructor(store?: SQLiteStore) {
    this.store = store ?? null;
  }

  record(tx: BLECreditTransaction): void {
    if (this.store) {
      this.store.recordBLECreditTx(tx.txId, tx.requesterId, tx.providerId, tx.credits, tx.cpuSeconds, tx.taskHash, tx.requesterSignature, tx.providerSignature);
    }
  }

  pending(): BLECreditTransaction[] {
    if (!this.store) return [];
    return this.store.listUnsyncedBLECredits().map((row) => ({
      txId: row.txId,
      requesterId: row.requesterId,
      providerId: row.providerId,
      requesterAccountId: row.requesterId,
      providerAccountId: row.providerId,
      credits: row.credits,
      cpuSeconds: row.cpuSeconds,
      taskHash: row.taskHash,
      timestamp: row.createdAt * 1000,
      requesterSignature: row.requesterSig,
      providerSignature: row.providerSig
    }));
  }

  exportBatch(): BLECreditTransaction[] {
    return this.pending();
  }

  markSynced(txIds: string[]): void {
    if (this.store) {
      this.store.markBLECreditsSynced(txIds);
    }
  }

  clear(): void {
    // No-op for SQLite-backed ledger; synced rows stay for audit
  }
}
