// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Periodic sweep of task billing left open by an instance that is gone.
 *
 * Billing is restored at startup (coordinator/billing-restore.ts). During a deploy the outgoing
 * instance can still accept calls after the incoming one (same coordinator id) has restored, and
 * those rows then stayed open until the next restart; on the live regtest network (2026-11-15) 10
 * model-call reserves waited about 9 minutes. Every TASK_BILLING_SWEEP_INTERVAL_MS this coordinator
 * looks at its own open rows, and the ones that are older than TASK_BILLING_SWEEP_MIN_AGE_MS and
 * that no task in this process holds go through the same resume-or-refund as at startup.
 *
 * Safe with several instances on one database: the sweep runs under a Postgres try-advisory-lock
 * per coordinator id (a second instance skips), only this coordinator id's rows are touched, the
 * minimum age is far longer than a model call (6 min stream deadline) or a deploy overlap, and the
 * refund row has a deterministic tx id, so a refund is never paid twice.
 *
 * That sweep skips every row a task in this process still holds in memory, so it never caught a
 * reserve this process itself forgot to settle (a model call whose settle was skipped or whose
 * refund failed all its retries, a code task whose split threw after the debit; st1 held such a
 * 750-cSat model-call reserve). The idle sweep (idleTaskBilling, below) covers those: every
 * TASK_BILLING_SWEEP_INTERVAL_MS it looks at this process's open billing, and an entry with no open
 * work (no queued, running, held or granted subtask, no result being paid, no result held for
 * verification) that was already idle on a sweep at least TASK_BILLING_IDLE_SWEEP_MS earlier is
 * settled: what it did not use goes back to the requester (same deterministic refund tx id).
 * Runs with or without Postgres.
 */
export interface OpenTaskBillingRow {
  taskId: string;
  accountId: string;
  kind: string;
  perSubtaskReserveMsat: number;
  subtaskIds: string[] | null;
  createdAtMs: number;
}

export interface BillingSweepStore {
  listOpenTaskBilling(coordinatorId: string): Promise<OpenTaskBillingRow[]>;
  withTaskBillingSweepLock<T>(coordinatorId: string, fn: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }>;
}

export interface BillingSweepSummary {
  resumed: number;
  refunded: number;
  subtasksRestored: number;
}

export const TASK_BILLING_SWEEP_MIN_AGE_MS = 30 * 60_000;
/**
 * A model call's row is swept sooner: no call lives past its 6-minute stream deadline, so a row
 * older than this that no task here holds is a call lost to a restart or an overlap (#524).
 */
export const INFERENCE_BILLING_SWEEP_MIN_AGE_MS = 8 * 60_000;
export const TASK_BILLING_SWEEP_INTERVAL_MS = 5 * 60_000;

export async function sweepStaleTaskBilling(d: {
  store: BillingSweepStore;
  coordinatorId: string;
  /** True when a task in this process holds the row (it is running here; not stale). */
  isLive: (taskId: string) => boolean;
  /** Resume or refund, as at startup (restoreTaskBillingRows). */
  restore: (rows: OpenTaskBillingRow[]) => Promise<BillingSweepSummary>;
  nowMs?: number;
  minAgeMs?: number;
}): Promise<{ swept: number; skipped?: "locked"; summary?: BillingSweepSummary }> {
  const now = d.nowMs ?? Date.now();
  const minAgeOf = (kind: string) => d.minAgeMs ?? (kind === "inference" ? INFERENCE_BILLING_SWEEP_MIN_AGE_MS : TASK_BILLING_SWEEP_MIN_AGE_MS);
  const locked = await d.store.withTaskBillingSweepLock(d.coordinatorId, async () => {
    const stale = (await d.store.listOpenTaskBilling(d.coordinatorId)).filter((r) => now - r.createdAtMs >= minAgeOf(r.kind) && !d.isLive(r.taskId));
    if (stale.length === 0) return { swept: 0 };
    return { swept: stale.length, summary: await d.restore(stale) };
  });
  if (!locked.acquired) return { skipped: "locked", swept: 0 };
  return locked.value;
}

/** How long an in-memory billing entry must stay idle (no open work) before the idle sweep settles it. */
export const TASK_BILLING_IDLE_SWEEP_MS = 10 * 60_000;

/**
 * Task ids whose billing has had no open work for at least `minIdleMs`: idle now, and already idle
 * when first seen so at least that long ago. `idleSince` carries those first sightings from one sweep
 * to the next; entries that are busy again or gone are dropped from it.
 */
export function idleTaskBilling(d: {
  taskIds: Iterable<string>;
  isBusy: (taskId: string) => boolean;
  idleSince: Map<string, number>;
  nowMs?: number;
  minIdleMs?: number;
}): string[] {
  const now = d.nowMs ?? Date.now();
  const minIdle = d.minIdleMs ?? TASK_BILLING_IDLE_SWEEP_MS;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of d.taskIds) {
    seen.add(id);
    if (d.isBusy(id)) {
      d.idleSince.delete(id);
      continue;
    }
    const since = d.idleSince.get(id);
    if (since === undefined) d.idleSince.set(id, now);
    else if (now - since >= minIdle) out.push(id);
  }
  for (const id of [...d.idleSince.keys()]) if (!seen.has(id)) d.idleSince.delete(id);
  return out;
}
