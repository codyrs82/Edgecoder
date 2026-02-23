import { BLECreditTransaction } from "../../common/types.js";
import type { SQLiteStore } from "../../db/sqlite-store.js";

export class OfflineLedger {
  private readonly store: SQLiteStore | null;

  constructor(store?: SQLiteStore) {
    this.store = store ?? null;
  }

  record(tx: BLECreditTransaction): void {
    if (this.store) {
      this.store.recordBLECreditTx(tx.txId, tx.requesterId, tx.providerId, tx.credits, tx.cpuSeconds, tx.taskHash);
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
      requesterSignature: "",
      providerSignature: ""
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
