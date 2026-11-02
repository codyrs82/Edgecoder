import { describe, expect, it } from "vitest";
import { createPublicPricingSource, formatSats, formatUsd, pricingFromRateEpoch, referencePricing } from "../../src/portal/public-pricing.js";
import { marketingHomeHtml } from "../../src/portal/pages/public.js";

const epoch = {
  btcUsd: 77_931,
  createdAtMs: Date.UTC(2026, 10, 1, 12, 0),
  classRates: {
    "cpu.std": { usdPerHour: 0.02, satsPerUnitHour: 30.8, source: "reference" },
    "gpu.dc80": { usdPerHour: 1.8, satsPerUnitHour: 2771.6, source: "gpu-market" }
  }
};

describe("public pricing", () => {
  it("reference mode has every class with USD only", () => {
    const p = referencePricing();
    expect(p.mode).toBe("reference");
    expect(p.classes).toHaveLength(9);
    expect(p.classes.every((c) => c.satsPerHour === undefined)).toBe(true);
  });

  it("live mode takes sats from the epoch and keeps references for classes it lacks", () => {
    const p = pricingFromRateEpoch(epoch);
    expect(p.mode).toBe("live");
    expect(p.btcUsd).toBe(77_931);
    const cpu = p.classes.find((c) => c.id === "cpu.std")!;
    expect(cpu.satsPerHour).toBe(30.8);
    const c24 = p.classes.find((c) => c.id === "gpu.c24")!;
    expect(c24.satsPerHour).toBeUndefined();
    expect(c24.usdPerHour).toBe(0.35);
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
    expect(html).toContain("2,772 <small>sats/h</small>");
    expect(html).toContain("BTC $77,931");
    const fallback = marketingHomeHtml();
    expect(fallback).toContain("reference prices");
    expect(fallback).toContain("$1.80/h");
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
