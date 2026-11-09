// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { BlacklistRecord } from "../common/types.js";
import { verifyPayload } from "../mesh/peer.js";
import { buildBlacklistEventHash } from "../security/blacklist.js";
import { fingerprintMatches } from "../security/key-fingerprint.js";

export type BlacklistAudit = { chainHead: string; events: BlacklistRecord[] };

/**
 * Verify a blacklist audit chain. Signing keys are presented by the coordinator being audited
 * (`presentedKeys`, peerId -> PEM), so each one is used only when it matches a fingerprint pinned
 * independently of that coordinator (`pinnedFingerprints`, peerId -> sha256 of the SPKI DER, from
 * TRUSTED_COORDINATOR_KEYS, the trust file or the seed keys). Throws on the first problem.
 */
export function verifyBlacklistAuditChain(
  audit: BlacklistAudit,
  presentedKeys: Map<string, string>,
  pinnedFingerprints: Map<string, string>
): { eventsVerified: number; chainHead: string } {
  let previousHash = "BLACKLIST_GENESIS";
  for (const event of audit.events) {
    if (event.prevEventHash !== previousHash) throw new Error(`hash_chain_break event=${event.eventId}`);
    const expectedHash = buildBlacklistEventHash({
      eventId: event.eventId,
      agentId: event.agentId,
      reasonCode: event.reasonCode,
      reason: event.reason,
      evidenceHashSha256: event.evidenceHashSha256,
      reporterId: event.reporterId,
      sourceCoordinatorId: event.sourceCoordinatorId,
      timestampMs: event.timestampMs,
      expiresAtMs: event.expiresAtMs,
      prevEventHash: event.prevEventHash,
      evidenceSignatureVerified: event.evidenceSignatureVerified
    });
    if (expectedHash !== event.eventHash) throw new Error(`event_hash_mismatch event=${event.eventId}`);

    const pinned = pinnedFingerprints.get(event.sourceCoordinatorId);
    if (!pinned) throw new Error(`untrusted_coordinator source=${event.sourceCoordinatorId} (not in TRUSTED_COORDINATOR_KEYS)`);
    const key = presentedKeys.get(event.sourceCoordinatorId);
    if (!key) throw new Error(`missing_coordinator_key source=${event.sourceCoordinatorId}`);
    if (!fingerprintMatches(pinned, key)) throw new Error(`coordinator_key_not_pinned source=${event.sourceCoordinatorId}`);
    if (!verifyPayload(event.eventHash, event.coordinatorSignature, key)) {
      throw new Error(`coordinator_signature_invalid event=${event.eventId}`);
    }
    previousHash = event.eventHash;
  }
  if (audit.chainHead !== previousHash) throw new Error(`chain_head_mismatch expected=${previousHash} actual=${audit.chainHead}`);
  return { eventsVerified: audit.events.length, chainHead: audit.chainHead };
}
