import { describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { CREDIT_LOCK_NAMESPACE, PostgresStore, SCHEMA_LOCK_KEY, SCHEMA_LOCK_NAMESPACE, SCHEMA_SQL } from "../../src/db/postgres.js";
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
            // #108: two-key form, credit namespace first.
            if (!sql.includes("pg_advisory_xact_lock($1, hashtext($2))") || params[0] !== CREDIT_LOCK_NAMESPACE) {
              throw new Error(`unexpected lock: ${sql} ${JSON.stringify(params)}`);
            }
            const key = String(params[1]);
            while (locks.has(key)) await locks.get(key);
            lockKey = key;
            locks.set(key, new Promise<void>((r) => { release = r; }));
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("SUM(CASE WHEN tx_type = 'spend'")) {
            const bal = committed.filter((r) => r.account_id === params[0])
              .reduce((s, r) => s + (r.tx_type === "spend" ? -r.credits : r.credits), 0);
            // Real Postgres compares NUMERICs exactly; model that with micro-credits.
            const enough = Math.round(bal * 1e6) >= Math.round(Number(params[1]) * 1e6);
            return { rows: [{ balance: bal, enough }], rowCount: 1 };
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

describe("exact credit arithmetic (#108)", () => {
  it("in memory: 0.1 + 0.2 earned covers a 0.3 spend, leaving exactly 0", () => {
    const e = new CreditEngine();
    e.adjust("f", 0.1, "seed");
    e.adjust("f", 0.2, "seed");
    e.spend("f", 0.3, "task_submit");
    expect(e.balance("f")).toBe(0);
    expect(() => e.spend("f", 0.001, "task_submit")).toThrow(/insufficient_credits/);
  });

  it("Postgres path: the sufficiency check is done in SQL on NUMERIC, not in JS", async () => {
    const pool = fakePool();
    pool.committed.push({ account_id: "f", tx_type: "earn", credits: 0.1 }, { account_id: "f", tx_type: "earn", credits: 0.2 });
    const store = new PostgresStore(pool as unknown as pg.Pool);
    expect((await store.debitCredits(spendTx("f", 0.3))).status).toBe("applied");
    expect((await store.debitCredits(spendTx("f", 0.001))).status).toBe("insufficient");
  });

  it("schema declares credit_transactions.credits NUMERIC and migrates DOUBLE PRECISION", () => {
    expect(SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS credit_transactions \([\s\S]*?credits NUMERIC\(30, 6\) NOT NULL/);
    expect(SCHEMA_SQL).toContain("ALTER COLUMN credits TYPE NUMERIC(30, 6) USING round(credits::numeric, 6)");
    // #153
    expect(SCHEMA_SQL).toMatch(/quoted_credits NUMERIC\(30, 6\) NOT NULL/);
    expect(SCHEMA_SQL).toContain("ALTER COLUMN quoted_credits TYPE NUMERIC(30, 6) USING round(quoted_credits::numeric, 6)");
  });

  it("schema migration starts with the schema advisory lock (#108 review)", () => {
    expect(SCHEMA_SQL.trimStart().split("\n")[0]).toBe(`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK_NAMESPACE}, ${SCHEMA_LOCK_KEY});`);
    expect(SCHEMA_LOCK_NAMESPACE).not.toBe(CREDIT_LOCK_NAMESPACE);
    // One implicit transaction only works without explicit transaction control in the script.
    expect(SCHEMA_SQL).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/m);
  });

  it("amounts are rounded to 6 decimals on write; sub-micro amounts are rejected (#108 review)", async () => {
    const { roundCredits, adjustCredits, spendCredits, creditEngine } = await import("../../src/credits/store.js");
    expect(roundCredits(0.1234567)).toBe(0.123457);
    expect(roundCredits(0.1 + 0.2)).toBe(0.3);
    const acct = `round-${randomUUID()}`;
    const tx = await adjustCredits(acct, 1.0000004, "seed");
    expect(tx?.credits).toBe(1);
    await expect(adjustCredits(acct, 0.0000004, "dust")).rejects.toThrow("invalid_credit_amount");
    await expect(spendCredits(acct, 0.0000004, "dust")).rejects.toThrow("invalid_credit_amount");
    expect(creditEngine.balance(acct)).toBe(1);
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

describe.skipIf(!PG_URL)("NUMERIC credits against real Postgres (#108)", () => {
  it("exact fractional balance can be spent in full; concurrent BLE + debit share one lock", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 10 });
    try {
      await pool.query(SCHEMA_SQL);
      const store = new PostgresStore(pool);
      const acct = `frac-${randomUUID()}`;
      await store.persistCreditTransaction({ ...spendTx(acct, 0.1), type: "earn", reason: "seed" });
      await store.persistCreditTransaction({ ...spendTx(acct, 0.2), type: "earn", reason: "seed" });
      expect((await store.debitCredits(spendTx(acct, 0.3))).status).toBe("applied");
      expect(await store.creditBalance(acct)).toBe(0);

      const shared = `shared-${randomUUID()}`;
      await store.persistCreditTransaction({ ...spendTx(shared, 5), type: "earn", reason: "seed" });
      const ops = Array.from({ length: 20 }, (_, i) =>
        i % 2
          ? store.debitCredits(spendTx(shared, 0.5)).then((r) => r.status)
          : store.applyBleTransfer({ txId: randomUUID(), requesterAccountId: shared, providerAccountId: `p-${randomUUID()}`, credits: 0.5 }),
      );
      const applied = (await Promise.all(ops)).filter((s) => s === "applied").length;
      expect(applied).toBe(10);
      expect(await store.creditBalance(shared)).toBe(0);
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("migrates an existing DOUBLE PRECISION column and cleans float artefacts", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 1 });
    const schema = `mig_${randomUUID().replace(/-/g, "")}`;
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(`SET search_path TO ${schema}`);
      await pool.query(`CREATE TABLE credit_transactions (
        tx_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, tx_type TEXT NOT NULL,
        credits DOUBLE PRECISION NOT NULL, reason TEXT NOT NULL, related_task_id TEXT, timestamp_ms BIGINT NOT NULL)`);
      await pool.query(`INSERT INTO credit_transactions VALUES ('a','m','earn',0.1 + 0.2,'seed',NULL,1)`);
      // #153: a legacy payment_intents with a float quoted_credits.
      await pool.query(`CREATE TABLE payment_intents (
        intent_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, coordinator_id TEXT NOT NULL, wallet_type TEXT NOT NULL,
        network TEXT NOT NULL, invoice_ref TEXT NOT NULL, amount_sats BIGINT NOT NULL, coordinator_fee_bps INT NOT NULL,
        coordinator_fee_sats BIGINT NOT NULL, net_sats BIGINT NOT NULL, quoted_credits DOUBLE PRECISION NOT NULL,
        status TEXT NOT NULL, created_at_ms BIGINT NOT NULL, settled_at_ms BIGINT, tx_ref TEXT)`);
      await pool.query(`INSERT INTO payment_intents VALUES ('i','m','c','lightning','regtest','inv',100,0,0,100,0.1 + 0.2,'pending',1,NULL,NULL)`);
      await pool.query(SCHEMA_SQL);
      const q = await pool.query(`SELECT quoted_credits::text AS q FROM payment_intents WHERE intent_id = 'i'`);
      expect(q.rows[0].q).toBe("0.300000");
      const qt = await pool.query(
        `SELECT numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'payment_intents' AND column_name = 'quoted_credits'`,
        [schema],
      );
      expect(qt.rows[0]).toEqual({ numeric_precision: 30, numeric_scale: 6 });
      const type = await pool.query(
        `SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'credit_transactions' AND column_name = 'credits'`,
        [schema],
      );
      expect(type.rows[0].data_type).toBe("numeric");
      const row = await pool.query(`SELECT credits::text AS c FROM credit_transactions WHERE tx_id = 'a'`);
      const t = await pool.query(
        `SELECT numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'credit_transactions' AND column_name = 'credits'`,
        [schema],
      );
      expect(t.rows[0]).toEqual({ numeric_precision: 30, numeric_scale: 6 });
      expect(row.rows[0].c).toBe("0.300000");
      await pool.query(SCHEMA_SQL); // idempotent
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await pool.end();
    }
  }, 60_000);

  it("rounds to 6 decimals on write", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    try {
      await pool.query(SCHEMA_SQL);
      const store = new PostgresStore(pool);
      const acct = `r6-${randomUUID()}`;
      await store.persistCreditTransaction({ ...spendTx(acct, 0.1234567), type: "earn", reason: "seed" });
      const row = await pool.query(`SELECT credits::text AS c FROM credit_transactions WHERE account_id = $1`, [acct]);
      expect(row.rows[0].c).toBe("0.123457");
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("is safe when several instances migrate at once", async () => {
    const schema = `race_${randomUUID().replace(/-/g, "")}`;
    const opts = { connectionString: PG_URL, max: 1, options: `-c search_path=${schema}` };
    const admin = new pg.Pool(opts);
    const pools = Array.from({ length: 4 }, () => new pg.Pool(opts));
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`CREATE TABLE credit_transactions (
        tx_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, tx_type TEXT NOT NULL,
        credits DOUBLE PRECISION NOT NULL, reason TEXT NOT NULL, related_task_id TEXT, timestamp_ms BIGINT NOT NULL)`);
      await admin.query(`INSERT INTO credit_transactions VALUES ('a','m','earn',0.1 + 0.2,'seed',NULL,1)`);
      // Without the schema lock, concurrent CREATE TABLE IF NOT EXISTS / ALTER can error out.
      const results = await Promise.allSettled(pools.map((p) => p.query(SCHEMA_SQL)));
      expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
      const row = await admin.query(`SELECT credits::text AS c FROM credit_transactions WHERE tx_id = 'a'`);
      expect(row.rows[0].c).toBe("0.300000");
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await admin.end();
    }
  }, 120_000);
});
