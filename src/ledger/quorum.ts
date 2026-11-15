// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash, randomUUID } from "node:crypto";
import { QuorumLedgerRecord } from "../common/types.js";
import { signPayload, verifyPayload } from "../mesh/peer.js";

type QuorumHashFields = Pick<QuorumLedgerRecord, "recordType" | "epochId" | "coordinatorId" | "prevHash" | "payloadJson">;

function quorumRecordHash(input: QuorumHashFields): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        recordType: input.recordType,
        epochId: input.epochId,
        coordinatorId: input.coordinatorId,
        prevHash: input.prevHash,
        payloadJson: input.payloadJson
      })
    )
    .digest("hex");
}

export function createQuorumLedgerRecord(input: {
  recordType: QuorumLedgerRecord["recordType"];
  epochId: string;
  coordinatorId: string;
  prevHash: string;
  payloadJson: string;
  privateKeyPem: string;
}): QuorumLedgerRecord {
  const hash = quorumRecordHash(input);
  return {
    recordId: randomUUID(),
    recordType: input.recordType,
    epochId: input.epochId,
    coordinatorId: input.coordinatorId,
    prevHash: input.prevHash,
    hash,
    payloadJson: input.payloadJson,
    signature: signPayload(hash, input.privateKeyPem),
    createdAtMs: Date.now()
  };
}

/** The signature covers `hash`, so the hash must be recomputed from the fields it claims to cover. */
export function verifyQuorumLedgerRecord(record: QuorumLedgerRecord, publicKeyPem: string): boolean {
  if (quorumRecordHash(record) !== record.hash) return false;
  return verifyPayload(record.hash, record.signature, publicKeyPem);
}
