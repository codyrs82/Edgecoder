// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";
import { BlacklistReasonCode } from "../common/types.js";
import { verifyPayload } from "../mesh/peer.js";

export interface BlacklistEvidenceInput {
  agentId: string;
  reasonCode: BlacklistReasonCode;
  reason: string;
  evidenceHashSha256: string;
  reporterId: string;
  timestampMs: number;
}

export function canonicalizeBlacklistEvidence(input: BlacklistEvidenceInput): string {
  return JSON.stringify({
    agentId: input.agentId,
    reasonCode: input.reasonCode,
    reason: input.reason,
    evidenceHashSha256: input.evidenceHashSha256,
    reporterId: input.reporterId,
    timestampMs: input.timestampMs
  });
}

export function buildBlacklistEventHash(input: {
  eventId: string;
  agentId: string;
  reasonCode: BlacklistReasonCode;
  reason: string;
  evidenceHashSha256: string;
  reporterId: string;
  sourceCoordinatorId: string;
  timestampMs: number;
  expiresAtMs?: number;
  prevEventHash: string;
  evidenceSignatureVerified: boolean;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        eventId: input.eventId,
        agentId: input.agentId,
        reasonCode: input.reasonCode,
        reason: input.reason,
        evidenceHashSha256: input.evidenceHashSha256,
        reporterId: input.reporterId,
        sourceCoordinatorId: input.sourceCoordinatorId,
        timestampMs: input.timestampMs,
        expiresAtMs: input.expiresAtMs ?? null,
        prevEventHash: input.prevEventHash,
        evidenceSignatureVerified: input.evidenceSignatureVerified
      })
    )
    .digest("hex");
}

export function verifyReporterEvidenceSignature(input: {
  evidence: BlacklistEvidenceInput;
  reporterPublicKeyPem?: string;
  reporterSignature?: string;
}): boolean {
  if (!input.reporterPublicKeyPem || !input.reporterSignature) {
    return false;
  }
  return verifyPayload(
    canonicalizeBlacklistEvidence(input.evidence),
    input.reporterSignature,
    input.reporterPublicKeyPem
  );
}

export function validateIncomingBlacklistRecord(input: {
  record: {
    eventId: string;
    agentId: string;
    reasonCode: BlacklistReasonCode;
    reason: string;
    evidenceHashSha256: string;
    reporterId: string;
    evidenceSignatureVerified: boolean;
    sourceCoordinatorId: string;
    timestampMs: number;
    expiresAtMs?: number;
    prevEventHash: string;
    eventHash: string;
    coordinatorSignature: string;
  };
  peerPublicKeyPem: string;
}): { ok: true } | { ok: false; reason: string } {
  const expectedHash = buildBlacklistEventHash({
    eventId: input.record.eventId,
    agentId: input.record.agentId,
    reasonCode: input.record.reasonCode,
    reason: input.record.reason,
    evidenceHashSha256: input.record.evidenceHashSha256,
    reporterId: input.record.reporterId,
    sourceCoordinatorId: input.record.sourceCoordinatorId,
    timestampMs: input.record.timestampMs,
    expiresAtMs: input.record.expiresAtMs,
    prevEventHash: input.record.prevEventHash,
    evidenceSignatureVerified: input.record.evidenceSignatureVerified
  });
  if (expectedHash !== input.record.eventHash) {
    return { ok: false, reason: "blacklist_event_hash_mismatch" };
  }
  if (!verifyPayload(input.record.eventHash, input.record.coordinatorSignature, input.peerPublicKeyPem)) {
    return { ok: false, reason: "blacklist_coordinator_signature_invalid" };
  }
  return { ok: true };
}
