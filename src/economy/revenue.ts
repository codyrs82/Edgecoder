// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * EdgeCoder's revenue: the NETWORK_FEE_BPS share of every compute payment, booked as `network_fee:`
 * earn rows on the fee pool account (network:fee_pool). Pure helpers for the admin revenue report
 * (GET /admin/revenue on the coordinator).
 */

export const DAY_MS = 86_400_000;
/** Reason prefix of the fee pool's intake rows (src/credits/store.ts accruePricedJob / accrueCredits). */
export const FEE_INCOME_REASON_PREFIX = "network_fee:";

export interface RevenueDay {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  msat: number;
  /** Fee rows (one per paid compute job). */
  payments: number;
}

/** UTC day number (days since the epoch) of a timestamp. */
export const utcDay = (ms: number): number => Math.floor(ms / DAY_MS);

/** First millisecond of the window of `days` UTC days ending today. */
export function revenueWindowStartMs(nowMs: number, days: number): number {
  return (utcDay(nowMs) - (Math.max(1, days) - 1)) * DAY_MS;
}

/** One entry per UTC day of the window (oldest first), days without income at 0. */
export function revenueDays(buckets: Array<{ day: number; msat: number; count: number }>, nowMs: number, days: number): RevenueDay[] {
  const byDay = new Map<number, { msat: number; count: number }>();
  for (const b of buckets) {
    const e = byDay.get(b.day) ?? { msat: 0, count: 0 };
    e.msat += b.msat;
    e.count += b.count;
    byDay.set(b.day, e);
  }
  const last = utcDay(nowMs);
  const out: RevenueDay[] = [];
  for (let d = last - (Math.max(1, days) - 1); d <= last; d++) {
    const e = byDay.get(d);
    out.push({ date: new Date(d * DAY_MS).toISOString().slice(0, 10), msat: Math.round(e?.msat ?? 0), payments: e?.count ?? 0 });
  }
  return out;
}

/** Day buckets from ledger rows (in-memory ledger): earn rows with the fee reason, at or after `sinceMs`. */
export function feeIncomeFromRows(
  rows: Array<{ type: string; reason: string; timestampMs: number; msat?: number }>,
  sinceMs: number
): { totalMsat: number; count: number; days: Array<{ day: number; msat: number; count: number }> } {
  let totalMsat = 0;
  let count = 0;
  const days = new Map<number, { msat: number; count: number }>();
  for (const r of rows) {
    if (r.type !== "earn" || !r.reason.startsWith(FEE_INCOME_REASON_PREFIX)) continue;
    const msat = Math.floor(r.msat ?? 0);
    totalMsat += msat;
    count += 1;
    if (r.timestampMs < sinceMs) continue;
    const e = days.get(utcDay(r.timestampMs)) ?? { msat: 0, count: 0 };
    e.msat += msat;
    e.count += 1;
    days.set(utcDay(r.timestampMs), e);
  }
  return { totalMsat, count, days: [...days.entries()].map(([day, e]) => ({ day, ...e })) };
}

/** HTTP status for a refused payout (same mapping as POST /economy/payouts/withdraw). */
export function payoutRefusalStatus(code: string): number {
  return code === "payout_unconfirmed" ? 202 : code === "payouts_paused" ? 503 : 400;
}
