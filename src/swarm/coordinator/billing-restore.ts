// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Stress finding 2: a coordinator restart (every deploy) lost its queued and running subtasks and
 * their billing (both in memory), so the requester's reserve stayed spent forever.
 *
 * Billing is now written to task_billing when a task is submitted and marked settled once its
 * unused reserve is refunded. On startup every task this coordinator billed and did not settle is
 * either resumed or refunded:
 * - resumed when it is a code job whose every subtask is accounted for: finished (result recorded),
 *   held for verification (restored by #105), or queued/running (queue_tasks row, no result). The
 *   queued ones go back on the queue; a running one keeps its claimant with a fresh lease, so its
 *   result is accepted if it reports, and it is requeued when the lease lapses. Billing is restored
 *   from the ledger: the reserve is what the requester was debited, the cost is what its work was
 *   paid (agent + fee rows), so nothing is paid twice and the refund is exact.
 * - refunded otherwise (a model call, whose requester's stream is gone; a subtask held behind
 *   dependencies, never written to the queue; a task cut off before it was split): the unused
 *   reserve (reserve − paid − already refunded) goes back to the requester and its open subtasks
 *   are recorded as failed, so nothing more is paid for them.
 * Never creates cSats: everything is computed from the ledger, and the refund row has the task's
 * deterministic tx id (a second refund is a no-op).
 */
import type { Subtask, SubtaskResult } from "../../common/types.js";
import type { PostgresStore } from "../../db/postgres.js";
import { sweepStaleTaskBilling, type OpenTaskBillingRow } from "../billing-sweep.js";
import { refundTxId } from "../../credits/store.js";
import type { ComputeClassId } from "../../economy/compute-classes.js";
import { capabilityConstraints } from "../../economy/order-book.js";
import { app } from "./app.js";
import { identity, queue, taskBilling } from "./context.js";
import { orderBook, MARKET_DEFAULT_BID_PREMIUM_BPS } from "./economy.js";
import { refundTaskSubmit, resultVerifier, settleTaskIfDone } from "./results.js";

export interface BillingRestoreSummary {
  resumed: number;
  refunded: number;
  subtasksRestored: number;
}

export async function restoreTaskBilling(store: PostgresStore, nowMs = Date.now()): Promise<BillingRestoreSummary> {
  return restoreTaskBillingRows(store, await store.listOpenTaskBilling(identity.peerId), nowMs);
}

/**
 * Resume or refund these open billing rows (startup, and the periodic sweep for rows an instance
 * that is gone left open: billing-sweep.ts). Rows a task in this process holds are skipped.
 */
export async function restoreTaskBillingRows(store: PostgresStore, rows: OpenTaskBillingRow[], nowMs = Date.now()): Promise<BillingRestoreSummary> {
  const summary: BillingRestoreSummary = { resumed: 0, refunded: 0, subtasksRestored: 0 };
  if (rows.length === 0) return summary;
  const totals = await store.taskLedgerTotals(rows.map((r) => ({ taskId: r.taskId, refundTxId: refundTxId(r.taskId) })));
  for (const row of rows) {
    if (taskBilling.has(row.taskId)) continue;
    const t = totals.get(row.taskId) ?? { reservedMsat: 0, paidMsat: 0, refundedMsat: 0 };
    // Restored billing: the refund that settles it is reserve − paid (a refund row already written,
    // e.g. the process died before marking the row settled, is the same tx id and is not repeated).
    taskBilling.set(row.taskId, {
      accountId: row.accountId,
      reservedMsat: t.reservedMsat,
      perSubtaskReserveMsat: row.perSubtaskReserveMsat,
      costMsat: Math.min(t.reservedMsat, t.paidMsat),
      refunded: false
    });
    const ids = row.subtaskIds ?? [];
    let plan: { subtasks: Array<{ subtask: Subtask; claimedBy: string | null; claimedAtMs: number | null; attempts: number }> } | null = null;
    if (row.kind === "job" && row.subtaskIds && ids.length > 0) {
      const done = await store.subtasksWithResults(ids);
      const unfinished = await store.listUnfinishedSubtasks(ids);
      const queued = new Set(unfinished.map((u) => u.subtask.id));
      const lost = ids.filter((id) => !done.has(id) && !queued.has(id) && !resultVerifier.isPending(id));
      if (lost.length === 0) plan = { subtasks: unfinished.filter((u) => !resultVerifier.isPending(u.subtask.id)) };
    }
    if (!plan) {
      // Cannot be resumed: refund what was not used, and close its open subtasks as failed.
      const open = (await store.listUnfinishedSubtasks(ids)).map((u) => u.subtask);
      for (const s of open) {
        const failed: SubtaskResult = { subtaskId: s.id, taskId: s.taskId, agentId: "coordinator", ok: false, output: "", error: "coordinator_restarted", durationMs: 0 };
        queue.complete(failed);
      }
      const ok = await refundTaskSubmit(row.taskId);
      summary.refunded++;
      app.log.warn({ taskId: row.taskId, kind: row.kind, reservedMsat: t.reservedMsat, paidMsat: t.paidMsat, refundedBeforeMsat: t.refundedMsat, failedSubtasks: open.length, ok }, "task_billing_restored_refunded");
      continue;
    }
    for (const u of plan.subtasks) {
      const claim = u.claimedBy && u.claimedAtMs !== null ? { agentId: u.claimedBy, claimedAtMs: u.claimedAtMs } : undefined;
      if (queue.restoreSubtask(u.subtask, { attempts: u.attempts, claim }, nowMs)) summary.subtasksRestored++;
    }
    // The requester's bid goes back in the book (class, ceiling, capability constraints).
    const meta = plan.subtasks[0]?.subtask.projectMeta;
    if (meta && !orderBook.bidFor(row.taskId)) {
      orderBook.postBid(row.taskId, (meta.computeClass ?? "any") as ComputeClassId | "any", meta.maxBidMsatPerCredit, MARKET_DEFAULT_BID_PREMIUM_BPS, nowMs, capabilityConstraints(meta));
    }
    summary.resumed++;
    // Everything had finished already: settle now.
    await settleTaskIfDone(row.taskId);
  }
  if (summary.resumed + summary.refunded > 0) app.log.info(summary, "task_billing_restored");
  return summary;
}

/** The periodic sweep (billing-sweep.ts) wired to this coordinator. */
export async function sweepTaskBilling(store: PostgresStore): Promise<void> {
  const r = await sweepStaleTaskBilling({ store, coordinatorId: identity.peerId, isLive: (taskId) => taskBilling.has(taskId), restore: (rows) => restoreTaskBillingRows(store, rows) });
  if (r.swept > 0) app.log.warn({ ...r }, "task_billing_swept");
}
