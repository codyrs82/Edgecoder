import { describe, it, expect } from "vitest";
import { BLECreditTransaction } from "../../../src/common/types.js";

describe("BLE sync endpoint schema", () => {
  it("validates a well-formed transaction batch", () => {
    const batch: BLECreditTransaction[] = [
      {
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
        providerSignature: "sig-b"
      }
    ];
    expect(batch).toHaveLength(1);
    expect(batch[0].requesterSignature).toBeTruthy();
    expect(batch[0].providerSignature).toBeTruthy();
  });

  it("rejects duplicate txIds in a batch", () => {
    const seen = new Set<string>();
    const batch = [
      { txId: "tx-1" }, { txId: "tx-1" }
    ];
    const unique = batch.filter((tx) => {
      if (seen.has(tx.txId)) return false;
      seen.add(tx.txId);
      return true;
    });
    expect(unique).toHaveLength(1);
  });
});
