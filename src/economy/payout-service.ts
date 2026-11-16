// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import type { CreditTransaction, InfrastructureHost, PayoutRecord } from "../common/types.js";
import { payFailureIsFinal, type LightningProvider, type NodePayment } from "./lightning.js";
import { PAYOUT_LIMIT_WINDOW_MS, checkPayoutLimits, payoutLimitsActive, type PayoutLimitCode, type PayoutLimits, type PayoutLimitViolation, type PayoutPauseControl, type PayoutPauseState, type PayoutPauseStore } from "./payout-safeguards.js";
import type { ReconcileLedger } from "./payout-reconcile.js";
import { callbackOrigin, checkCallbackPin, type CallbackPinStore, type PinCheck } from "./lnurl-callback-pin.js";
import {
  creditsToMsat,
  distributeFeePool,
  earningsMaturityCutoffMs,
  earnRowMatured,
  msatToCredits,
  payoutCapacityMsat,
  payoutDebitTxId,
  payoutFeeExcessTxId,
  payoutRefundTxId,
  payoutSettlementRefundMsat,
  preimageMatches,
  withdrawableMsat,
  requestLnurlInvoice,
  resolveLnurlCallback,
  validatePayoutRequest,
  type JsonFetcher,
  type PayoutPolicy
} from "./payouts.js";

/**
 * Turns earned msat into Lightning payments, and the network fee pool into host earnings.
 *
 * Storage is injected so the same flow runs on Postgres (atomic reservation under a per-account
 * lock) or in memory (dev, tests). The provider is the coordinator's Lightning node; its
 * `payInvoice` is the only thing that moves sats.
 */
/** Rolling-window cap check run inside the reservation (under the store's lock). */
export interface ReservationLimits {
  sinceMs: number;
  check: (window: { accountWindowMsat: number; globalWindowMsat: number }) => PayoutLimitViolation | null;
}

export type ReserveResult =
  | { ok: true }
  | { ok: false; code: "insufficient_payable" | "coordinator_capacity" | "duplicate_invoice"; payableMsat?: number }
  | { ok: false; code: PayoutLimitCode; violation: PayoutLimitViolation };

export type FeePoolLockResult<T> = { acquired: true; value: T } | { acquired: false };

/** An account's earnings split by the earnings hold (see earningsMaturityCutoffMs). */
export interface EarningsSummary {
  /** Every earn row's msat (matured or not). */
  totalMsat: number;
  /** Earn rows at or before the cutoff: the only earnings payable counts. */
  maturedMsat: number;
  /** Timestamp of the oldest earn row (with msat) still held, or null when none is held or unknown. */
  oldestHeldAtMs: number | null;
}

export interface PayoutStore extends ReconcileLedger, PayoutPauseStore {
  /** msat on the account's earn rows; with a cutoff, only rows matured at it (timestamp <= cutoff). */
  earnedMsat(accountId: string, maturedAtOrBeforeMs?: number): Promise<number>;
  /** Total and matured earnings in one read (balance reporting). */
  earnings(accountId: string, maturedAtOrBeforeMs: number | undefined): Promise<EarningsSummary>;
  receivedPurchaseMsat(): Promise<number>;
  payoutsTotalMsat(filter: { accountId?: string; statuses: Array<PayoutRecord["status"]> }): Promise<number>;
  /**
   * Insert the pending row if payable, capacity and (when given) the 24 h caps all hold. Postgres
   * serialises every reservation under one advisory lock so the global cap and capacity are exact.
   * `maturedAtOrBeforeMs`: payable counts only earn rows matured at this cutoff (earnings hold);
   * undefined = no hold.
   */
  reservePayout(
    payout: PayoutRecord,
    capacityMsat: (paidOrPendingAllMsat: number) => number,
    limits?: ReservationLimits,
    maturedAtOrBeforeMs?: number
  ): Promise<ReserveResult>;
  settlePayout(payoutId: string, outcome: { status: "paid"; feeMsat: number; preimage?: string } | { status: "failed"; error: string }): Promise<void>;
  listPayouts(accountId: string, limit?: number): Promise<PayoutRecord[]>;
  /** Payout rows still `pending`, oldest first. */
  listPendingPayouts(limit?: number): Promise<PayoutRecord[]>;
  listAutoPayoutAccounts(): Promise<Array<{ accountId: string; lightningAddress: string }>>;
  listInfrastructureHosts(): Promise<InfrastructureHost[]>;
  resetHostHeartbeatWindow(): Promise<void>;
  /** Fee-pool distribution rows: a spend on the pool and an earn (with msat) on each host account. */
  recordCreditTransactions(rows: CreditTransaction[]): Promise<void>;
  creditBalance(accountId: string): Promise<number>;
  /** msat already moved out of an account by spend rows (the pool's past distributions). */
  distributedMsat(accountId: string): Promise<number>;
  /**
   * Run `fn` holding the fee-pool lock, or return `acquired: false` at once if another holder has it.
   * Postgres: a session advisory lock, so two coordinators sharing a database never distribute together.
   */
  withFeePoolLock<T>(fn: () => Promise<T>): Promise<FeePoolLockResult<T>>;
  /** Time of the pool's most recent distribution (its newest spend row), or null. */
  lastPoolDistributionMs(accountId: string): Promise<number | null>;
}

/** msat a payout row has or may still move: pending rows count at their fee cap. */
function rowOutflowMsat(p: Pick<PayoutRecord, "status" | "amountMsat" | "feeMsat" | "maxFeeMsat">): number {
  return p.amountMsat + (p.status === "pending" ? Math.max(p.feeMsat, p.maxFeeMsat) : p.feeMsat);
}

/** In-memory store for dev and tests; same semantics, no durability. */
export class MemoryPayoutStore implements PayoutStore {
  readonly payouts = new Map<string, PayoutRecord>();
  readonly hosts = new Map<string, InfrastructureHost>();
  readonly autoAccounts = new Map<string, string>();
  readonly rows: CreditTransaction[] = [];
  received = 0;
  private reserving: Promise<unknown> = Promise.resolve();
  /**
   * `earned`: msat earned outside this store's rows; given a cutoff it should count only earnings
   * matured at it (a callback that ignores it applies no hold to those earnings). `credits`: credit
   * balance held outside the rows (added to the rows' balance); a subclass may override creditBalance instead.
   */
  constructor(
    private readonly earned: (accountId: string, maturedAtOrBeforeMs?: number) => number,
    private readonly credits: (accountId: string) => number = () => 0
  ) {}
  private earnRows(accountId: string): CreditTransaction[] {
    return this.rows.filter((r) => r.accountId === accountId && r.type === "earn");
  }
  async earnedMsat(accountId: string, maturedAtOrBeforeMs?: number): Promise<number> {
    const own = this.earnRows(accountId).filter((r) => earnRowMatured(r.timestampMs, maturedAtOrBeforeMs)).reduce((s, r) => s + (r.msat ?? 0), 0);
    return this.earned(accountId, maturedAtOrBeforeMs) + own;
  }
  async earnings(accountId: string, maturedAtOrBeforeMs: number | undefined): Promise<EarningsSummary> {
    const held = this.earnRows(accountId).filter((r) => (r.msat ?? 0) > 0 && !earnRowMatured(r.timestampMs, maturedAtOrBeforeMs));
    return {
      totalMsat: await this.earnedMsat(accountId),
      maturedMsat: await this.earnedMsat(accountId, maturedAtOrBeforeMs),
      oldestHeldAtMs: held.length ? Math.min(...held.map((r) => r.timestampMs)) : null
    };
  }
  async receivedPurchaseMsat(): Promise<number> {
    return this.received;
  }
  async payoutsTotalMsat(filter: { accountId?: string; statuses: Array<PayoutRecord["status"]> }): Promise<number> {
    let sum = 0;
    for (const p of this.payouts.values()) if (filter.statuses.includes(p.status) && (!filter.accountId || p.accountId === filter.accountId)) sum += p.amountMsat + p.feeMsat;
    return sum;
  }
  private pause: PayoutPauseState | null = null;
  private poolLock = false;
  /** One reservation at a time in this process (the reads below are async). */
  reservePayout(payout: PayoutRecord, capacityMsat: (all: number) => number, limits?: ReservationLimits, maturedAtOrBeforeMs?: number): Promise<ReserveResult> {
    const run = this.reserving.then(() => this.reserveLocked(payout, capacityMsat, limits, maturedAtOrBeforeMs));
    this.reserving = run.catch(() => undefined);
    return run;
  }
  private async reserveLocked(payout: PayoutRecord, capacityMsat: (all: number) => number, limits?: ReservationLimits, maturedAtOrBeforeMs?: number): Promise<ReserveResult> {
    if ([...this.payouts.values()].some((p) => p.paymentHash === payout.paymentHash)) return { ok: false as const, code: "duplicate_invoice" as const };
    const accountOut = [...this.payouts.values()].filter((p) => p.accountId === payout.accountId && (p.status === "paid" || p.status === "pending")).reduce((s, p) => s + rowOutflowMsat(p), 0);
    const payable = withdrawableMsat(await this.earnedMsat(payout.accountId, maturedAtOrBeforeMs), accountOut, await this.creditBalance(payout.accountId));
    if (payout.amountMsat + payout.maxFeeMsat > payable) return { ok: false as const, code: "insufficient_payable" as const, payableMsat: payable };
    if (payout.amountMsat + payout.maxFeeMsat > capacityMsat(await this.payoutsTotalMsat({ statuses: ["paid", "pending"] }))) return { ok: false as const, code: "coordinator_capacity" as const };
    if (limits) {
      // Synchronous from here to the insert, so concurrent in-process reservations cannot both pass.
      const recent = [...this.payouts.values()].filter((p) => (p.status === "paid" || p.status === "pending") && p.createdAtMs >= limits.sinceMs);
      const violation = limits.check({
        accountWindowMsat: recent.filter((p) => p.accountId === payout.accountId).reduce((s, p) => s + rowOutflowMsat(p), 0),
        globalWindowMsat: recent.reduce((s, p) => s + rowOutflowMsat(p), 0)
      });
      if (violation) return { ok: false as const, code: violation.code, violation };
    }
    this.payouts.set(payout.payoutId, { ...payout, status: "pending" });
    const debit = payoutDebitTxId(payout.payoutId);
    this.rows.push({ txId: debit, accountId: payout.accountId, type: "spend", credits: msatToCredits(payout.amountMsat + payout.maxFeeMsat), reason: debit, timestampMs: payout.createdAtMs });
    return { ok: true as const };
  }
  async settlePayout(payoutId: string, outcome: { status: "paid"; feeMsat: number; preimage?: string } | { status: "failed"; error: string }) {
    const p = this.payouts.get(payoutId);
    if (!p || p.status !== "pending") return;
    const now = Date.now();
    if (outcome.status === "paid") Object.assign(p, { status: "paid", feeMsat: Math.max(0, Math.floor(outcome.feeMsat)), preimage: outcome.preimage, settledAtMs: now });
    else Object.assign(p, { status: "failed", error: outcome.error, settledAtMs: now });
    const debit = this.rows.find((r) => r.txId === payoutDebitTxId(payoutId));
    if (!debit) return;
    const back = payoutSettlementRefundMsat(creditsToMsat(debit.credits), outcome.status === "paid" ? { status: "paid", amountMsat: p.amountMsat, feeMsat: p.feeMsat } : { status: "failed" });
    if (back === 0) return;
    const txId = back > 0 ? payoutRefundTxId(payoutId) : payoutFeeExcessTxId(payoutId);
    if (this.rows.some((r) => r.txId === txId)) return;
    this.rows.push({ txId, accountId: p.accountId, type: back > 0 ? "earn" : "spend", credits: msatToCredits(Math.abs(back)), reason: txId, timestampMs: now });
  }
  async listPayouts(accountId: string, limit = 50) {
    return [...this.payouts.values()].filter((p) => p.accountId === accountId).sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, limit);
  }
  async listPendingPayouts(limit = 100) {
    return [...this.payouts.values()].filter((p) => p.status === "pending").sort((a, b) => a.createdAtMs - b.createdAtMs).slice(0, limit);
  }
  async listAutoPayoutAccounts() {
    return [...this.autoAccounts.entries()].map(([accountId, lightningAddress]) => ({ accountId, lightningAddress }));
  }
  async listInfrastructureHosts() {
    return [...this.hosts.values()];
  }
  async resetHostHeartbeatWindow() {
    for (const h of this.hosts.values()) h.heartbeatsInWindow = 0;
  }
  async recordCreditTransactions(rows: CreditTransaction[]) {
    this.rows.push(...rows);
  }
  async creditBalance(accountId: string) {
    return this.credits(accountId) + this.rows.filter((r) => r.accountId === accountId).reduce((s, r) => s + (r.type === "spend" ? -r.credits : r.credits), 0);
  }
  async distributedMsat(accountId: string) {
    return this.rows.filter((r) => r.accountId === accountId && r.type === "spend").reduce((s, r) => s + (r.msat ?? 0), 0);
  }
  /** In-process only (no database to share): a second caller is turned away while one runs. */
  async withFeePoolLock<T>(fn: () => Promise<T>): Promise<FeePoolLockResult<T>> {
    if (this.poolLock) return { acquired: false };
    this.poolLock = true;
    try {
      return { acquired: true, value: await fn() };
    } finally {
      this.poolLock = false;
    }
  }
  async lastPoolDistributionMs(accountId: string) {
    const ts = this.rows.filter((r) => r.accountId === accountId && r.type === "spend" && r.reason.startsWith("fee_pool_distribution")).map((r) => r.timestampMs);
    return ts.length ? Math.max(...ts) : null;
  }
  async payoutsByPaymentHash(hashes: string[]) {
    const want = new Set(hashes.map((h) => h.toLowerCase()));
    const out = new Map<string, PayoutRecord>();
    for (const p of this.payouts.values()) if (want.has(p.paymentHash.toLowerCase())) out.set(p.paymentHash.toLowerCase(), p);
    return out;
  }
  async payoutsOutflowMsat() {
    let sum = 0;
    for (const p of this.payouts.values()) if (p.status === "paid" || p.status === "pending") sum += rowOutflowMsat(p);
    return sum;
  }
  /** Earn msat on this store's rows minus pool spends and paid/pending payouts. Engine-held earnings are not visible here. */
  async liabilitiesMsat(): Promise<number | undefined> {
    const earned = this.rows.reduce((s, r) => s + (r.type === "earn" ? (r.msat ?? 0) : -(r.msat ?? 0)), 0);
    return Math.max(0, earned - (await this.payoutsTotalMsat({ statuses: ["paid", "pending"] })));
  }
  async getPayoutPause() {
    return this.pause ? { ...this.pause } : null;
  }
  async setPayoutPause(state: PayoutPauseState) {
    this.pause = { ...state };
  }
}

export interface PayoutServiceDeps {
  store: PayoutStore;
  provider: LightningProvider;
  policy: PayoutPolicy;
  coordinatorId: string;
  feePoolAccountId: string;
  fetcher?: JsonFetcher;
  /** Called after a payout settles (ledger append). */
  onPaid?: (payout: PayoutRecord) => Promise<void>;
  onDistributed?: (rows: CreditTransaction[], hosts: Array<{ hostId: string; accountId: string; weight: number; msat: number }>) => Promise<void>;
  log?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
  now?: () => number;
  /** Hot-wallet caps (payout-safeguards.ts); omitted = none. */
  limits?: PayoutLimits;
  /** Kill switch; when paused nothing leaves the node and the fee pool is not distributed. */
  pause?: PayoutPauseControl;
  /** Security events (cap hits, payments refused while paused, a changed LNURL callback host). */
  onSecurityEvent?: (event: "payout_limit_exceeded" | "payout_blocked_paused" | "payout_callback_changed", details: Record<string, unknown>) => void;
  /** LNURL callback pins (lnurl-callback-pin.ts); omitted = no pinning. */
  pins?: CallbackPinStore;
  /**
   * Tell the owner a destination's callback host changed. Called once per change (the claim is
   * atomic across seeds); return false (or throw) when delivery failed so the next cycle retries.
   */
  onCallbackChanged?: (info: { accountId: string; destination: string; previousOrigin: string; newOrigin: string }) => Promise<boolean>;
}

export type CallbackChangedResult = { ok: false; code: "callback_changed"; detail: string; previousOrigin: string; newOrigin: string };

/** What resolvePendingPayouts did with one pending row (see there). */
export type PendingResolution = {
  payoutId: string;
  accountId: string;
  paymentHash: string;
  outcome: "paid" | "failed" | "in_flight" | "unknown" | "mismatch";
  reason?: string;
};

/** Pending rows younger than this are left alone: their payment may still be running in some process. */
export const PENDING_RESOLVE_MIN_AGE_MS = 10 * 60_000;
/** A pending row the node has no payment for is failed only after this long (it was never sent). */
export const PENDING_NOT_SENT_AFTER_MS = 30 * 60_000;

export type FeePoolDistribution = {
  distributedMsat: number;
  hosts: Array<{ hostId: string; accountId: string; weight: number; msat: number }>;
  /** Why nothing ran: another instance holds the lock, the window was distributed recently, or payouts are paused. */
  skipped?: "locked" | "recent" | "payouts_paused" | "disabled";
};

export type PayoutResult =
  | { ok: true; payout: PayoutRecord }
  | { ok: false; code: string; detail?: string; payableMsat?: number };

export interface PayoutBalance {
  earnedMsat: number;
  heldMsat: number;
  maturesAtMs: number | null;
  paidMsat: number;
  pendingMsat: number;
  payableMsat: number;
  capacityMsat: number;
}

export class PayoutService {
  private readonly inflight = new Set<string>();
  constructor(private readonly d: PayoutServiceDeps) {}

  /** The earnings hold in force (policy.earningsHoldMs; 0 = none). */
  get earningsHoldMs(): number {
    return Math.max(0, this.d.policy.earningsHoldMs ?? 0);
  }

  /**
   * Balance as shown to the account (GET /economy/payouts/:accountId):
   * - earnedMsat: every sat ever earned (matured or still held), unchanged meaning;
   * - heldMsat: earned but still inside the earnings hold, not yet payable;
   * - maturesAtMs: when the oldest held earning becomes payable (null when nothing is held);
   * - paidMsat / pendingMsat: payouts paid / in flight (amount + fee);
   * - payableMsat: matured earnings − paid − pending, capped at the credit balance;
   * - capacityMsat: what the coordinator can still pay out in total.
   */
  async balance(accountId: string): Promise<PayoutBalance> {
    const hold = this.earningsHoldMs;
    const cutoff = earningsMaturityCutoffMs((this.d.now ?? Date.now)(), hold);
    const [earnings, paid, pending, received, allOut, credits] = await Promise.all([
      this.d.store.earnings(accountId, cutoff),
      this.d.store.payoutsTotalMsat({ accountId, statuses: ["paid"] }),
      this.d.store.payoutsTotalMsat({ accountId, statuses: ["pending"] }),
      this.d.store.receivedPurchaseMsat(),
      this.d.store.payoutsTotalMsat({ statuses: ["paid", "pending"] }),
      this.d.store.creditBalance(accountId)
    ]);
    return {
      earnedMsat: earnings.totalMsat,
      heldMsat: Math.max(0, earnings.totalMsat - earnings.maturedMsat),
      maturesAtMs: earnings.oldestHeldAtMs === null ? null : earnings.oldestHeldAtMs + hold,
      paidMsat: paid,
      pendingMsat: pending,
      // Only matured earnings, and never more than the credit balance: earnings already spent as
      // cSats are not withdrawable.
      payableMsat: withdrawableMsat(earnings.maturedMsat, paid + pending, credits),
      capacityMsat: payoutCapacityMsat({ receivedMsat: received, paidOrPendingMsat: allOut }, this.d.policy)
    };
  }

  /** Pay `bolt11` from the account's payable balance. Idempotent per invoice (payment hash). */
  async withdraw(accountId: string, bolt11: string, kind: PayoutRecord["kind"] = "withdraw", destination?: string): Promise<PayoutResult> {
    const now = this.d.now ?? Date.now;
    const bal = await this.balance(accountId);
    const v = validatePayoutRequest({ bolt11, payableMsat: bal.payableMsat, capacityMsat: bal.capacityMsat, nowMs: now() }, this.d.policy);
    if (!v.ok) return { ok: false, code: v.code, detail: v.detail, payableMsat: bal.payableMsat };
    if (this.inflight.has(v.decoded.paymentHash)) return { ok: false, code: "payout_in_progress" };
    if (await this.d.pause?.isPaused()) {
      this.d.onSecurityEvent?.("payout_blocked_paused", { accountId, kind, amountMsat: v.amountMsat });
      return { ok: false, code: "payouts_paused" };
    }
    const limits = this.d.limits && payoutLimitsActive(this.d.limits) ? this.d.limits : undefined;
    const single = limits ? checkPayoutLimits({ amountMsat: v.amountMsat, maxFeeMsat: v.maxFeeMsat }, limits) : null;
    if (single) return this.limitRejected(accountId, kind, v.amountMsat, single);
    const payout: PayoutRecord = {
      payoutId: randomUUID(),
      accountId,
      coordinatorId: this.d.coordinatorId,
      kind,
      bolt11,
      paymentHash: v.decoded.paymentHash,
      amountMsat: v.amountMsat,
      feeMsat: 0,
      maxFeeMsat: v.maxFeeMsat,
      status: "pending",
      destination,
      createdAtMs: now()
    };
    const received = await this.d.store.receivedPurchaseMsat();
    const reserved = await this.d.store.reservePayout(
      payout,
      (allOut) => payoutCapacityMsat({ receivedMsat: received, paidOrPendingMsat: allOut }, this.d.policy),
      limits ? { sinceMs: now() - PAYOUT_LIMIT_WINDOW_MS, check: (w) => checkPayoutLimits({ amountMsat: v.amountMsat, maxFeeMsat: v.maxFeeMsat, ...w }, limits) } : undefined,
      // Rechecked under the store's lock with the same maturity rule the balance used.
      earningsMaturityCutoffMs(payout.createdAtMs, this.earningsHoldMs)
    );
    if (!reserved.ok) {
      if ("violation" in reserved) return this.limitRejected(accountId, kind, v.amountMsat, reserved.violation);
      return { ok: false, code: reserved.code, payableMsat: reserved.payableMsat };
    }
    this.inflight.add(payout.paymentHash);
    try {
      // Last look at the kill switch right before money moves (a pause may have landed meanwhile).
      if (await this.d.pause?.isPaused()) {
        await this.d.store.settlePayout(payout.payoutId, { status: "failed", error: "payouts_paused" });
        this.d.onSecurityEvent?.("payout_blocked_paused", { accountId, kind, payoutId: payout.payoutId, amountMsat: payout.amountMsat });
        return { ok: false, code: "payouts_paused" };
      }
      const res = await this.d.provider.payInvoice({ bolt11, maxFeeSats: Math.ceil(v.maxFeeMsat / 1000), timeoutSeconds: 60 });
      if (res.status !== "succeeded") {
        // Only a failure the node reported as final frees the balance. Anything else may leave an
        // HTLC in flight, so the row (and its credit debit) stays pending for reconciliation.
        const final = payFailureIsFinal(res.error);
        if (final) await this.d.store.settlePayout(payout.payoutId, { status: "failed", error: res.error ?? "pay_failed" });
        this.d.log?.warn({ accountId, payoutId: payout.payoutId, error: res.error, final }, "payout_failed");
        return { ok: false, code: final ? "payout_failed" : "payout_unconfirmed", detail: res.error };
      }
      if (res.paymentHash && res.paymentHash.toLowerCase() !== payout.paymentHash.toLowerCase()) {
        this.d.log?.warn({ payoutId: payout.payoutId, nodePaymentHash: res.paymentHash }, "payout_hash_mismatch");
        return { ok: false, code: "payout_unconfirmed", detail: "node paid a different payment hash than the invoice's; left pending for reconciliation" };
      }
      if (res.preimage && !preimageMatches(payout.paymentHash, res.preimage)) {
        this.d.log?.warn({ payoutId: payout.payoutId }, "payout_preimage_mismatch");
        return { ok: false, code: "payout_unconfirmed", detail: "preimage does not match the invoice hash; left pending for reconciliation" };
      }
      const paid: PayoutRecord = { ...payout, status: "paid", feeMsat: Math.max(0, Math.floor(res.feeMsat ?? 0)), preimage: res.preimage, settledAtMs: now() };
      await this.d.store.settlePayout(payout.payoutId, { status: "paid", feeMsat: paid.feeMsat, preimage: res.preimage });
      await this.d.onPaid?.(paid);
      this.d.log?.info({ accountId, payoutId: payout.payoutId, amountMsat: payout.amountMsat, feeMsat: paid.feeMsat }, "payout_paid");
      return { ok: true, payout: paid };
    } finally {
      this.inflight.delete(payout.paymentHash);
    }
  }

  /**
   * Settle Lightning payouts left `pending` because the coordinator never learned the outcome (transport
   * error, proxy timeout, a payment still in flight past the pay timeout, a restart mid-payment),
   * from the node's own payment record. Nothing is sent here, so it also runs while payouts are paused.
   * - node says succeeded for the row's amount: paid (fee and preimage from the node), onPaid fires;
   * - node says failed: failed, the credit debit comes back and the account can be paid again;
   * - node has the payment in flight, or reports a different amount: left pending (reported);
   * - node has no payment for the hash: failed as `not_sent` once the row is PENDING_NOT_SENT_AFTER_MS
   *   old and the node's list was complete; otherwise left pending.
   * Rows younger than `minAgeMs`, or being paid by this process right now, are skipped. Settling is
   * conditional on the row still being pending, so two coordinators resolving together are harmless.
   */
  async resolvePendingPayouts(opts: { minAgeMs?: number; notSentAfterMs?: number; limit?: number } = {}): Promise<PendingResolution[]> {
    const list = this.d.provider.listPayments;
    if (!list) return [];
    const now = (this.d.now ?? Date.now)();
    const minAge = opts.minAgeMs ?? PENDING_RESOLVE_MIN_AGE_MS;
    const notSentAfter = Math.max(minAge, opts.notSentAfterMs ?? PENDING_NOT_SENT_AFTER_MS);
    // Lightning payouts only: an on-chain payout (kind "onchain", onchain-payouts.ts) is pending
    // while its transaction confirms and has no Lightning payment; its own tracker settles it.
    const pending = (await this.d.store.listPendingPayouts(opts.limit ?? 200)).filter((p) => p.kind !== "onchain" && now - p.createdAtMs >= minAge && !this.inflight.has(p.paymentHash));
    if (pending.length === 0) return [];
    const sinceMs = Math.max(0, Math.min(...pending.map((p) => p.createdAtMs)) - 60 * 60_000);
    const node = await list.call(this.d.provider, { sinceMs, limit: 10_000 });
    if (!node.supported) return [];
    const byHash = new Map<string, NodePayment[]>();
    for (const np of node.payments) {
      const k = np.paymentHash.toLowerCase();
      byHash.set(k, [...(byHash.get(k) ?? []), np]);
    }
    const out: PendingResolution[] = [];
    for (const p of pending) {
      const base = { payoutId: p.payoutId, accountId: p.accountId, paymentHash: p.paymentHash };
      const attempts = byHash.get(p.paymentHash.toLowerCase()) ?? [];
      const ok = attempts.find((a) => a.status === "succeeded");
      if (ok) {
        if (ok.valueMsat !== p.amountMsat || (ok.preimage && !preimageMatches(p.paymentHash, ok.preimage))) {
          this.d.log?.warn({ payoutId: p.payoutId, nodeValueMsat: ok.valueMsat, amountMsat: p.amountMsat }, "payout_resolve_mismatch");
          out.push({ ...base, outcome: "mismatch", reason: `node paid ${ok.valueMsat} msat, row is ${p.amountMsat} msat` });
          continue;
        }
        const feeMsat = Math.max(0, Math.floor(ok.feeMsat));
        await this.d.store.settlePayout(p.payoutId, { status: "paid", feeMsat, preimage: ok.preimage });
        await this.d.onPaid?.({ ...p, status: "paid", feeMsat, preimage: ok.preimage, settledAtMs: now });
        this.d.log?.info({ payoutId: p.payoutId, accountId: p.accountId, amountMsat: p.amountMsat, feeMsat }, "payout_resolved_paid");
        out.push({ ...base, outcome: "paid" });
      } else if (attempts.some((a) => a.status === "in_flight")) {
        out.push({ ...base, outcome: "in_flight" });
      } else if (attempts.length > 0) {
        await this.d.store.settlePayout(p.payoutId, { status: "failed", error: "node_reported_failed" });
        this.d.log?.warn({ payoutId: p.payoutId, accountId: p.accountId }, "payout_resolved_failed");
        out.push({ ...base, outcome: "failed", reason: "node_reported_failed" });
      } else if (!node.truncated && now - p.createdAtMs >= notSentAfter) {
        await this.d.store.settlePayout(p.payoutId, { status: "failed", error: "not_sent" });
        this.d.log?.warn({ payoutId: p.payoutId, accountId: p.accountId }, "payout_resolved_not_sent");
        out.push({ ...base, outcome: "failed", reason: "not_sent" });
      } else {
        out.push({ ...base, outcome: "unknown", reason: node.truncated ? "node payment list truncated" : "no node payment yet" });
      }
    }
    return out;
  }

  private limitRejected(accountId: string, kind: PayoutRecord["kind"], amountMsat: number, v: PayoutLimitViolation): PayoutResult {
    this.d.onSecurityEvent?.("payout_limit_exceeded", { accountId, kind, amountMsat, code: v.code, limitSats: v.limitSats, wouldBeMsat: v.wouldBeMsat });
    this.d.log?.warn({ accountId, kind, amountMsat, code: v.code, limitSats: v.limitSats }, "payout_limit_exceeded");
    return { ok: false, code: v.code, detail: `limit ${v.limitSats} sats (would reach ${Math.ceil(v.wouldBeMsat / 1000)} sats incl. fee cap)` };
  }

  /** Pay every account with a registered Lightning address whose payable balance clears the auto minimum. */
  async runAutoPayouts(): Promise<Array<{ accountId: string; result: PayoutResult | { ok: false; code: string; detail?: string } }>> {
    if (!this.d.policy.enabled) return [];
    if (await this.d.pause?.isPaused()) return [];
    const fetcher = this.d.fetcher;
    if (!fetcher) return [];
    const out: Array<{ accountId: string; result: PayoutResult | { ok: false; code: string; detail?: string } }> = [];
    for (const { accountId, lightningAddress } of await this.d.store.listAutoPayoutAccounts()) {
      const bal = await this.balance(accountId);
      const min = this.d.policy.autoMinPayoutSats * 1000;
      if (bal.payableMsat < min) continue;
      // Leave room for the routing fee cap inside the payable balance.
      const amount = Math.floor((bal.payableMsat * 10_000) / (10_000 + this.d.policy.maxFeeBps)) - this.d.policy.minFeeFloorSats * 1000;
      if (amount < min) continue;
      let refused: PinCheck | null = null;
      try {
        const { bolt11 } = await requestLnurlInvoice(lightningAddress, amount, fetcher, this.d.policy.network, {
          beforeCallback: async (callbackUrl) => {
            const check = await this.checkPin(accountId, lightningAddress, callbackUrl);
            if (check && !check.ok) {
              refused = check;
              throw new Error("callback_changed");
            }
          }
        });
        out.push({ accountId, result: await this.withdraw(accountId, bolt11, "auto", lightningAddress) });
      } catch (err) {
        const r = refused as PinCheck | null;
        if (r && !r.ok) out.push({ accountId, result: await this.callbackChanged(accountId, lightningAddress, r) });
        else out.push({ accountId, result: { ok: false, code: "lnurl_failed", detail: err instanceof Error ? err.message : String(err) } });
      }
    }
    return out;
  }

  private async checkPin(accountId: string, destination: string, callbackUrl: string): Promise<PinCheck | null> {
    if (!this.d.pins) return null;
    return checkCallbackPin(this.d.pins, accountId, destination, callbackOrigin(callbackUrl), (this.d.now ?? Date.now)());
  }

  /** Payout held: nothing is reserved, so the earnings stay payable. Notifies the owner once per change. */
  private async callbackChanged(accountId: string, destination: string, r: Extract<PinCheck, { ok: false }>): Promise<CallbackChangedResult> {
    const { previousOrigin, newOrigin } = r;
    this.d.onSecurityEvent?.("payout_callback_changed", { accountId, destination, previousOrigin, newOrigin });
    this.d.log?.warn({ accountId, destination, previousOrigin, newOrigin }, "payout_callback_changed");
    const pins = this.d.pins;
    if (pins && this.d.onCallbackChanged) {
      const claimed = await pins.claimCallbackNotification(accountId, destination, (this.d.now ?? Date.now)());
      if (claimed) {
        const delivered = await this.d.onCallbackChanged({ accountId, destination, previousOrigin: claimed.origin, newOrigin: claimed.changedOrigin ?? newOrigin }).catch(() => false);
        if (!delivered) await pins.releaseCallbackNotification(accountId, destination);
      }
    }
    return { ok: false, code: "callback_changed", detail: `payment server changed from ${previousOrigin} to ${newOrigin}; held until the owner confirms`, previousOrigin, newOrigin };
  }

  /**
   * Resolve a destination's callback now and pin it (save time). Best effort: a destination that
   * does not resolve is pinned at its first payout instead. A mismatch is recorded and notified.
   */
  async pinDestination(accountId: string, destination: string): Promise<{ ok: true; origin: string; pinned: "new" | "match" } | CallbackChangedResult | { ok: false; code: "not_pinned"; detail: string }> {
    if (!this.d.pins || !this.d.fetcher) return { ok: false, code: "not_pinned", detail: "pinning not configured" };
    let callbackUrl: string;
    try {
      callbackUrl = await resolveLnurlCallback(destination, this.d.fetcher);
    } catch (err) {
      return { ok: false, code: "not_pinned", detail: err instanceof Error ? err.message : String(err) };
    }
    const check = (await this.checkPin(accountId, destination, callbackUrl))!;
    if (!check.ok) return this.callbackChanged(accountId, destination, check);
    return { ok: true, origin: check.pin.origin, pinned: check.pinned };
  }

  /**
   * Move the fee pool's balance to infrastructure hosts by weight (uptime × services). Writes a
   * spend row on the pool and an earn row (credits + msat) per host, then resets the heartbeat
   * window. The pool's msat is pro-rated from its credits so hosts receive sats, not just credits.
   */
  async distributeFeePool(expectedHeartbeats: number, opts: { minIntervalMs?: number } = {}): Promise<FeePoolDistribution> {
    if (await this.d.pause?.isPaused()) return { distributedMsat: 0, hosts: [], skipped: "payouts_paused" };
    const locked = await this.d.store.withFeePoolLock(async (): Promise<FeePoolDistribution> => {
      // Two seeds each run a timer; whichever fires second in a window finds the first one's spend
      // row and skips, so the pool is split once per window instead of twice on half-windows.
      if (opts.minIntervalMs && opts.minIntervalMs > 0) {
        const last = await this.d.store.lastPoolDistributionMs(this.d.feePoolAccountId);
        if (last !== null && (this.d.now ?? Date.now)() - last < opts.minIntervalMs) return { distributedMsat: 0, hosts: [], skipped: "recent" };
      }
      return this.distributeFeePoolLocked(expectedHeartbeats);
    });
    if (!locked.acquired) {
      this.d.log?.info({}, "fee_pool_distribution_skipped_locked");
      return { distributedMsat: 0, hosts: [], skipped: "locked" };
    }
    return locked.value;
  }

  private async distributeFeePoolLocked(expectedHeartbeats: number): Promise<FeePoolDistribution> {
    const now = this.d.now ?? Date.now;
    // No earnings hold on the pool's own intake when distributing: what it pays hosts arrives as
    // host earn rows, which are held like any other earnings before payout. (EdgeCoder withdrawing
    // the pool itself, /admin/revenue/withdraw, goes through withdraw() and so does meet the hold.)
    const poolMsat = await this.d.store.earnedMsat(this.d.feePoolAccountId);
    const alreadyOut = this.d.poolDistributedMsat ? this.d.poolDistributedMsat() : await this.d.store.distributedMsat(this.d.feePoolAccountId);
    // What EdgeCoder withdrew from the pool (paid or in flight) is gone too: never distribute it again.
    const withdrawnMsat = await this.d.store.payoutsTotalMsat({ accountId: this.d.feePoolAccountId, statuses: ["paid", "pending"] });
    const availableMsat = Math.max(0, Math.floor(poolMsat) - alreadyOut - withdrawnMsat);
    const hosts = await this.d.store.listInfrastructureHosts();
    const shares = distributeFeePool(availableMsat, hosts, expectedHeartbeats);
    const totalMsat = shares.reduce((s, h) => s + h.msat, 0);
    if (shares.length === 0 || totalMsat <= 0) return { distributedMsat: 0, hosts: [] };
    // Hosts get cSats equal to the sats they are paid (1 cSat = 1 sat). Withdrawals are capped at the
    // credit balance, so a host paid sats without matching cSats could not withdraw them. Purchase
    // fees reach the pool as sats without cSats, so the pool's own cSat balance may go below zero;
    // its sats (earn msat − spend msat) stay the measure of what it holds.
    const ts = now();
    const rows: CreditTransaction[] = [];
    rows.push({ txId: randomUUID(), accountId: this.d.feePoolAccountId, type: "spend", credits: msatToCredits(totalMsat), reason: `fee_pool_distribution:${ts}`, timestampMs: ts, msat: totalMsat });
    for (const h of shares) {
      rows.push({ txId: randomUUID(), accountId: h.accountId, type: "earn", credits: msatToCredits(h.msat), reason: `fee_pool_distribution:${ts}:${h.hostId}`, timestampMs: ts, msat: h.msat });
    }
    await this.d.store.recordCreditTransactions(rows);
    await this.d.store.resetHostHeartbeatWindow();
    this.d.onPoolDistributed?.(totalMsat);
    await this.d.onDistributed?.(rows, shares);
    this.d.log?.info({ distributedMsat: totalMsat, hosts: shares.length }, "fee_pool_distributed");
    return { distributedMsat: totalMsat, hosts: shares };
  }
}

export interface PayoutServiceDeps {
  /** msat already moved out of the pool by earlier distributions (pool spend rows). */
  poolDistributedMsat?: () => number;
  onPoolDistributed?: (msat: number) => void;
}
