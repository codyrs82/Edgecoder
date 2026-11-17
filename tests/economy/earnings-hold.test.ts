// Earnings hold (PAYOUT_EARNINGS_HOLD_MS, #56 "rewards held as pending until verified"): an earn row
// counts toward payable only once it is older than the hold, in the balance and inside the
// reservation, on both stores.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL, twoCoordinatorsOneDatabase, type SharedDb } from "../helpers/shared-pg.js";
import { MemoryPayoutStore, PayoutService, type PayoutStore } from "../../src/economy/payout-service.js";
import {
  DEFAULT_PAYOUT_POLICY,
  MAINNET_DEFAULT_EARNINGS_HOLD_MS,
  earnRowMatured,
  earningsHoldFromEnv,
  earningsMaturityCutoffMs,
  payoutPolicyFromEnv
} from "../../src/economy/payouts.js";
import { CreditEngine } from "../../src/credits/engine.js";
import type { LightningProvider } from "../../src/economy/lightning.js";
import type { CreditTransaction, PayoutRecord } from "../../src/common/types.js";
import { encodeTestBolt11 } from "./helpers/bolt11-encode.js";

const HOUR = 3_600_000;
const HOLD = 24 * HOUR;
// "Now" for the scenarios; real time because invoices carry their creation time (expiry check).
const T0 = Date.now();

function invoice(amountMsat: number) {
  const preimage = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  return { bolt11: encodeTestBolt11({ network: "tbs", amountMsat, paymentHashHex: hash }), hash, preimage };
}
const provider: LightningProvider = {
  createInvoice: async () => { throw new Error("n/a"); },
  checkSettlement: async () => ({ settled: false }),
  payInvoice: async () => ({ status: "succeeded", feeMsat: 0 })
};
const earn = (accountId: string, sats: number, timestampMs: number): CreditTransaction => ({
  txId: randomUUID(), accountId, type: "earn", credits: sats, reason: "compute_contribution", timestampMs, msat: sats * 1000
});

describe("earningsHoldFromEnv", () => {
  it("defaults to 24 h on mainnet and 0 elsewhere", () => {
    expect(earningsHoldFromEnv("bitcoin", {})).toEqual({ holdMs: MAINNET_DEFAULT_EARNINGS_HOLD_MS, source: "default", warning: null });
    for (const n of ["regtest", "signet", "testnet"] as const) expect(earningsHoldFromEnv(n, {})).toEqual({ holdMs: 0, source: "default", warning: null });
    expect(MAINNET_DEFAULT_EARNINGS_HOLD_MS).toBe(HOLD);
  });
  it("honours an explicit value, flagging a shorter one on mainnet", () => {
    expect(earningsHoldFromEnv("bitcoin", { PAYOUT_EARNINGS_HOLD_MS: "0" })).toEqual({ holdMs: 0, source: "env", warning: "mainnet_earnings_hold_disabled" });
    expect(earningsHoldFromEnv("bitcoin", { PAYOUT_EARNINGS_HOLD_MS: "3600000" })).toMatchObject({ holdMs: HOUR, warning: "mainnet_earnings_hold_below_default" });
    expect(earningsHoldFromEnv("bitcoin", { PAYOUT_EARNINGS_HOLD_MS: String(2 * HOLD) })).toMatchObject({ holdMs: 2 * HOLD, warning: null });
    expect(earningsHoldFromEnv("regtest", { PAYOUT_EARNINGS_HOLD_MS: "60000" })).toEqual({ holdMs: 60_000, source: "env", warning: null });
    expect(() => earningsHoldFromEnv("regtest", { PAYOUT_EARNINGS_HOLD_MS: "-1" })).toThrow(/whole number/);
    expect(() => earningsHoldFromEnv("regtest", { PAYOUT_EARNINGS_HOLD_MS: "1.5" })).toThrow(/whole number/);
  });
  it("payoutPolicyFromEnv carries the hold", () => {
    expect(payoutPolicyFromEnv("bitcoin", {}).earningsHoldMs).toBe(HOLD);
    expect(payoutPolicyFromEnv("regtest", {}).earningsHoldMs).toBe(0);
  });
  it("no hold means no cutoff (every row matured, no clock comparison)", () => {
    expect(earningsMaturityCutoffMs(T0, 0)).toBeUndefined();
    expect(earningsMaturityCutoffMs(T0, undefined)).toBeUndefined();
    expect(earningsMaturityCutoffMs(T0, HOLD)).toBe(T0 - HOLD);
    expect(earnRowMatured(T0 + 5, undefined)).toBe(true);
    expect(earnRowMatured(T0 - HOLD, T0 - HOLD)).toBe(true);
    expect(earnRowMatured(T0 - HOLD + 1, T0 - HOLD)).toBe(false);
  });
});

describe("CreditEngine.earnedMsat with a cutoff", () => {
  it("counts only matured earnings", () => {
    const engine = new CreditEngine();
    const tx = engine.accrue(
      { reportId: "r1", agentId: "a", taskId: "t", resourceClass: "cpu", cpuSeconds: 100, gpuSeconds: 0, success: true, qualityScore: 1, timestampMs: Date.now() } as never,
      { queuedTasks: 0, activeAgents: 1 } as never,
      { msatPerCredit: 1000 }
    );
    expect(engine.earnedMsat("a")).toBeGreaterThan(0);
    expect(engine.earnedMsat("a", tx.timestampMs)).toBe(engine.earnedMsat("a"));
    expect(engine.earnedMsat("a", tx.timestampMs - 1)).toBe(0);
  });
});

function scenario(store: PayoutStore, clock: { now: number }, holdMs = HOLD) {
  const policy = { ...DEFAULT_PAYOUT_POLICY, network: "signet" as const, maxFeeBps: 0, earningsHoldMs: holdMs };
  return new PayoutService({ store, provider, policy, coordinatorId: "c", feePoolAccountId: "pool", now: () => clock.now });
}

async function holdScenario(store: PayoutStore, record: (rows: CreditTransaction[]) => Promise<void>, acct: string) {
  const clock = { now: T0 };
  const svc = scenario(store, clock);
  // 30k sats earned 25 h ago (matured), 20k sats earned 1 h ago (held).
  await record([earn(acct, 30_000, T0 - 25 * HOUR), earn(acct, 20_000, T0 - HOUR)]);
  const bal = await svc.balance(acct);
  expect(bal).toMatchObject({ earnedMsat: 50_000_000, heldMsat: 20_000_000, maturesAtMs: T0 - HOUR + HOLD, payableMsat: 30_000_000 });

  // More than the matured part is refused even though total earnings would cover it.
  const tooMuch = await svc.withdraw(acct, invoice(40_000_000).bolt11);
  expect(tooMuch).toMatchObject({ ok: false, code: "insufficient_payable", payableMsat: 30_000_000 });
  const ok = await svc.withdraw(acct, invoice(25_000_000).bolt11);
  expect(ok.ok).toBe(true);

  // Once the held row matures it becomes payable.
  clock.now = T0 + HOLD;
  const later = await svc.balance(acct);
  expect(later).toMatchObject({ earnedMsat: 50_000_000, heldMsat: 0, maturesAtMs: null });
  expect(later.payableMsat).toBe(50_000_000 - 25_000_000); // minus the paid payout (routing fee 0)
}

/**
 * Matured earnings spent as cSats leave "earned − paid" high but the balance low; a fresh earning
 * then raises the balance. It is still under the hold, so it must not become withdrawable through
 * the balance cap: withdrawable = min(matured earned − paid, balance − held), in the balance (what
 * auto payouts use too) and in the reservation.
 */
async function spentThenFreshScenario(store: PayoutStore, record: (rows: CreditTransaction[]) => Promise<void>, acct: string) {
  const clock = { now: T0 };
  const svc = scenario(store, clock);
  await record([
    earn(acct, 30_000, T0 - 25 * HOUR),
    { txId: randomUUID(), accountId: acct, type: "spend", credits: 29_000, reason: "task_reserve", timestampMs: T0 - 24 * HOUR },
    earn(acct, 20_000, T0 - HOUR)
  ]);
  const bal = await svc.balance(acct);
  // Before: min(30k − 0, balance 21k) = 21k, of which 20k was the held earning.
  expect(bal).toMatchObject({ earnedMsat: 50_000_000, heldMsat: 20_000_000, payableMsat: 1_000_000 });
  expect(await svc.withdraw(acct, invoice(5_000_000).bolt11)).toMatchObject({ ok: false, code: "insufficient_payable" });
  const p: PayoutRecord = { payoutId: randomUUID(), accountId: acct, coordinatorId: "c", kind: "withdraw", bolt11: "lntest", paymentHash: randomBytes(32).toString("hex"), amountMsat: 5_000_000, feeMsat: 0, maxFeeMsat: 0, status: "pending", createdAtMs: T0 };
  expect(await store.reservePayout(p, () => 1e15, undefined, T0 - HOLD)).toMatchObject({ ok: false, code: "insufficient_payable", payableMsat: 1_000_000 });
  // Once it matures, it is withdrawable like any earning.
  clock.now = T0 + HOLD;
  expect((await svc.balance(acct)).payableMsat).toBe(21_000_000);
}

describe("earnings hold (memory store)", () => {
  it("a held earning does not free balance-cap headroom left by spent matured earnings", async () => {
    const store = new MemoryPayoutStore(() => 0);
    store.received = 1e12;
    await spentThenFreshScenario(store, async (rows) => store.recordCreditTransactions(rows), "acct-spent");
  });

  it("engine-held earnings count as held through the store's callback", async () => {
    const engine = new CreditEngine();
    const tx = engine.accrue(
      { reportId: "r-held", agentId: "eng", taskId: "t", resourceClass: "cpu", cpuSeconds: 100, gpuSeconds: 0, success: true, qualityScore: 1, timestampMs: Date.now() } as never,
      { queuedTasks: 0, activeAgents: 1 } as never,
      { msatPerCredit: 1000 }
    );
    expect(engine.heldEarnCredits("eng", tx.timestampMs - 1)).toBe(tx.credits);
    expect(engine.heldEarnCredits("eng", tx.timestampMs)).toBe(0);
    expect(engine.heldEarnCredits("eng", undefined)).toBe(0);
  });

  it("holds recent earnings out of payable until they mature", async () => {
    const store = new MemoryPayoutStore(() => 0);
    store.received = 1e12;
    await holdScenario(store, async (rows) => store.recordCreditTransactions(rows), "acct-mem");
  });

  it("the reservation rechecks maturity under its own lock", async () => {
    const store = new MemoryPayoutStore(() => 0);
    store.received = 1e12;
    await store.recordCreditTransactions([earn("x", 10_000, T0 - HOUR)]);
    const p: PayoutRecord = { payoutId: randomUUID(), accountId: "x", coordinatorId: "c", kind: "withdraw", bolt11: "lntest", paymentHash: randomBytes(32).toString("hex"), amountMsat: 5_000_000, feeMsat: 0, maxFeeMsat: 10_000, status: "pending", createdAtMs: T0 };
    expect(await store.reservePayout(p, () => 1e15, undefined, T0 - HOLD)).toMatchObject({ ok: false, code: "insufficient_payable", payableMsat: 0 });
    expect(await store.reservePayout(p, () => 1e15, undefined, undefined)).toEqual({ ok: true });
  });

  it("a hold of 0 behaves as before", async () => {
    const store = new MemoryPayoutStore(() => 0);
    store.received = 1e12;
    const svc = scenario(store, { now: T0 }, 0);
    await store.recordCreditTransactions([earn("z", 10_000, T0 + 1_000)]); // even a row stamped slightly ahead
    expect(await svc.balance("z")).toMatchObject({ earnedMsat: 10_000_000, heldMsat: 0, maturesAtMs: null, payableMsat: 10_000_000 });
  });

  it("the external earned callback receives the cutoff", async () => {
    const seen: Array<number | undefined> = [];
    const store = new MemoryPayoutStore((_a, cutoff) => { seen.push(cutoff); return cutoff === undefined ? 7_000 : 0; });
    const svc = scenario(store, { now: T0 });
    expect(await svc.balance("e")).toMatchObject({ earnedMsat: 7_000, heldMsat: 7_000 });
    expect(seen).toContain(T0 - HOLD);
  });
});

describe.skipIf(!PG_URL)("earnings hold (Postgres)", () => {
  let db: SharedDb;
  beforeAll(async () => { db = await twoCoordinatorsOneDatabase(); });
  afterAll(async () => { await db?.close(); });

  it("holds recent earnings out of payable until they mature", async () => {
    const acct = `hold-${randomUUID()}`;
    // Capacity: one settled purchase so the coordinator has received sats.
    await db.poolA.query(
      `INSERT INTO payment_intents (intent_id, account_id, coordinator_id, wallet_type, network, invoice_ref, amount_sats, coordinator_fee_bps, coordinator_fee_sats, net_sats, quoted_credits, status, created_at_ms)
       VALUES ($1,'buyer','c','lightning','signet','ref',1000000000,0,0,1000000000,0,'settled',$2)`,
      [randomUUID(), T0]
    );
    await holdScenario(db.a, async (rows) => db.a.recordCreditTransactions(rows), acct);
  });

  it("EdgeCoder's revenue (the fee pool, withdrawn via /admin/revenue/withdraw) is held like any earnings", async () => {
    // Capacity comes from the purchase recorded by the previous test (same database).
    await holdScenario(db.a, async (rows) => db.a.recordCreditTransactions(rows), "network:fee_pool");
  });

  it("a held earning does not free balance-cap headroom left by spent matured earnings", async () => {
    await spentThenFreshScenario(db.a, async (rows) => db.a.recordCreditTransactions(rows), `spent-${randomUUID()}`);
  });

  it("earnedMsat and earnings use the same maturity rule; reservation rechecks it in the transaction", async () => {
    const acct = `hold-${randomUUID()}`;
    await db.a.recordCreditTransactions([earn(acct, 10_000, T0 - HOLD), earn(acct, 5_000, T0 - HOLD + 1)]);
    expect(await db.a.earnedMsat(acct)).toBe(15_000_000);
    expect(await db.a.earnedMsat(acct, T0 - HOLD)).toBe(10_000_000);
    expect(await db.b.earnings(acct, T0 - HOLD)).toEqual({ totalMsat: 15_000_000, maturedMsat: 10_000_000, oldestHeldAtMs: T0 - HOLD + 1, heldCredits: 5_000 });
    expect(await db.b.earnings(acct, undefined)).toEqual({ totalMsat: 15_000_000, maturedMsat: 15_000_000, oldestHeldAtMs: null, heldCredits: 0 });
    const p: PayoutRecord = { payoutId: randomUUID(), accountId: acct, coordinatorId: "c", kind: "withdraw", bolt11: "lntest", paymentHash: randomBytes(32).toString("hex"), amountMsat: 12_000_000, feeMsat: 0, maxFeeMsat: 10_000, status: "pending", createdAtMs: T0 };
    expect(await db.b.reservePayout(p, () => 1e15, undefined, T0 - HOLD)).toMatchObject({ ok: false, code: "insufficient_payable", payableMsat: 10_000_000 });
    expect(await db.b.reservePayout(p, () => 1e15, undefined, T0 - HOLD + 1)).toEqual({ ok: true });
  });
});
