// A withdrawal consumes the credit balance; a spend lowers what can be withdrawn. Earned value
// leaves the ledger once, either as sats or as cSats spent, never both.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL, twoCoordinatorsOneDatabase, type SharedDb } from "../helpers/shared-pg.js";
import { MemoryPayoutStore, PayoutService } from "../../src/economy/payout-service.js";
import { DEFAULT_PAYOUT_POLICY, creditsToMsat, msatToCredits, payoutSettlementRefundMsat, validatePayoutRequest, withdrawableMsat } from "../../src/economy/payouts.js";
import type { LightningProvider, PayInvoiceResult } from "../../src/economy/lightning.js";
import type { PostgresStore } from "../../src/db/postgres.js";
import type { CreditTransaction, PayoutRecord } from "../../src/common/types.js";
import { encodeTestBolt11 } from "./helpers/bolt11-encode.js";

// Flat 10-sat fee cap keeps the arithmetic readable.
const policy = { ...DEFAULT_PAYOUT_POLICY, network: "signet" as const, maxFeeBps: 0 };
const FEE_CAP = 10_000;

function invoice(amountMsat: number, preimage = randomBytes(32).toString("hex")) {
  const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  return { bolt11: encodeTestBolt11({ network: "tbs", amountMsat, paymentHashHex: hash }), hash, preimage };
}
function provider(pay: () => PayInvoiceResult): LightningProvider {
  return { createInvoice: async () => { throw new Error("n/a"); }, checkSettlement: async () => ({ settled: false }), payInvoice: async () => pay() };
}
const earn = (accountId: string, sats: number, withMsat = true): CreditTransaction => ({
  txId: randomUUID(), accountId, type: "earn", credits: sats, reason: withMsat ? "compute_contribution" : "credit_purchase:x", timestampMs: Date.now(), ...(withMsat ? { msat: sats * 1000 } : {})
});
const spend = (accountId: string, sats: number): CreditTransaction => ({ txId: randomUUID(), accountId, type: "spend", credits: sats, reason: "reservation", timestampMs: Date.now() });

describe("payout credit arithmetic", () => {
  it("caps payable at the credit balance and converts exactly", () => {
    expect(withdrawableMsat(10_000_000, 0, 10_000)).toBe(10_000_000);
    expect(withdrawableMsat(10_000_000, 0, 2_500.5)).toBe(2_500_500);
    expect(withdrawableMsat(10_000_000, 9_000_000, 10_000)).toBe(1_000_000);
    expect(withdrawableMsat(10_000_000, 0, -5)).toBe(0);
    expect(creditsToMsat(0.1 + 0.2)).toBe(300);
    expect(msatToCredits(2_010_001)).toBe(2010.001);
    expect(payoutSettlementRefundMsat(2_010_000, { status: "failed" })).toBe(2_010_000);
    expect(payoutSettlementRefundMsat(2_010_000, { status: "paid", amountMsat: 2_000_000, feeMsat: 1_500 })).toBe(8_500);
    expect(payoutSettlementRefundMsat(2_010_000, { status: "paid", amountMsat: 2_000_000, feeMsat: 12_000 })).toBe(-2_000);
  });
});

describe("manual withdraw leaves room for the fee cap inside payable", () => {
  it("rejects an invoice for the whole payable balance; accepts one that leaves the cap", () => {
    const whole = invoice(10_000_000);
    expect(validatePayoutRequest({ bolt11: whole.bolt11, payableMsat: 10_000_000, capacityMsat: 1e12 }, policy)).toMatchObject({ ok: false, code: "insufficient_payable" });
    expect(validatePayoutRequest({ bolt11: invoice(9_990_000).bolt11, payableMsat: 10_000_000, capacityMsat: 1e12 }, policy)).toMatchObject({ ok: true, maxFeeMsat: FEE_CAP });
  });
});

describe("withdrawals consume the credit balance (memory store)", () => {
  function setup(pay: () => PayInvoiceResult) {
    const store = new MemoryPayoutStore(() => 0);
    store.received = 1_000_000_000;
    const svc = new PayoutService({ store, provider: provider(pay), policy, coordinatorId: "c", feePoolAccountId: "pool" });
    return { store, svc };
  }

  it("a paid withdrawal debits amount + actual fee from the credit balance", async () => {
    const inv = invoice(2_000_000);
    const { store, svc } = setup(() => ({ status: "succeeded", preimage: inv.preimage, feeMsat: 1_500 }));
    await store.recordCreditTransactions([earn("a", 10_000)]);
    expect((await svc.withdraw("a", inv.bolt11)).ok).toBe(true);
    expect(await store.creditBalance("a")).toBeCloseTo(10_000 - 2_001.5, 6);
    expect((await svc.balance("a")).payableMsat).toBe(10_000_000 - 2_001_500);
  });

  it("earnings already spent as cSats cannot be withdrawn", async () => {
    const { store, svc } = setup(() => ({ status: "succeeded" }));
    await store.recordCreditTransactions([earn("a", 10_000), spend("a", 9_000)]);
    expect((await svc.balance("a")).payableMsat).toBe(1_000_000);
    expect(await svc.withdraw("a", invoice(2_000_000).bolt11)).toMatchObject({ ok: false, code: "insufficient_payable" });
    expect(store.payouts.size).toBe(0);
  });

  it("purchased cSats are not withdrawable", async () => {
    const { store, svc } = setup(() => ({ status: "succeeded" }));
    await store.recordCreditTransactions([earn("a", 50_000, false)]);
    expect((await svc.balance("a")).payableMsat).toBe(0);
  });

  it("a failed payout gives the whole debit back, once", async () => {
    const { store, svc } = setup(() => ({ status: "failed", error: "lnd_pay_error:FAILURE_REASON_NO_ROUTE" }));
    await store.recordCreditTransactions([earn("a", 10_000)]);
    const r = await svc.withdraw("a", invoice(2_000_000).bolt11);
    expect(r).toMatchObject({ ok: false, code: "payout_failed" });
    expect(await store.creditBalance("a")).toBeCloseTo(10_000, 6);
    const id = [...store.payouts.keys()][0];
    await store.settlePayout(id, { status: "failed", error: "again" });
    expect(await store.creditBalance("a")).toBeCloseTo(10_000, 6);
  });

  it("a pending payout holds amount + fee cap out of the balance", async () => {
    const { store, svc } = setup(() => ({ status: "failed", error: "lnd_pay_transport:timeout" }));
    await store.recordCreditTransactions([earn("a", 10_000)]);
    expect(await svc.withdraw("a", invoice(2_000_000).bolt11)).toMatchObject({ code: "payout_unconfirmed" });
    expect(await store.creditBalance("a")).toBeCloseTo(10_000 - 2_010, 6);
  });

  it("withdrawing the whole balance leaves nothing to spend or withdraw again", async () => {
    const inv = invoice(9_990_000);
    const { store, svc } = setup(() => ({ status: "succeeded", preimage: inv.preimage, feeMsat: FEE_CAP }));
    await store.recordCreditTransactions([earn("a", 10_000)]);
    expect((await svc.withdraw("a", inv.bolt11)).ok).toBe(true);
    expect(await store.creditBalance("a")).toBeCloseTo(0, 6);
    expect((await svc.balance("a")).payableMsat).toBe(0);
  });

  it("concurrent withdrawals cannot both draw on the same balance", async () => {
    const { store, svc } = setup(() => ({ status: "failed", error: "lnd_pay_transport:timeout" }));
    await store.recordCreditTransactions([earn("a", 10_000)]);
    const rs = await Promise.all([svc.withdraw("a", invoice(6_000_000).bolt11), svc.withdraw("a", invoice(6_000_000).bolt11)]);
    expect(rs.filter((r) => !r.ok && r.code === "insufficient_payable")).toHaveLength(1);
    expect(store.payouts.size).toBe(1);
  });
});

describe.skipIf(!PG_URL)("withdrawals consume the credit balance (Postgres)", () => {
  let db: SharedDb;
  beforeAll(async () => { db = await twoCoordinatorsOneDatabase(); });
  afterAll(async () => { await db?.close(); });
  async function withStore(fn: (store: PostgresStore, pool: pg.Pool, acct: string) => Promise<void>) {
    await fn(db.a, db.poolA, `debit-${randomUUID()}`);
  }
  const payout = (accountId: string, amountMsat: number): PayoutRecord => ({
    payoutId: randomUUID(), accountId, coordinatorId: "c", kind: "withdraw", bolt11: "lntest", paymentHash: randomBytes(32).toString("hex"),
    amountMsat, feeMsat: 0, maxFeeMsat: FEE_CAP, status: "pending", createdAtMs: Date.now()
  });
  const big = () => Number.MAX_SAFE_INTEGER;

  it("reservation writes the debit; paid settlement gives back the unused fee cap; repeats change nothing", async () => {
    await withStore(async (store, _pool, acct) => {
      await store.persistCreditTransaction(earn(acct, 10_000));
      const p = payout(acct, 2_000_000);
      expect(await store.reservePayout(p, big)).toEqual({ ok: true });
      expect(await store.creditBalance(acct)).toBeCloseTo(10_000 - 2_010, 6);
      await store.settlePayout(p.payoutId, { status: "paid", feeMsat: 1_500, preimage: "00".repeat(32) });
      await store.settlePayout(p.payoutId, { status: "paid", feeMsat: 1_500, preimage: "00".repeat(32) });
      await store.settlePayout(p.payoutId, { status: "failed", error: "late" });
      expect(await store.creditBalance(acct)).toBeCloseTo(10_000 - 2_001.5, 6);
      // A retry of the same invoice is a duplicate and debits nothing.
      expect(await store.reservePayout({ ...p, payoutId: randomUUID() }, big)).toMatchObject({ ok: false, code: "duplicate_invoice" });
      expect(await store.creditBalance(acct)).toBeCloseTo(10_000 - 2_001.5, 6);
    });
  });

  it("a failed payout gives the whole debit back", async () => {
    await withStore(async (store, _pool, acct) => {
      await store.persistCreditTransaction(earn(acct, 10_000));
      const p = payout(acct, 2_000_000);
      expect((await store.reservePayout(p, big)).ok).toBe(true);
      await store.settlePayout(p.payoutId, { status: "failed", error: "no_route" });
      expect(await store.creditBalance(acct)).toBeCloseTo(10_000, 6);
    });
  });

  it("withdrawn earnings cannot be spent, and spent earnings cannot be withdrawn", async () => {
    await withStore(async (store, _pool, acct) => {
      await store.persistCreditTransaction(earn(acct, 10_000));
      expect((await store.reservePayout(payout(acct, 9_990_000), big)).ok).toBe(true);
      expect((await store.debitCredits(spend(acct, 1))).status).toBe("insufficient");

      const acct2 = acct; // same account, fresh earnings, then spend before withdrawing
      await store.persistCreditTransaction(earn(acct2, 5_000));
      expect((await store.debitCredits(spend(acct2, 4_500))).status).toBe("applied");
      expect(await store.reservePayout(payout(acct2, 1_000_000), big)).toMatchObject({ ok: false, code: "insufficient_payable", payableMsat: 500_000 });
    });
  });

  it("payable leaves room for the fee cap", async () => {
    await withStore(async (store, _pool, acct) => {
      await store.persistCreditTransaction(earn(acct, 10_000));
      expect(await store.reservePayout(payout(acct, 10_000_000), big)).toMatchObject({ ok: false, code: "insufficient_payable" });
      expect((await store.reservePayout(payout(acct, 9_990_000), big)).ok).toBe(true);
    });
  });

  it("a spend and a withdrawal racing on one balance cannot both succeed", async () => {
    await withStore(async (store, _pool, acct) => {
      await store.persistCreditTransaction(earn(acct, 10_000));
      const [r, d] = await Promise.all([store.reservePayout(payout(acct, 6_000_000), big), db.b.debitCredits(spend(acct, 6_000))]);
      expect([r.ok, d.status === "applied"].filter(Boolean)).toHaveLength(1);
      expect(await store.creditBalance(acct)).toBeGreaterThanOrEqual(0);
    });
  });

  it("solvency inputs: account balances, the pool at its sats, faucet grants; payouts keep the gap unchanged", async () => {
    const isolated = await twoCoordinatorsOneDatabase();
    try {
      const s = isolated.a;
      const gap = async () => {
        const sv = await s.solvencyMsat();
        return sv.outstandingMsat - ((await s.receivedPurchaseMsat()) - (await s.payoutsOutflowMsat()) + sv.grantedMsat);
      };
      expect(await s.solvencyMsat()).toEqual({ outstandingMsat: 0, grantedMsat: 0 });
      await s.persistCreditTransaction(earn("acct-a", 9_500));
      await s.persistCreditTransaction({ txId: randomUUID(), accountId: "network:fee_pool", type: "earn", credits: 0, reason: "purchase_fee:i", timestampMs: 1, msat: 500_000 });
      await s.persistCreditTransaction({ txId: randomUUID(), accountId: "acct-b", type: "earn", credits: 100, reason: "faucet", timestampMs: 1 });
      expect(await s.solvencyMsat()).toEqual({ outstandingMsat: 9_500_000 + 500_000 + 100_000, grantedMsat: 100_000 });
      const before = await gap();
      const p = payout("acct-a", 2_000_000);
      expect((await s.reservePayout(p, big)).ok).toBe(true);
      expect(await gap()).toBe(before);
      await s.settlePayout(p.payoutId, { status: "paid", feeMsat: 1_000 });
      expect(await gap()).toBe(before);
      const q = payout("acct-a", 2_000_000);
      expect((await s.reservePayout(q, big)).ok).toBe(true);
      await s.settlePayout(q.payoutId, { status: "failed", error: "x" });
      expect(await gap()).toBe(before);
    } finally {
      await isolated.close();
    }
  });

  it("EdgeCoder withdrawing its revenue from the fee pool keeps the solvency gap unchanged", async () => {
    const isolated = await twoCoordinatorsOneDatabase();
    try {
      const s = isolated.a;
      const gap = async () => {
        const sv = await s.solvencyMsat();
        return sv.outstandingMsat - ((await s.receivedPurchaseMsat()) - (await s.payoutsOutflowMsat()) + sv.grantedMsat);
      };
      await s.persistCreditTransaction(earn("acct-a", 9_500));
      // The network fee on a compute payment: cSats and their sats value on the pool.
      await s.persistCreditTransaction({ txId: randomUUID(), accountId: "network:fee_pool", type: "earn", credits: 5_000, reason: "network_fee:t1", relatedTaskId: "t1", timestampMs: Date.now(), msat: 5_000_000 });
      const before = await gap();
      const p = payout("network:fee_pool", 2_000_000);
      expect((await s.reservePayout(p, big)).ok).toBe(true);
      expect(await gap()).toBe(before);
      await s.settlePayout(p.payoutId, { status: "paid", feeMsat: 1_000 });
      expect(await gap()).toBe(before);
      const q = payout("network:fee_pool", 1_000_000);
      expect((await s.reservePayout(q, big)).ok).toBe(true);
      await s.settlePayout(q.payoutId, { status: "failed", error: "x" });
      expect(await gap()).toBe(before);
    } finally {
      await isolated.close();
    }
  });

  it("fee income by UTC day (earnIncome) counts only the pool's network_fee earn rows", async () => {
    const isolated = await twoCoordinatorsOneDatabase();
    try {
      const s = isolated.a;
      const DAY = 86_400_000;
      const today = Math.floor(Date.now() / DAY);
      const row = (accountId: string, reason: string, msat: number, atMs: number, type: "earn" | "spend" = "earn"): CreditTransaction => ({ txId: randomUUID(), accountId, type, credits: msat / 1000, reason, timestampMs: atMs, msat });
      await s.persistCreditTransaction(row("network:fee_pool", "network_fee:a", 1_000, today * DAY + 10));
      await s.persistCreditTransaction(row("network:fee_pool", "network_fee:b", 2_000, today * DAY + 20));
      await s.persistCreditTransaction(row("network:fee_pool", "network_fee:c", 4_000, (today - 2) * DAY + 5));
      await s.persistCreditTransaction(row("network:fee_pool", "network_fee:old", 8_000, (today - 40) * DAY));
      // Not fee income: another reason, another account, a spend, and a LIKE wildcard look-alike.
      await s.persistCreditTransaction(row("network:fee_pool", "purchase_fee:x", 16_000, today * DAY + 30));
      await s.persistCreditTransaction(row("network:fee_pool", "networkXfee:y", 32_000, today * DAY + 40));
      await s.persistCreditTransaction(row("acct-z", "network_fee:z", 64_000, today * DAY + 50));
      await s.persistCreditTransaction(row("network:fee_pool", "network_fee:spent", 128_000, today * DAY + 60, "spend"));
      const r = await s.earnIncome("network:fee_pool", "network_fee:", (today - 29) * DAY);
      expect(r.totalMsat).toBe(15_000);
      expect(r.count).toBe(4);
      expect(r.days).toEqual([{ day: today - 2, msat: 4_000, count: 1 }, { day: today, msat: 3_000, count: 2 }]);
    } finally {
      await isolated.close();
    }
  });

  it("a payout reserved before debits existed gets no refund at settlement", async () => {
    await withStore(async (store, pool, acct) => {
      await store.persistCreditTransaction(earn(acct, 10_000));
      const p = payout(acct, 2_000_000);
      await pool.query(
        `INSERT INTO payouts (payout_id, account_id, coordinator_id, kind, bolt11, payment_hash, amount_msat, fee_msat, max_fee_msat, status, created_at_ms)
         VALUES ($1,$2,'c','withdraw','lntest',$3,$4,0,$5,'pending',$6)`,
        [p.payoutId, acct, p.paymentHash, p.amountMsat, p.maxFeeMsat, p.createdAtMs]
      );
      await store.settlePayout(p.payoutId, { status: "failed", error: "x" });
      expect(await store.creditBalance(acct)).toBeCloseTo(10_000, 6);
    });
  });
});
