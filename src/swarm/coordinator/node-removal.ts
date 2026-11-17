// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

export type NodeRemovalBlocker =
  | { error: "active_reservation"; detail: string; reservationId: string; endMs: number }
  | { error: "running_task"; detail: string; runningClaims: number };

/** Why a machine should not be removed right now (an admin may still force it), or null. */
export function nodeRemovalBlocker(input: { lease?: { id: string; endMs: number }; runningClaims: number }): NodeRemovalBlocker | null {
  if (input.lease) {
    return { error: "active_reservation", detail: `holds active reservation ${input.lease.id} until ${new Date(input.lease.endMs).toISOString()}`, reservationId: input.lease.id, endMs: input.lease.endMs };
  }
  if (input.runningClaims > 0) return { error: "running_task", detail: `is running ${input.runningClaims} task(s)`, runningClaims: input.runningClaims };
  return null;
}
