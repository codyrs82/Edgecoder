import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { MemoryPayoutStore, PayoutService } from "../../src/economy/payout-service.js";
import { DEFAULT_PAYOUT_POLICY } from "../../src/economy/payouts.js";
import type { LightningProvider, PayInvoiceInput } from "../../src/economy/lightning.js";
import { INVALIDATE_SERVER_SEED_WALLETS_SQL, PostgresStore } from "../../src/db/postgres.js";
import { PortalStore } from "../../src/portal/store.js";
import { encodeTestBolt11 } from "./helpers/bolt11-encode.js";

const policy = { ...DEFAULT_PAYOUT_POLICY, network: "signet" as const };

/** Fake LNURL server for alice@getalby.com: returns an invoice for exactly the requested amount. */
function lnurlFetcher(requested: string[]) {
  const metadata = JSON.stringify([["text/identifier", "alice@getalby.com"]]);
  const descriptionHashHex = createHash("sha256").update(metadata).digest("hex");
  return async (url: string) => {
    requested.push(url);
    if (url === "https://getalby.com/.well-known/lnurlp/alice") return { tag: "payRequest", callback: "https://getalby.com/lnurlp/alice/cb", minSendable: 1000, maxSendable: 1e12, metadata };
    const amountMsat = Number(new URL(url).searchParams.get("amount"));
    const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
    return { pr: encodeTestBolt11({ network: "tbs", amountMsat, paymentHashHex: hash, descriptionHashHex }) };
  };
}

describe("auto payouts with no valid destination", () => {
  it("skip the account and keep its earnings payable; accounts with a Lightning address are paid", async () => {
    const earned: Record<string, number> = { "acct-nodest": 50_000_000, "acct-ln": 50_000_000 };
    const store = new MemoryPayoutStore((a) => earned[a] ?? 0);
    store.received = 10_000_000_000;
    store.autoAccounts.set("acct-ln", "alice@getalby.com"); // acct-nodest has none (retired seed address)
    const paid: PayInvoiceInput[] = [];
    const provider: LightningProvider = {
      createInvoice: async () => { throw new Error("n/a"); },
      checkSettlement: async () => ({ settled: false }),
      payInvoice: async (i) => { paid.push(i); return { status: "succeeded", feeMsat: 0 }; }
    };
    const requested: string[] = [];
    const svc = new PayoutService({ store, provider, policy, coordinatorId: "c", feePoolAccountId: "pool", fetcher: lnurlFetcher(requested) });

    const before = await svc.balance("acct-nodest");
    const results = await svc.runAutoPayouts();

    expect(results.map((r) => r.accountId)).toEqual(["acct-ln"]);
    expect(results[0].result.ok).toBe(true);
    expect(paid).toHaveLength(1);
    expect(requested.every((u) => u.startsWith("https://getalby.com/"))).toBe(true);
    // Held, not failed and not paid anywhere: no payout row, balance unchanged.
    expect(await store.listPayouts("acct-nodest")).toEqual([]);
    const after = await svc.balance("acct-nodest");
    expect({ ...after, capacityMsat: 0 }).toEqual({ ...before, capacityMsat: 0 }); // node capacity is global and moved with acct-ln's payout
    expect(before.payableMsat).toBe(50_000_000);
  });
});

/** Records every query; enough to check the migrations run without a database. */
function recordingPool() {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const pool = { query: async (text: string, values?: unknown[]) => { queries.push({ text, values }); return { rows: [], rowCount: 0 }; } };
  return { pool: pool as unknown as pg.Pool, queries };
}

describe("startup migrations retire server-generated seed wallets", () => {
  it("control plane: migrate() runs the invalidation for seed-sha256 refs and Lightning rows holding on-chain addresses", async () => {
    const { pool, queries } = recordingPool();
    await new PostgresStore(pool).migrate();
    const q = queries.find((x) => x.text === INVALIDATE_SERVER_SEED_WALLETS_SQL);
    expect(q).toBeDefined();
    expect(INVALIDATE_SERVER_SEED_WALLETS_SQL).toMatch(/payout_address = NULL/);
    expect(INVALIDATE_SERVER_SEED_WALLETS_SQL).toMatch(/legacy_payout_address = payout_address/);
    expect(INVALIDATE_SERVER_SEED_WALLETS_SQL).toMatch(/seed-sha256:%/);
    expect(INVALIDATE_SERVER_SEED_WALLETS_SQL).not.toMatch(/DELETE/i);
    expect(typeof q!.values![0]).toBe("number");
  });

  it("portal: migrate() creates the destination tables and marks old onboarding rows invalid without deleting them", async () => {
    const { pool, queries } = recordingPool();
    await new PortalStore(pool).migrate();
    const texts = queries.map((q) => q.text).join("\n");
    expect(texts).toMatch(/CREATE TABLE IF NOT EXISTS portal_payout_destinations/);
    expect(texts).toMatch(/CREATE TABLE IF NOT EXISTS portal_payout_destination_challenges/);
    expect(texts).toMatch(/UPDATE portal_wallet_onboarding SET invalidated_at_ms/);
    expect(texts).not.toMatch(/DELETE FROM portal_wallet_onboarding/i);
  });
});

// Real Postgres (CI's credits-pg service, or a local one via TEST_DATABASE_URL).
const PG_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("seed wallet retirement against real Postgres", () => {
  it("control plane: old addresses stop being payout addresses, earnings stay, a new destination is used", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    try {
      const store = new PostgresStore(pool);
      await store.migrate();
      const tag = randomUUID().slice(0, 8);
      const seedAcct = `acct-seed-${tag}`;
      const ghostAcct = `acct-ghost-${tag}`;
      const lnAcct = `acct-ln-${tag}`;
      await store.upsertWalletAccount({ accountId: seedAcct, walletType: "lightning", network: "signet", payoutAddress: "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", encryptedSecretRef: `seed-sha256:${"ab".repeat(32)}`, createdAtMs: 1 });
      await pool.query(`INSERT INTO wallet_accounts (account_id, wallet_type, network, payout_address, created_at_ms) VALUES ($1,'lightning','signet','tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',1)`, [ghostAcct]);
      await store.upsertWalletAccount({ accountId: lnAcct, walletType: "lightning", network: "signet", payoutAddress: "alice@getalby.com", createdAtMs: 1 });
      await store.recordCreditTransactions([{ txId: `tx-${tag}`, accountId: seedAcct, type: "earn", credits: 5, reason: "task", timestampMs: 1, msat: 7_000_000 }]);

      expect(await store.invalidateServerSeedWallets(123)).toBeGreaterThanOrEqual(2);
      const seed = (await pool.query(`SELECT * FROM wallet_accounts WHERE account_id = $1`, [seedAcct])).rows[0];
      expect(seed).toMatchObject({ payout_address: null, encrypted_secret_ref: null, legacy_payout_address: "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7" });
      expect(Number(seed.payout_invalidated_at_ms)).toBe(123);
      expect((await pool.query(`SELECT payout_address FROM wallet_accounts WHERE account_id = $1`, [ghostAcct])).rows[0].payout_address).toBeNull();
      expect((await store.getWalletAccount(lnAcct))?.payoutAddress).toBe("alice@getalby.com");
      expect((await store.getWalletAccount(seedAcct))?.payoutInvalidatedAtMs).toBe(123);

      const auto = (await store.listAutoPayoutAccounts()).map((a) => a.accountId);
      expect(auto).toContain(lnAcct);
      expect(auto).not.toContain(seedAcct);
      expect(auto).not.toContain(ghostAcct);
      expect(await store.earnedMsat(seedAcct)).toBe(7_000_000); // ledger untouched

      // Idempotent: a second startup changes nothing for these rows.
      await store.migrate();
      expect((await store.getWalletAccount(seedAcct))?.payoutInvalidatedAtMs).toBe(123);

      // The user sets a Lightning address: it becomes the payout address and the flag clears.
      await store.setLightningAddress(seedAcct, "bob@getalby.com", "signet");
      expect(await store.getWalletAccount(seedAcct)).toMatchObject({ payoutAddress: "bob@getalby.com", payoutInvalidatedAtMs: undefined });
      expect((await store.listAutoPayoutAccounts()).map((a) => a.accountId)).toContain(seedAcct);
      await store.migrate();
      expect((await store.getWalletAccount(seedAcct))?.payoutAddress).toBe("bob@getalby.com");

      await pool.query(`DELETE FROM wallet_accounts WHERE account_id = ANY($1)`, [[seedAcct, ghostAcct, lnAcct]]);
      await pool.query(`DELETE FROM credit_transactions WHERE tx_id = $1`, [`tx-${tag}`]);
    } finally {
      await pool.end();
    }
  });

  it("portal: onboarding rows are marked invalid and kept; destinations and challenges round-trip", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    try {
      const store = new PortalStore(pool);
      await store.migrate();
      const userId = `u-${randomUUID().slice(0, 8)}`;
      await pool.query(
        `INSERT INTO portal_wallet_onboarding (user_id, account_id, network, seed_phrase_hash, encrypted_private_key_ref, derived_address, created_at_ms)
         VALUES ($1,$2,'signet','hash','seed-sha256:x','tb1qold',1)`,
        [userId, `acct-${userId}`]
      );
      expect(await store.migratePayoutDestinations()).toBeGreaterThanOrEqual(1);
      const row = await store.getWalletOnboardingByUserId(userId);
      expect(row?.invalidatedAtMs).toBeGreaterThan(0);
      expect(row?.derivedAddress).toBe("tb1qold");
      expect(await store.migratePayoutDestinations()).toBe(0);

      await store.upsertPayoutDestination({ userId, accountId: `acct-${userId}`, kind: "lightning_address", destination: "alice@getalby.com", network: "signet" });
      expect(await store.getPayoutDestination(userId)).toMatchObject({ destination: "alice@getalby.com", kind: "lightning_address" });
      const challengeId = randomUUID();
      await store.createPayoutDestinationChallenge({ challengeId, userId, kind: "lightning_address", destination: "bob@getalby.com", emailCodeHash: "h", expiresAtMs: Date.now() + 60_000 });
      expect(await store.consumePayoutDestinationChallenge(challengeId)).toMatchObject({ userId, destination: "bob@getalby.com" });
      expect(await store.consumePayoutDestinationChallenge(challengeId)).toBeNull();

      await pool.query(`DELETE FROM portal_wallet_onboarding WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM portal_payout_destinations WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM portal_payout_destination_challenges WHERE user_id = $1`, [userId]);
    } finally {
      await pool.end();
    }
  });
});
