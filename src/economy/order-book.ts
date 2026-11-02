// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { CapabilityConstraints, ComputeClassId, ComputeTierId } from "./compute-classes.js";

/**
 * Per-class order book for compute, priced in msat per credit (one credit = one measured second
 * on the class's base tier, before model multipliers; faster tiers mint more credits per second,
 * so the price per credit is flat within a class). Four books: cpu, apple, gpu, gpu.dc.
 *
 * - Asks: each connected agent posts the minimum it will work for on its class. Default is the
 *   oracle reference for the class; an agent may set its own, and it moves with every heartbeat.
 * - Bids: a task carries the maximum its requester will pay per credit (default: the reference
 *   x a configurable premium so a default task clears at the reference).
 * - Matching happens at claim time: an agent may claim a task only if its ask <= the task's bid
 *   and its hardware satisfies the bid's capability constraints (minVramGb / minMemoryGb; e.g.
 *   a 30B task bids in gpu with minVramGb 24 and a 12 GB card cannot fill it). The trade prices at the ask (the requester never pays more than its bid; the agent gets at
 *   least its ask). The last N trade prices per class give the clearing price; the best ask and
 *   best bid give the spread.
 * - Repricing: the oracle recalibrates the reference daily (and on demand). Agents whose ask is
 *   "reference-tracking" (no explicit ask) move with it automatically; explicit asks stay put, so
 *   when BTC/USD swings a tracking agent reprices and a fixed-ask agent either becomes the
 *   cheapest or stops matching, which is exactly the signal a market should send.
 */

/**
 * The hardware behind an ask (from classifyHardware): what the constraints of a bid are checked against.
 * Planned SLA / reputation score: add it here (set from uptime / completion history at register and
 * heartbeat), add a matching `minReliability` to CapabilityConstraints, and check it in meetsCapability;
 * gpu.dc admission can then require a score instead of only a datacenter part.
 */
export interface AskCapability {
  tier?: ComputeTierId;
  /** Credits per measured second (tier weight). */
  creditsPerSecond?: number;
  vramGb?: number;
  memoryGb?: number;
}

export interface Ask extends AskCapability {
  agentId: string;
  computeClass: ComputeClassId;
  msatPerCredit: number;
  /** True when the ask is the class reference (no explicit ask from the agent). */
  tracking: boolean;
  updatedAtMs: number;
}

export interface Bid extends CapabilityConstraints {
  taskId: string;
  computeClass: ComputeClassId | "any";
  /** The ceiling. For a default "any" bid: the highest class reference × premium at post time (informational; see premiumBps). */
  maxMsatPerCredit: number;
  createdAtMs: number;
  /**
   * Set on an "any" bid posted without an explicit price: its ceiling in each class is that
   * class's live reference × (1 + premiumBps). Class prices differ ~35x (cpu vs gpu.dc), so one
   * msat number cannot be a sensible default ceiling for every class.
   */
  premiumBps?: number;
}

/** Sanitize requester constraints: finite positive numbers only; anything else means "no constraint". */
export function capabilityConstraints(input: CapabilityConstraints | undefined): CapabilityConstraints {
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  return { ...(ok(input?.minVramGb) ? { minVramGb: input!.minVramGb } : {}), ...(ok(input?.minMemoryGb) ? { minMemoryGb: input!.minMemoryGb } : {}) };
}

/** True when the hardware meets every constraint. Unknown capability never satisfies a constraint. */
export function meetsCapability(cap: AskCapability | undefined, req: CapabilityConstraints | undefined): boolean {
  const c = capabilityConstraints(req);
  if (c.minVramGb !== undefined && !((cap?.vramGb ?? 0) >= c.minVramGb)) return false;
  if (c.minMemoryGb !== undefined && !((cap?.memoryGb ?? 0) >= c.minMemoryGb)) return false;
  return true;
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

/**
 * Audit econ#2: the msat value locked on an earn row is withdrawable as real sats, so a trade price
 * (an agent's ask, which a self-dealing ask/bid pair controls) is clamped to [0.25x, 4x] the oracle
 * reference of the class the credits are valued in. No trade => the reference. No reference => the
 * trade price unclamped (no oracle epoch yet, e.g. offline dev).
 */
export function clampToClassReference(tradeMsatPerCredit: number | undefined, classRefMsatPerCredit: number | undefined): number | undefined {
  const base = tradeMsatPerCredit ?? classRefMsatPerCredit;
  if (base === undefined || classRefMsatPerCredit === undefined || !(classRefMsatPerCredit > 0)) return base;
  return Math.min(Math.max(base, classRefMsatPerCredit * 0.25), classRefMsatPerCredit * 4);
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

  /** False until the oracle has set a reference for the class (ticks before that would chart a placeholder price). */
  hasReference(computeClass: ComputeClassId): boolean {
    return this.reference.has(computeClass);
  }

  /**
   * Post or update an agent's ask. `msatPerCredit` undefined => track the class reference.
   * `capability` omitted keeps the agent's previous capability on the same class (a re-priced ask
   * is still the same hardware).
   */
  postAsk(agentId: string, computeClass: ComputeClassId, msatPerCredit: number | undefined, nowMs = Date.now(), capability?: AskCapability): Ask {
    const tracking = msatPerCredit === undefined || !Number.isFinite(msatPerCredit) || msatPerCredit <= 0;
    const prev = this.asks.get(agentId);
    const cap: AskCapability = capability ?? (prev && prev.computeClass === computeClass ? { tier: prev.tier, creditsPerSecond: prev.creditsPerSecond, vramGb: prev.vramGb, memoryGb: prev.memoryGb } : {});
    const ask: Ask = {
      agentId,
      computeClass,
      msatPerCredit: tracking ? this.referenceFor(computeClass) : Math.max(1, Math.round(msatPerCredit as number)),
      tracking,
      updatedAtMs: nowMs,
      ...(cap.tier !== undefined ? { tier: cap.tier } : {}),
      ...(cap.creditsPerSecond !== undefined ? { creditsPerSecond: cap.creditsPerSecond } : {}),
      ...(cap.vramGb !== undefined ? { vramGb: cap.vramGb } : {}),
      ...(cap.memoryGb !== undefined ? { memoryGb: cap.memoryGb } : {})
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

  /**
   * Register a task's bid. `maxMsatPerCredit` undefined => reference × (1 + defaultPremiumBps).
   * `constraints` (minVramGb / minMemoryGb) restrict which asks can fill it; default none.
   */
  postBid(
    taskId: string,
    computeClass: ComputeClassId | "any",
    maxMsatPerCredit: number | undefined,
    defaultPremiumBps = 0,
    nowMs = Date.now(),
    constraints?: CapabilityConstraints
  ): Bid {
    let max: number;
    const explicit = maxMsatPerCredit !== undefined && Number.isFinite(maxMsatPerCredit) && maxMsatPerCredit > 0;
    if (explicit) {
      max = Math.round(maxMsatPerCredit as number);
    } else {
      const ref = computeClass === "any" ? Math.max(...[...this.reference.values()], 1) : this.referenceFor(computeClass);
      max = Math.max(1, Math.round(ref * (1 + defaultPremiumBps / 10_000)));
    }
    const bid: Bid = {
      taskId,
      computeClass,
      maxMsatPerCredit: max,
      createdAtMs: nowMs,
      ...(computeClass === "any" && !explicit ? { premiumBps: defaultPremiumBps } : {}),
      ...capabilityConstraints(constraints)
    };
    this.bids.set(taskId, bid);
    return bid;
  }

  /** The most `bid` pays per credit on `computeClass`: class-relative for a default "any" bid, else its fixed ceiling. */
  bidCeilingFor(bid: Bid, computeClass: ComputeClassId): number {
    if (bid.computeClass === "any" && bid.premiumBps !== undefined) {
      return Math.max(1, Math.round(this.referenceFor(computeClass) * (1 + bid.premiumBps / 10_000)));
    }
    return bid.maxMsatPerCredit;
  }

  removeBid(taskId: string): void {
    this.bids.delete(taskId);
  }

  /** Remove every bid for which `stale` is true; returns how many were removed. */
  pruneBids(stale: (bid: Bid) => boolean): number {
    let n = 0;
    for (const [taskId, bid] of this.bids) {
      if (stale(bid)) {
        this.bids.delete(taskId);
        n++;
      }
    }
    return n;
  }

  bidFor(taskId: string): Bid | undefined {
    return this.bids.get(taskId);
  }

  /**
   * May `agentId` take `taskId`? True when the task has no bid (legacy) or the agent's ask is
   * within the bid, the class matches (or the bid accepts any class) and the agent's hardware
   * meets the bid's capability constraints. Returns the trade price (the ask) when it can.
   */
  canMatch(
    agentId: string,
    taskId: string
  ): { ok: true; msatPerCredit: number; computeClass: ComputeClassId } | { ok: false; reason: "no_ask" | "class_mismatch" | "below_min_spec" | "ask_above_bid" } {
    const ask = this.asks.get(agentId);
    if (!ask) return { ok: false, reason: "no_ask" };
    const bid = this.bids.get(taskId);
    if (!bid) return { ok: true, msatPerCredit: ask.msatPerCredit, computeClass: ask.computeClass };
    if (bid.computeClass !== "any" && bid.computeClass !== ask.computeClass) return { ok: false, reason: "class_mismatch" };
    if (!meetsCapability(ask, bid)) return { ok: false, reason: "below_min_spec" };
    if (ask.msatPerCredit > this.bidCeilingFor(bid, ask.computeClass)) return { ok: false, reason: "ask_above_bid" };
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
      [...this.bids.values()].filter((b) => b.computeClass === computeClass || b.computeClass === "any").map((b) => this.bidCeilingFor(b, computeClass)),
      "desc"
    );
    const bestAsk = askLevels[0]?.msatPerCredit;
    const bestBid = bidLevels[0]?.msatPerCredit;
    // One-sided books quote the reference: a lone bid (or ask) is not a price the market agreed on.
    const mid = bestAsk !== undefined && bestBid !== undefined ? Math.round((bestAsk + bestBid) / 2) : ref;
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
