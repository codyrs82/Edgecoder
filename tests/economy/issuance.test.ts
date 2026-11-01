import { describe, expect, it } from "vitest";
import type { RollingContributionShare } from "../../src/common/types.js";
import {
  computeDailyPoolTokens,
  computeHourlyIssuanceAllocations,
  computeLoadIndex,
  smoothLoadIndex,
  type IssuancePoolConfig
} from "../../src/economy/issuance.js";

// #17: coverage for the issuance math (was 0%).
const config: IssuancePoolConfig = {
  baseDailyPoolTokens: 1000,
  minDailyPoolTokens: 500,
  maxDailyPoolTokens: 4000,
  loadCurveSlope: 0.5,
  smoothingAlpha: 0.3
};

function share(accountId: string, weightedContribution: number): RollingContributionShare {
  return { accountId, cpuSeconds: 0, gpuSeconds: 0, avgQualityScore: 1, reliabilityScore: 1, weightedContribution };
}

describe("computeLoadIndex", () => {
  it("is demand over capacity, with GPUs counting double", () => {
    expect(computeLoadIndex({ queuedTasks: 6, activeAgents: 4, cpuCapacity: 6, gpuCapacity: 2 })).toBe(1);
    expect(computeLoadIndex({ queuedTasks: 15, activeAgents: 5, cpuCapacity: 10, gpuCapacity: 0 })).toBe(2);
  });

  it("clamps to [0.2, 6]", () => {
    expect(computeLoadIndex({ queuedTasks: 0, activeAgents: 0, cpuCapacity: 100, gpuCapacity: 0 })).toBe(0.2);
    expect(computeLoadIndex({ queuedTasks: 1000, activeAgents: 0, cpuCapacity: 1, gpuCapacity: 0 })).toBe(6);
  });

  it("never divides by zero (capacity and demand floor at 1)", () => {
    expect(computeLoadIndex({ queuedTasks: 0, activeAgents: 0, cpuCapacity: 0, gpuCapacity: 0 })).toBe(1);
    expect(computeLoadIndex({ queuedTasks: -5, activeAgents: -5, cpuCapacity: -3, gpuCapacity: -1 })).toBe(1);
  });

  it("rounds to 6 decimals", () => {
    expect(computeLoadIndex({ queuedTasks: 1, activeAgents: 0, cpuCapacity: 3, gpuCapacity: 0 })).toBe(0.333333);
  });
});

describe("smoothLoadIndex", () => {
  it("returns the current value when there is no usable previous value", () => {
    expect(smoothLoadIndex(null, 2, 0.5)).toBe(2);
    expect(smoothLoadIndex(Number.NaN, 2, 0.5)).toBe(2);
    expect(smoothLoadIndex(Number.POSITIVE_INFINITY, 2, 0.5)).toBe(2);
  });

  it("is an exponential moving average", () => {
    expect(smoothLoadIndex(1, 2, 0.25)).toBe(1.25);
    expect(smoothLoadIndex(4, 2, 1)).toBe(2);
  });

  it("clamps alpha to [0.01, 1]", () => {
    expect(smoothLoadIndex(1, 2, 0)).toBe(1.01);
    expect(smoothLoadIndex(1, 2, -3)).toBe(1.01);
    expect(smoothLoadIndex(1, 2, 7)).toBe(2);
  });
});

describe("computeDailyPoolTokens", () => {
  it("is the base pool at or below load 1", () => {
    expect(computeDailyPoolTokens(1, config)).toBe(1000);
    expect(computeDailyPoolTokens(0.2, { ...config, minDailyPoolTokens: 0 })).toBe(1000);
  });

  it("grows linearly with load above 1", () => {
    expect(computeDailyPoolTokens(3, config)).toBe(2000);
  });

  it("is clamped to [min, max]", () => {
    expect(computeDailyPoolTokens(6, { ...config, loadCurveSlope: 10 })).toBe(4000);
    expect(computeDailyPoolTokens(1, { ...config, baseDailyPoolTokens: 10 })).toBe(500);
  });
});

describe("computeHourlyIssuanceAllocations", () => {
  it("splits 1/24 of the daily pool by weighted contribution", () => {
    const out = computeHourlyIssuanceAllocations([share("a", 3), share("b", 1)], 2400);
    expect(out).toEqual([
      { accountId: "a", weightedContribution: 3, allocationShare: 0.75, issuedTokens: 75 },
      { accountId: "b", weightedContribution: 1, allocationShare: 0.25, issuedTokens: 25 }
    ]);
  });

  it("drops zero and negative contributions, and they don't dilute others", () => {
    const out = computeHourlyIssuanceAllocations([share("a", 2), share("z", 0), share("neg", -5)], 240);
    expect(out.map((r) => r.accountId)).toEqual(["a"]);
    expect(out[0].allocationShare).toBe(1);
    expect(out[0].issuedTokens).toBe(10);
  });

  it("issues nothing with no positive contribution or no pool", () => {
    expect(computeHourlyIssuanceAllocations([], 2400)).toEqual([]);
    expect(computeHourlyIssuanceAllocations([share("a", 0)], 2400)).toEqual([]);
    expect(computeHourlyIssuanceAllocations([share("a", 1)], 0)).toEqual([]);
    expect(computeHourlyIssuanceAllocations([share("a", 1)], -24)).toEqual([]);
  });

  it("never issues more than the hourly pool (rounding included)", () => {
    const shares = Array.from({ length: 7 }, (_, i) => share(`acct-${i}`, 1 + i * 0.137));
    const out = computeHourlyIssuanceAllocations(shares, 1000);
    const issued = out.reduce((sum, r) => sum + r.issuedTokens, 0);
    expect(issued).toBeLessThanOrEqual(1000 / 24 + 1e-5);
    expect(issued).toBeGreaterThan(1000 / 24 - 1e-4);
    expect(out.reduce((sum, r) => sum + r.allocationShare, 0)).toBeCloseTo(1, 6);
  });
});
