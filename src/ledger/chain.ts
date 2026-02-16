import { randomUUID } from "node:crypto";
import { QueueEventRecord } from "../common/types.js";
import { createQueueEventRecord } from "./record.js";

export class OrderingChain {
  private records: QueueEventRecord[] = [];

  constructor(
    private readonly signerPeerId: string,
    private readonly signerPrivateKeyPem: string
  ) {}

  append(event: {
    eventType: QueueEventRecord["eventType"];
    taskId: string;
    subtaskId?: string;
    actorId: string;
  }): QueueEventRecord {
    const prev = this.records[this.records.length - 1];
    const record = createQueueEventRecord({
      id: randomUUID(),
      eventType: event.eventType,
      taskId: event.taskId,
      subtaskId: event.subtaskId,
      actorId: event.actorId,
      sequence: this.records.length + 1,
      issuedAtMs: Date.now(),
      prevHash: prev?.hash ?? "GENESIS",
      signerPrivateKeyPem: this.signerPrivateKeyPem
    });
    this.records.push(record);
    return record;
  }

  latestProof(): {
    recordId: string;
    hash: string;
    prevHash: string;
    sequence: number;
    signerPeerId: string;
  } | null {
    const latest = this.records[this.records.length - 1];
    if (!latest) return null;
    return {
      recordId: latest.id,
      hash: latest.hash,
      prevHash: latest.prevHash,
      sequence: latest.sequence,
      signerPeerId: this.signerPeerId
    };
  }

  snapshot(): QueueEventRecord[] {
    return [...this.records];
  }
}
