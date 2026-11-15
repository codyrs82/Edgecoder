// Copyright (c) 2025 EdgeCoder, LLC
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
  const minAge = d.minAgeMs ?? TASK_BILLING_SWEEP_MIN_AGE_MS;
  const locked = await d.store.withTaskBillingSweepLock(d.coordinatorId, async () => {
    const stale = (await d.store.listOpenTaskBilling(d.coordinatorId)).filter((r) => now - r.createdAtMs >= minAge && !d.isLive(r.taskId));
    if (stale.length === 0) return { swept: 0 };
    return { swept: stale.length, summary: await d.restore(stale) };
  });
  if (!locked.acquired) return { skipped: "locked", swept: 0 };
  return locked.value;
}
