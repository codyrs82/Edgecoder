// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { BLECreditTransaction } from "../../common/types.js";
import type { BLECreditLedgerRow, SQLiteStore } from "../../db/sqlite-store.js";
import {
  bleTxV3CanonicalString,
  bleTxV3FieldsFromTx,
  signBleTxV3,
  type BleTxV3Fields
} from "../../credits/ble-tx-canonical.js";

type SignableTx = Pick<
  BLECreditTransaction,
  "txId" | "requesterId" | "requesterAccountId" | "providerId" | "providerAccountId" | "taskHash" | "cpuSeconds" | "credits"
>;

/**
 * #63: the canonical v3 string both parties sign (bytes = UTF-8 of this).
 * Requester AND provider must each sign it; the coordinator rejects
 * transactions missing either signature or signed over anything else.
 */
export function bleTransactionSigningPayload(tx: SignableTx): string {
  return bleTxV3CanonicalString(bleTxV3FieldsFromTx(tx));
}

/** Canonical v3 signer (ed25519, base64). Replaces the v2 float-JSON signer from #41. */
export function signBleTransactionV3(tx: SignableTx | BleTxV3Fields, privateKeyPem: string): string {
  const fields: BleTxV3Fields = "cpuMillis" in tx ? tx : bleTxV3FieldsFromTx(tx);
  return signBleTxV3(fields, privateKeyPem);
}

/** Shape a ledger row into the wire transaction sent to /credits/ble-sync. */
export function ledgerRowToTransaction(row: BLECreditLedgerRow): BLECreditTransaction {
  return {
    txId: row.txId,
    requesterId: row.requesterId,
    providerId: row.providerId,
    // Rows written before #63 have no account columns: fall back to the agent id
    // (what those clients signed with).
    requesterAccountId: row.requesterAccountId || row.requesterId,
    providerAccountId: row.providerAccountId || row.providerId,
    credits: row.credits,
    cpuSeconds: row.cpuSeconds,
    taskHash: row.taskHash,
    timestamp: row.createdAt * 1000,
    requesterSignature: row.requesterSig,
    providerSignature: row.providerSig
  };
}

export class OfflineLedger {
  private readonly store: SQLiteStore | null;

  constructor(store?: SQLiteStore) {
    this.store = store ?? null;
  }

  /** Only fully co-signed transactions are accepted (#63). */
  record(tx: BLECreditTransaction): void {
    if (!tx.requesterSignature || !tx.providerSignature) {
      throw new Error(`offline-ledger: refusing to record ${tx.txId} without both signatures`);
    }
    if (this.store) {
      this.store.recordBLECreditTx(
        tx.txId,
        tx.requesterId,
        tx.providerId,
        tx.credits,
        tx.cpuSeconds,
        tx.taskHash,
        tx.requesterSignature,
        tx.providerSignature,
        tx.requesterAccountId,
        tx.providerAccountId
      );
    }
  }

  pending(): BLECreditTransaction[] {
    if (!this.store) return [];
    return this.store.listUnsyncedBLECredits().map(ledgerRowToTransaction);
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
