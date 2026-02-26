// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

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
  coordinatorId?: string;
  checkpointHeight?: number;
  checkpointHash?: string;
  payloadJson?: string;
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
  coordinatorId?: string;
  checkpointHeight?: number;
  checkpointHash?: string;
  payloadJson?: string;
  signerPrivateKeyPem: string;
}): QueueEventRecord {
  const hash = hashRecordPayload({
    eventType: input.eventType,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    actorId: input.actorId,
    sequence: input.sequence,
    issuedAtMs: input.issuedAtMs,
    prevHash: input.prevHash,
    coordinatorId: input.coordinatorId,
    checkpointHeight: input.checkpointHeight,
    checkpointHash: input.checkpointHash,
    payloadJson: input.payloadJson
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
    coordinatorId: input.coordinatorId,
    checkpointHeight: input.checkpointHeight,
    checkpointHash: input.checkpointHash,
    payloadJson: input.payloadJson,
    hash,
    signature
  };
}
