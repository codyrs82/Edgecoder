// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { BLECreditTransaction } from "../../common/types.js";
import type { BLECreditLedgerRow, SQLiteStore } from "../../db/sqlite-store.js";
import {
  bleTxV3CanonicalBytes,
  bleTxV3FieldsFromWire,
  signBleTxV3,
  type BleTxV3Fields
} from "../../credits/ble-tx-v3.js";

/**
 * #63: BLE credit payload v3. Requester AND provider each sign the canonical bytes of these
 * fields (src/credits/ble-tx-v3.ts); the coordinator rejects transactions missing either signature.
 */
export function bleTransactionSigningPayload(fields: BleTxV3Fields): Buffer {
  return bleTxV3CanonicalBytes(fields);
}

export function signBleTransactionV3(fields: BleTxV3Fields, privateKeyPem: string): string {
  return signBleTxV3(fields, privateKeyPem);
}

/** Sign a wire-format transaction (credits / cpuSeconds must be exact milli-unit amounts). */
export function signBleTransaction(
  tx: Pick<BLECreditTransaction, "txId" | "requesterId" | "requesterAccountId" | "providerId" | "providerAccountId" | "taskHash" | "cpuSeconds" | "credits">,
  privateKeyPem: string
): string {
  const fields = bleTxV3FieldsFromWire(tx);
  if (!fields) throw new Error("credits and cpuSeconds must be exact milli-unit amounts");
  return signBleTxV3(fields, privateKeyPem);
}

/** A stored ledger row as the transaction /credits/ble-sync expects. */
export function ledgerRowToTransaction(row: BLECreditLedgerRow): BLECreditTransaction {
  return {
    txId: row.txId,
    requesterId: row.requesterId,
    providerId: row.providerId,
    // Rows from before #63 have no account columns; they never carried valid signatures anyway.
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

/**
 * Which txIds to stop retrying after a /credits/ble-sync answer: applied and duplicate ones, plus
 * those that can never succeed (bad signature or field). Missing keys, insufficient balance and
 * account mismatches stay pending, since they can resolve once the coordinator learns more.
 */
export function settledBleTxIds(response: unknown): string[] {
  const r = (response ?? {}) as { applied?: unknown; skipped?: unknown };
  const applied = Array.isArray(r.applied) ? r.applied.filter((id): id is string => typeof id === "string") : [];
  const final = new Set(["duplicate", "invalid_signature", "invalid_field"]);
  const skipped = Array.isArray(r.skipped)
    ? r.skipped
        .filter((s: any) => s && typeof s.txId === "string" && final.has(s.reason))
        .map((s: any) => s.txId as string)
    : [];
  return [...applied, ...skipped];
}

export class OfflineLedger {
  private readonly store: SQLiteStore | null;

  constructor(store?: SQLiteStore) {
    this.store = store ?? null;
  }

  /** Only fully co-signed transactions are kept (#63); returns whether it was recorded. */
  record(tx: BLECreditTransaction): boolean {
    if (!tx.requesterSignature || !tx.providerSignature) return false;
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
    return true;
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
