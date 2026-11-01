import { describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { PostgresStore, SCHEMA_SQL } from "../../src/db/postgres.js";
import { CreditEngine } from "../../src/credits/engine.js";
import type { CreditTransaction } from "../../src/common/types.js";

// #48: concurrent debits must never overspend, and the balance never goes negative.

type Row = { account_id: string; tx_type: string; credits: number };

/**
 * Minimal fake pg.Pool. It models what debitCredits relies on: transactions only
 * become visible at COMMIT, pg_advisory_xact_lock blocks until the holder's
 * transaction ends, and every query yields to the event loop so concurrent
 * callers interleave like real connections do.
 */
function fakePool() {
  const committed: Row[] = [];
  const locks = new Map<string, Promise<void>>();
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const pool = {
    committed,
    async connect() {
      let pending: Row[] = [];
      let release: (() => void) | null = null;
      let lockKey: string | null = null;
      const end = () => {
        if (lockKey) locks.delete(lockKey);
        release?.();
        release = null;
        lockKey = null;
      };
      return {
        async query(sql: string, params: unknown[] = []) {
          await tick();
          if (sql === "BEGIN") { pending = []; return { rows: [], rowCount: 0 }; }
          if (sql === "COMMIT") { committed.push(...pending); pending = []; end(); return { rows: [], rowCount: 0 }; }
          if (sql === "ROLLBACK") { pending = []; end(); return { rows: [], rowCount: 0 }; }
          if (sql.includes("pg_advisory_xact_lock")) {
            const key = String(params[0]);
            while (locks.has(key)) await locks.get(key);
            lockKey = key;
            locks.set(key, new Promise<void>((r) => { release = r; }));
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("SUM(CASE WHEN tx_type = 'spend'")) {
            const bal = committed.filter((r) => r.account_id === params[0])
              .reduce((s, r) => s + (r.tx_type === "spend" ? -r.credits : r.credits), 0);
            return { rows: [{ balance: bal }], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO credit_transactions")) {
            pending.push({ account_id: String(params[1]), tx_type: "spend", credits: Number(params[2]) });
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
        release() { end(); }
      };
    }
  };
  return pool;
}

const spendTx = (accountId: string, credits: number): CreditTransaction => ({
  txId: randomUUID(), accountId, type: "spend", credits, reason: "task_submit", timestampMs: Date.now()
});
const balanceOf = (rows: Row[], id: string) =>
  rows.filter((r) => r.account_id === id).reduce((s, r) => s + (r.tx_type === "spend" ? -r.credits : r.credits), 0);

describe("PostgresStore.debitCredits (#48)", () => {
  it("50 concurrent spends of 1 against a balance of 10: exactly 10 succeed, balance 0", async () => {
    const pool = fakePool();
    pool.committed.push({ account_id: "acct", tx_type: "earn", credits: 10 });
    const store = new PostgresStore(pool as unknown as pg.Pool);
    const results = await Promise.all(Array.from({ length: 50 }, () => store.debitCredits(spendTx("acct", 1))));
    expect(results.filter((r) => r.status === "applied")).toHaveLength(10);
    expect(results.filter((r) => r.status === "insufficient")).toHaveLength(40);
    expect(balanceOf(pool.committed, "acct")).toBe(0);
  });

  it("mixed amounts: the total spent never exceeds the balance", async () => {
    const pool = fakePool();
    pool.committed.push({ account_id: "acct", tx_type: "earn", credits: 25 });
    const store = new PostgresStore(pool as unknown as pg.Pool);
    const amounts = [7, 3, 9, 4, 8, 2, 6, 5, 1, 10];
    const results = await Promise.all(amounts.map((a) => store.debitCredits(spendTx("acct", a))));
    const spent = amounts.filter((_, i) => results[i].status === "applied").reduce((s, a) => s + a, 0);
    expect(spent).toBeLessThanOrEqual(25);
    expect(balanceOf(pool.committed, "acct")).toBeGreaterThanOrEqual(0);
  });

  it("other accounts are unaffected; invalid amounts and non-spend txs are rejected", async () => {
    const pool = fakePool();
    const store = new PostgresStore(pool as unknown as pg.Pool);
    expect((await store.debitCredits(spendTx("empty", 1))).status).toBe("insufficient");
    await expect(store.debitCredits(spendTx("acct", 0))).rejects.toThrow("invalid_credit_amount");
    await expect(store.debitCredits(spendTx("acct", Number.NaN))).rejects.toThrow("invalid_credit_amount");
    await expect(store.debitCredits({ ...spendTx("acct", 1), type: "earn" })).rejects.toThrow();
  });
});

describe("CreditEngine negative adjust (#48)", () => {
  it("can't take the balance below zero", () => {
    const e = new CreditEngine();
    e.adjust("a", 5, "seed");
    expect(() => e.adjust("a", -6, "penalty")).toThrow(/insufficient_credits/);
    e.adjust("a", -5, "penalty");
    expect(e.balance("a")).toBe(0);
    expect(() => e.spend("a", 1, "task_submit")).toThrow(/insufficient_credits/);
  });
});

// Real Postgres (CI `credits-pg` job sets TEST_DATABASE_URL). Proves the advisory
// lock + transaction actually serialise concurrent debits across pool connections.
const PG_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("debitCredits against real Postgres (#48)", () => {
  it("100 concurrent spends over a 20-connection pool never overspend", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 20 });
    try {
      await pool.query(SCHEMA_SQL);
      const store = new PostgresStore(pool);
      const acct = `acct-${randomUUID()}`;
      await store.persistCreditTransaction({ ...spendTx(acct, 30), type: "earn", reason: "seed" });
      const results = await Promise.all(Array.from({ length: 100 }, () => store.debitCredits(spendTx(acct, 1))));
      expect(results.filter((r) => r.status === "applied")).toHaveLength(30);
      expect(await store.creditBalance(acct)).toBe(0);
    } finally {
      await pool.end();
    }
  }, 60_000);
});

describe("grantCredits (#48 review: payment settler)", () => {
  it("is a no-op for a zero-credit settlement and refuses to debit", async () => {
    const { grantCredits, creditEngine } = await import("../../src/credits/store.js");
    const acct = `grant-${randomUUID()}`;
    await expect(grantCredits(acct, 0, "credit_purchase:zero")).resolves.toBeNull();
    expect(creditEngine.balance(acct)).toBe(0);
    await expect(grantCredits(acct, -5, "credit_purchase:neg")).rejects.toThrow("invalid_credit_amount");
    await expect(grantCredits(acct, Number.NaN, "credit_purchase:nan")).rejects.toThrow("invalid_credit_amount");
    await grantCredits(acct, 3, "credit_purchase:ok");
    expect(creditEngine.balance(acct)).toBe(3);
  });
});
