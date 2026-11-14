// Network guard: a ledger made on one Bitcoin network never serves another, and the explicit reset
// wipes exactly the money rows before recording the new network.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore, SCHEMA_SQL } from "../../src/db/postgres.js";
import { LedgerNetworkMismatchError, assertLedgerNetwork, readLedgerNetwork } from "../../src/db/ledger-network.js";
import { KEPT_TABLES, WIPED_TABLES, parseResetArgs, resetLedgerNetwork } from "../../src/db/ledger-reset.js";

const PG_URL = process.env.TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../", import.meta.url));

describe("reset table lists", () => {
  it("classify every table in SCHEMA_SQL exactly once", () => {
    const tables = [...SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    const classified = [...WIPED_TABLES, ...KEPT_TABLES, "ledger_network"];
    expect(new Set(classified).size).toBe(classified.length);
    expect(tables.filter((t) => !classified.includes(t))).toEqual([]);
    expect(classified.filter((t) => !tables.includes(t))).toEqual([]);
  });

  it("parses arguments strictly", () => {
    expect(parseResetArgs(["--confirm-wipe-ledger", "regtest", "--to", "bitcoin"])).toEqual({ confirm: "regtest", to: "bitcoin", dryRun: false });
    expect(parseResetArgs(["--to", "signet", "--confirm-wipe-ledger", "unrecorded", "--dry-run"])).toMatchObject({ to: "signet", dryRun: true });
    expect(() => parseResetArgs(["--to", "bitcoin"])).toThrow(/--confirm-wipe-ledger/);
    expect(() => parseResetArgs(["--confirm-wipe-ledger", "regtest", "--to", "mainnet"])).toThrow(/--to must be one of/);
    expect(() => parseResetArgs(["--confirm-wipe-ledger", "regtest", "--to", "bitcoin", "--force"])).toThrow(/unknown argument/);
  });
});

describe.skipIf(!PG_URL)("ledger network guard (Postgres)", () => {
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  const schemas: string[] = [];
  const pools: pg.Pool[] = [];
  afterAll(async () => {
    for (const p of pools) await p.end();
    for (const s of schemas) await admin.query(`DROP SCHEMA ${s} CASCADE`).catch(() => undefined);
    await admin.end();
  });

  async function freshDb(): Promise<{ pool: pg.Pool; store: PostgresStore; schema: string }> {
    const schema = `ln_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    schemas.push(schema);
    const pool = new pg.Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${schema}` });
    pools.push(pool);
    await pool.query(SCHEMA_SQL);
    return { pool, store: new PostgresStore(pool), schema };
  }

  async function seed(pool: pg.Pool, network: string) {
    const now = Date.now();
    await pool.query(`INSERT INTO credit_transactions (tx_id, account_id, tx_type, credits, reason, timestamp_ms, msat) VALUES ($1,'acct','earn',100,'compute_contribution',$2,100000), ($3,'acct','spend',10,'x',$2,NULL)`, [randomUUID(), now, randomUUID()]);
    await pool.query(
      `INSERT INTO payment_intents (intent_id, account_id, coordinator_id, wallet_type, network, invoice_ref, amount_sats, coordinator_fee_bps, coordinator_fee_sats, net_sats, quoted_credits, status, created_at_ms)
       VALUES ($1,'acct','c','lightning',$2,'ref',5000,0,0,5000,5000,'settled',$3)`,
      [randomUUID(), network, now]
    );
    await pool.query(
      `INSERT INTO payouts (payout_id, account_id, coordinator_id, kind, bolt11, payment_hash, amount_msat, status, created_at_ms) VALUES ($1,'acct','c','withdraw','lnbcrt1',$2,1000,'paid',$3)`,
      [randomUUID(), randomUUID(), now]
    );
    await pool.query(`INSERT INTO queue_tasks (subtask_id, task_id, payload_json, project_id, resource_class, priority, created_at_ms) VALUES ($1,'t','{}','p','cpu',1,$2)`, [randomUUID(), now]);
    await pool.query(`INSERT INTO credit_accounts (account_id, display_name, owner_user_id, created_at_ms) VALUES ('acct','A','u',$1)`, [now]);
    await pool.query(`INSERT INTO wallet_accounts (account_id, wallet_type, network, payout_address, created_at_ms) VALUES ('acct','lightning',$1,'a@example.com',$2)`, [network, now]);
    await pool.query(`INSERT INTO ble_synced_tx (tx_id, requester_account_id, provider_account_id, credits) VALUES ($1,'a','b',1)`, [randomUUID()]);
    await pool.query(`INSERT INTO payout_controls (control_key, value_json, updated_at_ms) VALUES ('pause','{"paused":true}',$1)`, [now]);
  }
  const count = async (pool: pg.Pool, table: string) => Number((await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n);

  it("records the network on first start and accepts the same network again", async () => {
    const { pool, store } = await freshDb();
    expect(await store.assertLedgerNetwork("regtest", "coord-a")).toEqual({ network: "regtest", recordedNow: true });
    expect(await assertLedgerNetwork(pool, "regtest")).toEqual({ network: "regtest", recordedNow: false });
    expect(await readLedgerNetwork(pool)).toMatchObject({ network: "regtest", recordedBy: "coord-a" });
  });

  it("refuses any other network, naming both and the remedy", async () => {
    const { store } = await freshDb();
    await store.assertLedgerNetwork("regtest");
    for (const other of ["bitcoin", "signet", "testnet"] as const) {
      const err = await store.assertLedgerNetwork(other).catch((e) => e);
      expect(err).toBeInstanceOf(LedgerNetworkMismatchError);
      expect(err).toMatchObject({ stored: "regtest", configured: other });
      expect(err.message).toMatch(/belongs to regtest/);
      expect(err.message).toContain(`BITCOIN_NETWORK=${other}`);
      expect(err.message).toContain(`--confirm-wipe-ledger regtest --to ${other}`);
    }
  });

  it("an unrecorded database with money rows cannot start on mainnet; with intents from another network it cannot start at all", async () => {
    const { pool, store } = await freshDb();
    await seed(pool, "regtest");
    await expect(store.assertLedgerNetwork("bitcoin")).rejects.toMatchObject({ stored: "unrecorded", configured: "bitcoin" });
    await expect(store.assertLedgerNetwork("signet")).rejects.toThrow(/payment intents were made on regtest/);
    expect(await readLedgerNetwork(pool)).toBeNull();
    // The network it was used on adopts it.
    expect(await store.assertLedgerNetwork("regtest")).toEqual({ network: "regtest", recordedNow: true });
  });

  it("an empty unrecorded database starts on mainnet", async () => {
    const { store } = await freshDb();
    expect(await store.assertLedgerNetwork("bitcoin")).toEqual({ network: "bitcoin", recordedNow: true });
  });

  it("concurrent first starts with different networks: one wins, the other refuses", async () => {
    const { pool } = await freshDb();
    const results = await Promise.allSettled([assertLedgerNetwork(pool, "regtest"), assertLedgerNetwork(pool, "signet")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("reset: wrong confirmation refuses and changes nothing; dry run counts; the real run wipes money rows only", async () => {
    const { pool, store } = await freshDb();
    await seed(pool, "regtest");
    await store.assertLedgerNetwork("regtest");

    await expect(resetLedgerNetwork(pool, { confirm: "signet", to: "bitcoin", dryRun: false })).rejects.toThrow(/recorded as "regtest"/);
    expect(await count(pool, "credit_transactions")).toBe(2);

    const dry = await resetLedgerNetwork(pool, { confirm: "regtest", to: "bitcoin", dryRun: true });
    expect(dry).toMatchObject({ from: "regtest", to: "bitcoin", dryRun: true });
    expect(dry.deleted).toMatchObject({ credit_transactions: 2, payouts: 1, payment_intents: 1, queue_tasks: 1 });
    expect(await count(pool, "credit_transactions")).toBe(2);
    expect((await readLedgerNetwork(pool))?.network).toBe("regtest");

    const r = await resetLedgerNetwork(pool, { confirm: "regtest", to: "bitcoin", dryRun: false });
    expect(r.deleted).toMatchObject({ credit_transactions: 2, payouts: 1, payment_intents: 1, queue_tasks: 1 });
    for (const t of WIPED_TABLES) expect(await count(pool, t), t).toBe(0);
    for (const t of ["credit_accounts", "wallet_accounts", "ble_synced_tx", "payout_controls"]) expect(await count(pool, t), t).toBe(1);
    expect(await readLedgerNetwork(pool)).toMatchObject({ network: "bitcoin" });
    expect(await store.assertLedgerNetwork("bitcoin")).toEqual({ network: "bitcoin", recordedNow: false });
    await expect(store.assertLedgerNetwork("regtest")).rejects.toBeInstanceOf(LedgerNetworkMismatchError);
    // Nothing earned on regtest is payable any more.
    expect(await store.earnedMsat("acct")).toBe(0);
    expect(await store.creditBalance("acct")).toBe(0);
  });

  it("reset of an unrecorded database needs --confirm-wipe-ledger unrecorded", async () => {
    const { pool, store } = await freshDb();
    await seed(pool, "regtest");
    await expect(resetLedgerNetwork(pool, { confirm: "regtest", to: "bitcoin", dryRun: false })).rejects.toThrow(/recorded as "unrecorded"/);
    await resetLedgerNetwork(pool, { confirm: "unrecorded", to: "bitcoin", dryRun: false });
    expect(await store.assertLedgerNetwork("bitcoin")).toEqual({ network: "bitcoin", recordedNow: false });
  });

  it("the script runs the reset and prints counts without the database URL", async () => {
    const { pool, store, schema } = await freshDb();
    await seed(pool, "regtest");
    await store.assertLedgerNetwork("regtest");
    const url = new URL(PG_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const run = (args: string[]) =>
      promisify(execFile)(`${root}node_modules/.bin/tsx`, ["scripts/ledger-reset-network.ts", ...args], { cwd: root, env: { ...process.env, DATABASE_URL: url.toString() } });

    const refused = await run(["--confirm-wipe-ledger", "testnet", "--to", "bitcoin"]).catch((e) => e);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/recorded as "regtest"/);

    const ok = await run(["--confirm-wipe-ledger", "regtest", "--to", "bitcoin"]);
    expect(ok.stdout).toMatch(/wiped ledger: regtest -> bitcoin/);
    expect(ok.stdout).toMatch(/credit_transactions\s+2/);
    expect(ok.stdout + ok.stderr).not.toContain(url.password);
    expect(await count(pool, "credit_transactions")).toBe(0);
    expect((await readLedgerNetwork(pool))?.network).toBe("bitcoin");
  }, 30_000);
});
