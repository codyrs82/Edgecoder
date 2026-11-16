// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { Pool, PoolClient } from "pg";
import type { BitcoinNetwork, PayoutRecord } from "../common/types.js";
import type { DepositAddress, DepositCredit, DepositStatus, OnchainDeposit, OnchainDepositStore } from "../economy/onchain-deposits.js";
import { edgecoderFeeTxId, type BatchState, type OnchainBatch, type OnchainDestination, type OnchainPayoutStore } from "../economy/onchain-payouts.js";
import type { FeePoolLockResult } from "../economy/payout-service.js";
import { CREDIT_LOCK_NAMESPACE, rowToPayout } from "./postgres.js";

/**
 * Postgres side of on-chain funding and payouts. Tables are created by SCHEMA_SQL (postgres.ts):
 * onchain_deposit_addresses, onchain_deposits, onchain_payout_destinations, onchain_payout_batches,
 * plus payouts.batch_id / payouts.txid.
 */

/** Advisory-lock namespace for the on-chain watcher and batch runner (one of each across coordinators). */
export const ONCHAIN_LOCK_NAMESPACE = 0x45430007;
export const ONCHAIN_DEPOSIT_WATCHER_LOCK_KEY = 1;
export const ONCHAIN_BATCH_LOCK_KEY = 2;

/** Session try-lock on a dedicated connection: a second coordinator returns at once instead of queueing. */
async function withTryLock<T>(pool: Pool, key: number, fn: () => Promise<T>): Promise<FeePoolLockResult<T>> {
  const client = await pool.connect();
  let held = false;
  try {
    const r = await client.query("SELECT pg_try_advisory_lock($1, $2) AS got", [ONCHAIN_LOCK_NAMESPACE, key]);
    held = r.rows[0]?.got === true;
    if (!held) return { acquired: false };
    return { acquired: true, value: await fn() };
  } finally {
    if (held) await client.query("SELECT pg_advisory_unlock($1, $2)", [ONCHAIN_LOCK_NAMESPACE, key]).catch(() => undefined);
    client.release();
  }
}

async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const nullableNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function rowToDeposit(r: Record<string, unknown>): OnchainDeposit {
  return {
    txid: String(r.txid),
    vout: Number(r.vout),
    accountId: String(r.account_id),
    address: String(r.address),
    amountSats: Number(r.amount_sats),
    confirmations: Number(r.confirmations ?? 0),
    blockHeight: Number(r.block_height ?? 0),
    status: r.status as DepositStatus,
    firstSeenAtMs: Number(r.first_seen_at_ms),
    lastSeenAtMs: Number(r.last_seen_at_ms),
    creditedAtMs: nullableNumber(r.credited_at_ms),
    detail: (r.detail as string | null) ?? null
  };
}

export class PostgresOnchainDepositStore implements OnchainDepositStore {
  constructor(private readonly pool: Pool) {}

  async latestDepositAddress(accountId: string): Promise<DepositAddress | null> {
    const r = await this.pool.query(`SELECT * FROM onchain_deposit_addresses WHERE account_id = $1 ORDER BY created_at_ms DESC LIMIT 1`, [accountId]);
    const row = r.rows[0];
    return row ? { address: row.address, accountId: row.account_id, network: row.network as BitcoinNetwork, createdAtMs: Number(row.created_at_ms), usedAtMs: nullableNumber(row.used_at_ms) } : null;
  }

  async addDepositAddress(a: DepositAddress): Promise<void> {
    await this.pool.query(
      `INSERT INTO onchain_deposit_addresses (address, account_id, network, created_at_ms, used_at_ms) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (address) DO NOTHING`,
      [a.address, a.accountId, a.network, a.createdAtMs, a.usedAtMs]
    );
  }

  async depositAccounts(addresses: string[]): Promise<Map<string, { accountId: string; usedAtMs: number | null }>> {
    const out = new Map<string, { accountId: string; usedAtMs: number | null }>();
    if (addresses.length === 0) return out;
    const r = await this.pool.query(`SELECT address, account_id, used_at_ms FROM onchain_deposit_addresses WHERE address = ANY($1)`, [addresses]);
    for (const row of r.rows) out.set(row.address, { accountId: row.account_id, usedAtMs: nullableNumber(row.used_at_ms) });
    return out;
  }

  async markAddressUsed(address: string, atMs: number): Promise<void> {
    await this.pool.query(`UPDATE onchain_deposit_addresses SET used_at_ms = $2 WHERE address = $1 AND used_at_ms IS NULL`, [address, atMs]);
  }

  async observeDeposit(seen: Omit<OnchainDeposit, "status" | "creditedAtMs" | "detail" | "lastSeenAtMs">, nowMs: number): Promise<OnchainDeposit> {
    // The account and amount of a known deposit never change: they come from the first sighting.
    const r = await this.pool.query(
      `INSERT INTO onchain_deposits (txid, vout, account_id, address, amount_sats, confirmations, block_height, status, first_seen_at_ms, last_seen_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)
       ON CONFLICT (txid, vout) DO UPDATE SET
         confirmations = EXCLUDED.confirmations,
         block_height = EXCLUDED.block_height,
         last_seen_at_ms = EXCLUDED.last_seen_at_ms,
         status = CASE WHEN onchain_deposits.status = 'dropped' THEN 'pending' ELSE onchain_deposits.status END,
         detail = CASE WHEN onchain_deposits.status = 'dropped' THEN NULL ELSE onchain_deposits.detail END
       RETURNING *`,
      [seen.txid, seen.vout, seen.accountId, seen.address, seen.amountSats, seen.confirmations, seen.blockHeight, seen.firstSeenAtMs, nowMs]
    );
    return rowToDeposit(r.rows[0]);
  }

  async setDepositStatus(txid: string, vout: number, from: DepositStatus[], to: DepositStatus, detail: string | null = null): Promise<boolean> {
    const r = await this.pool.query(`UPDATE onchain_deposits SET status = $4, detail = $5 WHERE txid = $1 AND vout = $2 AND status = ANY($3)`, [txid, vout, from, to, detail]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * One transaction: the deposit's status CAS, a settled payment intent (so receivedPurchaseMsat,
   * payout capacity and solvency count the sats like a Lightning purchase) and the credit row, all
   * keyed by txid:vout. The account's credit lock is taken like any credit write.
   */
  async creditDeposit(txid: string, vout: number, c: DepositCredit, from: DepositStatus[]): Promise<"credited" | "already"> {
    return inTransaction(this.pool, async (client) => {
      const upd = await client.query(
        `UPDATE onchain_deposits SET status = 'credited', credited_at_ms = $4, detail = NULL WHERE txid = $1 AND vout = $2 AND status = ANY($3) RETURNING account_id, amount_sats, first_seen_at_ms`,
        [txid, vout, from, c.nowMs]
      );
      const row = upd.rows[0];
      if (!row) return "already" as const;
      const accountId = String(row.account_id);
      const amountSats = Number(row.amount_sats);
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [CREDIT_LOCK_NAMESPACE, accountId]);
      const intent = await client.query(
        `INSERT INTO payment_intents (intent_id, account_id, coordinator_id, wallet_type, network, invoice_ref, amount_sats, coordinator_fee_bps, coordinator_fee_sats, net_sats, quoted_credits, status, created_at_ms, settled_at_ms, tx_ref)
         VALUES ($1,$2,$3,'onchain',$4,$1,$5,$6,$7,$8::bigint,$8::numeric,'settled',$9,$10,$1) ON CONFLICT (intent_id) DO NOTHING`,
        [c.intentId, accountId, c.coordinatorId, c.network, amountSats, c.feeBps, c.feeSats, c.netSats, Number(row.first_seen_at_ms), c.nowMs]
      );
      if ((intent.rowCount ?? 0) === 0) throw new Error(`onchain_intent_exists:${c.intentId}`);
      await client.query(
        `INSERT INTO credit_transactions (tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms)
         SELECT $1,$2,'earn',$3::numeric,$4,NULL,$5 WHERE $3::numeric > 0`,
        [`onchain_deposit:${txid}:${vout}`, accountId, c.netSats, `credit_purchase:${c.intentId}`, c.nowMs]
      );
      return "credited" as const;
    });
  }

  async creditedSatsSince(accountId: string, sinceMs: number): Promise<number> {
    const r = await this.pool.query(`SELECT COALESCE(SUM(amount_sats), 0) AS sats FROM onchain_deposits WHERE account_id = $1 AND status = 'credited' AND credited_at_ms >= $2`, [accountId, sinceMs]);
    return Number(r.rows[0]?.sats ?? 0);
  }

  async listWatchedDeposits(minHeight: number): Promise<OnchainDeposit[]> {
    const r = await this.pool.query(
      `SELECT * FROM onchain_deposits WHERE status IN ('pending','held','below_minimum','dropped') OR (status = 'credited' AND (block_height = 0 OR block_height >= $1)) LIMIT 5000`,
      [minHeight]
    );
    return r.rows.map(rowToDeposit);
  }

  async listDeposits(accountId: string, limit: number): Promise<OnchainDeposit[]> {
    const r = await this.pool.query(`SELECT * FROM onchain_deposits WHERE account_id = $1 ORDER BY first_seen_at_ms DESC LIMIT $2`, [accountId, limit]);
    return r.rows.map(rowToDeposit);
  }

  async getDeposit(txid: string, vout: number): Promise<OnchainDeposit | null> {
    const r = await this.pool.query(`SELECT * FROM onchain_deposits WHERE txid = $1 AND vout = $2`, [txid, vout]);
    return r.rows[0] ? rowToDeposit(r.rows[0]) : null;
  }

  async uncreditedDepositSats(): Promise<number> {
    const r = await this.pool.query(`SELECT COALESCE(SUM(amount_sats), 0) AS sats FROM onchain_deposits WHERE status IN ('pending','held','below_minimum')`);
    return Number(r.rows[0]?.sats ?? 0);
  }

  async getScanHeight(): Promise<number> {
    const r = await this.pool.query(`SELECT value_json FROM payout_controls WHERE control_key = 'onchain_scan_height'`);
    const v = r.rows[0]?.value_json as { height?: number } | undefined;
    return Number(v?.height ?? 0) || 0;
  }

  async setScanHeight(height: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO payout_controls (control_key, value_json, updated_at_ms) VALUES ('onchain_scan_height', $1, $2)
       ON CONFLICT (control_key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at_ms = EXCLUDED.updated_at_ms`,
      [JSON.stringify({ height }), Date.now()]
    );
  }

  withWatcherLock<T>(fn: () => Promise<T>): Promise<FeePoolLockResult<T>> {
    return withTryLock(this.pool, ONCHAIN_DEPOSIT_WATCHER_LOCK_KEY, fn);
  }
}

function rowToBatch(r: Record<string, unknown>): OnchainBatch {
  const outputs = typeof r.outputs_json === "string" ? JSON.parse(r.outputs_json) : r.outputs_json;
  return {
    batchId: String(r.batch_id),
    coordinatorId: String(r.coordinator_id),
    state: r.state as BatchState,
    feeRateSatVb: Number(r.fee_rate_sat_vb),
    feePayer: r.fee_payer === "edgecoder" ? "edgecoder" : "host",
    label: String(r.label),
    outputs: Array.isArray(outputs) ? outputs : [],
    txid: (r.txid as string | null) ?? null,
    totalFeeSats: nullableNumber(r.total_fee_sats),
    confirmations: Number(r.confirmations ?? 0),
    error: (r.error as string | null) ?? null,
    createdAtMs: Number(r.created_at_ms),
    sendAttemptedAtMs: nullableNumber(r.send_attempted_at_ms),
    broadcastAtMs: nullableNumber(r.broadcast_at_ms),
    confirmedAtMs: nullableNumber(r.confirmed_at_ms)
  };
}

const BATCH_COLUMNS: Record<keyof Omit<OnchainBatch, "batchId">, string> = {
  coordinatorId: "coordinator_id",
  state: "state",
  feeRateSatVb: "fee_rate_sat_vb",
  feePayer: "fee_payer",
  label: "label",
  outputs: "outputs_json",
  txid: "txid",
  totalFeeSats: "total_fee_sats",
  confirmations: "confirmations",
  error: "error",
  createdAtMs: "created_at_ms",
  sendAttemptedAtMs: "send_attempted_at_ms",
  broadcastAtMs: "broadcast_at_ms",
  confirmedAtMs: "confirmed_at_ms"
};

export class PostgresOnchainPayoutStore implements OnchainPayoutStore {
  constructor(private readonly pool: Pool) {}

  async listOnchainDestinations(): Promise<OnchainDestination[]> {
    const r = await this.pool.query(`SELECT * FROM onchain_payout_destinations ORDER BY updated_at_ms ASC`);
    return r.rows.map((row) => ({ accountId: row.account_id, address: row.address, network: row.network as BitcoinNetwork, updatedAtMs: Number(row.updated_at_ms) }));
  }

  async getOnchainDestination(accountId: string): Promise<OnchainDestination | null> {
    const r = await this.pool.query(`SELECT * FROM onchain_payout_destinations WHERE account_id = $1`, [accountId]);
    const row = r.rows[0];
    return row ? { accountId: row.account_id, address: row.address, network: row.network as BitcoinNetwork, updatedAtMs: Number(row.updated_at_ms) } : null;
  }

  async setOnchainDestination(accountId: string, address: string | null, network: BitcoinNetwork): Promise<void> {
    if (address === null) {
      await this.pool.query(`DELETE FROM onchain_payout_destinations WHERE account_id = $1`, [accountId]);
      return;
    }
    await this.pool.query(
      `INSERT INTO onchain_payout_destinations (account_id, address, network, updated_at_ms) VALUES ($1,$2,$3,$4)
       ON CONFLICT (account_id) DO UPDATE SET address = EXCLUDED.address, network = EXCLUDED.network, updated_at_ms = EXCLUDED.updated_at_ms`,
      [accountId, address, network, Date.now()]
    );
  }

  async createBatch(b: OnchainBatch): Promise<void> {
    await this.pool.query(
      `INSERT INTO onchain_payout_batches (batch_id, coordinator_id, state, fee_rate_sat_vb, fee_payer, label, outputs_json, txid, total_fee_sats, confirmations, error, created_at_ms, send_attempted_at_ms, broadcast_at_ms, confirmed_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [b.batchId, b.coordinatorId, b.state, b.feeRateSatVb, b.feePayer, b.label, JSON.stringify(b.outputs), b.txid, b.totalFeeSats, b.confirmations, b.error, b.createdAtMs, b.sendAttemptedAtMs, b.broadcastAtMs, b.confirmedAtMs]
    );
  }

  async updateBatch(batchId: string, from: BatchState[], patch: Partial<Omit<OnchainBatch, "batchId">>): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [batchId, from];
    for (const [key, value] of Object.entries(patch) as Array<[keyof typeof BATCH_COLUMNS, unknown]>) {
      const column = BATCH_COLUMNS[key];
      if (!column || value === undefined) continue;
      params.push(key === "outputs" ? JSON.stringify(value) : value);
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length === 0) {
      const r = await this.pool.query(`SELECT 1 FROM onchain_payout_batches WHERE batch_id = $1 AND state = ANY($2)`, params);
      return (r.rowCount ?? 0) > 0;
    }
    const r = await this.pool.query(`UPDATE onchain_payout_batches SET ${sets.join(", ")} WHERE batch_id = $1 AND state = ANY($2)`, params);
    return (r.rowCount ?? 0) > 0;
  }

  async getBatch(batchId: string): Promise<OnchainBatch | null> {
    const r = await this.pool.query(`SELECT * FROM onchain_payout_batches WHERE batch_id = $1`, [batchId]);
    return r.rows[0] ? rowToBatch(r.rows[0]) : null;
  }

  async listBatches(filter: { states?: BatchState[]; sinceMs?: number; limit: number }): Promise<OnchainBatch[]> {
    const r = await this.pool.query(
      `SELECT * FROM onchain_payout_batches WHERE ($1::text[] IS NULL OR state = ANY($1)) AND ($2::bigint IS NULL OR created_at_ms >= $2) ORDER BY created_at_ms DESC LIMIT $3`,
      [filter.states ?? null, filter.sinceMs ?? null, filter.limit]
    );
    return r.rows.map(rowToBatch);
  }

  async latestBatchCreatedAtMs(): Promise<number | null> {
    const r = await this.pool.query(`SELECT MAX(created_at_ms) AS at FROM onchain_payout_batches`);
    return nullableNumber(r.rows[0]?.at);
  }

  async payoutsInBatch(batchId: string): Promise<PayoutRecord[]> {
    const r = await this.pool.query(`SELECT * FROM payouts WHERE batch_id = $1 ORDER BY created_at_ms ASC`, [batchId]);
    return r.rows.map(rowToPayout);
  }

  async setPayoutTxid(payoutIds: string[], txid: string): Promise<void> {
    if (payoutIds.length === 0) return;
    await this.pool.query(`UPDATE payouts SET txid = $2 WHERE payout_id = ANY($1)`, [payoutIds, txid]);
  }

  async recordEdgecoderFee(batchId: string, feePoolAccountId: string, sats: number, nowMs: number): Promise<void> {
    if (sats <= 0) return;
    const txId = edgecoderFeeTxId(batchId);
    await this.pool.query(
      `INSERT INTO credit_transactions (tx_id, account_id, tx_type, credits, reason, timestamp_ms, msat) VALUES ($1,$2,'spend',0,$1,$3,$4) ON CONFLICT (tx_id) DO NOTHING`,
      [txId, feePoolAccountId, nowMs, sats * 1000]
    );
  }

  async edgecoderFeeOutflowMsat(): Promise<number> {
    const r = await this.pool.query(`SELECT COALESCE(SUM(msat), 0) AS msat FROM credit_transactions WHERE tx_type = 'spend' AND reason LIKE 'onchain\\_batch\\_fee:%'`);
    return Number(r.rows[0]?.msat ?? 0);
  }

  withBatchLock<T>(fn: () => Promise<T>): Promise<FeePoolLockResult<T>> {
    return withTryLock(this.pool, ONCHAIN_BATCH_LOCK_KEY, fn);
  }
}
