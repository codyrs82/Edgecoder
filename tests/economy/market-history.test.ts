import { describe, expect, it } from "vitest";
import { CANDLE_INTERVALS, MarketHistory, type MarketTick } from "../../src/economy/market-history.js";

const tick = (atMs: number, mid: number): MarketTick => ({
  atMs,
  computeClass: "cpu.std",
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
    h.recordTrade({ taskId: "t", subtaskId: "s1", agentId: "a", computeClass: "cpu.std", msatPerCredit: 8, atMs: 90_000 });
    h.settleTrade("s1", 42);
    const c = h.candles("cpu.std", m, 500, 12 * 60_000);
    expect(c).toHaveLength(3);
    expect(c[0]).toEqual({ time: 0, open: 10, high: 12, low: 8, close: 11, volume: 1, creditsTraded: 42 });
    expect(c[1]).toEqual({ time: 300, open: 11, high: 11, low: 11, close: 11, volume: 0, creditsTraded: 0 });
    expect(c[2]).toMatchObject({ time: 600, open: 13, close: 13 });
    expect(h.candles("cpu.std", m, 2, 12 * 60_000)).toHaveLength(2);
    expect(h.candles("gpu.c24", m)).toEqual([]);
  });

  it("prunes old ticks, caps trades, and lists recent trades newest first", () => {
    const h = new MarketHistory({ maxTickAgeMs: 1_000, maxTradesPerClass: 2 });
    h.recordTick(tick(0, 1));
    h.recordTick(tick(500, 2));
    h.recordTick(tick(2_000, 3));
    expect(h.ticksFor("cpu.std").map((t) => t.atMs)).toEqual([2_000]);
    for (const i of [1, 2, 3]) h.recordTrade({ taskId: "t", subtaskId: `s${i}`, agentId: "a", computeClass: "cpu.std", msatPerCredit: i, atMs: i });
    expect(h.recentTrades("cpu.std").map((t) => t.subtaskId)).toEqual(["s3", "s2"]);
    expect(h.latest("cpu.std")?.midMsat).toBe(3);
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
