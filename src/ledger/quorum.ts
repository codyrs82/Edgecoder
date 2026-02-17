import { createHash, randomUUID } from "node:crypto";
import { QuorumLedgerRecord } from "../common/types.js";
import { signPayload, verifyPayload } from "../mesh/peer.js";

export function createQuorumLedgerRecord(input: {
  recordType: QuorumLedgerRecord["recordType"];
  epochId: string;
  coordinatorId: string;
  prevHash: string;
  payloadJson: string;
  privateKeyPem: string;
}): QuorumLedgerRecord {
  const hash = createHash("sha256")
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

export function verifyQuorumLedgerRecord(record: QuorumLedgerRecord, publicKeyPem: string): boolean {
  return verifyPayload(record.hash, record.signature, publicKeyPem);
}
