import { describe, expect, it } from "vitest";
import { closeUnreservedBillingRow, settleUnreservedBillingRows, UNRESERVED_ROW_MIN_AGE_MS } from "../../src/swarm/coordinator/billing-restore.js";
import { identity, taskBilling } from "../../src/swarm/coordinator/context.js";

/*
 * A submit refused before its reserve (402 insufficient cSats) used to leave its task_billing row
 * open for ever. It is closed at once when the ledger has nothing under it, and a reconcile closes
 * the orphans left before; a row whose debit happened is never closed by either.
 */

type Row = { taskId: string; accountId: string; kind: string; perSubtaskReserveMsat: number; subtaskIds: string[] | null; createdAtMs: number; settledAtMs?: number; coordinatorId: string };
function fakeStore(rows: Row[], ledger: Record<string, { reservedMsat: number; paidMsat: number; refundedMsat: number }>) {
  return {
    rows,
    async listOpenTaskBilling(coordinatorId: string) {
      return rows.filter((r) => r.coordinatorId === coordinatorId && r.settledAtMs === undefined);
    },
    async taskLedgerTotals(tasks: Array<{ taskId: string }>) {
      return new Map(tasks.map((t) => [t.taskId, ledger[t.taskId] ?? { reservedMsat: 0, paidMsat: 0, refundedMsat: 0 }]));
    },
    async markTaskBillingSettled(taskId: string, atMs: number, coordinatorId?: string) {
      for (const r of rows) if (r.taskId === taskId && r.settledAtMs === undefined && (!coordinatorId || r.coordinatorId === coordinatorId)) r.settledAtMs = atMs;
    },
  };
}
const row = (taskId: string, createdAtMs: number, coordinatorId = identity.peerId): Row => ({ taskId, accountId: "acct-1", kind: "inference", perSubtaskReserveMsat: 5_000, subtaskIds: null, createdAtMs, coordinatorId });

describe("billing rows of refused submits", () => {
  it("a refused submit's row is closed when the ledger has nothing under it, and only then", async () => {
    const store = fakeStore([row("refused", 1_000), row("debited", 1_000)], { debited: { reservedMsat: 5_000, paidMsat: 0, refundedMsat: 0 } });
    expect(await closeUnreservedBillingRow(store as never, { taskId: "refused", accountId: "acct-1", kind: "inference" }, 2_000)).toBe(true);
    expect(await closeUnreservedBillingRow(store as never, { taskId: "debited", accountId: "acct-1", kind: "inference" }, 2_000)).toBe(false);
    expect(store.rows.map((r) => [r.taskId, r.settledAtMs ?? null])).toEqual([["refused", 2_000], ["debited", null]]);
    // Idempotent.
    expect(await closeUnreservedBillingRow(store as never, { taskId: "refused", accountId: "acct-1", kind: "inference" }, 3_000)).toBe(true);
    expect(store.rows[0].settledAtMs).toBe(2_000);
  });

  it("the reconcile closes old orphans, never a fresh row, a live task, a debited one or another coordinator's", async () => {
    const now = 10 * UNRESERVED_ROW_MIN_AGE_MS;
    const store = fakeStore(
      [row("orphan", 0), row("fresh", now - 1_000), row("live", 0), row("debited", 0), row("paid-refunded", 0), row("other-seed", 0, "coord-other")],
      { debited: { reservedMsat: 5_000, paidMsat: 0, refundedMsat: 0 }, "paid-refunded": { reservedMsat: 0, paidMsat: 10, refundedMsat: 0 } },
    );
    taskBilling.set("live", { accountId: "acct-1", reservedMsat: 0, perSubtaskReserveMsat: 0, costMsat: 0, refunded: false });
    try {
      expect(await settleUnreservedBillingRows(store as never, now)).toBe(1);
      expect(store.rows.filter((r) => r.settledAtMs !== undefined).map((r) => r.taskId)).toEqual(["orphan"]);
      expect(await settleUnreservedBillingRows(store as never, now)).toBe(0);
    } finally {
      taskBilling.delete("live");
    }
  });
});
