import { describe, expect, it } from "vitest";
import { computeDynamicPricePerComputeUnitSats, creditsForSats, satsForCredits } from "../../src/economy/pricing.js";

// #17: boundary coverage for the dynamic price and the sats/credits conversions.
const idle = { cpuCapacity: 100, gpuCapacity: 100, queuedTasks: 0, activeAgents: 0 };
const flooded = { cpuCapacity: 1, gpuCapacity: 1, queuedTasks: 10_000, activeAgents: 0 };

describe("computeDynamicPricePerComputeUnitSats bounds", () => {
  it("uses the cpu/gpu base price at balanced load (multiplier 1)", () => {
    expect(computeDynamicPricePerComputeUnitSats("cpu", { cpuCapacity: 10, gpuCapacity: 0, queuedTasks: 10, activeAgents: 0 })).toBe(30);
    expect(computeDynamicPricePerComputeUnitSats("gpu", { cpuCapacity: 0, gpuCapacity: 10, queuedTasks: 10, activeAgents: 0 })).toBe(120);
  });

  it("floors the multiplier near 0.65 when idle", () => {
    expect(computeDynamicPricePerComputeUnitSats("cpu", idle)).toBe(Math.round(30 * (0.65 + 0.01 * 0.35)));
    expect(computeDynamicPricePerComputeUnitSats("gpu", idle)).toBe(Math.round(120 * (0.65 + 0.01 * 0.35)));
  });

  it("caps the multiplier at 4x under extreme demand", () => {
    expect(computeDynamicPricePerComputeUnitSats("cpu", flooded)).toBe(120);
    expect(computeDynamicPricePerComputeUnitSats("gpu", flooded)).toBe(480);
  });

  it("gpu price only depends on gpu capacity, cpu on cpu capacity", () => {
    const a = computeDynamicPricePerComputeUnitSats("gpu", { cpuCapacity: 1, gpuCapacity: 5, queuedTasks: 5, activeAgents: 0 });
    const b = computeDynamicPricePerComputeUnitSats("gpu", { cpuCapacity: 999, gpuCapacity: 5, queuedTasks: 5, activeAgents: 0 });
    expect(a).toBe(b);
  });

  it("zero or negative inputs never produce a price below 1 or NaN", () => {
    for (const cls of ["cpu", "gpu"] as const) {
      const p = computeDynamicPricePerComputeUnitSats(cls, { cpuCapacity: 0, gpuCapacity: -4, queuedTasks: -1, activeAgents: 0 });
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(1);
    }
  });

  it("is monotonic in queued tasks", () => {
    let prev = 0;
    for (const queuedTasks of [0, 5, 10, 20, 40, 80, 200]) {
      const p = computeDynamicPricePerComputeUnitSats("cpu", { cpuCapacity: 10, gpuCapacity: 0, queuedTasks, activeAgents: 0 });
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

describe("sats <-> credits conversions", () => {
  it("creditsForSats returns 0 for a non-positive rate", () => {
    expect(creditsForSats(1000, 0)).toBe(0);
    expect(creditsForSats(1000, -30)).toBe(0);
  });

  it("creditsForSats rounds to 3 decimals", () => {
    expect(creditsForSats(1, 3)).toBe(0.333);
    expect(creditsForSats(2, 3)).toBe(0.667);
  });

  it("satsForCredits floors (never over-pays) and rejects non-positive input", () => {
    expect(satsForCredits(1.9999, 1)).toBe(1);
    expect(satsForCredits(-5, 30)).toBe(0);
    expect(satsForCredits(5, 0)).toBe(0);
    expect(satsForCredits(5, -1)).toBe(0);
  });

  it("a round trip never yields more sats than went in", () => {
    for (const sats of [1, 29, 30, 31, 1000, 12345]) {
      for (const rate of [1, 3, 7, 30, 1000]) {
        expect(satsForCredits(creditsForSats(sats, rate), rate)).toBeLessThanOrEqual(sats);
      }
    }
  });
});
