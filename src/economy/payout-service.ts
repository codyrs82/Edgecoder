// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import type { CreditTransaction, InfrastructureHost, PayoutRecord } from "../common/types.js";
import type { LightningProvider } from "./lightning.js";
import { PAYOUT_LIMIT_WINDOW_MS, checkPayoutLimits, payoutLimitsActive, type PayoutLimitCode, type PayoutLimits, type PayoutLimitViolation, type PayoutPauseControl, type PayoutPauseState, type PayoutPauseStore } from "./payout-safeguards.js";
import type { ReconcileLedger } from "./payout-reconcile.js";
import {
  distributeFeePool,
  payableMsat,
  payoutCapacityMsat,
  preimageMatches,
  requestLnurlInvoice,
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

export interface PayoutStore extends ReconcileLedger, PayoutPauseStore {
  earnedMsat(accountId: string): Promise<number>;
  receivedPurchaseMsat(): Promise<number>;
  payoutsTotalMsat(filter: { accountId?: string; statuses: Array<PayoutRecord["status"]> }): Promise<number>;
  /**
   * Insert the pending row if payable, capacity and (when given) the 24 h caps all hold. Postgres
   * serialises every reservation under one advisory lock so the global cap and capacity are exact.
   */
  reservePayout(payout: PayoutRecord, capacityMsat: (paidOrPendingAllMsat: number) => number, limits?: ReservationLimits): Promise<ReserveResult>;
  settlePayout(payoutId: string, outcome: { status: "paid"; feeMsat: number; preimage?: string } | { status: "failed"; error: string }): Promise<void>;
  listPayouts(accountId: string, limit?: number): Promise<PayoutRecord[]>;
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
  constructor(private readonly earned: (accountId: string) => number) {}
  async earnedMsat(accountId: string): Promise<number> {
    return this.earned(accountId) + this.rows.filter((r) => r.accountId === accountId && r.type === "earn").reduce((s, r) => s + (r.msat ?? 0), 0);
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
  async reservePayout(payout: PayoutRecord, capacityMsat: (all: number) => number, limits?: ReservationLimits): Promise<ReserveResult> {
    if ([...this.payouts.values()].some((p) => p.paymentHash === payout.paymentHash)) return { ok: false as const, code: "duplicate_invoice" as const };
    const payable = payableMsat(await this.earnedMsat(payout.accountId), await this.payoutsTotalMsat({ accountId: payout.accountId, statuses: ["paid", "pending"] }));
    if (payout.amountMsat > payable) return { ok: false as const, code: "insufficient_payable" as const, payableMsat: payable };
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
    return { ok: true as const };
  }
  async settlePayout(payoutId: string, outcome: { status: "paid"; feeMsat: number; preimage?: string } | { status: "failed"; error: string }) {
    const p = this.payouts.get(payoutId);
    if (!p || p.status !== "pending") return;
    if (outcome.status === "paid") Object.assign(p, { status: "paid", feeMsat: outcome.feeMsat, preimage: outcome.preimage, settledAtMs: Date.now() });
    else Object.assign(p, { status: "failed", error: outcome.error, settledAtMs: Date.now() });
  }
  async listPayouts(accountId: string, limit = 50) {
    return [...this.payouts.values()].filter((p) => p.accountId === accountId).sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, limit);
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
    return this.rows.filter((r) => r.accountId === accountId).reduce((s, r) => s + (r.type === "spend" ? -r.credits : r.credits), 0);
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
  /** Security events (cap hits, payments refused while paused). */
  onSecurityEvent?: (event: "payout_limit_exceeded" | "payout_blocked_paused", details: Record<string, unknown>) => void;
}

export type FeePoolDistribution = {
  distributedMsat: number;
  hosts: Array<{ hostId: string; accountId: string; weight: number; msat: number }>;
  /** Why nothing ran: another instance holds the lock, the window was distributed recently, or payouts are paused. */
  skipped?: "locked" | "recent" | "payouts_paused";
};

export type PayoutResult =
  | { ok: true; payout: PayoutRecord }
  | { ok: false; code: string; detail?: string; payableMsat?: number };

export class PayoutService {
  private readonly inflight = new Set<string>();
  constructor(private readonly d: PayoutServiceDeps) {}

  async balance(accountId: string): Promise<{ earnedMsat: number; paidMsat: number; pendingMsat: number; payableMsat: number; capacityMsat: number }> {
    const [earned, paid, pending, received, allOut] = await Promise.all([
      this.d.store.earnedMsat(accountId),
      this.d.store.payoutsTotalMsat({ accountId, statuses: ["paid"] }),
      this.d.store.payoutsTotalMsat({ accountId, statuses: ["pending"] }),
      this.d.store.receivedPurchaseMsat(),
      this.d.store.payoutsTotalMsat({ statuses: ["paid", "pending"] })
    ]);
    return {
      earnedMsat: earned,
      paidMsat: paid,
      pendingMsat: pending,
      payableMsat: payableMsat(earned, paid + pending),
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
      limits ? { sinceMs: now() - PAYOUT_LIMIT_WINDOW_MS, check: (w) => checkPayoutLimits({ amountMsat: v.amountMsat, maxFeeMsat: v.maxFeeMsat, ...w }, limits) } : undefined
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
        // Transport errors may leave an in-flight HTLC; the row stays pending for reconciliation.
        const transport = /transport/.test(res.error ?? "");
        if (!transport) await this.d.store.settlePayout(payout.payoutId, { status: "failed", error: res.error ?? "pay_failed" });
        this.d.log?.warn({ accountId, payoutId: payout.payoutId, error: res.error, transport }, "payout_failed");
        return { ok: false, code: transport ? "payout_unconfirmed" : "payout_failed", detail: res.error };
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
      try {
        const { bolt11 } = await requestLnurlInvoice(lightningAddress, amount, fetcher, this.d.policy.network);
        out.push({ accountId, result: await this.withdraw(accountId, bolt11, "auto", lightningAddress) });
      } catch (err) {
        out.push({ accountId, result: { ok: false, code: "lnurl_failed", detail: err instanceof Error ? err.message : String(err) } });
      }
    }
    return out;
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
    const [poolCredits, poolMsat] = await Promise.all([this.d.store.creditBalance(this.d.feePoolAccountId), this.d.store.earnedMsat(this.d.feePoolAccountId)]);
    const alreadyOut = this.d.poolDistributedMsat ? this.d.poolDistributedMsat() : await this.d.store.distributedMsat(this.d.feePoolAccountId);
    const availableMsat = Math.max(0, Math.floor(poolMsat) - alreadyOut);
    const hosts = await this.d.store.listInfrastructureHosts();
    const shares = distributeFeePool(availableMsat, hosts, expectedHeartbeats);
    const totalMsat = shares.reduce((s, h) => s + h.msat, 0);
    if (shares.length === 0 || totalMsat <= 0) return { distributedMsat: 0, hosts: [] };
    // Purchase fees arrive as sats without credits; accrual fees carry both. Credits follow the sats pro rata.
    const creditsPerMsat = poolCredits > 0 ? poolCredits / Math.max(1, availableMsat) : 0;
    const ts = now();
    const rows: CreditTransaction[] = [];
    rows.push({ txId: randomUUID(), accountId: this.d.feePoolAccountId, type: "spend", credits: Number((totalMsat * creditsPerMsat).toFixed(6)), reason: `fee_pool_distribution:${ts}`, timestampMs: ts, msat: totalMsat });
    for (const h of shares) {
      rows.push({ txId: randomUUID(), accountId: h.accountId, type: "earn", credits: Number((h.msat * creditsPerMsat).toFixed(6)), reason: `fee_pool_distribution:${ts}:${h.hostId}`, timestampMs: ts, msat: h.msat });
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
