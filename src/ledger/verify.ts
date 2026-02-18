import { QueueEventRecord } from "../common/types.js";
import { verifyPayload } from "../mesh/peer.js";
import { hashRecordPayload } from "./record.js";

export function verifyOrderingChain(
  records: QueueEventRecord[],
  publicKeyPem: string
): { ok: boolean; reason?: string } {
  let prevHash = "GENESIS";

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.sequence !== i + 1) {
      return { ok: false, reason: "invalid_sequence" };
    }
    if (record.prevHash !== prevHash) {
      return { ok: false, reason: "invalid_prev_hash" };
    }
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
    if (expectedHash !== record.hash) {
      return { ok: false, reason: "hash_mismatch" };
    }
    const sigOk = verifyPayload(record.hash, record.signature, publicKeyPem);
    if (!sigOk) {
      return { ok: false, reason: "invalid_signature" };
    }
    prevHash = record.hash;
  }

  return { ok: true };
}
