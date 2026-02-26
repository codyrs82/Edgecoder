// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";

export interface LedgerEvent {
  sequence: number;
  hash: string;
  prevHash: string;
  payload: string;
}

export interface LedgerVerifyResult {
  valid: boolean;
  breakpoint?: number;
  reason?: string;
}

export function verifyLedgerChain(events: LedgerEvent[]): LedgerVerifyResult {
  if (events.length === 0) {
    return { valid: true };
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // Check monotonic sequence
    if (i > 0 && event.sequence !== events[i - 1].sequence + 1) {
      return {
        valid: false,
        breakpoint: event.sequence,
        reason: "sequence_gap",
      };
    }

    // Verify hash = SHA256(prevHash + payload)
    const expectedHash = createHash("sha256")
      .update(event.prevHash + event.payload)
      .digest("hex");

    if (event.hash !== expectedHash) {
      return {
        valid: false,
        breakpoint: event.sequence,
        reason: "hash_mismatch",
      };
    }

    // Check chain linkage (event's prevHash must match previous event's hash)
    if (i > 0 && event.prevHash !== events[i - 1].hash) {
      return {
        valid: false,
        breakpoint: event.sequence,
        reason: "chain_break",
      };
    }
  }

  return { valid: true };
}
