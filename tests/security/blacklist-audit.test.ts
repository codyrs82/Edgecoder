import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createPeerKeys, signPayload } from "../../src/mesh/peer.js";
import {
  buildBlacklistEventHash,
  canonicalizeBlacklistEvidence,
  validateIncomingBlacklistRecord,
  verifyReporterEvidenceSignature
} from "../../src/security/blacklist.js";
import { BlacklistRecord } from "../../src/common/types.js";

function createRecord(input: {
  prevEventHash: string;
  sourceCoordinatorId: string;
  sourceCoordinatorPrivateKeyPem: string;
  reporterPublicKeyPem: string;
  reporterPrivateKeyPem: string;
}): BlacklistRecord {
  const eventId = randomUUID();
  const timestampMs = Date.now();
  const evidence = {
    agentId: "agent-1",
    reasonCode: "policy_violation" as const,
    reason: "submitted forged outputs",
    evidenceHashSha256: "a".repeat(64),
    reporterId: "reporter-a",
    timestampMs
  };
  const reporterSignature = signPayload(
    canonicalizeBlacklistEvidence(evidence),
    input.reporterPrivateKeyPem
  );
  const eventHash = buildBlacklistEventHash({
    eventId,
    agentId: evidence.agentId,
    reasonCode: evidence.reasonCode,
    reason: evidence.reason,
    evidenceHashSha256: evidence.evidenceHashSha256,
    reporterId: evidence.reporterId,
    sourceCoordinatorId: input.sourceCoordinatorId,
    timestampMs,
    prevEventHash: input.prevEventHash,
    evidenceSignatureVerified: true
  });
  return {
    eventId,
    agentId: evidence.agentId,
    reasonCode: evidence.reasonCode,
    reason: evidence.reason,
    evidenceHashSha256: evidence.evidenceHashSha256,
    reporterId: evidence.reporterId,
    reporterPublicKeyPem: input.reporterPublicKeyPem,
    reporterSignature,
    evidenceSignatureVerified: true,
    sourceCoordinatorId: input.sourceCoordinatorId,
    reportedBy: "policy-engine",
    timestampMs,
    prevEventHash: input.prevEventHash,
    eventHash,
    coordinatorSignature: signPayload(eventHash, input.sourceCoordinatorPrivateKeyPem)
  };
}

describe("blacklist security primitives", () => {
  it("verifies reporter evidence signatures", () => {
    const reporter = createPeerKeys("reporter-a");
    const timestampMs = Date.now();
    const evidence = {
      agentId: "agent-1",
      reasonCode: "abuse_spam" as const,
      reason: "flooding queue",
      evidenceHashSha256: "b".repeat(64),
      reporterId: "reporter-a",
      timestampMs
    };
    const signature = signPayload(canonicalizeBlacklistEvidence(evidence), reporter.privateKeyPem);
    expect(
      verifyReporterEvidenceSignature({
        evidence,
        reporterPublicKeyPem: reporter.publicKeyPem,
        reporterSignature: signature
      })
    ).toBe(true);
    expect(
      verifyReporterEvidenceSignature({
        evidence: { ...evidence, reason: "tampered" },
        reporterPublicKeyPem: reporter.publicKeyPem,
        reporterSignature: signature
      })
    ).toBe(false);
  });

  it("builds hash-chain-linked blacklist records", () => {
    const coordinator = createPeerKeys("coord");
    const reporter = createPeerKeys("reporter-a");
    const first = createRecord({
      prevEventHash: "BLACKLIST_GENESIS",
      sourceCoordinatorId: "coord",
      sourceCoordinatorPrivateKeyPem: coordinator.privateKeyPem,
      reporterPublicKeyPem: reporter.publicKeyPem,
      reporterPrivateKeyPem: reporter.privateKeyPem
    });
    const second = createRecord({
      prevEventHash: first.eventHash,
      sourceCoordinatorId: "coord",
      sourceCoordinatorPrivateKeyPem: coordinator.privateKeyPem,
      reporterPublicKeyPem: reporter.publicKeyPem,
      reporterPrivateKeyPem: reporter.privateKeyPem
    });

    expect(second.prevEventHash).toBe(first.eventHash);
    const tamperedSecondHash = buildBlacklistEventHash({
      eventId: second.eventId,
      agentId: second.agentId,
      reasonCode: second.reasonCode,
      reason: "tampered reason",
      evidenceHashSha256: second.evidenceHashSha256,
      reporterId: second.reporterId,
      sourceCoordinatorId: second.sourceCoordinatorId,
      timestampMs: second.timestampMs,
      prevEventHash: second.prevEventHash,
      evidenceSignatureVerified: second.evidenceSignatureVerified
    });
    expect(tamperedSecondHash).not.toBe(second.eventHash);
  });

  it("rejects tampered blacklist propagation events", () => {
    const coordinator = createPeerKeys("coord");
    const reporter = createPeerKeys("reporter-a");
    const record = createRecord({
      prevEventHash: "BLACKLIST_GENESIS",
      sourceCoordinatorId: "coord",
      sourceCoordinatorPrivateKeyPem: coordinator.privateKeyPem,
      reporterPublicKeyPem: reporter.publicKeyPem,
      reporterPrivateKeyPem: reporter.privateKeyPem
    });

    const good = validateIncomingBlacklistRecord({
      record,
      peerPublicKeyPem: coordinator.publicKeyPem
    });
    expect(good.ok).toBe(true);

    const tamperedReason = validateIncomingBlacklistRecord({
      record: { ...record, reason: "tampered reason" },
      peerPublicKeyPem: coordinator.publicKeyPem
    });
    expect(tamperedReason).toEqual({
      ok: false,
      reason: "blacklist_event_hash_mismatch"
    });

    const forgedSignature = validateIncomingBlacklistRecord({
      record: {
        ...record,
        coordinatorSignature: signPayload(record.eventHash, createPeerKeys("rogue").privateKeyPem)
      },
      peerPublicKeyPem: coordinator.publicKeyPem
    });
    expect(forgedSignature).toEqual({
      ok: false,
      reason: "blacklist_coordinator_signature_invalid"
    });
  });
});
