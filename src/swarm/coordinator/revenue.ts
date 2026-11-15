// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * EdgeCoder's revenue, for the admin routes (GET /admin/revenue, POST /admin/revenue/withdraw).
 *
 * The NETWORK_FEE_BPS share of every compute payment is booked to the fee pool account
 * (network:fee_pool). Withdrawing it goes through the same PayoutService as any account's
 * withdrawal, so the hot-wallet caps, the pause switch, the earnings hold, reconciliation, the
 * ledger record of the payout and the security events all apply unchanged.
 */
import { NETWORK_FEE_POOL_ACCOUNT, creditEngine } from "../../credits/store.js";
import { pgStore } from "../../db/store.js";
import { FEE_INCOME_REASON_PREFIX, feeIncomeFromRows, revenueDays, revenueWindowStartMs, type RevenueDay } from "../../economy/revenue.js";
import type { PayoutBalance, PayoutResult } from "../../economy/payout-service.js";
import type { PayoutRecord } from "../../common/types.js";
import { CC, identity, securityLog } from "./context.js";
import { NETWORK_FEE_BPS } from "./economy.js";
import { memoryPayoutStore, payoutLimits, payoutPause, payoutService, payoutStore } from "./payouts.js";

export const REVENUE_DAYS = 30;

export interface RevenueReport {
  accountId: string;
  feeBps: number;
  /** Whether part of the pool is shared with infrastructure hosts (FEE_POOL_HOST_DISTRIBUTION). */
  hostDistribution: boolean;
  /** Fee income ever booked (network_fee rows) and how many payments it came from. */
  feeIncome: { totalMsat: number; payments: number };
  /** The pool as a payout account: earned, still in the earnings hold, payable now, paid, in flight. */
  balance: PayoutBalance;
  /** Moved to infrastructure host accounts (fee pool distribution). */
  distributedToHostsMsat: number;
  earningsHoldMs: number;
  byDay: RevenueDay[];
  payouts: PayoutRecord[];
  payoutsPaused: boolean;
  limits: typeof payoutLimits;
}

async function feeIncome(sinceMs: number) {
  if (pgStore) return pgStore.earnIncome(NETWORK_FEE_POOL_ACCOUNT, FEE_INCOME_REASON_PREFIX, sinceMs);
  // In memory the fee rows are on the credit engine (and any rows the memory payout store holds).
  return feeIncomeFromRows([...creditEngine.history(NETWORK_FEE_POOL_ACCOUNT), ...(memoryPayoutStore?.rows.filter((r) => r.accountId === NETWORK_FEE_POOL_ACCOUNT) ?? [])], sinceMs);
}

export async function revenueReport(nowMs = Date.now()): Promise<RevenueReport> {
  const [income, balance, distributed, payouts, paused] = await Promise.all([
    feeIncome(revenueWindowStartMs(nowMs, REVENUE_DAYS)),
    payoutService.balance(NETWORK_FEE_POOL_ACCOUNT),
    payoutStore.distributedMsat(NETWORK_FEE_POOL_ACCOUNT),
    payoutStore.listPayouts(NETWORK_FEE_POOL_ACCOUNT, 100),
    payoutPause.isPaused()
  ]);
  return {
    accountId: NETWORK_FEE_POOL_ACCOUNT,
    feeBps: NETWORK_FEE_BPS,
    hostDistribution: CC.FEE_POOL_HOST_DISTRIBUTION,
    feeIncome: { totalMsat: income.totalMsat, payments: income.count },
    balance,
    distributedToHostsMsat: distributed,
    earningsHoldMs: payoutService.earningsHoldMs,
    byDay: revenueDays(income.days, nowMs, REVENUE_DAYS),
    payouts,
    payoutsPaused: paused,
    limits: payoutLimits
  };
}

/**
 * Pay `bolt11` from the fee pool. Every attempt is a security event (who asked, the outcome);
 * a refused payout's own events (cap hit, paused) are logged by PayoutService as usual.
 */
export async function withdrawRevenue(bolt11: string, actor: string, sourceIp?: string): Promise<PayoutResult> {
  const result = await payoutService.withdraw(NETWORK_FEE_POOL_ACCOUNT, bolt11, "withdraw");
  securityLog.log({
    level: securityLog.severity("revenue_withdrawal"),
    event: "revenue_withdrawal",
    source: { type: "coordinator", id: actor, ...(sourceIp ? { ip: sourceIp } : {}) },
    details: result.ok
      ? { accountId: NETWORK_FEE_POOL_ACCOUNT, ok: true, payoutId: result.payout.payoutId, amountMsat: result.payout.amountMsat, feeMsat: result.payout.feeMsat, paymentHash: result.payout.paymentHash }
      : { accountId: NETWORK_FEE_POOL_ACCOUNT, ok: false, code: result.code, detail: result.detail },
    action: result.ok ? "revenue_paid_out" : "revenue_withdrawal_refused",
    coordinatorId: identity.peerId
  });
  return result;
}
