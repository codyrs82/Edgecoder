/**
 * In-memory store for human escalation entries.
 *
 * When all automated resolvers in the escalation waterfall fail, the
 * EscalationResolver creates a HumanEscalation record here. The portal
 * server exposes API endpoints that let a human operator list pending
 * escalations, provide additional context, or directly edit the code.
 */

import { HumanEscalation, HumanEscalationStatus } from "./types.js";

const humanEscalations = new Map<string, HumanEscalation>();

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export function createHumanEscalation(entry: HumanEscalation): void {
  humanEscalations.set(entry.escalationId, entry);
}

export function getHumanEscalation(escalationId: string): HumanEscalation | undefined {
  return humanEscalations.get(escalationId);
}

export function updateHumanEscalation(
  escalationId: string,
  updates: Partial<HumanEscalation>
): HumanEscalation | undefined {
  const existing = humanEscalations.get(escalationId);
  if (!existing) return undefined;
  const updated: HumanEscalation = {
    ...existing,
    ...updates,
    updatedAtMs: Date.now(),
  };
  humanEscalations.set(escalationId, updated);
  return updated;
}

export function listHumanEscalations(
  status?: HumanEscalationStatus
): HumanEscalation[] {
  const all = Array.from(humanEscalations.values());
  if (!status) return all;
  return all.filter((e) => e.status === status);
}

export function countPendingHumanEscalations(): number {
  let count = 0;
  for (const entry of humanEscalations.values()) {
    if (entry.status === "pending_human") count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Test helper — clear all entries (only for use in tests)
// ---------------------------------------------------------------------------

export function clearHumanEscalations(): void {
  humanEscalations.clear();
}
