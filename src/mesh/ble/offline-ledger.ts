import { BLECreditTransaction } from "../../common/types.js";

export class OfflineLedger {
  private readonly transactions = new Map<string, BLECreditTransaction>();

  record(tx: BLECreditTransaction): void {
    if (!this.transactions.has(tx.txId)) {
      this.transactions.set(tx.txId, tx);
    }
  }

  pending(): BLECreditTransaction[] {
    return [...this.transactions.values()];
  }

  exportBatch(): BLECreditTransaction[] {
    return this.pending();
  }

  markSynced(txIds: string[]): void {
    for (const id of txIds) {
      this.transactions.delete(id);
    }
  }

  clear(): void {
    this.transactions.clear();
  }
}
