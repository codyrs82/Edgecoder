// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { BitcoinNetwork } from "../common/types.js";

/**
 * Network guard for the ledger (docs/going-to-mainnet.md, "Switching the database to mainnet").
 *
 * Earnings, cSat balances and payment rows only mean something on the Bitcoin network they were
 * made on: a balance earned or bought on regtest must never be withdrawable as mainnet sats. The
 * database therefore records the network it belongs to (table ledger_network, one row) and a
 * coordinator configured for any other network refuses to start. Any change refuses, not only
 * a switch to mainnet: testnet, signet and regtest sats are all play money relative to each other,
 * and one rule ("one database, one network") is easier to reason about than a matrix.
 *
 * The only way to move a database to another network is scripts/ledger-reset-network.ts, which
 * wipes the money rows and rewrites ledger_network in one transaction (src/db/ledger-reset.ts).
 */

export const BITCOIN_NETWORKS: readonly BitcoinNetwork[] = ["bitcoin", "testnet", "signet", "regtest"];

/** pg.Pool, pg.PoolClient or pg.Client. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface LedgerNetworkRecord {
  network: BitcoinNetwork;
  recordedAtMs: number;
  recordedBy: string;
}

export interface LedgerNetworkCheck {
  network: BitcoinNetwork;
  /** True when this call wrote the row (first start on this database). */
  recordedNow: boolean;
}

/** Tables whose rows mean money already exists on this database (any one row is enough). */
const MONEY_EVIDENCE_TABLES = ["credit_transactions", "payouts", "payment_intents"] as const;

export const RESET_COMMAND = (from: string, to: string) => `npx tsx scripts/ledger-reset-network.ts --confirm-wipe-ledger ${from} --to ${to}`;

export class LedgerNetworkMismatchError extends Error {
  readonly code = "ledger_network_mismatch";
  constructor(
    /** Recorded network, or "unrecorded" when the row is missing but the data says otherwise. */
    readonly stored: BitcoinNetwork | "unrecorded",
    readonly configured: BitcoinNetwork,
    detail: string
  ) {
    super(
      `ledger_network_mismatch: ${detail} The coordinator is configured with BITCOIN_NETWORK=${configured}. ` +
        `Balances, earnings and payments made on one network must never become sats on another, so it will not start. ` +
        `Either set BITCOIN_NETWORK back to the database's network, point DATABASE_URL at a database for ${configured}, ` +
        `or, with every coordinator on this database stopped, wipe the ledger for ${configured}: ` +
        `${RESET_COMMAND(stored, configured)} (docs/going-to-mainnet.md).`
    );
    this.name = "LedgerNetworkMismatchError";
  }
}

export async function readLedgerNetwork(db: Queryable): Promise<LedgerNetworkRecord | null> {
  const r = await db.query(`SELECT network, recorded_at_ms, recorded_by FROM ledger_network WHERE singleton`);
  const row = r.rows[0];
  if (!row) return null;
  return { network: row.network as BitcoinNetwork, recordedAtMs: Number(row.recorded_at_ms), recordedBy: String(row.recorded_by) };
}

/** True when the ledger already holds credit, payout or payment rows. */
export async function ledgerHasMoneyRows(db: Queryable): Promise<boolean> {
  const r = await db.query(`SELECT ${MONEY_EVIDENCE_TABLES.map((t) => `EXISTS (SELECT 1 FROM ${t})`).join(" OR ")} AS any`);
  return Boolean(r.rows[0]?.any);
}

/**
 * Check (and on first use record) the database's network. Throws LedgerNetworkMismatchError when:
 * - the recorded network differs from `configured` (any change refuses);
 * - no network is recorded yet (a database from before this check) and either its payment
 *   intents name another network, or `configured` is mainnet while money rows already exist:
 *   their origin cannot be proven, and a database used before mainnet was never mainnet.
 * Otherwise records `configured` (if unrecorded) and returns it. Safe under concurrent starts:
 * the insert is ON CONFLICT DO NOTHING and the row is re-read and compared.
 */
export async function assertLedgerNetwork(db: Queryable, configured: BitcoinNetwork, recordedBy = "coordinator", nowMs = Date.now()): Promise<LedgerNetworkCheck> {
  if (!BITCOIN_NETWORKS.includes(configured)) throw new Error(`assertLedgerNetwork: unknown network ${String(configured)}`);
  const existing = await readLedgerNetwork(db);
  if (existing) {
    if (existing.network !== configured) {
      throw new LedgerNetworkMismatchError(existing.network, configured, `this database's ledger belongs to ${existing.network} (recorded ${new Date(existing.recordedAtMs).toISOString()} by ${existing.recordedBy}).`);
    }
    return { network: configured, recordedNow: false };
  }
  const seen = await db.query(`SELECT DISTINCT network FROM payment_intents WHERE network IS NOT NULL`);
  const others = seen.rows.map((r) => String(r.network)).filter((n) => n !== configured);
  if (others.length) {
    throw new LedgerNetworkMismatchError("unrecorded", configured, `this database records no network yet, but its payment intents were made on ${others.sort().join(", ")}.`);
  }
  if (configured === "bitcoin" && (await ledgerHasMoneyRows(db))) {
    throw new LedgerNetworkMismatchError("unrecorded", configured, "this database records no network yet but already holds credit, payout or payment rows, which cannot be proven to be mainnet.");
  }
  const ins = await db.query(
    `INSERT INTO ledger_network (singleton, network, recorded_at_ms, recorded_by) VALUES (TRUE, $1, $2, $3) ON CONFLICT (singleton) DO NOTHING`,
    [configured, nowMs, recordedBy]
  );
  const now = await readLedgerNetwork(db);
  if (!now || now.network !== configured) {
    // Another coordinator configured for a different network recorded it first.
    throw new LedgerNetworkMismatchError(now?.network ?? "unrecorded", configured, `this database's ledger belongs to ${now?.network ?? "an unknown network"}.`);
  }
  return { network: configured, recordedNow: (ins.rowCount ?? 0) > 0 };
}
