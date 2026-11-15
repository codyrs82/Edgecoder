// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import type { BitcoinNetwork, CreditTransaction, PayoutRecord } from "../common/types.js";
import { allocateBatchFee, ONCHAIN_VBYTES_PER_PAYOUT, sendManyFailureIsFinal, validateOnchainPayoutAddress, type ChainTransaction, type OnchainConfig, type OnchainWallet } from "./onchain.js";
import { PAYOUT_LIMIT_WINDOW_MS, checkPayoutLimits, payoutLimitsActive, type PayoutLimits, type PayoutPauseControl } from "./payout-safeguards.js";
import { earningsMaturityCutoffMs, payoutCapacityMsat, type PayoutPolicy } from "./payouts.js";
import type { FeePoolLockResult, MemoryPayoutStore, PayoutService, PayoutStore } from "./payout-service.js";

/**
 * Batched on-chain payouts (docs/economy-math.md "On-chain"). Every ONCHAIN_PAYOUT_INTERVAL_MS the
 * runner pays each account whose payout destination is a Bitcoin address and whose payable balance
 * clears ONCHAIN_PAYOUT_MIN_SATS, all in one LND SendMany transaction.
 *
 * Each payout is an ordinary payouts row (kind "onchain"), reserved through PayoutStore.reservePayout,
 * so the payable balance, the earnings hold, node capacity and the 24 h caps apply exactly as for
 * Lightning, and the reservation debits the account (amount + fee cap) under the same locks.
 *
 * Batch states (one row per batch, written before anything is sent):
 *
 *   building ──> pending ──(SendMany)──> broadcast ──(N confirmations)──> confirmed
 *      │            │
 *      └────────────┴──> failed   (payouts released; their earnings go into a later batch: the retry)
 *
 *   building   payouts are being reserved; a crash here leaves nothing sent: the batch fails.
 *   pending    outputs frozen. `sendAttemptedAtMs` is stamped just before SendMany. After a crash or a
 *              timeout the node is asked: a wallet transaction carrying the batch label means it
 *              was sent -> broadcast; none after ONCHAIN_BROADCAST_GRACE_MS -> failed. A batch never stamped was never sent -> failed.
 *   broadcast  txid recorded on the batch and its payouts; payouts stay pending (counted at their fee cap).
 *   confirmed  the fee is split (allocateBatchFee) and each payout settles as paid with its share; the
 *              unused fee cap goes back to the account.
 *
 * Never double-pays: a payout row belongs to one batch; only a failed batch releases its payouts, and
 * a batch fails only when the node shows no transaction for it. If a failed batch's transaction
 * appears in the node later, payouts are paused (kill switch) for an operator.
 * The runner holds an advisory lock, so one coordinator at a time builds or advances batches.
 */

export type BatchState = "building" | "pending" | "broadcast" | "confirmed" | "failed";

export interface BatchOutput {
  payoutId: string;
  accountId: string;
  address: string;
  amountSats: number;
  /** Network fee the host may be charged for this payout (0 when EdgeCoder pays). */
  feeCapSats: number;
}

export interface OnchainBatch {
  batchId: string;
  coordinatorId: string;
  state: BatchState;
  feeRateSatVb: number;
  feePayer: "host" | "edgecoder";
  label: string;
  outputs: BatchOutput[];
  txid: string | null;
  totalFeeSats: number | null;
  confirmations: number;
  error: string | null;
  createdAtMs: number;
  sendAttemptedAtMs: number | null;
  broadcastAtMs: number | null;
  confirmedAtMs: number | null;
}

export interface OnchainDestination {
  accountId: string;
  address: string;
  network: BitcoinNetwork;
  updatedAtMs: number;
}

export interface OnchainPayoutStore {
  listOnchainDestinations(): Promise<OnchainDestination[]>;
  getOnchainDestination(accountId: string): Promise<OnchainDestination | null>;
  /** null removes it. */
  setOnchainDestination(accountId: string, address: string | null, network: BitcoinNetwork): Promise<void>;
  createBatch(batch: OnchainBatch): Promise<void>;
  /** Compare-and-set on the state; `patch` applied only when the batch is in one of `from`. */
  updateBatch(batchId: string, from: BatchState[], patch: Partial<Omit<OnchainBatch, "batchId">>): Promise<boolean>;
  getBatch(batchId: string): Promise<OnchainBatch | null>;
  listBatches(filter: { states?: BatchState[]; sinceMs?: number; limit: number }): Promise<OnchainBatch[]>;
  latestBatchCreatedAtMs(): Promise<number | null>;
  payoutsInBatch(batchId: string): Promise<PayoutRecord[]>;
  setPayoutTxid(payoutIds: string[], txid: string): Promise<void>;
  /** The network fee EdgeCoder pays for a batch: one spend row (msat) on the fee pool, idempotent per batch. */
  recordEdgecoderFee(batchId: string, feePoolAccountId: string, sats: number, nowMs: number): Promise<void>;
  /** Σ EdgeCoder-paid batch fees (msat): sats that left the node outside any payout row (reconciliation outflow). */
  edgecoderFeeOutflowMsat(): Promise<number>;
  withBatchLock<T>(fn: () => Promise<T>): Promise<FeePoolLockResult<T>>;
}

export function edgecoderFeeTxId(batchId: string): string {
  return `onchain_batch_fee:${batchId}`;
}

/** In-memory store over a MemoryPayoutStore (dev, tests). */
export class MemoryOnchainPayoutStore implements OnchainPayoutStore {
  readonly destinations = new Map<string, OnchainDestination>();
  readonly batches = new Map<string, OnchainBatch>();
  private locked = false;
  constructor(private readonly payouts: MemoryPayoutStore) {}
  async listOnchainDestinations() {
    return [...this.destinations.values()].map((d) => ({ ...d }));
  }
  async getOnchainDestination(accountId: string) {
    const d = this.destinations.get(accountId);
    return d ? { ...d } : null;
  }
  async setOnchainDestination(accountId: string, address: string | null, network: BitcoinNetwork) {
    if (address === null) this.destinations.delete(accountId);
    else this.destinations.set(accountId, { accountId, address, network, updatedAtMs: Date.now() });
  }
  async createBatch(batch: OnchainBatch) {
    if (this.batches.has(batch.batchId)) throw new Error("duplicate_batch");
    this.batches.set(batch.batchId, structuredClone(batch));
  }
  async updateBatch(batchId: string, from: BatchState[], patch: Partial<Omit<OnchainBatch, "batchId">>) {
    const b = this.batches.get(batchId);
    if (!b || !from.includes(b.state)) return false;
    Object.assign(b, structuredClone(patch));
    return true;
  }
  async getBatch(batchId: string) {
    const b = this.batches.get(batchId);
    return b ? structuredClone(b) : null;
  }
  async listBatches(filter: { states?: BatchState[]; sinceMs?: number; limit: number }) {
    return [...this.batches.values()]
      .filter((b) => (!filter.states || filter.states.includes(b.state)) && (filter.sinceMs === undefined || b.createdAtMs >= filter.sinceMs))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, filter.limit)
      .map((b) => structuredClone(b));
  }
  async latestBatchCreatedAtMs() {
    const all = [...this.batches.values()].map((b) => b.createdAtMs);
    return all.length ? Math.max(...all) : null;
  }
  async payoutsInBatch(batchId: string) {
    return [...this.payouts.payouts.values()].filter((p) => p.batchId === batchId).map((p) => ({ ...p }));
  }
  async setPayoutTxid(payoutIds: string[], txid: string) {
    for (const id of payoutIds) {
      const p = this.payouts.payouts.get(id);
      if (p) p.txid = txid;
    }
  }
  async recordEdgecoderFee(batchId: string, feePoolAccountId: string, sats: number, nowMs: number) {
    const txId = edgecoderFeeTxId(batchId);
    if (sats <= 0 || this.payouts.rows.some((r) => r.txId === txId)) return;
    const row: CreditTransaction = { txId, accountId: feePoolAccountId, type: "spend", credits: 0, reason: txId, timestampMs: nowMs, msat: sats * 1000 };
    await this.payouts.recordCreditTransactions([row]);
  }
  async edgecoderFeeOutflowMsat() {
    return this.payouts.rows.filter((r) => r.type === "spend" && r.reason.startsWith("onchain_batch_fee:")).reduce((s, r) => s + (r.msat ?? 0), 0);
  }
  async withBatchLock<T>(fn: () => Promise<T>): Promise<FeePoolLockResult<T>> {
    if (this.locked) return { acquired: false };
    this.locked = true;
    try {
      return { acquired: true, value: await fn() };
    } finally {
      this.locked = false;
    }
  }
}

export interface OnchainPayoutDeps {
  store: OnchainPayoutStore;
  payouts: PayoutStore;
  /** Balance as the account sees it (hold, credit cap): what a batch may pay. */
  payoutService: Pick<PayoutService, "balance" | "earningsHoldMs">;
  wallet: OnchainWallet;
  config: OnchainConfig;
  policy: PayoutPolicy;
  limits?: PayoutLimits;
  pause?: PayoutPauseControl;
  coordinatorId: string;
  feePoolAccountId: string;
  /** Current chain height hint (the deposit watcher's scan height): bounds how far back a batch is looked up. 0 = read everything. */
  heightHint?: () => Promise<number>;
  onPaid?: (payout: PayoutRecord) => Promise<void>;
  onSecurityEvent?: (event: "payout_limit_exceeded" | "payout_blocked_paused" | "onchain_batch_resurfaced" | "onchain_batch_stuck", details: Record<string, unknown>) => void;
  /** Pause payouts (the kill switch), when a released batch turns out to have been sent. */
  pausePayouts?: (reason: string) => Promise<void>;
  log?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
  now?: () => number;
}

export type BatchRunResult =
  | { skipped: "disabled" | "locked" | "payouts_disabled" | "payouts_paused" | "not_due" | "batch_open" | "fee_above_cap" | "nothing_to_pay"; feeRateSatVb?: number; advanced?: AdvanceSummary }
  | { skipped?: undefined; batchId: string; state: BatchState; payouts: number; amountSats: number; txid?: string; error?: string; advanced?: AdvanceSummary };

export interface AdvanceSummary {
  broadcast: number;
  confirmed: number;
  failed: number;
  resurfaced: number;
}

/** How far below the height hint a batch transaction is looked for (about two weeks of blocks). */
const LOOKUP_DEPTH_BLOCKS = 2016;
/** A broadcast batch unconfirmed this long is reported (fee too low, or dropped from mempools). */
const STUCK_ALERT_MS = 24 * 60 * 60 * 1000;
/** Failed batches whose transaction could still turn up are re-checked this long. */
const RESURFACE_WATCH_MS = 7 * 24 * 60 * 60 * 1000;

export function batchLabel(batchId: string): string {
  return `edgecoder:onchain-batch:${batchId}`;
}

/**
 * The node transaction that is this batch: its recorded txid, or the batch label LND stores with the
 * transaction it publishes (SendMany `label`). Outputs are never matched: an earlier batch can pay the
 * same addresses the same amounts, and taking its transaction for this one would mark unpaid payouts paid.
 */
export function findBatchTransaction(batch: Pick<OnchainBatch, "label" | "txid">, txs: ChainTransaction[]): ChainTransaction | undefined {
  if (batch.txid) {
    const byId = txs.find((t) => t.txid === batch.txid);
    if (byId) return byId;
  }
  return txs.find((t) => t.label === batch.label);
}

export class OnchainPayoutService {
  private running: Promise<BatchRunResult> | null = null;
  constructor(private readonly d: OnchainPayoutDeps) {}

  private now() {
    return (this.d.now ?? Date.now)();
  }

  /** One run: advance open batches (recovery included), then build and send a new one when due. Single-flight. */
  tick(opts: { force?: boolean } = {}): Promise<BatchRunResult> {
    if (!this.d.config.enabled) return Promise.resolve({ skipped: "disabled" });
    if (!this.running) {
      this.running = (async (): Promise<BatchRunResult> => {
        const r = await this.d.store.withBatchLock(() => this.run(opts.force === true));
        return r.acquired ? r.value : { skipped: "locked" };
      })().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run(force: boolean): Promise<BatchRunResult> {
    const advanced = await this.advance();
    const open = await this.d.store.listBatches({ states: ["building", "pending"], limit: 1 });
    if (open.length) return { skipped: "batch_open", advanced };
    const last = await this.d.store.latestBatchCreatedAtMs();
    if (!force && last !== null && this.now() - last < this.d.config.payoutIntervalMs) return { skipped: "not_due", advanced };
    const built = await this.build();
    return { ...built, advanced } as BatchRunResult;
  }

  private async chainTxs(): Promise<ChainTransaction[]> {
    const hint = this.d.heightHint ? await this.d.heightHint().catch(() => 0) : 0;
    return this.d.wallet.listTransactions({ startHeight: hint > LOOKUP_DEPTH_BLOCKS ? hint - LOOKUP_DEPTH_BLOCKS : 0 });
  }

  /** Move every open batch forward with what the node reports. Safe to run any number of times. */
  async advance(): Promise<AdvanceSummary> {
    const out: AdvanceSummary = { broadcast: 0, confirmed: 0, failed: 0, resurfaced: 0 };
    const now = this.now();
    const open = await this.d.store.listBatches({ states: ["building", "pending", "broadcast"], limit: 100 });
    const failedRecent = await this.d.store.listBatches({ states: ["failed"], sinceMs: now - RESURFACE_WATCH_MS, limit: 100 });
    // Releasing payouts of a failed batch is a second step; finish it if a crash came in between.
    for (const b of failedRecent) await this.releasePayouts(b, b.error ?? "batch_failed");
    const needNode = open.some((b) => b.state !== "building") || failedRecent.some((b) => b.sendAttemptedAtMs !== null);
    let txs: ChainTransaction[] = [];
    if (needNode) txs = await this.chainTxs();

    for (const b of open) {
      if (b.state === "building") {
        if (await this.fail(b, "interrupted while reserving payouts; nothing was sent")) out.failed += 1;
        continue;
      }
      if (b.state === "pending") {
        if (b.sendAttemptedAtMs === null) {
          if (await this.fail(b, "not sent (interrupted before broadcast)")) out.failed += 1;
          continue;
        }
        const tx = findBatchTransaction(b, txs);
        if (tx) {
          if (await this.markBroadcast(b, tx.txid, tx)) out.broadcast += 1;
          continue;
        }
        if (now - b.sendAttemptedAtMs > this.d.config.broadcastGraceMs) {
          if (await this.fail(b, "the node has no transaction for this batch")) out.failed += 1;
        }
        continue;
      }
      // broadcast
      const tx = findBatchTransaction(b, txs);
      if (tx && b.totalFeeSats === null) await this.recordFee(b, tx);
      if (tx && tx.confirmations >= this.d.config.payoutConfirmations) {
        if (await this.confirm({ ...b, totalFeeSats: b.totalFeeSats ?? tx.totalFeesSats }, tx)) out.confirmed += 1;
      } else {
        if (tx && tx.confirmations !== b.confirmations) await this.d.store.updateBatch(b.batchId, ["broadcast"], { confirmations: tx.confirmations });
        if (b.broadcastAtMs !== null && now - b.broadcastAtMs > STUCK_ALERT_MS && b.error === null) {
          await this.d.store.updateBatch(b.batchId, ["broadcast"], { error: tx ? "unconfirmed for over 24 h" : "the node no longer lists this transaction" });
          this.d.onSecurityEvent?.("onchain_batch_stuck", { batchId: b.batchId, txid: b.txid, inWallet: Boolean(tx) });
          this.d.log?.warn({ batchId: b.batchId, txid: b.txid, inWallet: Boolean(tx) }, "onchain_batch_stuck");
        }
      }
    }

    // A released batch whose transaction is in the node after all: its payouts were freed and may be
    // paid again. Stop all payouts for an operator.
    for (const b of failedRecent) {
      if (b.sendAttemptedAtMs === null) continue;
      const tx = findBatchTransaction(b, txs);
      if (!tx || b.error?.startsWith("resurfaced")) continue;
      out.resurfaced += 1;
      await this.d.store.updateBatch(b.batchId, ["failed"], { error: `resurfaced: ${tx.txid} is in the node; payouts paused` });
      this.d.onSecurityEvent?.("onchain_batch_resurfaced", { batchId: b.batchId, txid: tx.txid });
      this.d.log?.warn({ batchId: b.batchId, txid: tx.txid }, "onchain_batch_resurfaced");
      await this.d.pausePayouts?.(`on-chain batch ${b.batchId} was released but its transaction ${tx.txid} is in the node`).catch(() => undefined);
    }
    return out;
  }

  private async build(): Promise<Omit<Extract<BatchRunResult, { batchId: string }>, "advanced"> | Extract<BatchRunResult, { skipped: string }>> {
    const cfg = this.d.config;
    if (!this.d.policy.enabled) return { skipped: "payouts_disabled" };
    if (await this.d.pause?.isPaused()) return { skipped: "payouts_paused" };
    const rate = await this.d.wallet.estimateFeeRate(cfg.payoutTargetConf);
    if (rate > cfg.payoutMaxFeeRateSatVb) {
      this.d.log?.info({ feeRateSatVb: rate, capSatVb: cfg.payoutMaxFeeRateSatVb }, "onchain_batch_fee_above_cap");
      return { skipped: "fee_above_cap", feeRateSatVb: rate };
    }
    const feeCapSats = cfg.payoutFeePayer === "host" ? Math.ceil(rate * ONCHAIN_VBYTES_PER_PAYOUT) : 0;
    const now = this.now();
    const batchId = randomUUID();
    const batch: OnchainBatch = {
      batchId,
      coordinatorId: this.d.coordinatorId,
      state: "building",
      feeRateSatVb: rate,
      feePayer: cfg.payoutFeePayer,
      label: batchLabel(batchId),
      outputs: [],
      txid: null,
      totalFeeSats: null,
      confirmations: 0,
      error: null,
      createdAtMs: now,
      sendAttemptedAtMs: null,
      broadcastAtMs: null,
      confirmedAtMs: null
    };
    const limits = this.d.limits && payoutLimitsActive(this.d.limits) ? this.d.limits : undefined;
    const outputs: BatchOutput[] = [];
    const addresses = new Set<string>();
    let created = false;
    for (const dest of await this.d.store.listOnchainDestinations()) {
      if (addresses.has(dest.address)) continue; // one output per address per batch; the other account goes next time
      if (!validateOnchainPayoutAddress(dest.address, cfg.network).ok) continue;
      const bal = await this.d.payoutService.balance(dest.accountId);
      let amountSats = Math.floor(bal.payableMsat / 1000) - feeCapSats;
      if (limits?.maxSingleSats) amountSats = Math.min(amountSats, limits.maxSingleSats - feeCapSats);
      if (amountSats < cfg.payoutMinSats) continue;
      if (!created) {
        await this.d.store.createBatch(batch);
        created = true;
      }
      const payout: PayoutRecord = {
        payoutId: randomUUID(),
        accountId: dest.accountId,
        coordinatorId: this.d.coordinatorId,
        kind: "onchain",
        bolt11: "",
        paymentHash: "",
        amountMsat: amountSats * 1000,
        feeMsat: 0,
        maxFeeMsat: feeCapSats * 1000,
        status: "pending",
        destination: dest.address,
        batchId,
        createdAtMs: this.now()
      };
      payout.paymentHash = `onchain:${payout.payoutId}`;
      const received = await this.d.payouts.receivedPurchaseMsat();
      const reserved = await this.d.payouts.reservePayout(
        payout,
        (allOut) => payoutCapacityMsat({ receivedMsat: received, paidOrPendingMsat: allOut }, this.d.policy),
        limits ? { sinceMs: payout.createdAtMs - PAYOUT_LIMIT_WINDOW_MS, check: (w) => checkPayoutLimits({ amountMsat: payout.amountMsat, maxFeeMsat: payout.maxFeeMsat, ...w }, limits) } : undefined,
        earningsMaturityCutoffMs(payout.createdAtMs, this.d.payoutService.earningsHoldMs)
      );
      if (!reserved.ok) {
        if ("violation" in reserved) {
          this.d.onSecurityEvent?.("payout_limit_exceeded", { accountId: dest.accountId, kind: "onchain", amountMsat: payout.amountMsat, code: reserved.violation.code, limitSats: reserved.violation.limitSats });
        }
        this.d.log?.info({ accountId: dest.accountId, code: reserved.code }, "onchain_payout_not_reserved");
        continue;
      }
      outputs.push({ payoutId: payout.payoutId, accountId: dest.accountId, address: dest.address, amountSats, feeCapSats });
      addresses.add(dest.address);
    }
    if (!created) return { skipped: "nothing_to_pay" };
    if (outputs.length === 0) {
      await this.fail(batch, "nothing reserved");
      return { batchId, state: "failed", payouts: 0, amountSats: 0, error: "nothing reserved" };
    }
    const amountSats = outputs.reduce((s, o) => s + o.amountSats, 0);
    await this.d.store.updateBatch(batchId, ["building"], { state: "pending", outputs });
    const pending: OnchainBatch = { ...batch, state: "pending", outputs };

    // Last look at the kill switch, then record the attempt, then send.
    if (await this.d.pause?.isPaused()) {
      this.d.onSecurityEvent?.("payout_blocked_paused", { kind: "onchain", batchId, amountSats });
      await this.fail(pending, "payouts_paused");
      return { batchId, state: "failed", payouts: outputs.length, amountSats, error: "payouts_paused" };
    }
    const attemptedAt = this.now();
    if (!(await this.d.store.updateBatch(batchId, ["pending"], { sendAttemptedAtMs: attemptedAt }))) {
      return { batchId, state: "failed", payouts: outputs.length, amountSats, error: "batch changed before send" };
    }
    const sendable: OnchainBatch = { ...pending, sendAttemptedAtMs: attemptedAt };
    let txid: string;
    try {
      txid = (await this.d.wallet.sendMany({ outputs: Object.fromEntries(outputs.map((o) => [o.address, o.amountSats])), satPerVbyte: rate, label: batch.label })).txid;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (sendManyFailureIsFinal(error)) {
        await this.fail(sendable, error);
        this.d.log?.warn({ batchId, error }, "onchain_batch_failed");
        return { batchId, state: "failed", payouts: outputs.length, amountSats, error };
      }
      // Unknown outcome: stays pending; the next runs look for the batch label in the node.
      this.d.log?.warn({ batchId, error }, "onchain_batch_send_unconfirmed");
      return { batchId, state: "pending", payouts: outputs.length, amountSats, error };
    }
    // The fee is read from the node right away when it can be; otherwise on a later run.
    const tx = await this.chainTxs().then((txs) => txs.find((t) => t.txid === txid)).catch(() => undefined);
    await this.markBroadcast(sendable, txid, tx);
    this.d.log?.info({ batchId, txid, payouts: outputs.length, amountSats, feeRateSatVb: rate }, "onchain_batch_broadcast");
    return { batchId, state: "broadcast", payouts: outputs.length, amountSats, txid };
  }

  private async markBroadcast(b: OnchainBatch, txid: string, tx: ChainTransaction | undefined): Promise<boolean> {
    const ok = await this.d.store.updateBatch(b.batchId, ["pending"], { state: "broadcast", txid, broadcastAtMs: this.now(), confirmations: tx?.confirmations ?? 0, error: null });
    if (!ok) return false;
    await this.d.store.setPayoutTxid(b.outputs.map((o) => o.payoutId), txid);
    if (tx) await this.recordFee({ ...b, state: "broadcast", txid }, tx);
    return true;
  }

  /** The actual fee, and EdgeCoder's part of it as a fee-pool spend row (same moment, so solvency stays balanced). */
  private async recordFee(b: OnchainBatch, tx: ChainTransaction): Promise<void> {
    const total = tx.totalFeesSats;
    if (!(await this.d.store.updateBatch(b.batchId, ["broadcast"], { totalFeeSats: total }))) return;
    const { edgecoderSats } = allocateBatchFee(total, b.outputs.map((o) => o.feeCapSats), b.feePayer);
    await this.d.store.recordEdgecoderFee(b.batchId, this.d.feePoolAccountId, edgecoderSats, this.now());
  }

  private async confirm(b: OnchainBatch, tx: ChainTransaction): Promise<boolean> {
    const total = b.totalFeeSats ?? tx.totalFeesSats;
    const { sharesSats } = allocateBatchFee(total, b.outputs.map((o) => o.feeCapSats), b.feePayer);
    const rows = new Map((await this.d.store.payoutsInBatch(b.batchId)).map((p) => [p.payoutId, p]));
    for (let i = 0; i < b.outputs.length; i++) {
      const o = b.outputs[i];
      const row = rows.get(o.payoutId);
      if (!row || row.status !== "pending") continue;
      await this.d.payouts.settlePayout(o.payoutId, { status: "paid", feeMsat: sharesSats[i] * 1000 });
      await this.d.onPaid?.({ ...row, status: "paid", feeMsat: sharesSats[i] * 1000, txid: tx.txid, settledAtMs: this.now() }).catch(() => undefined);
    }
    return this.d.store.updateBatch(b.batchId, ["broadcast"], { state: "confirmed", confirmations: tx.confirmations, confirmedAtMs: this.now(), totalFeeSats: total, error: null });
  }

  /** Fail a batch that was never sent and give its payouts back (state first, so it is never sent afterwards). */
  private async fail(b: OnchainBatch, error: string): Promise<boolean> {
    const ok = await this.d.store.updateBatch(b.batchId, ["building", "pending"], { state: "failed", error: error.slice(0, 500) });
    if (ok) await this.releasePayouts(b, error);
    return ok;
  }

  private async releasePayouts(b: Pick<OnchainBatch, "batchId">, error: string): Promise<void> {
    for (const p of await this.d.store.payoutsInBatch(b.batchId)) {
      if (p.status === "pending") await this.d.payouts.settlePayout(p.payoutId, { status: "failed", error: `onchain_batch_failed: ${error}`.slice(0, 500) });
    }
  }

  /** For the reconciler: a batch whose send outcome is not yet known makes the node balance unreadable for a moment. */
  async inFlight(): Promise<boolean> {
    const open = await this.d.store.listBatches({ states: ["pending", "broadcast"], limit: 100 });
    return open.some((b) => (b.state === "pending" && b.sendAttemptedAtMs !== null) || (b.state === "broadcast" && b.totalFeeSats === null));
  }
}

/** A batch as an operator sees it (GET /admin/onchain/batches). */
export function batchView(b: OnchainBatch) {
  return {
    batchId: b.batchId,
    state: b.state,
    txid: b.txid,
    payouts: b.outputs.length,
    amountSats: b.outputs.reduce((s, o) => s + o.amountSats, 0),
    feeRateSatVb: b.feeRateSatVb,
    feePayer: b.feePayer,
    totalFeeSats: b.totalFeeSats,
    confirmations: b.confirmations,
    error: b.error,
    createdAtMs: b.createdAtMs,
    broadcastAtMs: b.broadcastAtMs,
    confirmedAtMs: b.confirmedAtMs
  };
}
