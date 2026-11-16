import { describe, expect, it } from "vitest";
import { inferenceCostMsat, inferenceReserveMsat, INFERENCE_RESERVE_MARGIN } from "../../src/economy/job-pricing.js";
import { boundTokenCounts, OUTPUT_TOKEN_ALLOWANCE, PROMPT_TOKEN_ALLOWANCE } from "../../src/swarm/inference-streams.js";

// Size-aware model-call reserve (2026-11-16): an upper bound on what the call can settle at.
const BTC = 100_000;
const CLASSES: Record<string, number> = { cpu: 4, apple: 2.5, gpu: 4.5, "gpu.dc": 2.9 };
const floorClasses = (c: string) => (c === "any" ? Object.keys(CLASSES) : [c]).map((k) => ({ computeClass: k, maxTierWeight: CLASSES[k] }));
const reserve = (paramsB: number, inputBytes: number, maxTokens: number, cls = "apple", timeoutMs = 180_000, capMsat?: number) =>
  inferenceReserveMsat({ paramsB, btcUsd: BTC, promptTokensMax: inputBytes + PROMPT_TOKEN_ALLOWANCE, outputTokensMax: maxTokens + OUTPUT_TOKEN_ALLOWANCE, maxDurationMs: timeoutMs, floorClasses: floorClasses(cls), ...(capMsat ? { capMsat } : {}) });

describe("inferenceReserveMsat", () => {
  it("1.5B reserves less than 30B, and a long prompt more than a short one", () => {
    const small = reserve(1.5, 400, 4096).reserveMsat;
    const big = reserve(30, 400, 4096).reserveMsat;
    const bigLong = reserve(30, 120_000, 4096).reserveMsat;
    expect(small).toBeLessThan(big);
    expect(big).toBeLessThan(bigLong);
    // All far under the old flat ~750 cSats (750,000 msat).
    for (const r of [small, big, bigLong]) expect(r).toBeLessThan(750_000 / 3);
    // 1.5B with a short prompt: the power floor bounds it (apple, 180 s, top tier) × 1.5.
    const r = reserve(1.5, 400, 4096);
    expect(r.floorMsat).toBeGreaterThan(r.tokenMsat);
    expect(small).toBeCloseTo(r.floorMsat * INFERENCE_RESERVE_MARGIN, -1);
  });

  it("a shorter output cap or timeout lowers it; maxCSats caps it", () => {
    expect(reserve(30, 400, 256).reserveMsat).toBeLessThan(reserve(30, 400, 4096).reserveMsat);
    expect(reserve(1.5, 400, 256, "gpu.dc", 30_000).reserveMsat).toBeLessThan(reserve(1.5, 400, 256, "gpu.dc", 180_000).reserveMsat);
    const capped = reserve(30, 400, 4096, "apple", 180_000, 1_000);
    expect(capped).toMatchObject({ reserveMsat: 1_000, capped: true });
    expect(reserve(30, 400, 4096, "apple", 180_000, 10_000_000).capped).toBe(false);
  });

  it("never under the settled cost, whatever the agent reports, the class, tier, slots or duration", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    const sizes = [0.5, 1.5, 3, 7, 14, 30, 70, 400];
    for (let i = 0; i < 2_000; i++) {
      const paramsB = sizes[Math.floor(rnd() * sizes.length)];
      const cls = ["cpu", "apple", "gpu", "gpu.dc", "any"][Math.floor(rnd() * 5)];
      const inputBytes = Math.floor(rnd() * 300_000);
      const maxTokens = 16 + Math.floor(rnd() * 32_000);
      const timeoutMs = 10_000 + Math.floor(rnd() * 290_000);
      const replyBytes = Math.floor(rnd() * maxTokens * 6);
      const r = reserve(paramsB, inputBytes, maxTokens, cls, timeoutMs).reserveMsat;
      // An agent reports huge counts; the coordinator bounds them as at /inference/chunks.
      const counts = boundTokenCounts({ promptTokens: 1e9, outputTokens: 1e9 }, inputBytes, replyBytes, maxTokens);
      const ran = cls === "any" ? Object.keys(CLASSES)[Math.floor(rnd() * 4)] : cls;
      const settled = inferenceCostMsat({
        ...counts, paramsB, btcUsd: BTC * (0.7 + rnd() * 0.6), durationMs: timeoutMs * rnd(), computeClass: ran,
        tierWeight: 1 + rnd() * (CLASSES[ran] - 1), floorSlots: 1 + Math.floor(rnd() * 4), perSecondCostMsat: 0,
      }).costMsat;
      expect(settled, JSON.stringify({ paramsB, cls, inputBytes, maxTokens, timeoutMs })).toBeLessThanOrEqual(r);
    }
  });
});
