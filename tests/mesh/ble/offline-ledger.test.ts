import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OfflineLedger } from "../../../src/mesh/ble/offline-ledger.js";
import { BLECreditTransaction } from "../../../src/common/types.js";
import { SQLiteStore } from "../../../src/db/sqlite-store.js";

let store: SQLiteStore;

beforeEach(() => {
  store = new SQLiteStore(":memory:");
});

afterEach(() => {
  store.close();
});

function makeTx(overrides: Partial<BLECreditTransaction> = {}): BLECreditTransaction {
  return {
    txId: "tx-1",
    requesterId: "agent-a",
    providerId: "agent-b",
    requesterAccountId: "account-a",
    providerAccountId: "account-b",
    credits: 1.5,
    cpuSeconds: 1.5,
    taskHash: "abc123",
    timestamp: Date.now(),
    requesterSignature: "sig-a",
    providerSignature: "sig-b",
    ...overrides
  };
}

describe("OfflineLedger", () => {
  it("records and retrieves pending transactions", () => {
    const ledger = new OfflineLedger(store);
    ledger.record(makeTx({ txId: "tx-1" }));
    ledger.record(makeTx({ txId: "tx-2" }));
    expect(ledger.pending()).toHaveLength(2);
  });

  it("deduplicates by txId", () => {
    const ledger = new OfflineLedger(store);
    ledger.record(makeTx({ txId: "tx-1" }));
    ledger.record(makeTx({ txId: "tx-1" }));
    expect(ledger.pending()).toHaveLength(1);
  });

  it("clears synced transactions", () => {
    const ledger = new OfflineLedger(store);
    ledger.record(makeTx({ txId: "tx-1" }));
    ledger.record(makeTx({ txId: "tx-2" }));
    ledger.markSynced(["tx-1"]);
    expect(ledger.pending()).toHaveLength(1);
    expect(ledger.pending()[0].txId).toBe("tx-2");
  });

  it("exports batch for sync", () => {
    const ledger = new OfflineLedger(store);
    ledger.record(makeTx({ txId: "tx-1" }));
    ledger.record(makeTx({ txId: "tx-2" }));
    const batch = ledger.exportBatch();
    expect(batch).toHaveLength(2);
  });
});
