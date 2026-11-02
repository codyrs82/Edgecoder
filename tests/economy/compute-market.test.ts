import { describe, expect, it } from "vitest";
import {
  COMPUTE_CLASS_IDS,
  DEFAULT_COMPUTE_CLASSES,
  LEGACY_COMPUTE_CLASS_IDS,
  classifyHardware,
  computeClassesFromEnv,
  legacyClassConstraints,
  legacyMsatToCurrent,
  modalityMultiplier,
  normalizeComputeClass,
  resolveRequestedClass,
  satsPerCreditForClass,
  tierSpec,
  type ComputeTierId,
  settlementClassFor
} from "../../src/economy/compute-classes.js";
import { ComputeOrderBook, clampToClassReference, meetsCapability } from "../../src/economy/order-book.js";
import { DEFAULT_RATE_ORACLE_CONFIG, computeRateEpoch, normalizeRateEpoch, type RateEpoch, type SourceQuote } from "../../src/economy/rate-oracle.js";
import { contributionCredits, creditRatePerSecond, estimateReserveCredits, modelSizeMultiplier, splitNetworkFee } from "../../src/credits/pricing.js";

const q = (name: string, value: number): SourceQuote => ({ name, ok: true, value });

/** USD/hour of every tier before the four-class model (the old per-class references). */
const OLD_TIER_USD_PER_HOUR: Record<string, number> = {
  "cpu.std": 0.02,
  "cpu.hi": 0.08,
  "apple.m": 0.12,
  "apple.m.hi": 0.3,
  "gpu.c8": 0.1,
  "gpu.c16": 0.2,
  "gpu.c24": 0.35,
  "gpu.dc40": 0.7
};

describe("compute classes: classification and weights", () => {
  it("four class-markets", () => {
    expect(COMPUTE_CLASS_IDS).toEqual(["cpu", "apple", "gpu", "gpu.dc"]);
    expect(Object.keys(DEFAULT_COMPUTE_CLASSES)).toEqual(COMPUTE_CLASS_IDS);
    for (const spec of Object.values(DEFAULT_COMPUTE_CLASSES)) expect(spec.tiers[0].creditsPerSecond).toBe(1); // base tier
  });

  it("classifies hardware into class, tier, weight and capability", () => {
    expect(classifyHardware(undefined)).toEqual({ computeClass: "cpu", tier: "cpu.std", creditsPerSecond: 1 });
    expect(classifyHardware({ cpuCores: 8, ramGb: 16, platform: "linux", arch: "x64" })).toEqual({ computeClass: "cpu", tier: "cpu.std", creditsPerSecond: 1, memoryGb: 16 });
    expect(classifyHardware({ cpuCores: 64, ramGb: 256, platform: "linux" })).toMatchObject({ computeClass: "cpu", tier: "cpu.hi", creditsPerSecond: 4 });
    expect(classifyHardware({ cpuCores: 8, ramGb: 128, platform: "linux" })).toMatchObject({ tier: "cpu.hi", creditsPerSecond: 4 });
    expect(classifyHardware({ platform: "darwin", arch: "arm64", ramGb: 16 })).toEqual({ computeClass: "apple", tier: "apple.m", creditsPerSecond: 1, memoryGb: 16 });
    expect(classifyHardware({ platform: "darwin", arch: "arm64", ramGb: 64 })).toMatchObject({ computeClass: "apple", tier: "apple.m.hi", creditsPerSecond: 2.5, memoryGb: 64 });
    expect(classifyHardware({ gpu: { vendor: "nvidia", model: "RTX 4060", vramGb: 8 } })).toEqual({ computeClass: "gpu", tier: "gpu.c8", creditsPerSecond: 1, vramGb: 8 });
    expect(classifyHardware({ gpu: { vendor: "nvidia", model: "RTX 3060", vramGb: 12 }, ramGb: 32 })).toEqual({ computeClass: "gpu", tier: "gpu.c16", creditsPerSecond: 2, vramGb: 12, memoryGb: 32 });
    expect(classifyHardware({ gpu: { vendor: "nvidia", model: "RTX 4090", vramGb: 24 } })).toMatchObject({ computeClass: "gpu", tier: "gpu.c24", creditsPerSecond: 3.5, vramGb: 24 });
    expect(classifyHardware({ gpu: { vendor: "nvidia", model: "RTX 5090", vramGb: 32 } })).toMatchObject({ computeClass: "gpu", tier: "gpu.c32", creditsPerSecond: 4.5, vramGb: 32 });
    expect(classifyHardware({ gpu: { vendor: "nvidia", model: "A6000", vramGb: 48 } })).toMatchObject({ computeClass: "gpu.dc", tier: "gpu.dc40", creditsPerSecond: 1, vramGb: 48 });
    expect(classifyHardware({ gpu: { vendor: "nvidia", model: "H100", vramGb: 80 } })).toMatchObject({ computeClass: "gpu.dc", tier: "gpu.dc80", creditsPerSecond: 2.9, vramGb: 80 });
    expect(classifyHardware({ gpu: { vendor: "nvidia", model: "unknown", vramGb: 80, datacenter: true } })).toMatchObject({ tier: "gpu.dc80" });
    expect(classifyHardware({ gpu: { vendor: "intel", model: "iris", vramGb: 2 }, cpuCores: 4 })).toMatchObject({ computeClass: "cpu", tier: "cpu.std", creditsPerSecond: 1 });
  });

  it("unknown or garbage hardware falls back to cpu at weight 1, and absurd sizes are capped", () => {
    expect(classifyHardware({})).toEqual({ computeClass: "cpu", tier: "cpu.std", creditsPerSecond: 1 });
    expect(classifyHardware({ gpu: { vendor: "nvidia", vramGb: Number.NaN } })).toEqual({ computeClass: "cpu", tier: "cpu.std", creditsPerSecond: 1 });
    expect(classifyHardware({ gpu: { vendor: "nvidia", vramGb: -4 }, ramGb: -1 })).toEqual({ computeClass: "cpu", tier: "cpu.std", creditsPerSecond: 1 });
    expect(classifyHardware({ gpu: { vendor: "nvidia", vramGb: 1e12 } }).vramGb).toBe(4096);
  });

  it("weights come from the (env-overridable) class table", () => {
    const classes = computeClassesFromEnv({ COMPUTE_TIER_WEIGHTS_JSON: JSON.stringify({ "gpu.c24": 3.2 }) });
    expect(classifyHardware({ gpu: { vendor: "nvidia", vramGb: 24 } }, classes).creditsPerSecond).toBe(3.2);
    expect(classes.gpu.usdPerHourReference).toBe(0.1); // the class reference does not move with a weight
    expect(() => computeClassesFromEnv({ COMPUTE_TIER_WEIGHTS_JSON: JSON.stringify({ "gpu.c8": 2 }) })).toThrow(/base tier/);
    expect(() => computeClassesFromEnv({ COMPUTE_TIER_WEIGHTS_JSON: JSON.stringify({ "gpu.c99": 2 }) })).toThrow(/unknown tier/);
    expect(() => computeClassesFromEnv({ COMPUTE_TIER_WEIGHTS_JSON: JSON.stringify({ "gpu.c24": 0 }) })).toThrow(/positive/);
  });
});

describe("compute classes: flat per-class price", () => {
  it("credits × the class price reproduces the old per-tier hourly references", () => {
    const btc = 100_000;
    for (const [tier, usd] of Object.entries(OLD_TIER_USD_PER_HOUR)) {
      const cls = normalizeComputeClass(tier)!;
      const spec = DEFAULT_COMPUTE_CLASSES[cls];
      const perCredit = satsPerCreditForClass(spec.usdPerHourReference, btc, 0); // flat within the class
      const weight = tierSpec(DEFAULT_COMPUTE_CLASSES, tier as ComputeTierId)!.creditsPerSecond;
      const creditsPerHour = weight * 3600;
      expect(perCredit * creditsPerHour).toBeCloseTo((usd / btc) * 1e8, 3);
    }
    // The owner's weights move two tiers off the old references: > 24 GB consumer cards were
    // priced as gpu.dc40 ($0.70/h) and are now gpu at 4.5 ($0.45/h); gpu.dc80 is 2.9 × $0.70 = $2.03/h (was $1.80).
    expect(DEFAULT_COMPUTE_CLASSES.gpu.usdPerHourReference * 4.5).toBeCloseTo(0.45, 9);
    expect(DEFAULT_COMPUTE_CLASSES["gpu.dc"].usdPerHourReference * 2.9).toBeCloseTo(2.03, 9);
  });

  it("a 24 GB GPU-hour is 3.5 GPU-credit-hours through the real accrual formula", () => {
    const load = { queuedTasks: 1, activeAgents: 1 }; // load multiplier 1.0
    const hw = classifyHardware({ gpu: { vendor: "nvidia", model: "RTX 4090", vramGb: 24 } });
    const credits = contributionCredits({ resourceClass: "gpu", cpuSeconds: 0, gpuSeconds: 3600, qualityScore: 1, success: true, hardwareWeight: hw.creditsPerSecond }, load);
    expect(credits).toBe(3.5 * 3600);
    // Same seconds on an 8 GB card mint a third as much... of the same-priced credit.
    const small = contributionCredits({ resourceClass: "gpu", cpuSeconds: 0, gpuSeconds: 3600, qualityScore: 1, success: true, hardwareWeight: 1 }, load);
    expect(small).toBe(3600);
    // Without a weight (BLE mesh, older callers) the cpu/gpu base rate is unchanged.
    expect(contributionCredits({ resourceClass: "gpu", cpuSeconds: 0, gpuSeconds: 10, qualityScore: 1, success: true }, load)).toBe(40);
    expect(creditRatePerSecond("gpu", 30, 3.5)).toBe(8.75); // weight × model size 2.5
  });

  it("env overrides references by class id, by tier id (tier hour) and by the legacy knobs", () => {
    const c = computeClassesFromEnv({ COMPUTE_REFERENCE_USD_PER_HOUR_JSON: JSON.stringify({ gpu: 0.12, "apple.m.hi": 0.5 }), COMPUTE_REFERENCE_USD_PER_VCPU_HOUR: "0.01" });
    expect(c.gpu.usdPerHourReference).toBe(0.12);
    expect(c.apple.usdPerHourReference).toBeCloseTo(0.2, 9); // 0.5 / 2.5
    expect(c.cpu.usdPerHourReference).toBe(0.01);
    expect(computeClassesFromEnv({ COMPUTE_REFERENCE_USD_PER_GPU_HOUR: "0.42" }).gpu.usdPerHourReference).toBeCloseTo(0.12, 9); // 4090 hour / 3.5
    expect(computeClassesFromEnv({ COMPUTE_REFERENCE_USD_PER_HOUR_JSON: JSON.stringify({ "gpu.c24": 0.7, gpu: 0.15 }) }).gpu.usdPerHourReference).toBe(0.15); // class key wins
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
  const cfg = { ...DEFAULT_RATE_ORACLE_CONFIG, hashpriceEnabled: false };

  it("one rate per class (four), with the tier hours; live sources override one class only", () => {
    const e = computeRateEpoch(
      {
        btcUsdQuotes: [q("a", 100_000), q("b", 100_000)],
        computeQuotes: [{ name: "dc-market", ok: true, value: 0.8, resourceClass: "gpu", computeClass: "gpu.dc" } as SourceQuote]
      },
      null,
      cfg,
      1_000
    );
    expect(Object.keys(e.classRates)).toEqual(["cpu", "apple", "gpu", "gpu.dc"]);
    expect(e.classRates["gpu.dc"]).toMatchObject({ usdPerHour: 0.8, source: "dc-market" });
    expect(e.classRates.cpu).toMatchObject({ usdPerHour: 0.02, source: "reference", msatPerCredit: 7 });
    expect(e.classRates.gpu).toMatchObject({ usdPerHour: 0.1, source: "reference" }); // 0.35 4090-hour / 3.5
    expect(e.classRates.gpu!.satsPerUnitHour).toBeCloseTo(120, 3); // 0.10 USD + 20 % at 100k
    const c24 = e.classRates.gpu!.tiers!.find((t) => t.tier === "gpu.c24")!;
    expect(c24).toMatchObject({ creditsPerSecond: 3.5 });
    expect(c24.satsPerHour).toBeCloseTo(420, 3); // same as the old gpu.c24 hour and epoch.satsPerGpuHour
    expect(c24.satsPerHour).toBeCloseTo(e.satsPerGpuHour, 3);
  });

  it("a live source tagged with a tier id prices that tier's hour", () => {
    const e = computeRateEpoch(
      { btcUsdQuotes: [q("a", 100_000), q("b", 100_000)], computeQuotes: [{ name: "4090s", ok: true, value: 0.42, computeClass: "gpu.c24" } as SourceQuote] },
      null,
      cfg,
      1_000
    );
    expect(e.classRates.gpu!.usdPerHour).toBeCloseTo(0.12, 9);
    expect(e.classRates.gpu!.source).toBe("4090s");
  });

  it("an epoch persisted under the nine legacy ids normalizes to the same four class references", () => {
    const fresh = computeRateEpoch({ btcUsdQuotes: [q("a", 80_000), q("b", 80_000)], computeQuotes: [] }, null, cfg, 1_000);
    // What the nine-class oracle stored at the same BTC/USD: per-credit = tier hour / (old credits/s × 3600).
    const oldCps: Record<string, number> = { "cpu.std": 1, "cpu.hi": 1, "apple.m": 2, "apple.m.hi": 3, "gpu.c8": 2, "gpu.c16": 3, "gpu.c24": 4, "gpu.dc40": 6, "gpu.dc80": 10 };
    const oldUsd: Record<string, number> = { ...OLD_TIER_USD_PER_HOUR, "gpu.dc80": 1.8 };
    const legacyRates: Record<string, unknown> = {};
    for (const id of LEGACY_COMPUTE_CLASS_IDS) {
      const unitHour = Number(((oldUsd[id] / 80_000) * 1e8 * 1.2).toFixed(3));
      const perCredit = Number((unitHour / (oldCps[id] * 3600)).toFixed(9));
      legacyRates[id] = { computeClass: id, usdPerHour: oldUsd[id], satsPerUnitHour: unitHour, satsPerCredit: perCredit, msatPerCredit: Math.max(1, Math.round(perCredit * 1000)), source: "reference" };
    }
    const stored = { ...fresh, classRates: legacyRates } as unknown as RateEpoch;
    const norm = normalizeRateEpoch(stored);
    expect(Object.keys(norm.classRates)).toEqual(["cpu", "apple", "gpu", "gpu.dc"]);
    for (const id of COMPUTE_CLASS_IDS) {
      expect(norm.classRates[id]!.msatPerCredit).toBe(fresh.classRates[id]!.msatPerCredit);
      expect(norm.classRates[id]!.satsPerCredit).toBeCloseTo(fresh.classRates[id]!.satsPerCredit, 6);
    }
    expect(stored.classRates).toBe(legacyRates); // the stored row is not rewritten
    expect(normalizeRateEpoch(fresh)).toBe(fresh); // current epochs pass through
  });

  it("the accrual valuation clamp works per new class, including on a normalized legacy epoch", () => {
    const e = computeRateEpoch({ btcUsdQuotes: [q("a", 100_000), q("b", 100_000)], computeQuotes: [] }, null, cfg, 1_000);
    for (const id of COMPUTE_CLASS_IDS) {
      const ref = e.classRates[id]!.msatPerCredit;
      expect(clampToClassReference(ref * 100, ref)).toBe(ref * 4); // self-dealing ask cannot inflate
      expect(clampToClassReference(1, ref)).toBe(Math.max(1, ref * 0.25));
      expect(clampToClassReference(ref * 2, ref)).toBe(ref * 2);
      expect(clampToClassReference(undefined, ref)).toBe(ref);
    }
    // A gpu.dc trade must be clamped against the gpu.dc reference, not cpu's.
    expect(clampToClassReference(1e9, e.classRates["gpu.dc"]!.msatPerCredit)).toBe(e.classRates["gpu.dc"]!.msatPerCredit * 4);
    expect(clampToClassReference(50, undefined)).toBe(50); // no oracle epoch: unchanged behavior
  });
});

describe("legacy class ids", () => {
  it("one map: every legacy id lands on its class; current ids pass; unknown ids do not", () => {
    expect(Object.fromEntries(LEGACY_COMPUTE_CLASS_IDS.map((id) => [id, normalizeComputeClass(id)]))).toEqual({
      "cpu.std": "cpu",
      "cpu.hi": "cpu",
      "apple.m": "apple",
      "apple.m.hi": "apple",
      "gpu.c8": "gpu",
      "gpu.c16": "gpu",
      "gpu.c24": "gpu",
      "gpu.dc40": "gpu.dc",
      "gpu.dc80": "gpu.dc"
    });
    for (const id of COMPUTE_CLASS_IDS) expect(normalizeComputeClass(id)).toBe(id);
    expect(normalizeComputeClass("gpu.c32")).toBe("gpu");
    expect(normalizeComputeClass("any")).toBeUndefined();
    expect(normalizeComputeClass("gpu.x")).toBeUndefined();
    expect(normalizeComputeClass(undefined)).toBeUndefined();
  });

  it("legacy prices convert to the current unit preserving the tier hour", () => {
    expect(legacyMsatToCurrent("cpu.std", 7)).toBe(7);
    expect(legacyMsatToCurrent("gpu.c8", 10)).toBe(20); // old gpu.c8 credit was half a second
    expect(legacyMsatToCurrent("gpu.c24", 35)).toBeCloseTo(40, 9); // × 4 / 3.5
    expect(legacyMsatToCurrent("gpu", 35)).toBe(35);
  });

  it("legacy ids keep the capability they implied", () => {
    expect(legacyClassConstraints("gpu.c24")).toEqual({ minVramGb: 17 });
    expect(legacyClassConstraints("gpu.c16")).toEqual({ minVramGb: 9 });
    expect(legacyClassConstraints("gpu.dc80")).toEqual({ minVramGb: 49 });
    expect(legacyClassConstraints("apple.m.hi")).toEqual({ minMemoryGb: 32 });
    expect(legacyClassConstraints("gpu.c8")).toEqual({});
    expect(legacyClassConstraints("gpu")).toEqual({});
  });
});

describe("API edges accept legacy ids (mapped, not rejected)", () => {
  it("a stale client bidding on gpu.c24 lands in gpu with the price converted and the 24 GB-class constraint kept", () => {
    expect(resolveRequestedClass("gpu.c24", 35)).toEqual({ computeClass: "gpu", msatPerCredit: 40, constraints: { minVramGb: 17 } });
    expect(resolveRequestedClass("gpu.c24", undefined, { minVramGb: 24 })).toEqual({ computeClass: "gpu", msatPerCredit: undefined, constraints: { minVramGb: 24 } });
    expect(resolveRequestedClass("cpu.std", 0)).toEqual({ computeClass: "cpu", msatPerCredit: 0, constraints: {} });
    expect(resolveRequestedClass("gpu", 35, { minVramGb: 24 })).toEqual({ computeClass: "gpu", msatPerCredit: 35, constraints: { minVramGb: 24 } });
    expect(resolveRequestedClass("any", 9)).toEqual({ computeClass: "any", msatPerCredit: 9, constraints: {} });
    expect(resolveRequestedClass("nope", 9).computeClass).toBeUndefined();
  });

  it("the resolved legacy bid excludes the cards the old class excluded", () => {
    const book = new ComputeOrderBook();
    book.setReference("gpu", 33);
    const r = resolveRequestedClass("gpu.c24", undefined);
    book.postBid("old-client", r.computeClass as "gpu", r.msatPerCredit, 1000, 1, r.constraints);
    book.postAsk("g12", "gpu", undefined, 1, { tier: "gpu.c16", creditsPerSecond: 2, vramGb: 12 });
    book.postAsk("g24", "gpu", undefined, 1, { tier: "gpu.c24", creditsPerSecond: 3.5, vramGb: 24 });
    expect(book.canMatch("g12", "old-client")).toEqual({ ok: false, reason: "below_min_spec" });
    expect(book.canMatch("g24", "old-client").ok).toBe(true);
  });
});

describe("compute order book", () => {
  it("tracking asks follow the reference; explicit asks do not", () => {
    const book = new ComputeOrderBook();
    book.setReference("cpu", 7);
    book.postAsk("a1", "cpu", undefined, 1);
    book.postAsk("a2", "cpu", 9, 1);
    book.setReference("cpu", 10);
    expect(book.askFor("a1")?.msatPerCredit).toBe(10);
    expect(book.askFor("a2")?.msatPerCredit).toBe(9);
  });

  it("matches only when the ask is within the bid and the class fits; prices at the ask", () => {
    const book = new ComputeOrderBook();
    book.setReference("cpu", 7);
    book.setReference("gpu", 100);
    book.postAsk("cheap", "cpu", 6);
    book.postAsk("pricey", "cpu", 12);
    book.postAsk("gpu", "gpu", 100);
    book.postBid("t1", "cpu", undefined, 1000); // 7 × 1.1 = 8
    expect(book.canMatch("cheap", "t1")).toEqual({ ok: true, msatPerCredit: 6, computeClass: "cpu" });
    expect(book.canMatch("pricey", "t1")).toEqual({ ok: false, reason: "ask_above_bid" });
    expect(book.canMatch("gpu", "t1")).toEqual({ ok: false, reason: "class_mismatch" });
    expect(book.canMatch("nobody", "t1")).toEqual({ ok: false, reason: "no_ask" });
    book.postBid("t2", "any", 500);
    expect(book.canMatch("gpu", "t2").ok).toBe(true);
    expect(book.canMatch("cheap", "legacy-no-bid").ok).toBe(true);
  });

  it("a constrained bid is filled only by asks whose hardware meets it", () => {
    const book = new ComputeOrderBook();
    book.setReference("gpu", 33);
    const card = (vramGb: number) => classifyHardware({ gpu: { vendor: "nvidia", vramGb } });
    for (const [id, vram] of [["g8", 8], ["g12", 12], ["g24", 24], ["g32", 32]] as const) {
      const hw = card(vram);
      book.postAsk(id, hw.computeClass, undefined, 1, { tier: hw.tier, creditsPerSecond: hw.creditsPerSecond, vramGb: hw.vramGb, memoryGb: hw.memoryGb });
    }
    book.postAsk("blind", "gpu", undefined, 1); // no capability reported
    // A 30B task: gpu market, at least 24 GB of VRAM.
    book.postBid("big", "gpu", undefined, 1000, 1, { minVramGb: 24 });
    expect(book.bidFor("big")).toMatchObject({ minVramGb: 24 });
    expect(book.canMatch("g12", "big")).toEqual({ ok: false, reason: "below_min_spec" });
    expect(book.canMatch("g8", "big")).toEqual({ ok: false, reason: "below_min_spec" });
    expect(book.canMatch("blind", "big")).toEqual({ ok: false, reason: "below_min_spec" });
    expect(book.canMatch("g24", "big")).toEqual({ ok: true, msatPerCredit: 33, computeClass: "gpu" });
    expect(book.canMatch("g32", "big").ok).toBe(true);
    // Default: no constraint, any card in the class may fill it.
    book.postBid("small", "gpu", undefined, 1000);
    expect(book.canMatch("g8", "small").ok).toBe(true);
    // Constraints apply to "any" bids too; memory constraints check unified/system memory.
    book.postAsk("mac", "apple", 1, 1, { tier: "apple.m.hi", creditsPerSecond: 2.5, memoryGb: 64 });
    book.postBid("mem", "any", 1e6, 0, 1, { minMemoryGb: 48 });
    expect(book.canMatch("mac", "mem").ok).toBe(true);
    expect(book.canMatch("g24", "mem")).toEqual({ ok: false, reason: "below_min_spec" });
    // Garbage constraints are ignored rather than blocking every agent.
    book.postBid("junk", "gpu", undefined, 1000, 1, { minVramGb: Number.NaN, minMemoryGb: -3 });
    expect(book.bidFor("junk")).not.toHaveProperty("minVramGb");
    expect(book.canMatch("g8", "junk").ok).toBe(true);
  });

  it("re-pricing an ask keeps its capability; meetsCapability reads task metadata", () => {
    const book = new ComputeOrderBook();
    book.postAsk("a", "gpu", undefined, 1, { tier: "gpu.c24", creditsPerSecond: 3.5, vramGb: 24 });
    book.postAsk("a", "gpu", 50, 2); // heartbeat / standing order re-price without capability
    expect(book.askFor("a")).toMatchObject({ msatPerCredit: 50, tier: "gpu.c24", creditsPerSecond: 3.5, vramGb: 24 });
    expect(meetsCapability({ vramGb: 12 }, { projectId: "p", resourceClass: "gpu", priority: 1, minVramGb: 24 } as { minVramGb: number })).toBe(false);
    expect(meetsCapability(undefined, {})).toBe(true);
  });

  it("a default 'any' bid pays each class its own reference × premium, not the dearest class's price", () => {
    const book = new ComputeOrderBook();
    book.setReference("cpu", 8);
    book.setReference("gpu.dc", 280); // ~35x cpu
    book.postAsk("cpu-ref", "cpu", undefined);
    book.postAsk("cpu-greedy", "cpu", 30); // 3.75x the cpu reference
    book.postAsk("dc", "gpu.dc", undefined);
    const bid = book.postBid("t", "any", undefined, 1000);
    expect(bid).toMatchObject({ premiumBps: 1000, maxMsatPerCredit: 308 });
    expect(book.canMatch("cpu-ref", "t").ok).toBe(true);
    expect(book.canMatch("dc", "t").ok).toBe(true);
    expect(book.canMatch("cpu-greedy", "t")).toEqual({ ok: false, reason: "ask_above_bid" });
    // The cpu book quotes the bid at the cpu ceiling, so the cpu mid is not dragged toward gpu.dc prices.
    expect(book.snapshot("cpu").bestBid).toBe(9);
    expect(book.snapshot("gpu.dc").bestBid).toBe(308);
    // An explicit "any" price is the requester's own ceiling everywhere.
    book.postBid("t2", "any", 40);
    expect(book.bidFor("t2")).not.toHaveProperty("premiumBps");
    expect(book.canMatch("cpu-greedy", "t2").ok).toBe(true);
  });

  it("a one-sided book quotes the reference as mid and bids can be pruned", () => {
    const book = new ComputeOrderBook();
    book.setReference("cpu", 10);
    book.postBid("t1", "cpu", 85, 0, 1_000);
    expect(book.snapshot("cpu", 2_000)).toMatchObject({ bestBid: 85, bestAsk: undefined, midMsatPerCredit: 10, openTasks: 1 });
    expect(book.pruneBids((b) => b.taskId === "t1")).toBe(1);
    expect(book.snapshot("cpu", 2_000).openTasks).toBe(0);
    expect(book.hasReference("cpu")).toBe(true);
    expect(book.hasReference("gpu")).toBe(false);
  });

  it("snapshot reports spread, mid and clearing price", () => {
    const book = new ComputeOrderBook({ tradeWindowMs: 60_000 });
    book.setReference("cpu", 10);
    book.postAsk("a", "cpu", 8);
    book.postAsk("b", "cpu", 8);
    book.postAsk("c", "cpu", 12);
    book.postBid("t1", "cpu", 9);
    book.postBid("t2", "cpu", 11);
    const s0 = book.snapshot("cpu", 1_000);
    expect(s0).toMatchObject({ bestAsk: 8, bestBid: 11, spreadMsat: -3, midMsatPerCredit: 10, clearingMsatPerCredit: 10, agents: 3, openTasks: 2 });
    expect(s0.asks).toEqual([{ msatPerCredit: 8, count: 2 }, { msatPerCredit: 12, count: 1 }]);
    book.recordTrade({ taskId: "t1", subtaskId: "s1", agentId: "a", computeClass: "cpu", msatPerCredit: 8, atMs: 1_000 });
    book.recordTrade({ taskId: "t2", subtaskId: "s2", agentId: "c", computeClass: "cpu", msatPerCredit: 12, atMs: 2_000 });
    expect(book.snapshot("cpu", 3_000).clearingMsatPerCredit).toBe(10);
    expect(book.snapshot("cpu", 100_000).clearingMsatPerCredit).toBe(10); // window expired -> reference
    expect(book.snapshot("cpu", 100_000).recentTrades).toBe(0);
  });
});

describe("settlementClassFor (self-reported hardware cap)", () => {
  it("pays CPU tasks as CPU work whatever hardware the agent claims", () => {
    expect(settlementClassFor("cpu", "gpu.dc", 2.9)).toEqual({ computeClass: "cpu", creditsPerSecond: 1 });
    expect(settlementClassFor("cpu", "apple", 2.5)).toEqual({ computeClass: "cpu", creditsPerSecond: 1 });
  });
  it("keeps a cpu agent's own tier, and the agent's class on GPU tasks", () => {
    expect(settlementClassFor("cpu", "cpu", 4)).toEqual({ computeClass: "cpu", creditsPerSecond: 4 });
    expect(settlementClassFor("gpu", "gpu.dc", 2.9)).toEqual({ computeClass: "gpu.dc", creditsPerSecond: 2.9 });
  });
});
