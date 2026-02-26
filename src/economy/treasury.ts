// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import { KeyCustodyEvent, TreasuryPolicy } from "../common/types.js";
import { signPayload } from "../mesh/peer.js";

export function createTreasuryPolicy(input: {
  treasuryAccountId: string;
  multisigDescriptor: string;
  quorumThreshold: number;
  totalCustodians: number;
  approvedCoordinatorIds: string[];
  keyRotationDays: number;
}): TreasuryPolicy {
  const now = Date.now();
  return {
    policyId: randomUUID(),
    treasuryAccountId: input.treasuryAccountId,
    multisigDescriptor: input.multisigDescriptor,
    quorumThreshold: input.quorumThreshold,
    totalCustodians: input.totalCustodians,
    approvedCoordinatorIds: input.approvedCoordinatorIds,
    keyRotationDays: input.keyRotationDays,
    status: "draft",
    createdAtMs: now,
    updatedAtMs: now
  };
}

export function signKeyCustodyEvent(input: {
  policyId: string;
  actorId: string;
  action: KeyCustodyEvent["action"];
  details: string;
  privateKeyPem: string;
}): KeyCustodyEvent {
  const createdAtMs = Date.now();
  const payload = JSON.stringify({
    policyId: input.policyId,
    actorId: input.actorId,
    action: input.action,
    details: input.details,
    createdAtMs
  });
  return {
    eventId: randomUUID(),
    policyId: input.policyId,
    actorId: input.actorId,
    action: input.action,
    details: input.details,
    signature: signPayload(payload, input.privateKeyPem),
    createdAtMs
  };
}
