import { describe, expect, it } from "vitest";
import { createQuorumLedgerRecord, verifyQuorumLedgerRecord } from "../../src/ledger/quorum.js";
import { createPeerKeys } from "../../src/mesh/peer.js";

describe("quorum ledger records", () => {
  const keys = createPeerKeys("coord-a");
  const record = createQuorumLedgerRecord({
    recordType: "issuance_commit",
    epochId: "e1",
    coordinatorId: "coord-a",
    prevHash: "0".repeat(64),
    payloadJson: JSON.stringify({ total: 100 }),
    privateKeyPem: keys.privateKeyPem
  });

  it("verifies an untouched record", () => {
    expect(verifyQuorumLedgerRecord(record, keys.publicKeyPem)).toBe(true);
  });

  it("rejects a record whose fields no longer match its signed hash", () => {
    expect(verifyQuorumLedgerRecord({ ...record, payloadJson: JSON.stringify({ total: 1_000_000 }) }, keys.publicKeyPem)).toBe(false);
    expect(verifyQuorumLedgerRecord({ ...record, epochId: "e2" }, keys.publicKeyPem)).toBe(false);
    expect(verifyQuorumLedgerRecord({ ...record, prevHash: "1".repeat(64) }, keys.publicKeyPem)).toBe(false);
  });

  it("rejects another key", () => {
    expect(verifyQuorumLedgerRecord(record, createPeerKeys().publicKeyPem)).toBe(false);
  });
});
