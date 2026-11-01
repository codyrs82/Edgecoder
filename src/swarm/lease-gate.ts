// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { SwarmQueue } from "./queue.js";

/**
 * #51: a result from an agent whose lease on the subtask expired is late. The
 * coordinator's /result route runs this before the #44 claim/peer-forward checks
 * and before any credit is accrued.
 */
export function lateResultRejection(
  queue: Pick<SwarmQueue, "leaseExpiredFor">,
  subtaskId: string,
  agentId: string
): { statusCode: 409; body: { error: "lease_expired" } } | null {
  return queue.leaseExpiredFor(subtaskId, agentId) ? { statusCode: 409, body: { error: "lease_expired" } } : null;
}
