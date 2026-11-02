import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPUTE_CLASSES,
  classifyHardware,
  computeClassesFromEnv,
  modalityMultiplier,
  satsPerCreditForClass
} from "../../src/economy/compute-classes.js";
import { ComputeOrderBook } from "../../src/economy/order-book.js";
import { DEFAULT_RATE_ORACLE_CONFIG, computeRateEpoch, type SourceQuote } from "../../src/economy/rate-oracle.js";
import { creditRatePerSecond, estimateReserveCredits, modelSizeMultiplier, splitNetworkFee } from "../../src/credits/pricing.js";

const q = (name: string, value: number): SourceQuote => ({ name, ok: true, value });

describe("compute classes", () => {
  it("classifies hardware deterministically", () => {
    expect(classifyHardware(undefined)).toBe("cpu.std");
    expect(classifyHardware({ cpuCores: 8, ramGb: 16, platform: "linux", arch: "x64" })).toBe("cpu.std");
    expect(classifyHardware({ cpuCores: 64, ramGb: 256, platform: "linux" })).toBe("cpu.hi");
    expect(classifyHardware({ platform: "darwin", arch: "arm64", ramGb: 16 })).toBe("apple.m");
    expect(classifyHardware({ platform: "darwin", arch: "arm64", ramGb: 64 })).toBe("apple.m.hi");
    expect(classifyHardware({ gpu: { vendor: "nvidia", model: "RTX 4060", vramGb: 8 } })).toBe("gpu.c8");
    expect(classifyHardware({ gpu: { vendor: "nvidia", model: "RTX 4080", vramGb: 16 } })).toBe("gpu.c16");
    expect(classifyHardware({ gpu: { vendor: "nvidia", model: "RTX 4090", vramGb: 24 } })).toBe("gpu.c24");
    expect(classifyHardware({ gpu: { vendor: "nvidia", model: "A6000", vramGb: 48 } })).toBe("gpu.dc40");
    expect(classifyHardware({ gpu: { vendor: "nvidia", model: "H100", vramGb: 80 } })).toBe("gpu.dc80");
    expect(classifyHardware({ gpu: { vendor: "nvidia", model: "unknown", vramGb: 80, datacenter: true } })).toBe("gpu.dc80");
    expect(classifyHardware({ gpu: { vendor: "intel", model: "iris", vramGb: 2 }, cpuCores: 4 })).toBe("cpu.std");
  });

  it("prices one unit-hour of a class at its USD reference regardless of credits per second", () => {
    const btc = 100_000;
    for (const spec of Object.values(DEFAULT_COMPUTE_CLASSES)) {
      const perCredit = satsPerCreditForClass(spec, spec.usdPerHourReference, btc, 0);
      const unitHourSats = perCredit * spec.creditsPerSecond * 3600;
      expect(unitHourSats).toBeCloseTo((spec.usdPerHourReference / btc) * 1e8, 3);
    }
    // An H100 hour is 90x a commodity CPU hour at the defaults.
    expect(DEFAULT_COMPUTE_CLASSES["gpu.dc80"].usdPerHourReference / DEFAULT_COMPUTE_CLASSES["cpu.std"].usdPerHourReference).toBe(90);
  });

  it("env overrides per class and rejects unknown classes", () => {
    const c = computeClassesFromEnv({ COMPUTE_REFERENCE_USD_PER_HOUR_JSON: JSON.stringify({ "gpu.c24": 0.5 }), COMPUTE_REFERENCE_USD_PER_VCPU_HOUR: "0.01" });
    expect(c["gpu.c24"].usdPerHourReference).toBe(0.5);
    expect(c["cpu.std"].usdPerHourReference).toBe(0.01);
    expect(() => computeClassesFromEnv({ COMPUTE_REFERENCE_USD_PER_HOUR_JSON: JSON.stringify({ "gpu.x": 1 }) })).toThrow(/unknown class/);
  });

  it("model size and modality multiply the per-second rate", () => {
    expect(modelSizeMultiplier(undefined)).toBe(1);
    expect(modelSizeMultiplier(9)).toBe(1.5);
    expect(modelSizeMultiplier(30)).toBe(2.5);
    expect(modelSizeMultiplier(120)).toBe(4);
    expect(creditRatePerSecond("gpu", 30)).toBe(10);
    expect(modalityMultiplier(["tools"])).toBe(1);
    expect(modalityMultiplier(["vision", "thinking"])).toBeCloseTo(1.375, 4);
  });

  it("reserve estimate and network fee split", () => {
    expect(estimateReserveCredits({ resourceClass: "cpu", timeoutMs: 30_000, expectedSeconds: 10, subtaskCount: 2 })).toBe(20);
    expect(estimateReserveCredits({ resourceClass: "gpu", modelParamSizeB: 30, timeoutMs: 5_000, expectedSeconds: 10, subtaskCount: 1 })).toBe(50);
    expect(estimateReserveCredits({ resourceClass: "cpu", timeoutMs: 100, expectedSeconds: 10, subtaskCount: 1 })).toBe(1);
    expect(splitNetworkFee(100, 500)).toEqual({ worker: 95, fee: 5 });
    expect(splitNetworkFee(100, 0)).toEqual({ worker: 100, fee: 0 });
  });
});

describe("rate epoch class rates", () => {
  it("carries a rate for every class, live sources override one class only", () => {
    const cfg = { ...DEFAULT_RATE_ORACLE_CONFIG, hashpriceEnabled: false };
    const e = computeRateEpoch(
      {
        btcUsdQuotes: [q("a", 100_000), q("b", 100_000)],
        computeQuotes: [{ name: "gpu-market", ok: true, value: 0.5, resourceClass: "gpu", computeClass: "gpu.c24" } as SourceQuote]
      },
      null,
      cfg,
      1_000
    );
    expect(Object.keys(e.classRates)).toHaveLength(9);
    expect(e.classRates["gpu.c24"]).toMatchObject({ usdPerHour: 0.5, source: "gpu-market" });
    expect(e.classRates["cpu.std"]).toMatchObject({ usdPerHour: 0.02, source: "reference", msatPerCredit: 7 });
    expect(e.classRates["gpu.dc80"]!.satsPerUnitHour).toBeCloseTo(2160, 0); // 1.8 USD + 20 % at 100k
  });
});

describe("compute order book", () => {
  it("tracking asks follow the reference; explicit asks do not", () => {
    const book = new ComputeOrderBook();
    book.setReference("cpu.std", 7);
    book.postAsk("a1", "cpu.std", undefined, 1);
    book.postAsk("a2", "cpu.std", 9, 1);
    book.setReference("cpu.std", 10);
    expect(book.askFor("a1")?.msatPerCredit).toBe(10);
    expect(book.askFor("a2")?.msatPerCredit).toBe(9);
  });

  it("matches only when the ask is within the bid and the class fits; prices at the ask", () => {
    const book = new ComputeOrderBook();
    book.setReference("cpu.std", 7);
    book.setReference("gpu.c24", 100);
    book.postAsk("cheap", "cpu.std", 6);
    book.postAsk("pricey", "cpu.std", 12);
    book.postAsk("gpu", "gpu.c24", 100);
    book.postBid("t1", "cpu.std", undefined, 1000); // 7 × 1.1 = 8
    expect(book.canMatch("cheap", "t1")).toEqual({ ok: true, msatPerCredit: 6, computeClass: "cpu.std" });
    expect(book.canMatch("pricey", "t1")).toEqual({ ok: false, reason: "ask_above_bid" });
    expect(book.canMatch("gpu", "t1")).toEqual({ ok: false, reason: "class_mismatch" });
    expect(book.canMatch("nobody", "t1")).toEqual({ ok: false, reason: "no_ask" });
    book.postBid("t2", "any", 500);
    expect(book.canMatch("gpu", "t2").ok).toBe(true);
    expect(book.canMatch("cheap", "legacy-no-bid").ok).toBe(true);
  });

  it("a one-sided book quotes the reference as mid and bids can be pruned", () => {
    const book = new ComputeOrderBook();
    book.setReference("cpu.std", 10);
    book.postBid("t1", "cpu.std", 85, 0, 1_000);
    expect(book.snapshot("cpu.std", 2_000)).toMatchObject({ bestBid: 85, bestAsk: undefined, midMsatPerCredit: 10, openTasks: 1 });
    expect(book.pruneBids((b) => b.taskId === "t1")).toBe(1);
    expect(book.snapshot("cpu.std", 2_000).openTasks).toBe(0);
    expect(book.hasReference("cpu.std")).toBe(true);
    expect(book.hasReference("gpu.c24")).toBe(false);
  });

  it("snapshot reports spread, mid and clearing price", () => {
    const book = new ComputeOrderBook({ tradeWindowMs: 60_000 });
    book.setReference("cpu.std", 10);
    book.postAsk("a", "cpu.std", 8);
    book.postAsk("b", "cpu.std", 8);
    book.postAsk("c", "cpu.std", 12);
    book.postBid("t1", "cpu.std", 9);
    book.postBid("t2", "cpu.std", 11);
    const s0 = book.snapshot("cpu.std", 1_000);
    expect(s0).toMatchObject({ bestAsk: 8, bestBid: 11, spreadMsat: -3, midMsatPerCredit: 10, clearingMsatPerCredit: 10, agents: 3, openTasks: 2 });
    expect(s0.asks).toEqual([{ msatPerCredit: 8, count: 2 }, { msatPerCredit: 12, count: 1 }]);
    book.recordTrade({ taskId: "t1", subtaskId: "s1", agentId: "a", computeClass: "cpu.std", msatPerCredit: 8, atMs: 1_000 });
    book.recordTrade({ taskId: "t2", subtaskId: "s2", agentId: "c", computeClass: "cpu.std", msatPerCredit: 12, atMs: 2_000 });
    expect(book.snapshot("cpu.std", 3_000).clearingMsatPerCredit).toBe(10);
    expect(book.snapshot("cpu.std", 100_000).clearingMsatPerCredit).toBe(10); // window expired -> reference
    expect(book.snapshot("cpu.std", 100_000).recentTrades).toBe(0);
  });
});
