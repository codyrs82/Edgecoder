import { createHash } from "node:crypto";
import { QueueEventRecord } from "../common/types.js";
import { signPayload } from "../mesh/peer.js";

export type QueueEventType = QueueEventRecord["eventType"];

export function hashRecordPayload(payload: {
  eventType: QueueEventType;
  taskId: string;
  subtaskId?: string;
  actorId: string;
  sequence: number;
  issuedAtMs: number;
  prevHash: string;
}): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function createQueueEventRecord(input: {
  id: string;
  eventType: QueueEventType;
  taskId: string;
  subtaskId?: string;
  actorId: string;
  sequence: number;
  issuedAtMs: number;
  prevHash: string;
  signerPrivateKeyPem: string;
}): QueueEventRecord {
  const hash = hashRecordPayload({
    eventType: input.eventType,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    actorId: input.actorId,
    sequence: input.sequence,
    issuedAtMs: input.issuedAtMs,
    prevHash: input.prevHash
  });

  const signature = signPayload(hash, input.signerPrivateKeyPem);
  return {
    id: input.id,
    eventType: input.eventType,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    actorId: input.actorId,
    sequence: input.sequence,
    issuedAtMs: input.issuedAtMs,
    prevHash: input.prevHash,
    hash,
    signature
  };
}
