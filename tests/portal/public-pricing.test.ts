import { describe, expect, it } from "vitest";
import { createPublicPricingSource, formatSats, formatUsd, pricingFromRateEpoch, referencePricing } from "../../src/portal/public-pricing.js";
import { marketingHomeHtml } from "../../src/portal/pages/public.js";

const epoch = {
  btcUsd: 77_931,
  createdAtMs: Date.UTC(2026, 10, 1, 12, 0),
  classRates: {
    cpu: { usdPerHour: 0.02, satsPerUnitHour: 30.8, source: "reference" },
    "gpu.dc": {
      usdPerHour: 0.7,
      satsPerUnitHour: 1077.9,
      source: "gpu-market",
      tiers: [
        { tier: "gpu.dc40", creditsPerSecond: 1, satsPerHour: 1077.9 },
        { tier: "gpu.dc80", creditsPerSecond: 2.5, satsPerHour: 2694.75 } // coordinator-overridden weight wins
      ]
    }
  }
};

describe("public pricing", () => {
  it("reference mode has the four classes with their weight tables, USD only", () => {
    const p = referencePricing();
    expect(p.mode).toBe("reference");
    expect(p.classes.map((c) => c.id)).toEqual(["cpu", "apple", "gpu", "gpu.dc"]);
    expect(p.classes.every((c) => c.satsPerHour === undefined && c.tiers.every((t) => t.satsPerHour === undefined))).toBe(true);
    const gpu = p.classes.find((c) => c.id === "gpu")!;
    expect(gpu.tiers.map((t) => [t.id, t.creditsPerSecond, t.usdPerHour])).toEqual([
      ["gpu.c8", 1, 0.1],
      ["gpu.c16", 2, 0.2],
      ["gpu.c24", 3.5, 0.35],
      ["gpu.c32", 4.5, 0.45]
    ]);
  });

  it("live mode takes sats from the epoch and keeps references for classes it lacks", () => {
    const p = pricingFromRateEpoch(epoch);
    expect(p.mode).toBe("live");
    expect(p.btcUsd).toBe(77_931);
    const cpu = p.classes.find((c) => c.id === "cpu")!;
    expect(cpu.satsPerHour).toBe(30.8);
    expect(cpu.tiers.find((t) => t.id === "cpu.hi")!.satsPerHour).toBeCloseTo(123.2, 6); // 30.8 × 4
    const gpu = p.classes.find((c) => c.id === "gpu")!;
    expect(gpu.satsPerHour).toBeUndefined();
    expect(gpu.usdPerHour).toBe(0.1);
    const dc80 = p.classes.find((c) => c.id === "gpu.dc")!.tiers.find((t) => t.id === "gpu.dc80")!;
    expect(dc80.creditsPerSecond).toBe(2.5);
    expect(dc80.satsPerHour).toBeCloseTo(2694.75, 6);
  });

  it("an epoch from a coordinator still on the nine-class build prices the classes from their legacy base tiers", () => {
    const p = pricingFromRateEpoch({
      btcUsd: 77_931,
      createdAtMs: 0,
      classRates: { "cpu.std": { usdPerHour: 0.02, satsPerUnitHour: 30.8, source: "reference" }, "gpu.c8": { usdPerHour: 0.1, satsPerUnitHour: 154, source: "reference" } }
    });
    expect(p.classes.find((c) => c.id === "cpu")!.satsPerHour).toBe(30.8);
    expect(p.classes.find((c) => c.id === "gpu")!.tiers.find((t) => t.id === "gpu.c24")!.satsPerHour).toBeCloseTo(539, 6);
    expect(p.classes.find((c) => c.id === "apple")!.satsPerHour).toBeUndefined();
  });

  it("formats sats and dollars for the page", () => {
    expect(formatSats(30.8)).toBe("30.8");
    expect(formatSats(2771.6)).toBe("2,772");
    expect(formatSats(7.25)).toBe("7.25");
    expect(formatUsd(0.02)).toBe("$0.02");
    expect(formatUsd(0.35)).toBe("$0.35");
    expect(formatUsd(0.3)).toBe("$0.30");
    expect(formatUsd(0.004)).toBe("$0.004");
    expect(formatUsd(1.8)).toBe("$1.80");
    expect(formatUsd(77_931)).toBe("$77,931");
  });

  it("the home page shows sats per hour first and the USD conversion under it", () => {
    const html = marketingHomeHtml(pricingFromRateEpoch(epoch));
    expect(html).toContain('30.8 <small>sats/h</small>');
    expect(html).toContain("≈ $0.02/h");
    expect(html).toContain("2,695 <small>sats/h</small>"); // gpu.dc80 tier hour
    expect(html).toContain("BTC $77,931");
    for (const pair of ["CPU / BTC", "Apple silicon / BTC", "GPU / BTC", "Datacenter GPU / BTC"]) expect(html).toContain(pair);
    expect(html).toContain("3.5×");
    const fallback = marketingHomeHtml();
    expect(fallback).toContain("reference prices");
    expect(fallback).toContain("$0.35/h"); // 24 GB GPU-hour = 3.5 GPU credit-hours
    expect(fallback).toContain("$2.03/h");
  });

  it("caches the epoch, serves the last good value on failure, and falls back to references", async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const source = createPublicPricingSource(
      async () => {
        calls++;
        if (fail) throw new Error("down");
        return epoch;
      },
      { ttlMs: 1000, now: () => now }
    );
    expect((await source()).mode).toBe("live");
    expect((await source()).mode).toBe("live");
    expect(calls).toBe(1);
    now = 2000;
    fail = true;
    expect((await source()).mode).toBe("live"); // last good value
    expect(calls).toBe(2);

    const cold = createPublicPricingSource(async () => { throw new Error("down"); }, { ttlMs: 1000, now: () => now });
    expect((await cold()).mode).toBe("reference");
  });
});
