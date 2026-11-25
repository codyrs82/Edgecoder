import { describe, expect, it } from "vitest";
import { expectedWorkMs, inferenceCostMsat, inferenceReserveMsat, INFERENCE_RESERVE_MARGIN, POWER_FLOOR_USD_PER_HOUR, usdToMsat, WORK_PROMPT_TOKEN_ALLOWANCE } from "../../src/economy/job-pricing.js";
import { boundTokenCounts, OUTPUT_TOKEN_ALLOWANCE, PROMPT_TOKEN_ALLOWANCE } from "../../src/swarm/inference-streams.js";

// Size-aware model-call reserve (2026-11-16): an upper bound on what the call can settle at.
const BTC = 100_000;
const CLASSES: Record<string, number> = { cpu: 4, apple: 2.5, gpu: 4.5, "gpu.dc": 2.9 };
const floorClasses = (c: string) => (c === "any" ? Object.keys(CLASSES) : [c]).map((k) => ({ computeClass: k, maxTierWeight: CLASSES[k] }));
const reserve = (paramsB: number, inputBytes: number, maxTokens: number, cls = "apple", timeoutMs = 180_000, capMsat?: number) =>
  inferenceReserveMsat({ paramsB, btcUsd: BTC, promptTokensMax: inputBytes + PROMPT_TOKEN_ALLOWANCE, outputTokensMax: maxTokens + OUTPUT_TOKEN_ALLOWANCE, workPromptTokensMax: inputBytes + WORK_PROMPT_TOKEN_ALLOWANCE, maxDurationMs: timeoutMs, floorClasses: floorClasses(cls), ...(capMsat ? { capMsat } : {}) });

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
    // The timeout caps the power floor's seconds when the call's own work could take longer.
    expect(reserve(7, 4_000, 4_096, "cpu", 30_000).reserveMsat).toBeLessThan(reserve(7, 4_000, 4_096, "cpu", 180_000).reserveMsat);
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
      const tierWeight = 1 + rnd() * (CLASSES[ran] - 1);
      // As results.ts settles it: the floor's seconds at most the work its reported counts take there.
      const floorMaxMs = expectedWorkMs({ paramsB, computeClass: ran, promptTokens: Math.min(counts.promptTokens ?? 0, inputBytes + WORK_PROMPT_TOKEN_ALLOWANCE), outputTokens: counts.outputTokens ?? 0, tierWeight });
      const settled = inferenceCostMsat({
        ...counts, paramsB, btcUsd: BTC * (0.7 + rnd() * 0.6), durationMs: timeoutMs * rnd(), computeClass: ran,
        tierWeight, floorSlots: 1 + Math.floor(rnd() * 4), perSecondCostMsat: 0, floorMaxMs,
        ...(rnd() < 0.5 ? { floorWorkMs: timeoutMs * rnd() } : {}),
      }).costMsat;
      expect(settled, JSON.stringify({ paramsB, cls, inputBytes, maxTokens, timeoutMs })).toBeLessThanOrEqual(r);
    }
  });

  it("sizes the power floor on the call's own work, not the timeout (C8): a short 1.5B call holds a few cSats, not 54", () => {
    // Network test 2026-11-24 (BTC ~60k USD): every 1.5b call held 54.47 cSats, 180 s on the dearest
    // class, for a cost of 0.002 to 0.5; a buyer with ~200 cSats got 402s with 3 or 4 calls in flight.
    const btc = 60_000;
    const floorAll = floorClasses("any");
    const call = { paramsB: 1.5, btcUsd: btc, promptTokensMax: 300 + PROMPT_TOKEN_ALLOWANCE, outputTokensMax: 48 + OUTPUT_TOKEN_ALLOWANCE, workPromptTokensMax: 300 + WORK_PROMPT_TOKEN_ALLOWANCE, maxDurationMs: 180_000, floorClasses: floorAll };
    const now = inferenceReserveMsat(call).reserveMsat;
    const old = Math.ceil(Math.max(...floorAll.map((c) => usdToMsat(POWER_FLOOR_USD_PER_HOUR[c.computeClass] * c.maxTierWeight * 0.05, btc))) * INFERENCE_RESERVE_MARGIN);
    expect(old / 1000).toBeGreaterThan(50);
    expect(now / 1000).toBeLessThan(5);
    // 200 cSats now holds dozens of such calls at once.
    expect(Math.floor(200_000 / now)).toBeGreaterThan(40);
    // A long call is still bounded by its timeout: the cap is the old timeout-based maximum.
    const long = { ...call, paramsB: 7, promptTokensMax: 100_000, outputTokensMax: 32_000, workPromptTokensMax: 100_000, floorClasses: floorClasses("cpu") };
    expect(inferenceReserveMsat(long).floorMsat).toBe(Math.ceil(usdToMsat(POWER_FLOOR_USD_PER_HOUR.cpu * CLASSES.cpu * 0.05, btc)));
  });
});
