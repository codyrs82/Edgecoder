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

import { HOST_PROFIT_MARGIN, cSatsPerMTokens, inferenceCostMsat, tokenPriceUsdPerM } from "../../src/economy/job-pricing.js";
import { paramsB } from "../../src/inference-api/auto-route.js";

describe("per-token pricing for model calls", () => {
  const base = { paramsB: 9, btcUsd: 100_000, durationMs: 10_000, computeClass: "apple", tierWeight: 3, perSecondCostMsat: 1_560 };

  it("prices by size", () => {
    expect(tokenPriceUsdPerM(1.5)).toEqual({ input: 0.01, output: 0.03 });
    expect(tokenPriceUsdPerM(9)).toEqual({ input: 0.04, output: 0.1 });
    expect(tokenPriceUsdPerM(70)).toEqual({ input: 2.6, output: 6.95 });
    // 9B at $100k BTC: 40 sats in, 100 sats out per million tokens.
    expect(cSatsPerMTokens(9, 100_000)).toEqual({ input: 40, output: 100 });
  });

  it("prices qwen3-coder-next (no size in its tag) as the 80B model it is, not the 7B default", () => {
    expect(tokenPriceUsdPerM(paramsB("qwen3-coder-next:latest"))).toEqual({ input: 2.6, output: 6.95 });
  });

  it("prices for host profit at 50 % utilization (2026-11-16): 30B and up ~8.64x, 16B and below unchanged", () => {
    expect(HOST_PROFIT_MARGIN).toBe(0.2);
    expect(tokenPriceUsdPerM(paramsB("qwen3-coder:30b"))).toEqual({ input: 1.05, output: 3.05 });
    expect(tokenPriceUsdPerM(paramsB("qwen2.5-coder:32b"))).toEqual({ input: 1.05, output: 3.05 });
    expect(tokenPriceUsdPerM(paramsB("llama3.3:70b"))).toEqual({ input: 2.6, output: 6.95 });
    expect(tokenPriceUsdPerM(paramsB("deepseek-v3:671b"))).toEqual({ input: 5.2, output: 13 });
    expect(tokenPriceUsdPerM(paramsB("deepseek-r1:14b"))).toEqual({ input: 0.07, output: 0.2 });
    expect(tokenPriceUsdPerM(paramsB("qwen3.5:9b"))).toEqual({ input: 0.04, output: 0.1 });
    // Measured 2026-11-16: a qwen3-coder:30b call averages 2,841 tokens in, 134 out. At 64,870 USD/BTC
    // that was 0.61 cSats and is now 5.23 cSats.
    const call = { paramsB: 30, btcUsd: 64_870, promptTokens: 2_841, outputTokens: 134, durationMs: 4_000, computeClass: "gpu.dc", tierWeight: 1, perSecondCostMsat: 0 };
    expect(inferenceCostMsat(call)).toEqual({ costMsat: 5_229, basis: "tokens" });
    expect(cSatsPerMTokens(30, 100_000)).toEqual({ input: 1_050, output: 3_050 });
  });

  it("CPU and Apple power floors are 0.025 and 0.014 USD per base-tier hour, split over the slots", () => {
    // 1.5b on a 2-slot CPU agent: 317 tokens in, 76 out, 33 s: 0.025 × 33 / 3600 / 2 USD = 0.18 cSats.
    const call = { paramsB: 1.5, btcUsd: 64_870, promptTokens: 317, outputTokens: 76, durationMs: 33_000, computeClass: "cpu", tierWeight: 1, floorSlots: 2, perSecondCostMsat: 0 };
    expect(inferenceCostMsat(call)).toEqual({ costMsat: 177, basis: "power_floor" });
  });

  it("charges tokens when that covers the power, else the power floor", () => {
    // A Claude Code step: 25k in, 300 out on a 9B: 1.03 sats; 10 s of an Apple tier-3 machine is 0.0083 sats of power.
    expect(inferenceCostMsat({ ...base, promptTokens: 25_000, outputTokens: 300 })).toEqual({ costMsat: 1030, basis: "tokens" });
    // A tiny reply that took a long time: the floor wins.
    expect(inferenceCostMsat({ ...base, promptTokens: 10, outputTokens: 5, durationMs: 600_000 })).toMatchObject({ basis: "power_floor" });
  });

  it("the power floor leaves out the host's model load: a cold call costs what the warm one does", () => {
    // Live regtest, 2026-11-15: qwen2.5-coder:1.5b, 48 tokens in, 11 out; tokens alone are ~0.0008 cSats.
    const call = { paramsB: 1.5, btcUsd: 80_000, promptTokens: 48, outputTokens: 11, computeClass: "apple", tierWeight: 1, perSecondCostMsat: 0 };
    const warm = inferenceCostMsat({ ...call, durationMs: 1_500 });
    const cold = inferenceCostMsat({ ...call, durationMs: 4_900, floorExcludeMs: 3_400 });
    expect(warm.basis).toBe("power_floor");
    expect(cold).toEqual(warm);
    // Without a reported load the whole duration counts (older agents), never below zero.
    expect(inferenceCostMsat({ ...call, durationMs: 4_900 }).costMsat).toBeGreaterThan(warm.costMsat * 3);
    expect(inferenceCostMsat({ ...call, durationMs: 1_000, floorExcludeMs: 5_000 })).toMatchObject({ basis: "tokens" });
    expect(inferenceCostMsat({ ...call, durationMs: 4_900, floorExcludeMs: Number.NaN })).toEqual(inferenceCostMsat({ ...call, durationMs: 4_900 }));
  });

  it("splits the power floor across the agent's parallel slots: one machine's power, not N", () => {
    // A tiny reply that ran 60 s on an Apple tier-2.5 machine: the floor applies.
    const call = { paramsB: 9, btcUsd: 100_000, promptTokens: 10, outputTokens: 5, durationMs: 60_000, computeClass: "apple", tierWeight: 2.5, perSecondCostMsat: 0 };
    const one = inferenceCostMsat(call);
    expect(one).toEqual({ costMsat: 583, basis: "power_floor" }); // 0.014 × 2.5 × 60 / 3600 USD
    // 1 slot (and no report) is unchanged.
    expect(inferenceCostMsat({ ...call, floorSlots: 1 })).toEqual(one);
    expect(inferenceCostMsat({ ...call, floorSlots: Number.NaN })).toEqual(one);
    expect(inferenceCostMsat({ ...call, floorSlots: 0 })).toEqual(one);
    // A 4-slot Ollama Mac and a 12-slot vLLM host get a quarter and a twelfth.
    expect(inferenceCostMsat({ ...call, floorSlots: 4 })).toEqual({ costMsat: 146, basis: "power_floor" });
    expect(inferenceCostMsat({ ...call, floorSlots: 12 })).toEqual({ costMsat: 49, basis: "power_floor" });
    // Once the floor falls below the tokens, the tokens are charged.
    const gpu = { paramsB: 30, btcUsd: 64_870, promptTokens: 2_841, outputTokens: 134, durationMs: 30_000, computeClass: "gpu.dc", tierWeight: 2.9, perSecondCostMsat: 0 };
    expect(inferenceCostMsat(gpu).basis).toBe("power_floor");
    expect(inferenceCostMsat({ ...gpu, floorSlots: 12 })).toEqual({ costMsat: 5_229, basis: "tokens" });
  });

  it("falls back to per-second without token counts", () => {
    expect(inferenceCostMsat(base)).toEqual({ costMsat: 1_560, basis: "per_second" });
  });
});
