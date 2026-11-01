// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { ComputeClassId } from "./compute-classes.js";
import type { Trade } from "./order-book.js";

/**
 * Price history for the compute market, per compute class, so it can be charted and traded
 * like an exchange pair (compute class / BTC, quoted in msat per credit).
 *
 * - A tick is taken every minute from the order book: reference (oracle), best ask, best bid,
 *   mid and the hourly clearing price. Ticks are what candles are built from (OHLC of the mid),
 *   so the chart is continuous even on a quiet market.
 * - Trades (claims matched at an ask) are kept for the trade tape and candle volume.
 * - Everything lives in memory with a bounded window; the coordinator persists ticks and trades
 *   to Postgres when configured and reloads the window at startup.
 */

export interface MarketTick {
  atMs: number;
  computeClass: ComputeClassId;
  referenceMsat: number;
  bestAskMsat?: number;
  bestBidMsat?: number;
  midMsat: number;
  clearingMsat: number;
  agents: number;
  openTasks: number;
}

export interface Candle {
  /** Bucket start, unix seconds (what Lightweight Charts expects). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Trades in the bucket. */
  volume: number;
  /** Credits traded in the bucket when known (0 when only ticks exist). */
  creditsTraded: number;
}

export const CANDLE_INTERVALS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000
};

export interface MarketTrade extends Trade {
  /** Credits actually accrued for the subtask once known (0 until the result lands). */
  credits?: number;
}

export class MarketHistory {
  private readonly ticks = new Map<ComputeClassId, MarketTick[]>();
  private readonly trades = new Map<ComputeClassId, MarketTrade[]>();

  constructor(private readonly opts: { maxTickAgeMs?: number; maxTradesPerClass?: number } = {}) {}

  recordTick(tick: MarketTick): void {
    const list = this.ticks.get(tick.computeClass) ?? [];
    list.push(tick);
    const maxAge = this.opts.maxTickAgeMs ?? 30 * 24 * 60 * 60_000;
    const cutoff = tick.atMs - maxAge;
    while (list.length && list[0].atMs < cutoff) list.shift();
    this.ticks.set(tick.computeClass, list);
  }

  recordTrade(trade: MarketTrade): void {
    const list = this.trades.get(trade.computeClass) ?? [];
    list.push(trade);
    const max = this.opts.maxTradesPerClass ?? 10_000;
    if (list.length > max) list.splice(0, list.length - max);
    this.trades.set(trade.computeClass, list);
  }

  /** Attach the accrued credits to a trade once the result is in (volume in credits). */
  settleTrade(subtaskId: string, credits: number): void {
    for (const list of this.trades.values()) {
      const t = list.find((x) => x.subtaskId === subtaskId);
      if (t) {
        t.credits = credits;
        return;
      }
    }
  }

  ticksFor(computeClass: ComputeClassId): MarketTick[] {
    return [...(this.ticks.get(computeClass) ?? [])];
  }

  recentTrades(computeClass: ComputeClassId, limit = 50): MarketTrade[] {
    const list = this.trades.get(computeClass) ?? [];
    return list.slice(-limit).reverse();
  }

  latest(computeClass: ComputeClassId): MarketTick | undefined {
    const list = this.ticks.get(computeClass);
    return list?.[list.length - 1];
  }

  /**
   * OHLC candles of the mid price per bucket, with trade count and credits as volume. Buckets
   * with no tick are carried forward (flat candle at the previous close) so the chart has no
   * holes; leading buckets before the first tick are omitted.
   */
  candles(computeClass: ComputeClassId, intervalMs: number, limit = 500, nowMs = Date.now()): Candle[] {
    const ticks = this.ticks.get(computeClass) ?? [];
    if (ticks.length === 0 || intervalMs <= 0) return [];
    const bucketOf = (ms: number) => Math.floor(ms / intervalMs) * intervalMs;
    const byBucket = new Map<number, Candle>();
    for (const t of ticks) {
      const b = bucketOf(t.atMs);
      const c = byBucket.get(b);
      if (!c) byBucket.set(b, { time: b / 1000, open: t.midMsat, high: t.midMsat, low: t.midMsat, close: t.midMsat, volume: 0, creditsTraded: 0 });
      else {
        c.high = Math.max(c.high, t.midMsat);
        c.low = Math.min(c.low, t.midMsat);
        c.close = t.midMsat;
      }
    }
    for (const tr of this.trades.get(computeClass) ?? []) {
      const b = bucketOf(tr.atMs);
      const c = byBucket.get(b);
      if (c) {
        c.volume += 1;
        c.creditsTraded += tr.credits ?? 0;
        c.high = Math.max(c.high, tr.msatPerCredit);
        c.low = Math.min(c.low, tr.msatPerCredit);
      }
    }
    const first = bucketOf(ticks[0].atMs);
    const last = bucketOf(nowMs);
    const out: Candle[] = [];
    let prevClose: number | undefined;
    for (let b = first; b <= last; b += intervalMs) {
      const c = byBucket.get(b);
      if (c) {
        out.push(c);
        prevClose = c.close;
      } else if (prevClose !== undefined) {
        out.push({ time: b / 1000, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0, creditsTraded: 0 });
      }
    }
    return out.slice(-limit);
  }

  /** Cumulative depth from book levels: asks ascending, bids descending; for the depth chart. */
  static depth(
    asks: Array<{ msatPerCredit: number; count: number }>,
    bids: Array<{ msatPerCredit: number; count: number }>
  ): { asks: Array<{ price: number; cumulative: number }>; bids: Array<{ price: number; cumulative: number }> } {
    let acc = 0;
    const a = [...asks].sort((x, y) => x.msatPerCredit - y.msatPerCredit).map((l) => ({ price: l.msatPerCredit, cumulative: (acc += l.count) }));
    acc = 0;
    const b = [...bids].sort((x, y) => y.msatPerCredit - x.msatPerCredit).map((l) => ({ price: l.msatPerCredit, cumulative: (acc += l.count) }));
    return { asks: a, bids: b };
  }
}

/** Standing order placed from the portal: a buyer's default max bid, or a seller's ask applied to every agent they own. */
export interface MarketOrder {
  accountId: string;
  side: "buy" | "sell";
  computeClass: ComputeClassId | "any";
  msatPerCredit: number;
  updatedAtMs: number;
}
