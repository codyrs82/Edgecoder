import { describe, expect, it } from "vitest";
import { createPeerKeys, verifyPayload } from "../../src/mesh/peer.js";
import { createQueueEventRecord, hashRecordPayload } from "../../src/ledger/record.js";
import { OrderingChain } from "../../src/ledger/chain.js";
import { verifyOrderingChain } from "../../src/ledger/verify.js";

describe("stats ledger metadata", () => {
  it("hashes and signs checkpoint metadata deterministically", () => {
    const keys = createPeerKeys("coordinator-stats-1");
    const record = createQueueEventRecord({
      id: "record-1",
      eventType: "stats_checkpoint_signature",
      taskId: "stats-ledger",
      actorId: "coordinator-stats-1",
      sequence: 1,
      issuedAtMs: 1234,
      prevHash: "GENESIS",
      coordinatorId: "coordinator-stats-1",
      checkpointHeight: 42,
      checkpointHash: "abc123",
      payloadJson: JSON.stringify({ threshold: 2, signerPeerId: "coordinator-stats-1" }),
      signerPrivateKeyPem: keys.privateKeyPem
    });
    const expectedHash = hashRecordPayload({
      eventType: record.eventType,
      taskId: record.taskId,
      subtaskId: record.subtaskId,
      actorId: record.actorId,
      sequence: record.sequence,
      issuedAtMs: record.issuedAtMs,
      prevHash: record.prevHash,
      coordinatorId: record.coordinatorId,
      checkpointHeight: record.checkpointHeight,
      checkpointHash: record.checkpointHash,
      payloadJson: record.payloadJson
    });
    expect(record.hash).toBe(expectedHash);
    expect(verifyPayload(record.hash, record.signature, keys.publicKeyPem)).toBe(true);
  });

  it("fails verification when metadata is tampered", () => {
    const keys = createPeerKeys("coordinator-stats-1");
    const chain = new OrderingChain(keys.peerId, keys.privateKeyPem);
    chain.append({
      eventType: "node_validation",
      taskId: "agent:node-1",
      actorId: "node-1",
      coordinatorId: keys.peerId,
      payloadJson: JSON.stringify({ allowed: true, reason: "ok" })
    });
    const records = chain.snapshot();
    records[0].payloadJson = JSON.stringify({ allowed: false, reason: "tampered" });
    const validation = verifyOrderingChain(records, keys.publicKeyPem);
    expect(validation.ok).toBe(false);
    expect(validation.reason).toBe("hash_mismatch");
  });
});
