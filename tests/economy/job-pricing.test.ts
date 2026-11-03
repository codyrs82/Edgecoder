import { describe, expect, it } from "vitest";
import { clampToBand, cSatsToMsat, jobCostMsat, msatToCSats, ratePerSecondMsat, reserveMsat, splitJobCost } from "../../src/economy/job-pricing.js";

describe("job pricing (cSats = sats)", () => {
  it("prices measured seconds at the tier's rate", () => {
    // 200 msat per base-tier second, a tier with weight 4.5: 900 msat/s; 12.4 s of work.
    const rate = ratePerSecondMsat(200, 4.5);
    expect(rate).toBe(900);
    expect(jobCostMsat(12_400, rate)).toBe(11_160);
    expect(jobCostMsat(0, rate)).toBe(0);
  });

  it("keeps a matched price inside the class band", () => {
    expect(clampToBand(10_000, 200)).toBe(800);
    expect(clampToBand(1, 200)).toBe(50);
    expect(clampToBand(undefined, 200)).toBe(200);
    expect(clampToBand(300, 200)).toBe(300);
  });

  it("splits the network fee out of the cost; the parts add up", () => {
    const { agentMsat, feeMsat } = splitJobCost(11_160, 500);
    expect(feeMsat).toBe(558);
    expect(agentMsat + feeMsat).toBe(11_160);
  });

  it("sets aside the worst case, or the requester's own ceiling", () => {
    // 30 s limit, 200 msat reference -> top of band 800, fastest tier 4.5: 108,000 msat.
    expect(reserveMsat({ timeoutMs: 30_000, classRefMsatPerCredit: 200, maxTierWeight: 4.5 })).toBe(108_000);
    expect(reserveMsat({ timeoutMs: 30_000, classRefMsatPerCredit: 200, maxTierWeight: 4.5, bidCeilingMsatPerCredit: 250 })).toBe(33_750);
    // The worst case always covers the actual cost.
    const actual = jobCostMsat(30_000, ratePerSecondMsat(clampToBand(10_000, 200), 4.5));
    expect(actual).toBeLessThanOrEqual(reserveMsat({ timeoutMs: 30_000, classRefMsatPerCredit: 200, maxTierWeight: 4.5 }));
  });

  it("converts between msat and cSats", () => {
    expect(msatToCSats(11_160)).toBe(11.16);
    expect(cSatsToMsat(11.16)).toBe(11_160);
  });
});

import { cSatsPerMTokens, inferenceCostMsat, tokenPriceUsdPerM } from "../../src/economy/job-pricing.js";

describe("per-token pricing for model calls", () => {
  const base = { paramsB: 9, btcUsd: 100_000, durationMs: 10_000, computeClass: "apple", tierWeight: 3, perSecondCostMsat: 1_560 };

  it("prices by size, below hosted list prices", () => {
    expect(tokenPriceUsdPerM(1.5)).toEqual({ input: 0.01, output: 0.03 });
    expect(tokenPriceUsdPerM(9)).toEqual({ input: 0.04, output: 0.1 });
    expect(tokenPriceUsdPerM(70)).toEqual({ input: 0.3, output: 0.8 });
    // 9B at $100k BTC: 40 sats in, 100 sats out per million tokens.
    expect(cSatsPerMTokens(9, 100_000)).toEqual({ input: 40, output: 100 });
  });

  it("charges tokens when that covers the power, else the power floor", () => {
    // A Claude Code step: 25k in, 300 out on a 9B: 1.03 sats; 10 s of an Apple tier-3 machine is 0.0083 sats of power.
    expect(inferenceCostMsat({ ...base, promptTokens: 25_000, outputTokens: 300 })).toEqual({ costMsat: 1030, basis: "tokens" });
    // A tiny reply that took a long time: the floor wins.
    expect(inferenceCostMsat({ ...base, promptTokens: 10, outputTokens: 5, durationMs: 600_000 })).toMatchObject({ basis: "power_floor" });
  });

  it("falls back to per-second without token counts", () => {
    expect(inferenceCostMsat(base)).toEqual({ costMsat: 1_560, basis: "per_second" });
  });
});
