// Proof of reserves, ledger side (PostgresStore.reserveLiabilitiesMsat): totals only, from the
// existing credit_transactions and task_billing tables (no new table).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PG_URL, twoCoordinatorsOneDatabase } from "../helpers/shared-pg.js";
import type { CreditTransaction } from "../../src/common/types.js";

const row = (accountId: string, type: "earn" | "spend", credits: number, reason: string, extra: Partial<CreditTransaction> = {}): CreditTransaction => ({
  txId: randomUUID(), accountId, type, credits, reason, timestampMs: Date.now(), ...extra
});

describe.skipIf(!PG_URL)("reserveLiabilitiesMsat (Postgres)", () => {
  it("sums positive balances, the pool at its sats and open task reserves", async () => {
    const db = await twoCoordinatorsOneDatabase();
    try {
      const s = db.a;
      expect(await s.reserveLiabilitiesMsat()).toEqual({ accountBalancesMsat: 0, feePoolMsat: 0, heldForJobsMsat: 0 });
      // Buyer: 1 000 bought, 400 reserved for an open task (100 paid out so far), 50 reserved for a settled task.
      await s.persistCreditTransaction(row("buyer", "earn", 1_000, "credit_purchase:i1"));
      await s.persistCreditTransaction(row("buyer", "spend", 400, "task_reserve", { relatedTaskId: "open-1" }));
      await s.persistCreditTransaction(row("buyer", "spend", 50, "task_reserve", { relatedTaskId: "done-1" }));
      await s.persistCreditTransaction(row("host", "earn", 95, "compute_contribution", { relatedTaskId: "open-1", msat: 95_000 }));
      await s.persistCreditTransaction(row("network:fee_pool", "earn", 5, "network_fee:open-1", { relatedTaskId: "open-1", msat: 5_000 }));
      // An account below zero must not offset the others.
      await s.persistCreditTransaction(row("broken", "spend", 30, "adjust"));
      await s.insertTaskBilling({ taskId: "open-1", coordinatorId: "c", accountId: "buyer", kind: "job", perSubtaskReserveMsat: 400_000, createdAtMs: 1 });
      await s.insertTaskBilling({ taskId: "done-1", coordinatorId: "c", accountId: "buyer", kind: "job", perSubtaskReserveMsat: 50_000, createdAtMs: 1 });
      await s.markTaskBillingSettled("done-1", 2);
      expect(await s.reserveLiabilitiesMsat()).toEqual({
        accountBalancesMsat: (550 + 95) * 1000,
        feePoolMsat: 5_000,
        heldForJobsMsat: (400 - 100) * 1000
      });
    } finally {
      await db.close();
    }
  });
});
