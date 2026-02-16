import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { OrderingChain } from "../../src/ledger/chain.js";
import { verifyOrderingChain } from "../../src/ledger/verify.js";

describe("ordering ledger", () => {
  it("verifies valid hash-chained records", () => {
    const keys = createPeerKeys("coordinator-1");
    const chain = new OrderingChain(keys.peerId, keys.privateKeyPem);
    chain.append({ eventType: "task_enqueue", taskId: "t-1", actorId: "submitter" });
    chain.append({ eventType: "task_claim", taskId: "t-1", subtaskId: "s-1", actorId: "worker-a" });
    const result = verifyOrderingChain(chain.snapshot(), keys.publicKeyPem);
    expect(result.ok).toBe(true);
  });

  it("detects tampering attempts", () => {
    const keys = createPeerKeys("coordinator-1");
    const chain = new OrderingChain(keys.peerId, keys.privateKeyPem);
    chain.append({ eventType: "task_enqueue", taskId: "t-1", actorId: "submitter" });
    const records = chain.snapshot();
    records[0].taskId = "tampered";
    const result = verifyOrderingChain(records, keys.publicKeyPem);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hash_mismatch");
  });
});
