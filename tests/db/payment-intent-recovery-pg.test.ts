// Late settlement recovery and purchase locking on the shared database (both seeds).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PG_URL, twoCoordinatorsOneDatabase } from "../helpers/shared-pg.js";
import type { PaymentIntent } from "../../src/common/types.js";

const intent = (o: Partial<PaymentIntent> = {}): PaymentIntent => ({
  intentId: randomUUID(), accountId: "buyer", coordinatorId: "us", walletType: "lightning", network: "signet",
  invoiceRef: `lnbc-${randomUUID()}`, paymentHash: randomUUID().replace(/-/g, "").padEnd(64, "0"), amountSats: 1_000,
  coordinatorFeeBps: 0, coordinatorFeeSats: 0, netSats: 1_000, quotedCredits: 1_000, status: "created", createdAtMs: Date.now(), ...o
});

describe.skipIf(!PG_URL)("late settlement recovery (Postgres)", () => {
  it("expired -> settled only with fromExpired, once, crediting the stored intent", async () => {
    const db = await twoCoordinatorsOneDatabase();
    try {
      const old = intent({ status: "expired", createdAtMs: Date.now() - 8 * 24 * 3_600_000 });
      const recent = intent({ status: "expired", createdAtMs: Date.now() - 3_600_000 });
      const open = intent();
      for (const i of [old, recent, open]) await db.a.upsertPaymentIntent(i);
      // Only recent expired intents are listed for recovery, paged by cursor.
      const since = Date.now() - 7 * 24 * 3_600_000;
      expect((await db.a.listExpiredPaymentIntentsSince(since)).map((i) => i.intentId)).toEqual([recent.intentId]);
      expect(await db.a.listExpiredPaymentIntentsSince(since, 10, { createdAtMs: recent.createdAtMs, intentId: recent.intentId })).toEqual([]);

      // The normal settle path does not touch an expired intent.
      expect((await db.a.settlePaymentIntentAtomic(recent.intentId, "tx")).status).toBe("already");
      expect(await db.a.creditBalance("buyer")).toBe(0);
      // Recovery from both seeds at once: one credit.
      const both = await Promise.all([
        db.a.settlePaymentIntentAtomic(recent.intentId, "tx", undefined, { fromExpired: true }),
        db.b.settlePaymentIntentAtomic(recent.intentId, "tx", undefined, { fromExpired: true })
      ]);
      expect(both.map((r) => r.status).sort()).toEqual(["already", "settled"]);
      expect(await db.a.creditBalance("buyer")).toBe(1_000);
      expect((await db.b.getPaymentIntent(recent.intentId))!.status).toBe("settled");
      expect(await db.a.listExpiredPaymentIntentsSince(since)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("the purchase lock serialises one account across coordinators", async () => {
    const db = await twoCoordinatorsOneDatabase();
    try {
      const order: string[] = [];
      const work = (name: string) => async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 150));
        order.push(`${name}:end`);
      };
      await Promise.all([db.a.withAccountPurchaseLock("acct", work("a")), db.b.withAccountPurchaseLock("acct", work("b"))]);
      expect([order[0]!.split(":")[0], order[1]!.split(":")[0]]).toEqual([order[0]!.split(":")[0], order[0]!.split(":")[0]]);
      expect(order[1]).toMatch(/:end$/);
      // Another account is not blocked, and a busy lock times out instead of hanging.
      let release!: () => void;
      const held = db.a.withAccountPurchaseLock("acct2", () => new Promise<void>((r) => { release = r; }));
      await new Promise((r) => setTimeout(r, 50));
      await expect(db.b.withAccountPurchaseLock("acct2", async () => 1, 300)).rejects.toThrow(/purchase_lock_busy/);
      expect(await db.b.withAccountPurchaseLock("acct3", async () => 7)).toBe(7);
      release();
      await held;
    } finally {
      await db.close();
    }
  });
});
