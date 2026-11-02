import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import {
  DEFAULT_BTC_USD_SOURCES,
  DEFAULT_RATE_ORACLE_CONFIG,
  agreeingMedian,
  computeHashprice,
  computeRateEpoch,
  fetchHashprice,
  fetchQuotes,
  isRateEpochStale,
  rateOracleConfigFromEnv,
  readNumberAtPath,
  recalibrateRates,
  satsPerHourFromUsd,
  undiciJsonFetcher,
  type RateEpoch,
  type SourceQuote
} from "../../src/economy/rate-oracle.js";

const cfg = { ...DEFAULT_RATE_ORACLE_CONFIG, hashpriceEnabled: false };
const q = (name: string, value?: number, error?: string): SourceQuote => (value === undefined ? { name, ok: false, error } : { name, ok: true, value });

describe("rate oracle math", () => {
  it("converts a USD/hour reference to sats with the network markup", () => {
    // 0.02 USD/h at 100,000 USD/BTC = 20 sats/h; +20 % markup = 24 sats/h
    expect(satsPerHourFromUsd(0.02, 100_000, 2000)).toBe(24);
    expect(satsPerHourFromUsd(0.35, 100_000, 0)).toBe(350);
  });

  it("takes the median of agreeing quotes and drops outliers", () => {
    const r = agreeingMedian([q("a", 100_000), q("b", 100_400), q("c", 99_800), q("d", 150_000), q("e", undefined, "http_500")], 5, 2);
    expect(r.value).toBe(100_000);
    expect(r.quotes.find((x) => x.name === "d")?.outlier).toBe(true);
    expect(r.quotes.find((x) => x.name === "e")?.ok).toBe(false);
  });

  it("refuses a value when fewer than minSources agree", () => {
    expect(agreeingMedian([q("a", 100_000)], 5, 2).value).toBeUndefined();
    expect(agreeingMedian([q("a", 100_000), q("b", 120_000)], 5, 2).value).toBeUndefined(); // 20 % apart: both outliers vs median 110k? no: dev 9 % each -> dropped
    expect(agreeingMedian([q("a", 100_000), q("b", 101_000)], 5, 2).value).toBe(100_500);
  });

  it("an epoch prices a CPU-second in fractional sats and reports msat", () => {
    const e = computeRateEpoch({ btcUsdQuotes: [q("a", 100_000), q("b", 100_000)], computeQuotes: [] }, null, cfg, 1_000);
    expect(e.status).toBe("ok");
    expect(e.btcUsd).toBe(100_000);
    expect(e.satsPerCpuHour).toBe(24); // 0.02 USD/h + 20 %
    expect(e.satsPerGpuHour).toBe(420); // 0.35 USD/h + 20 %
    expect(e.satsPerCredit).toBeCloseTo(24 / 3600, 6);
    expect(e.msatPerCredit).toBe(7); // 6.67 msat rounded
    expect(e.clamped).toBeUndefined();
  });

  it("clamps the daily move against the previous epoch and records the unclamped value", () => {
    const prev = computeRateEpoch({ btcUsdQuotes: [q("a", 100_000), q("b", 100_000)], computeQuotes: [] }, null, cfg, 1_000);
    // BTC halves overnight -> sats price would double; clamp to +25 %
    const next = computeRateEpoch({ btcUsdQuotes: [q("a", 50_000), q("b", 50_000)], computeQuotes: [] }, prev, cfg, 2_000);
    expect(next.satsPerCpuHour).toBe(30);
    expect(next.clamped?.unclampedSatsPerCpuHour).toBe(48);
    expect(next.previousEpochId).toBe(prev.epochId);
  });

  it("carries the previous price when sources fail, and uses the static fallback only with no history", () => {
    const prev = computeRateEpoch({ btcUsdQuotes: [q("a", 100_000), q("b", 100_000)], computeQuotes: [] }, null, cfg, 1_000);
    const carried = computeRateEpoch({ btcUsdQuotes: [q("a", undefined, "timeout")], computeQuotes: [] }, prev, cfg, 2_000);
    expect(carried.status).toBe("carried");
    expect(carried.btcUsd).toBe(100_000);
    const fb = computeRateEpoch({ btcUsdQuotes: [], computeQuotes: [] }, null, { ...cfg, btcUsdFallback: 80_000 }, 1_000);
    expect(fb.status).toBe("fallback");
    expect(fb.satsPerCpuHour).toBe(30);
    expect(() => computeRateEpoch({ btcUsdQuotes: [q("a", undefined, "boom")], computeQuotes: [] }, null, cfg, 1_000)).toThrow(/rate_oracle_no_btc_usd/);
  });

  it("live compute sources override the reference per resource class", () => {
    const e = computeRateEpoch(
      {
        btcUsdQuotes: [q("a", 100_000), q("b", 100_000)],
        computeQuotes: [
          { name: "spot-cpu", ok: true, value: 0.01, resourceClass: "cpu" } as SourceQuote,
          { name: "gpu-market", ok: true, value: 0.5, resourceClass: "gpu" } as SourceQuote
        ]
      },
      null,
      cfg,
      1_000
    );
    expect(e.usdPerCpuHour).toBe(0.01);
    expect(e.usdPerGpuHour).toBe(0.5);
    expect(e.satsPerCpuHour).toBe(12);
  });

  it("staleness", () => {
    const e = { createdAtMs: 0 } as RateEpoch;
    expect(isRateEpochStale(null, cfg, 1)).toBe(true);
    expect(isRateEpochStale(e, cfg, cfg.staleAfterMs)).toBe(false);
    expect(isRateEpochStale(e, cfg, cfg.staleAfterMs + 1)).toBe(true);
  });

  it("hashprice from chain data: 144 × (subsidy + fees) / TH", () => {
    // height 900k -> 4 halvings -> 3.125 BTC subsidy; 1 ZH/s = 1e9 TH/s
    const h = computeHashprice({ blockHeight: 900_000, networkHashrateHs: 1e21, avgFeesPerBlockSats: 5_000_000, source: "test" });
    expect(h.blockSubsidySats).toBe(312_500_000);
    expect(h.satsPerThPerDay).toBeCloseTo((144 * 317_500_000) / 1e9, 6);
  });

  it("reads numbers from JSON paths in every default exchange shape", () => {
    expect(readNumberAtPath({ data: { amount: "100123.45" } }, "data.amount")).toBe(100123.45);
    expect(readNumberAtPath({ result: { XXBTZUSD: { c: ["99999.9", "1.0"] } } }, "result.XXBTZUSD.c[0]")).toBe(99999.9);
    expect(readNumberAtPath({ last: "100,000" }, "last")).toBe(100000);
    expect(readNumberAtPath({ USD: 100000 }, "USD")).toBe(100000);
    expect(readNumberAtPath({ USD: -1 }, "USD")).toBeUndefined();
    expect(readNumberAtPath({}, "a.b")).toBeUndefined();
  });

  it("config from env validates and parses source lists", () => {
    const c = rateOracleConfigFromEnv({
      COMPUTE_REFERENCE_USD_PER_VCPU_HOUR: "0.015",
      RATE_NETWORK_MARKUP_BPS: "1000",
      RATE_COMPUTE_SOURCES_JSON: JSON.stringify([{ name: "x", url: "https://x.test/p", path: "usd", resourceClass: "gpu" }]),
      BTC_USD_FALLBACK: "90000"
    });
    expect(c.usdPerCpuHourReference).toBe(0.015);
    expect(c.networkMarkupBps).toBe(1000);
    expect(c.computeSources[0]).toMatchObject({ name: "x", resourceClass: "gpu" });
    expect(c.btcUsdFallback).toBe(90_000);
    expect(c.btcUsdSources).toBe(DEFAULT_BTC_USD_SOURCES);
    expect(() => rateOracleConfigFromEnv({ RATE_MAX_DAILY_MOVE_PCT: "lots" })).toThrow(/RATE_MAX_DAILY_MOVE_PCT/);
    expect(() => rateOracleConfigFromEnv({ RATE_COMPUTE_SOURCES_JSON: JSON.stringify([{ name: "x", url: "http://insecure", path: "p" }]) })).toThrow(/https/);
  });
});

describe("rate oracle fetching (recorded exchange responses)", () => {
  let original: Dispatcher;
  let agent: MockAgent;
  beforeEach(() => {
    original = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    setGlobalDispatcher(original);
    await agent.close();
  });

  it("parses Coinbase, Kraken, Bitstamp and mempool.space, tolerates one failure, and builds an epoch", async () => {
    agent.get("https://api.coinbase.com").intercept({ path: "/v2/prices/BTC-USD/spot", method: "GET" })
      .reply(200, { data: { base: "BTC", currency: "USD", amount: "100250.12" } });
    agent.get("https://api.kraken.com").intercept({ path: "/0/public/Ticker?pair=XBTUSD", method: "GET" })
      .reply(200, { error: [], result: { XXBTZUSD: { a: ["100300.0", "1", "1.000"], b: ["100299.9", "1", "1.000"], c: ["100300.0", "0.01"] } } });
    agent.get("https://www.bitstamp.net").intercept({ path: "/api/v2/ticker/btcusd/", method: "GET" })
      .reply(200, { last: "100199.00", high: "101000", low: "99000" });
    agent.get("https://mempool.space").intercept({ path: "/api/v1/prices", method: "GET" }).reply(503, "upstream down");

    const quotes = await fetchQuotes(DEFAULT_BTC_USD_SOURCES, undiciJsonFetcher(2_000));
    expect(quotes.map((x) => x.ok)).toEqual([true, true, true, false]);
    expect(quotes[3].error).toBe("http_503");
    const epoch = computeRateEpoch({ btcUsdQuotes: quotes, computeQuotes: [] }, null, cfg, 1_000);
    expect(epoch.status).toBe("ok");
    expect(epoch.btcUsd).toBe(100250.12);
  });

  it("hashprice from mempool.space endpoints; missing data yields undefined instead of throwing", async () => {
    const pool = agent.get("https://mempool.space");
    pool.intercept({ path: "/api/blocks/tip/height", method: "GET" }).reply(200, "920000");
    pool.intercept({ path: "/api/v1/mining/hashrate/3d", method: "GET" }).reply(200, { currentHashrate: 1.0e21, currentDifficulty: 1.4e14, hashrates: [] });
    pool.intercept({ path: "/api/v1/mining/blocks/fees/24h", method: "GET" }).reply(200, [{ avgHeight: 919900, avgFees: 4_000_000 }, { avgHeight: 919950, avgFees: 6_000_000 }]);
    const h = await fetchHashprice("https://mempool.space", undiciJsonFetcher(2_000));
    expect(h).toMatchObject({ blockHeight: 920_000, blockSubsidySats: 312_500_000, avgFeesPerBlockSats: 5_000_000, networkHashrateThs: 1e9 });

    pool.intercept({ path: "/api/blocks/tip/height", method: "GET" }).reply(500, "x");
    pool.intercept({ path: "/api/v1/mining/hashrate/3d", method: "GET" }).reply(500, "x");
    pool.intercept({ path: "/api/v1/mining/blocks/fees/24h", method: "GET" }).reply(500, "x");
    expect(await fetchHashprice("https://mempool.space", undiciJsonFetcher(2_000))).toBeUndefined();
  });

  it("recalibrateRates end to end with an injected fetcher", async () => {
    const fetcher = async (url: string): Promise<unknown> => {
      if (url.includes("coinbase")) return { data: { amount: "100000" } };
      if (url.includes("kraken")) return { result: { XXBTZUSD: { c: ["100100", "1"] } } };
      throw new Error("offline");
    };
    const epoch = await recalibrateRates({ cfg, previous: null, fetcher, now: () => 5_000 });
    expect(epoch).toMatchObject({ status: "ok", btcUsd: 100_050, createdAtMs: 5_000 });
    expect(epoch.btcUsdSources.filter((x) => x.ok)).toHaveLength(2);
  });
});
