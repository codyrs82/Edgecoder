import { describe, expect, it } from "vitest";
import { CANDLE_INTERVALS, MarketHistory, normalizeLegacyOrder, normalizeLegacyTicks, normalizeLegacyTrades, type MarketTick } from "../../src/economy/market-history.js";

const tick = (atMs: number, mid: number): MarketTick => ({
  atMs,
  computeClass: "cpu",
  referenceMsat: 7,
  bestAskMsat: mid - 1,
  bestBidMsat: mid + 1,
  midMsat: mid,
  clearingMsat: mid,
  agents: 1,
  openTasks: 1
});

describe("MarketHistory candles", () => {
  it("builds OHLC of the mid per bucket, carries flat candles over gaps, counts trade volume", () => {
    const h = new MarketHistory();
    const m = CANDLE_INTERVALS["5m"];
    h.recordTick(tick(0, 10));
    h.recordTick(tick(60_000, 12));
    h.recordTick(tick(120_000, 9));
    h.recordTick(tick(180_000, 11)); // bucket 0: o10 h12 l9 c11
    // bucket 1 (5-10 min): no ticks -> flat 11
    h.recordTick(tick(10 * 60_000 + 30_000, 13)); // bucket 2
    h.recordTrade({ taskId: "t", subtaskId: "s1", agentId: "a", computeClass: "cpu", msatPerCredit: 8, atMs: 90_000 });
    h.settleTrade("s1", 42);
    const c = h.candles("cpu", m, 500, 12 * 60_000);
    expect(c).toHaveLength(3);
    expect(c[0]).toEqual({ time: 0, open: 10, high: 12, low: 8, close: 11, volume: 1, creditsTraded: 42 });
    expect(c[1]).toEqual({ time: 300, open: 11, high: 11, low: 11, close: 11, volume: 0, creditsTraded: 0 });
    expect(c[2]).toMatchObject({ time: 600, open: 13, close: 13 });
    expect(h.candles("cpu", m, 2, 12 * 60_000)).toHaveLength(2);
    expect(h.candles("gpu", m)).toEqual([]);
  });

  it("prunes old ticks, caps trades, and lists recent trades newest first", () => {
    const h = new MarketHistory({ maxTickAgeMs: 1_000, maxTradesPerClass: 2 });
    h.recordTick(tick(0, 1));
    h.recordTick(tick(500, 2));
    h.recordTick(tick(2_000, 3));
    expect(h.ticksFor("cpu").map((t) => t.atMs)).toEqual([2_000]);
    for (const i of [1, 2, 3]) h.recordTrade({ taskId: "t", subtaskId: `s${i}`, agentId: "a", computeClass: "cpu", msatPerCredit: i, atMs: i });
    expect(h.recentTrades("cpu").map((t) => t.subtaskId)).toEqual(["s3", "s2"]);
    expect(h.latest("cpu")?.midMsat).toBe(3);
  });

  it("depth is cumulative in price order on each side", () => {
    const d = MarketHistory.depth(
      [{ msatPerCredit: 9, count: 2 }, { msatPerCredit: 7, count: 1 }],
      [{ msatPerCredit: 6, count: 3 }, { msatPerCredit: 8, count: 1 }]
    );
    expect(d.asks).toEqual([{ price: 7, cumulative: 1 }, { price: 9, cumulative: 3 }]);
    expect(d.bids).toEqual([{ price: 8, cumulative: 1 }, { price: 6, cumulative: 4 }]);
  });
});

describe("legacy history (nine-class ids) mapped at read time", () => {
  const legacyTick = (computeClass: string, atMs: number, msat: number, agents = 1) => ({
    atMs,
    computeClass,
    referenceMsat: msat,
    bestAskMsat: msat,
    midMsat: msat,
    clearingMsat: msat,
    agents,
    openTasks: 0
  });

  it("merges sibling tiers of one minute into one tick of the class, in the current price unit", () => {
    // Old references at one BTC/USD: cpu.std 7 msat/credit, cpu.hi 4x that (same cps): both are 7 per new cpu credit.
    // Old gpu.c8 10 (cps 2) and gpu.c24 35 × 4 / 3.5 = 40: gpu.c8 is the base tier and sets the price.
    const out = normalizeLegacyTicks([
      legacyTick("cpu.std", 60_000, 7, 3),
      legacyTick("cpu.hi", 60_000, 28, 1),
      legacyTick("gpu.c24", 60_000, 35, 2),
      legacyTick("gpu.c8", 60_000, 10, 5),
      legacyTick("cpu", 120_000, 7, 4), // a current row passes through
      legacyTick("bogus", 120_000, 1, 1)
    ]);
    expect(out.map((t) => [t.computeClass, t.atMs])).toEqual([
      ["cpu", 60_000],
      ["gpu", 60_000],
      ["cpu", 120_000]
    ]);
    expect(out[0]).toMatchObject({ referenceMsat: 7, midMsat: 7, agents: 4 });
    expect(out[1]).toMatchObject({ referenceMsat: 20, midMsat: 20, bestAskMsat: 20, agents: 7 });
    expect(out[1]).not.toHaveProperty("bestBidMsat");
    // Charted through MarketHistory, the old rows sit under the new class.
    const h = new MarketHistory();
    for (const t of out) h.recordTick(t);
    expect(h.ticksFor("cpu").map((t) => t.atMs)).toEqual([60_000, 120_000]);
    expect(h.candles("cpu", CANDLE_INTERVALS["1m"], 10, 120_000).map((c) => c.close)).toEqual([7, 7]);
  });

  it("maps trades and standing orders, converting explicit prices and keeping 0 = track", () => {
    const trades = normalizeLegacyTrades([
      { taskId: "t", subtaskId: "s1", agentId: "a", computeClass: "gpu.dc40", msatPerCredit: 50, credits: 3, atMs: 1 },
      { taskId: "t", subtaskId: "s2", agentId: "a", computeClass: "gpu.dc", msatPerCredit: 300, atMs: 2 }
    ]);
    expect(trades).toEqual([
      { taskId: "t", subtaskId: "s1", agentId: "a", computeClass: "gpu.dc", msatPerCredit: 300, credits: 3, atMs: 1 },
      { taskId: "t", subtaskId: "s2", agentId: "a", computeClass: "gpu.dc", msatPerCredit: 300, atMs: 2 }
    ]);
    expect(normalizeLegacyOrder({ accountId: "x", side: "sell", computeClass: "apple.m", msatPerCredit: 15, updatedAtMs: 1 })).toMatchObject({ computeClass: "apple", msatPerCredit: 30 });
    expect(normalizeLegacyOrder({ accountId: "x", side: "buy", computeClass: "gpu.c24", msatPerCredit: 0, updatedAtMs: 1 })).toMatchObject({ computeClass: "gpu", msatPerCredit: 0 });
    expect(normalizeLegacyOrder({ accountId: "x", side: "buy", computeClass: "any", msatPerCredit: 9, updatedAtMs: 1 })).toMatchObject({ computeClass: "any", msatPerCredit: 9 });
    expect(normalizeLegacyOrder({ accountId: "x", side: "buy", computeClass: "nope", msatPerCredit: 9, updatedAtMs: 1 })).toBeUndefined();
  });
});
