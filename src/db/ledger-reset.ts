// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { Pool } from "pg";
import type { BitcoinNetwork } from "../common/types.js";
import { BITCOIN_NETWORKS, readLedgerNetwork } from "./ledger-network.js";
import { FEE_POOL_LOCK_KEY, FEE_POOL_LOCK_NAMESPACE, PAYOUT_GLOBAL_LOCK_KEY, PAYOUT_LOCK_NAMESPACE } from "./postgres.js";

/**
 * Wipe a ledger for a new Bitcoin network (scripts/ledger-reset-network.ts). Deletes every row that
 * carries money meaning or attests to it, then rewrites ledger_network, in one transaction.
 *
 * Deleted (WIPED_TABLES): balances and earnings (credit_transactions and the projections and
 * contribution reports reconciliation checks them against), purchases and fees (payment_intents,
 * coordinator_fee_events), payouts, usage and reservation leases priced in msat, work still able to
 * accrue earnings (queue, pending verifications, task billing), and the signed/anchored history of all of that
 * (ordering and stats ledgers, quorum records, anchors, work receipts and epochs, issuance, ledger
 * verifications). A ledger chain anchored on regtest proves nothing on mainnet, so it restarts.
 * On-chain deposit addresses, deposits, payout batches and on-chain payout destinations are wiped
 * too: a bcrt1 address is meaningless on mainnet.
 *
 * Kept: who people and machines are and how they are configured (credit accounts, memberships,
 * agent registry, signing keys and ownership, payout destinations in wallet_accounts and their
 * LNURL callback pins, infrastructure hosts), safety state (payout_controls kill switch, blacklist,
 * verification reputation, hardware verifications, request nonces, ble_synced_tx replay dedupe),
 * and network-independent reference data (price/rate epochs, market history and orders, treasury,
 * key custody, rollouts, node status).
 */
export const WIPED_TABLES = [
  "credit_transactions",
  "coordinator_earnings_projection",
  "compute_contribution_reports",
  "payouts",
  "payment_intents",
  "coordinator_fee_events",
  "usage_records",
  "compute_reservations",
  "pending_verifications",
  "queue_tasks",
  "queue_results",
  "queue_expired_holders",
  "task_billing",
  "ledger_records",
  "stats_ledger_records",
  "quorum_ledger_records",
  "bitcoin_anchor_records",
  "work_receipts",
  "receipt_epochs",
  "issuance_epochs",
  "issuance_allocations",
  "issuance_payout_events",
  "ledger_verifications",
  // On-chain addresses, deposits, payout batches and destinations all belong to one network.
  "onchain_deposit_addresses",
  "onchain_deposits",
  "onchain_payout_batches",
  "onchain_payout_destinations"
] as const;

export const KEPT_TABLES = [
  "credit_accounts",
  "account_memberships",
  "agent_registry",
  "agent_signing_keys",
  "agent_ownership",
  "wallet_accounts",
  "payout_callback_pins",
  "infrastructure_hosts",
  "payout_controls",
  "blacklist_events",
  "verification_reputation",
  "hardware_verifications",
  "request_nonces",
  "ble_synced_tx",
  "price_epochs",
  "rate_epochs",
  "market_ticks",
  "market_trades",
  "market_orders",
  "treasury_policies",
  "key_custody_events",
  "rollout_policies",
  "agent_rollout_states",
  "ollama_rollouts",
  "node_status_projection"
] as const;

export type ResetArgs = { confirm: string; to: BitcoinNetwork; dryRun: boolean };

export const RESET_USAGE =
  "usage: DATABASE_URL=... npx tsx scripts/ledger-reset-network.ts --confirm-wipe-ledger <current-network|unrecorded> --to <bitcoin|testnet|signet|regtest> [--dry-run]";

export function parseResetArgs(argv: string[]): ResetArgs {
  let confirm: string | undefined;
  let to: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--confirm-wipe-ledger") confirm = argv[++i];
    else if (a === "--to") to = argv[++i];
    else if (a === "--dry-run") dryRun = true;
    else throw new Error(`unknown argument ${a}\n${RESET_USAGE}`);
  }
  if (!confirm) throw new Error(`--confirm-wipe-ledger <current-network> is required\n${RESET_USAGE}`);
  if (!to || !BITCOIN_NETWORKS.includes(to as BitcoinNetwork)) throw new Error(`--to must be one of ${BITCOIN_NETWORKS.join(", ")}\n${RESET_USAGE}`);
  return { confirm, to: to as BitcoinNetwork, dryRun };
}

export interface ResetResult {
  from: BitcoinNetwork | "unrecorded";
  to: BitcoinNetwork;
  dryRun: boolean;
  /** Rows deleted per table (dry run: rows that would be deleted). */
  deleted: Record<string, number>;
}

/**
 * Run the reset. `confirm` must name the network currently recorded ("unrecorded" for a database
 * that has none yet), so a copy-pasted command cannot wipe the wrong database. Every coordinator on
 * the database should be stopped; the tables are locked for the transaction regardless, and the
 * payout and fee-pool advisory locks are taken so no reservation or distribution interleaves.
 */
export async function resetLedgerNetwork(pool: Pool, args: ResetArgs, opts: { by?: string; nowMs?: number } = {}): Promise<ResetResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [PAYOUT_LOCK_NAMESPACE, PAYOUT_GLOBAL_LOCK_KEY]);
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [FEE_POOL_LOCK_NAMESPACE, FEE_POOL_LOCK_KEY]);
    await client.query(`LOCK TABLE ledger_network, ${WIPED_TABLES.join(", ")} IN ACCESS EXCLUSIVE MODE`);
    const current = await readLedgerNetwork(client);
    const from = current?.network ?? "unrecorded";
    if (args.confirm !== from) {
      throw new Error(`refusing: this database's ledger is recorded as "${from}", but --confirm-wipe-ledger says "${args.confirm}". Re-run with --confirm-wipe-ledger ${from} if this is the database you mean to wipe.`);
    }
    const deleted: Record<string, number> = {};
    for (const table of WIPED_TABLES) {
      if (args.dryRun) {
        const r = await client.query(`SELECT COUNT(*)::bigint AS n FROM ${table}`);
        deleted[table] = Number(r.rows[0]?.n ?? 0);
      } else {
        const r = await client.query(`DELETE FROM ${table}`);
        deleted[table] = Number(r.rowCount ?? 0);
      }
    }
    if (args.dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query(
        `INSERT INTO ledger_network (singleton, network, recorded_at_ms, recorded_by) VALUES (TRUE, $1, $2, $3)
         ON CONFLICT (singleton) DO UPDATE SET network = EXCLUDED.network, recorded_at_ms = EXCLUDED.recorded_at_ms, recorded_by = EXCLUDED.recorded_by`,
        [args.to, opts.nowMs ?? Date.now(), opts.by ?? `ledger-reset-network from ${from}`]
      );
      await client.query("COMMIT");
    }
    return { from, to: args.to, dryRun: args.dryRun, deleted };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
