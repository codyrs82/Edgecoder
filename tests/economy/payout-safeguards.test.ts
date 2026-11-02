import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { MemoryPayoutStore, PayoutService, type FeePoolLockResult, type PayoutStore } from "../../src/economy/payout-service.js";
import { DEFAULT_PAYOUT_POLICY } from "../../src/economy/payouts.js";
import {
  MAINNET_DEFAULT_PAYOUT_LIMITS,
  MemoryPayoutPauseStore,
  PayoutPauseControl,
  checkPayoutLimits,
  payoutLimitsFromEnv,
  payoutsPausedByEnv,
  type PayoutLimits
} from "../../src/economy/payout-safeguards.js";
import type { LightningProvider, PayInvoiceInput, PayInvoiceResult } from "../../src/economy/lightning.js";
import { PostgresStore, SCHEMA_SQL } from "../../src/db/postgres.js";
import type { PayoutRecord } from "../../src/common/types.js";
import { encodeTestBolt11 } from "./helpers/bolt11-encode.js";

const policy = { ...DEFAULT_PAYOUT_POLICY, network: "signet" as const };
function invoice(amountMsat: number, preimage = randomBytes(32).toString("hex")) {
  const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  return { bolt11: encodeTestBolt11({ network: "tbs", amountMsat, paymentHashHex: hash }), hash, preimage };
}
function provider(behaviour: (input: PayInvoiceInput) => PayInvoiceResult, calls: PayInvoiceInput[] = []): LightningProvider {
  return {
    createInvoice: async () => { throw new Error("n/a"); },
    checkSettlement: async () => ({ settled: false }),
    payInvoice: async (i) => { calls.push(i); return behaviour(i); }
  };
}
// Flat 10-sat fee cap (no bps part) keeps the cap arithmetic in these tests readable.
const capPolicy = { ...policy, maxFeeBps: 0 };
const ok = () => ({ status: "succeeded" as const, feeMsat: 0 });

function setup(opts: { limits?: PayoutLimits; earned?: number; pause?: PayoutPauseControl; calls?: PayInvoiceInput[] } = {}) {
  const store = new MemoryPayoutStore(() => opts.earned ?? 1_000_000_000);
  store.received = 10_000_000_000;
  const events: Array<{ event: string; details: Record<string, unknown> }> = [];
  const svc = new PayoutService({
    store,
    provider: provider(ok, opts.calls),
    policy: capPolicy,
    coordinatorId: "coord",
    feePoolAccountId: "pool",
    limits: opts.limits,
    pause: opts.pause,
    onSecurityEvent: (event, details) => events.push({ event, details })
  });
  return { store, svc, events };
}

describe("payout limits config", () => {
  it("defaults to conservative caps on mainnet and none elsewhere; explicit values (0 = no cap) win", () => {
    expect(payoutLimitsFromEnv("bitcoin", {})).toEqual(MAINNET_DEFAULT_PAYOUT_LIMITS);
    expect(payoutLimitsFromEnv("signet", {})).toEqual({ maxSingleSats: 0, maxAccountDailySats: 0, maxGlobalDailySats: 0 });
    expect(payoutLimitsFromEnv("bitcoin", { PAYOUT_MAX_SINGLE_SATS: "0", PAYOUT_MAX_GLOBAL_DAILY_SATS: "5000000" })).toEqual({ ...MAINNET_DEFAULT_PAYOUT_LIMITS, maxSingleSats: 0, maxGlobalDailySats: 5_000_000 });
    expect(() => payoutLimitsFromEnv("signet", { PAYOUT_MAX_SINGLE_SATS: "-1" })).toThrow(/whole number/);
    expect(() => payoutLimitsFromEnv("signet", { PAYOUT_MAX_ACCOUNT_DAILY_SATS: "1.5" })).toThrow(/whole number/);
  });

  it("checkPayoutLimits counts the fee cap and the 24 h totals", () => {
    const l = { maxSingleSats: 10, maxAccountDailySats: 20, maxGlobalDailySats: 30 };
    expect(checkPayoutLimits({ amountMsat: 9_000, maxFeeMsat: 1_000 }, l)).toBeNull();
    expect(checkPayoutLimits({ amountMsat: 9_000, maxFeeMsat: 1_001 }, l)?.code).toBe("payout_limit_single");
    expect(checkPayoutLimits({ amountMsat: 5_000, maxFeeMsat: 0, accountWindowMsat: 16_000 }, l)?.code).toBe("payout_limit_account_daily");
    expect(checkPayoutLimits({ amountMsat: 5_000, maxFeeMsat: 0, accountWindowMsat: 0, globalWindowMsat: 26_000 }, l)?.code).toBe("payout_limit_global_daily");
    expect(checkPayoutLimits({ amountMsat: 1e12, maxFeeMsat: 0, accountWindowMsat: 1e12, globalWindowMsat: 1e12 }, { maxSingleSats: 0, maxAccountDailySats: 0, maxGlobalDailySats: 0 })).toBeNull();
  });
});

describe("hot-wallet caps in PayoutService", () => {
  it("rejects a payout over the single cap (fee cap included), logs a security event and pays nothing", async () => {
    const calls: PayInvoiceInput[] = [];
    const { svc, store, events } = setup({ limits: { maxSingleSats: 5_000, maxAccountDailySats: 0, maxGlobalDailySats: 0 }, calls });
    // 4,995 sats + 10 sat fee floor > 5,000
    expect(await svc.withdraw("acct", invoice(4_995_000).bolt11)).toMatchObject({ ok: false, code: "payout_limit_single" });
    expect(calls).toHaveLength(0);
    expect(store.payouts.size).toBe(0);
    expect(events).toEqual([expect.objectContaining({ event: "payout_limit_exceeded", details: expect.objectContaining({ accountId: "acct", code: "payout_limit_single", limitSats: 5_000 }) })]);
    expect(await svc.withdraw("acct", invoice(4_990_000).bolt11)).toMatchObject({ ok: true });
  });

  it("enforces the per-account rolling 24 h total; older payouts roll off", async () => {
    const { svc, store } = setup({ limits: { maxSingleSats: 0, maxAccountDailySats: 10_000, maxGlobalDailySats: 0 } });
    expect(await svc.withdraw("a", invoice(6_000_000).bolt11)).toMatchObject({ ok: true });
    expect(await svc.withdraw("a", invoice(4_000_000).bolt11)).toMatchObject({ ok: false, code: "payout_limit_account_daily" });
    expect(await svc.withdraw("b", invoice(4_000_000).bolt11)).toMatchObject({ ok: true }); // other account unaffected
    for (const p of store.payouts.values()) if (p.accountId === "a") p.createdAtMs -= 25 * 60 * 60 * 1000;
    expect(await svc.withdraw("a", invoice(4_000_000).bolt11)).toMatchObject({ ok: true });
  });

  it("counts pending payouts at their fee cap and enforces the global total across accounts", async () => {
    const { svc, store } = setup({ limits: { maxSingleSats: 0, maxAccountDailySats: 0, maxGlobalDailySats: 10_000 } });
    store.payouts.set("p", { payoutId: "p", accountId: "x", coordinatorId: "c", kind: "withdraw", bolt11: "lnx", paymentHash: "h".repeat(64), amountMsat: 5_000_000, feeMsat: 0, maxFeeMsat: 1_000_000, status: "pending", createdAtMs: Date.now() });
    // 5,000 + 1,000 (pending fee cap) + 3,990 + 10 (fee floor) = 10,000 sats: allowed; one msat more is not.
    expect(await svc.withdraw("y", invoice(3_990_000).bolt11)).toMatchObject({ ok: true });
    expect(await svc.withdraw("z", invoice(1_000_000).bolt11)).toMatchObject({ ok: false, code: "payout_limit_global_daily" });
  });

  it("concurrent withdrawals cannot overshoot the global cap", async () => {
    const { svc, store } = setup({ limits: { maxSingleSats: 0, maxAccountDailySats: 0, maxGlobalDailySats: 20_000 } });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => svc.withdraw(`acct-${i}`, invoice(4_990_000).bolt11)));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(await store.payoutsOutflowMsat()).toBeLessThanOrEqual(20_000_000);
  });
});

describe("payout kill switch", () => {
  it("PAYOUTS_PAUSED parsing", () => {
    expect(payoutsPausedByEnv({ PAYOUTS_PAUSED: "1" })).toBe(true);
    expect(payoutsPausedByEnv({ PAYOUTS_PAUSED: " True " })).toBe(true);
    expect(payoutsPausedByEnv({ PAYOUTS_PAUSED: "0" })).toBe(false);
    expect(payoutsPausedByEnv({})).toBe(false);
  });

  it("halts withdrawals, auto payouts and fee-pool distribution; resume restores them; changes are reported", async () => {
    const changes: Array<{ paused: boolean; source?: string }> = [];
    const pause = new PayoutPauseControl({ store: new MemoryPayoutPauseStore(), envPaused: false, onChange: (s) => { changes.push({ paused: s.paused, source: s.source }); } });
    const calls: PayInvoiceInput[] = [];
    const { svc, store, events } = setup({ pause, calls });
    store.autoAccounts.set("acct", "cody@example.com");
    await store.recordCreditTransactions([{ txId: "f", accountId: "pool", type: "earn", credits: 1, reason: "network_fee", timestampMs: 1, msat: 1_000_000 }]);
    store.hosts.set("h", { hostId: "h", accountId: "host:h", services: ["coordinator"], firstSeenMs: 0, lastSeenMs: 0, heartbeatsInWindow: 10 });

    await pause.pause("drill", "admin", "admin:ops");
    expect(await svc.withdraw("acct", invoice(2_000_000).bolt11)).toMatchObject({ ok: false, code: "payouts_paused" });
    expect(await svc.runAutoPayouts()).toEqual([]);
    expect(await svc.distributeFeePool(10)).toMatchObject({ distributedMsat: 0, skipped: "payouts_paused" });
    expect(calls).toHaveLength(0);
    expect(store.payouts.size).toBe(0);
    expect(events.map((e) => e.event)).toContain("payout_blocked_paused");

    expect(await pause.resume("admin:ops")).toMatchObject({ ok: true, state: { paused: false } });
    expect(await svc.withdraw("acct", invoice(2_000_000).bolt11)).toMatchObject({ ok: true });
    expect((await svc.distributeFeePool(10)).distributedMsat).toBeGreaterThan(0);
    expect(changes).toEqual([{ paused: true, source: "admin" }, { paused: false, source: "admin" }]);
  });

  it("a pause that lands after reservation stops the payment before the node is called and frees the balance", async () => {
    const store = new MemoryPayoutPauseStore();
    let reads = 0;
    // First read (before reservation) says running, the second (right before paying) says paused.
    const flaky = { getPayoutPause: async () => (reads++ === 0 ? null : { paused: true }), setPayoutPause: store.setPayoutPause.bind(store) };
    const calls: PayInvoiceInput[] = [];
    const { svc, store: ps } = setup({ pause: new PayoutPauseControl({ store: flaky, envPaused: false }), calls });
    expect(await svc.withdraw("acct", invoice(2_000_000).bolt11)).toMatchObject({ ok: false, code: "payouts_paused" });
    expect(calls).toHaveLength(0);
    expect([...ps.payouts.values()][0]).toMatchObject({ status: "failed", error: "payouts_paused" });
  });

  it("PAYOUTS_PAUSED in the environment cannot be lifted over the API", async () => {
    const pause = new PayoutPauseControl({ store: new MemoryPayoutPauseStore(), envPaused: true });
    expect(await pause.state()).toMatchObject({ paused: true, source: "env" });
    expect(await pause.resume("admin:x")).toMatchObject({ ok: false, code: "paused_by_env" });
    expect(await pause.isPaused()).toBe(true);
  });

  it("fails closed when the stored pause flag cannot be read", async () => {
    const pause = new PayoutPauseControl({ store: { getPayoutPause: async () => { throw new Error("db down"); }, setPayoutPause: async () => {} }, envPaused: false });
    expect(await pause.isPaused()).toBe(true);
  });
});

describe("coordinator wiring (source)", () => {
  const src = readFileSync("src/swarm/coordinator.ts", "utf8");
  it("pause and reconciliation routes live in the admin plugin; the payout service pays through the pause-guarded provider", () => {
    const plugin = src.slice(src.indexOf("app.register(async (admin) => {"));
    for (const r of ['admin.get("/admin/payouts/pause"', 'admin.post("/admin/payouts/pause"', 'admin.get("/admin/payouts/reconciliation"', 'admin.post("/admin/payouts/reconciliation/run"']) {
      expect(plugin).toContain(r);
    }
    const svc = src.slice(src.indexOf("const payoutService = new PayoutService({"), src.indexOf("const payoutService = new PayoutService({") + 400);
    expect(svc).toContain("provider: payoutProvider");
    expect(svc).toContain("pause: payoutPause");
    expect(svc).toContain("limits: payoutLimits");
  });
});

describe("fee-pool distribution lock", () => {
  function poolSetup(store: PayoutStore & MemoryPayoutStore) {
    store.hosts.set("h", { hostId: "h", accountId: "host:h", services: ["coordinator"], firstSeenMs: 0, lastSeenMs: 0, heartbeatsInWindow: 10 });
    return new PayoutService({ store, provider: provider(ok), policy, coordinatorId: "c", feePoolAccountId: "pool" });
  }

  it("in memory: a second concurrent run is turned away, the pool is split once", async () => {
    const store = new MemoryPayoutStore(() => 0);
    await store.recordCreditTransactions([{ txId: "f", accountId: "pool", type: "earn", credits: 1, reason: "network_fee", timestampMs: 1, msat: 1_000_000 }]);
    const svc = poolSetup(store);
    const [a, b] = await Promise.all([svc.distributeFeePool(10), svc.distributeFeePool(10)]);
    expect([a.distributedMsat, b.distributedMsat].sort()).toEqual([0, 1_000_000]);
    expect([a.skipped, b.skipped]).toContain("locked");
    expect(await store.earnedMsat("host:h")).toBe(1_000_000);
  });

  it("when another instance holds the lock nothing is written", async () => {
    class Contended extends MemoryPayoutStore {
      override async withFeePoolLock<T>(): Promise<FeePoolLockResult<T>> {
        return { acquired: false };
      }
    }
    const store = new Contended(() => 0);
    await store.recordCreditTransactions([{ txId: "f", accountId: "pool", type: "earn", credits: 1, reason: "network_fee", timestampMs: 1, msat: 1_000_000 }]);
    const svc = poolSetup(store);
    expect(await svc.distributeFeePool(10)).toEqual({ distributedMsat: 0, hosts: [], skipped: "locked" });
    expect(store.rows).toHaveLength(1);
    expect(store.hosts.get("h")?.heartbeatsInWindow).toBe(10);
  });

  it("the timer path skips a window another instance distributed recently; a manual run does not", async () => {
    const store = new MemoryPayoutStore(() => 0);
    await store.recordCreditTransactions([
      { txId: "f", accountId: "pool", type: "earn", credits: 1, reason: "network_fee", timestampMs: 1, msat: 2_000_000 },
      { txId: "s", accountId: "pool", type: "spend", credits: 0, reason: "fee_pool_distribution:1", timestampMs: Date.now() - 60_000, msat: 1_000_000 }
    ]);
    const svc = poolSetup(store);
    expect(await svc.distributeFeePool(10, { minIntervalMs: 3_600_000 })).toMatchObject({ distributedMsat: 0, skipped: "recent" });
    expect((await svc.distributeFeePool(10, { minIntervalMs: 0 })).distributedMsat).toBe(1_000_000);
  });
});

// Real Postgres (CI sets TEST_DATABASE_URL): the advisory locks hold across separate pools,
// i.e. across coordinators sharing one database.
const PG_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("payout safeguards against real Postgres", () => {
  it("fee-pool lock: a second coordinator is turned away while the first holds it", async () => {
    const a = new pg.Pool({ connectionString: PG_URL, max: 4 });
    const b = new pg.Pool({ connectionString: PG_URL, max: 4 });
    try {
      await a.query(SCHEMA_SQL);
      const sa = new PostgresStore(a);
      const sb = new PostgresStore(b);
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const first = sa.withFeePoolLock(async () => { await held; return "a"; });
      await new Promise((r) => setTimeout(r, 100));
      expect(await sb.withFeePoolLock(async () => "b")).toEqual({ acquired: false });
      release();
      expect(await first).toEqual({ acquired: true, value: "a" });
      expect(await sb.withFeePoolLock(async () => "b")).toEqual({ acquired: true, value: "b" });
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("pause flag is shared and survives a new store; reservations respect the global 24 h cap under concurrency", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 20 });
    try {
      await pool.query(SCHEMA_SQL);
      const store = new PostgresStore(pool);
      const prior = await store.getPayoutPause();
      await store.setPayoutPause({ paused: true, reason: "test", source: "admin", changedAtMs: 1 });
      expect(await new PostgresStore(pool).getPayoutPause()).toMatchObject({ paused: true, reason: "test" });
      await store.setPayoutPause(prior ?? { paused: false });

      const since = Date.now() - 1_000;
      const tag = randomUUID().slice(0, 8);
      const before = Number((await pool.query(`SELECT COALESCE(SUM(amount_msat + max_fee_msat), 0) AS m FROM payouts WHERE status IN ('paid','pending') AND created_at_ms >= $1`, [since])).rows[0].m);
      const accounts = Array.from({ length: 8 }, (_, i) => `cap-${tag}-${i}`);
      for (const acct of accounts) await store.persistCreditTransaction({ txId: randomUUID(), accountId: acct, type: "earn", credits: 1, reason: "seed", timestampMs: Date.now(), msat: 100_000_000 });
      const capMsat = before + 30_000_000;
      const results = await Promise.all(
        accounts.map((acct) => {
          const payout: PayoutRecord = { payoutId: randomUUID(), accountId: acct, coordinatorId: "c", kind: "withdraw", bolt11: "lntest", paymentHash: randomBytes(32).toString("hex"), amountMsat: 9_000_000, feeMsat: 0, maxFeeMsat: 1_000_000, status: "pending", createdAtMs: Date.now() };
          return store.reservePayout(payout, () => Number.MAX_SAFE_INTEGER, {
            sinceMs: since,
            check: (w) => (w.globalWindowMsat + 10_000_000 > capMsat ? { code: "payout_limit_global_daily", limitSats: capMsat / 1000, wouldBeMsat: w.globalWindowMsat + 10_000_000 } : null)
          });
        })
      );
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "payout_limit_global_daily")).toBe(true);
      await pool.query(`DELETE FROM payouts WHERE account_id = ANY($1)`, [accounts]);
      await pool.query(`DELETE FROM credit_transactions WHERE account_id = ANY($1)`, [accounts]);
    } finally {
      await pool.end();
    }
  });

  it("reconciliation reads: rows by payment hash, outflow, liabilities, last pool distribution", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
    try {
      await pool.query(SCHEMA_SQL);
      const store = new PostgresStore(pool);
      const acct = `rec-${randomUUID()}`;
      const poolAcct = `pool-${randomUUID()}`;
      const outflow0 = await store.payoutsOutflowMsat();
      const liab0 = await store.liabilitiesMsat();
      await store.persistCreditTransaction({ txId: randomUUID(), accountId: acct, type: "earn", credits: 1, reason: "seed", timestampMs: Date.now(), msat: 50_000_000 });
      await store.persistCreditTransaction({ txId: randomUUID(), accountId: poolAcct, type: "spend", credits: 0, reason: "fee_pool_distribution:42", timestampMs: 42, msat: 0 });
      const h = randomBytes(32).toString("hex");
      const p: PayoutRecord = { payoutId: randomUUID(), accountId: acct, coordinatorId: "c", kind: "withdraw", bolt11: "lntest", paymentHash: h, amountMsat: 10_000_000, feeMsat: 0, maxFeeMsat: 500_000, status: "pending", createdAtMs: Date.now() };
      expect((await store.reservePayout(p, () => Number.MAX_SAFE_INTEGER)).ok).toBe(true);
      expect((await store.payoutsByPaymentHash([h.toUpperCase()])).get(h)).toMatchObject({ status: "pending", amountMsat: 10_000_000 });
      expect((await store.payoutsOutflowMsat()) - outflow0).toBe(10_500_000);
      expect((await store.liabilitiesMsat()) - liab0).toBe(40_000_000);
      expect(await store.lastPoolDistributionMs(poolAcct)).toBe(42);
      await pool.query(`DELETE FROM payouts WHERE account_id = $1`, [acct]);
      await pool.query(`DELETE FROM credit_transactions WHERE account_id = ANY($1)`, [[acct, poolAcct]]);
    } finally {
      await pool.end();
    }
  });
});
