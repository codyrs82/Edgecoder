import { describe, expect, test } from "vitest";
import { computeDynamicPricePerComputeUnitSats, creditsForSats, satsForCredits } from "../../src/economy/pricing.js";

describe("economy pricing", () => {
  test("increases price when demand outpaces supply", () => {
    const lowDemand = computeDynamicPricePerComputeUnitSats("cpu", {
      cpuCapacity: 50,
      gpuCapacity: 5,
      queuedTasks: 10,
      activeAgents: 10
    });
    const highDemand = computeDynamicPricePerComputeUnitSats("cpu", {
      cpuCapacity: 10,
      gpuCapacity: 2,
      queuedTasks: 100,
      activeAgents: 50
    });
    expect(highDemand).toBeGreaterThan(lowDemand);
  });

  test("converts sats to credits using current quote", () => {
    expect(creditsForSats(3000, 30)).toBe(100);
    expect(creditsForSats(2500, 30)).toBeCloseTo(83.333, 3);
  });

  test("converts earned credits to sats estimate", () => {
    expect(satsForCredits(100, 30)).toBe(3000);
    expect(satsForCredits(83.333, 30)).toBe(2499);
    expect(satsForCredits(0, 30)).toBe(0);
  });
});
