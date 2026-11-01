// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { ComputeClassId } from "./compute-classes.js";

/**
 * Per-class order book for compute, priced in msat per credit (one credit = one measured second
 * on the class, before model multipliers).
 *
 * - Asks: each connected agent posts the minimum it will work for on its class. Default is the
 *   oracle reference for the class; an agent may set its own, and it moves with every heartbeat.
 * - Bids: a task carries the maximum its requester will pay per credit (default: the reference
 *   x a configurable premium so a default task clears at the reference).
 * - Matching happens at claim time: an agent may claim a task only if its ask <= the task's bid.
 *   The trade prices at the ask (the requester never pays more than its bid; the agent gets at
 *   least its ask). The last N trade prices per class give the clearing price; the best ask and
 *   best bid give the spread.
 * - Repricing: the oracle recalibrates the reference daily (and on demand). Agents whose ask is
 *   "reference-tracking" (no explicit ask) move with it automatically; explicit asks stay put, so
 *   when BTC/USD swings a tracking agent reprices and a fixed-ask agent either becomes the
 *   cheapest or stops matching, which is exactly the signal a market should send.
 */

export interface Ask {
  agentId: string;
  computeClass: ComputeClassId;
  msatPerCredit: number;
  /** True when the ask is the class reference (no explicit ask from the agent). */
  tracking: boolean;
  updatedAtMs: number;
}

export interface Bid {
  taskId: string;
  computeClass: ComputeClassId | "any";
  maxMsatPerCredit: number;
  createdAtMs: number;
}

export interface Trade {
  taskId: string;
  subtaskId: string;
  agentId: string;
  computeClass: ComputeClassId;
  msatPerCredit: number;
  atMs: number;
}

export interface BookLevel {
  msatPerCredit: number;
  count: number;
}

export interface BookSnapshot {
  computeClass: ComputeClassId;
  referenceMsatPerCredit: number;
  bestAsk?: number;
  bestBid?: number;
  /** bestAsk - bestBid in msat; negative means crossed (every default task clears). */
  spreadMsat?: number;
  /** Mid of best ask and best bid, or the reference when one side is empty. */
  midMsatPerCredit: number;
  /** Volume-weighted price of the last trades in the window; the reference when there are none. */
  clearingMsatPerCredit: number;
  asks: BookLevel[];
  bids: BookLevel[];
  recentTrades: number;
  agents: number;
  openTasks: number;
}

export class ComputeOrderBook {
  private readonly asks = new Map<string, Ask>(); // by agentId
  private readonly bids = new Map<string, Bid>(); // by taskId
  private readonly trades: Trade[] = [];
  private readonly reference = new Map<ComputeClassId, number>();

  constructor(private readonly opts: { tradeWindowMs?: number; maxTrades?: number } = {}) {}

  /** Oracle reference per class (msat per credit). Tracking asks follow it. */
  setReference(computeClass: ComputeClassId, msatPerCredit: number): void {
    this.reference.set(computeClass, Math.max(1, Math.round(msatPerCredit)));
    for (const ask of this.asks.values()) {
      if (ask.tracking && ask.computeClass === computeClass) ask.msatPerCredit = this.reference.get(computeClass)!;
    }
  }

  referenceFor(computeClass: ComputeClassId): number {
    return this.reference.get(computeClass) ?? 1;
  }

  /** Post or update an agent's ask. `msatPerCredit` undefined => track the class reference. */
  postAsk(agentId: string, computeClass: ComputeClassId, msatPerCredit: number | undefined, nowMs = Date.now()): Ask {
    const tracking = msatPerCredit === undefined || !Number.isFinite(msatPerCredit) || msatPerCredit <= 0;
    const ask: Ask = {
      agentId,
      computeClass,
      msatPerCredit: tracking ? this.referenceFor(computeClass) : Math.max(1, Math.round(msatPerCredit as number)),
      tracking,
      updatedAtMs: nowMs
    };
    this.asks.set(agentId, ask);
    return ask;
  }

  removeAsk(agentId: string): void {
    this.asks.delete(agentId);
  }

  askFor(agentId: string): Ask | undefined {
    return this.asks.get(agentId);
  }

  /** Register a task's bid. `maxMsatPerCredit` undefined => reference × (1 + defaultPremiumBps). */
  postBid(taskId: string, computeClass: ComputeClassId | "any", maxMsatPerCredit: number | undefined, defaultPremiumBps = 0, nowMs = Date.now()): Bid {
    let max: number;
    if (maxMsatPerCredit !== undefined && Number.isFinite(maxMsatPerCredit) && maxMsatPerCredit > 0) {
      max = Math.round(maxMsatPerCredit);
    } else {
      const ref = computeClass === "any" ? Math.max(...[...this.reference.values()], 1) : this.referenceFor(computeClass);
      max = Math.max(1, Math.round(ref * (1 + defaultPremiumBps / 10_000)));
    }
    const bid: Bid = { taskId, computeClass, maxMsatPerCredit: max, createdAtMs: nowMs };
    this.bids.set(taskId, bid);
    return bid;
  }

  removeBid(taskId: string): void {
    this.bids.delete(taskId);
  }

  bidFor(taskId: string): Bid | undefined {
    return this.bids.get(taskId);
  }

  /**
   * May `agentId` take `taskId`? True when the task has no bid (legacy) or the agent's ask is
   * within the bid and the class matches (or the bid accepts any class). Returns the trade
   * price (the ask) when it can.
   */
  canMatch(agentId: string, taskId: string): { ok: true; msatPerCredit: number; computeClass: ComputeClassId } | { ok: false; reason: "no_ask" | "class_mismatch" | "ask_above_bid" } {
    const ask = this.asks.get(agentId);
    if (!ask) return { ok: false, reason: "no_ask" };
    const bid = this.bids.get(taskId);
    if (!bid) return { ok: true, msatPerCredit: ask.msatPerCredit, computeClass: ask.computeClass };
    if (bid.computeClass !== "any" && bid.computeClass !== ask.computeClass) return { ok: false, reason: "class_mismatch" };
    if (ask.msatPerCredit > bid.maxMsatPerCredit) return { ok: false, reason: "ask_above_bid" };
    return { ok: true, msatPerCredit: ask.msatPerCredit, computeClass: ask.computeClass };
  }

  recordTrade(trade: Trade): void {
    this.trades.push(trade);
    const max = this.opts.maxTrades ?? 5_000;
    if (this.trades.length > max) this.trades.splice(0, this.trades.length - max);
  }

  /** Volume-weighted (by count) price of trades in the window for a class; undefined when none. */
  clearingPrice(computeClass: ComputeClassId, nowMs = Date.now()): number | undefined {
    const window = this.opts.tradeWindowMs ?? 60 * 60 * 1000;
    const recent = this.trades.filter((t) => t.computeClass === computeClass && nowMs - t.atMs <= window);
    if (recent.length === 0) return undefined;
    return Math.round(recent.reduce((s, t) => s + t.msatPerCredit, 0) / recent.length);
  }

  snapshot(computeClass: ComputeClassId, nowMs = Date.now()): BookSnapshot {
    const ref = this.referenceFor(computeClass);
    const askLevels = levels([...this.asks.values()].filter((a) => a.computeClass === computeClass).map((a) => a.msatPerCredit), "asc");
    const bidLevels = levels(
      [...this.bids.values()].filter((b) => b.computeClass === computeClass || b.computeClass === "any").map((b) => b.maxMsatPerCredit),
      "desc"
    );
    const bestAsk = askLevels[0]?.msatPerCredit;
    const bestBid = bidLevels[0]?.msatPerCredit;
    const mid = bestAsk !== undefined && bestBid !== undefined ? Math.round((bestAsk + bestBid) / 2) : bestAsk ?? bestBid ?? ref;
    const window = this.opts.tradeWindowMs ?? 60 * 60 * 1000;
    const recentTrades = this.trades.filter((t) => t.computeClass === computeClass && nowMs - t.atMs <= window).length;
    return {
      computeClass,
      referenceMsatPerCredit: ref,
      bestAsk,
      bestBid,
      spreadMsat: bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : undefined,
      midMsatPerCredit: mid,
      clearingMsatPerCredit: this.clearingPrice(computeClass, nowMs) ?? ref,
      asks: askLevels,
      bids: bidLevels,
      recentTrades,
      agents: askLevels.reduce((s, l) => s + l.count, 0),
      openTasks: bidLevels.reduce((s, l) => s + l.count, 0)
    };
  }

  classes(): ComputeClassId[] {
    const set = new Set<ComputeClassId>([...this.reference.keys(), ...[...this.asks.values()].map((a) => a.computeClass)]);
    return [...set];
  }
}

function levels(prices: number[], order: "asc" | "desc"): BookLevel[] {
  const counts = new Map<number, number>();
  for (const p of prices) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts.entries()]
    .map(([msatPerCredit, count]) => ({ msatPerCredit, count }))
    .sort((a, b) => (order === "asc" ? a.msatPerCredit - b.msatPerCredit : b.msatPerCredit - a.msatPerCredit));
}
