// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The worker's buffer of results it could not deliver (coordinator unreachable, rate limited).
 *
 * A result the coordinator refused for good is dropped, not retried: 409 `lease_expired` means the
 * claim's lease lapsed and the subtask went back on the queue (src/swarm/lease-gate.ts), so the
 * coordinator will refuse it every time. Kept in the buffer, it was retried forever and, because a
 * flush stops at the first failure, held back every result queued behind it.
 */

/** The coordinator will never take this result: its claim's lease lapsed (409 lease_expired). */
export function isPermanentResultRefusal(error: unknown): boolean {
  const e = error as { statusCode?: unknown; message?: unknown } | null;
  return !!e && e.statusCode === 409 && typeof e.message === "string" && e.message.includes("lease_expired");
}

export interface PendingResultStore {
  listPendingResults(limit?: number): Array<{ subtaskId: string; payload: string; attempts: number }>;
  markResultSynced(subtaskId: string): void;
  incrementResultAttempt(subtaskId: string): void;
}

export interface FlushOutcome {
  flushed: string[];
  dropped: string[];
  /** The result the flush stopped at (a failure worth retrying later), if any. */
  stoppedAt?: string;
}

/**
 * Send buffered results oldest first. A delivered one leaves the buffer; one refused for good
 * (isPermanentResultRefusal) is dropped and logged once, and the flush goes on; any other failure
 * counts an attempt and stops the flush (the coordinator is likely still unreachable).
 */
export async function flushPendingResultBuffer(
  store: PendingResultStore,
  post: (payload: unknown) => Promise<unknown>,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
  limit = 20
): Promise<FlushOutcome> {
  const outcome: FlushOutcome = { flushed: [], dropped: [] };
  const pending = store.listPendingResults(limit);
  if (pending.length === 0) return outcome;
  log.info(`flushing ${pending.length} buffered result(s)`);
  for (const row of pending) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      store.markResultSynced(row.subtaskId);
      outcome.dropped.push(row.subtaskId);
      log.warn(`dropped unreadable buffered result: ${row.subtaskId}`);
      continue;
    }
    try {
      await post(payload);
      store.markResultSynced(row.subtaskId);
      outcome.flushed.push(row.subtaskId);
      log.info(`flushed result: ${row.subtaskId}`);
    } catch (error) {
      if (isPermanentResultRefusal(error)) {
        store.markResultSynced(row.subtaskId);
        outcome.dropped.push(row.subtaskId);
        log.warn(`dropped buffered result ${row.subtaskId}: the coordinator refused it (lease_expired: the claim lapsed and the call went back on the queue)`);
        continue;
      }
      store.incrementResultAttempt(row.subtaskId);
      log.warn(`flush failed for ${row.subtaskId} (attempt ${row.attempts + 1}), stopping`);
      outcome.stoppedAt = row.subtaskId;
      break;
    }
  }
  return outcome;
}
