import { describe, expect, it } from "vitest";
import { BUILTIN_CLOUD_MODELS } from "../../src/cloud-host/catalog.js";
import { CLOUD_PROMPT_BYTES_PER_TOKEN, INFERENCE_RESERVE_MARGIN, WORK_PROMPT_TOKEN_ALLOWANCE, usdToMsat } from "../../src/economy/job-pricing.js";
import { modelTokenPrice } from "../../src/economy/cloud-pricing.js";
import { inferenceCallReserve } from "../../src/swarm/coordinator/economy.js";
import { OUTPUT_TOKEN_ALLOWANCE, PROMPT_TOKEN_ALLOWANCE } from "../../src/swarm/inference-streams.js";
import { FALLBACK_BTC_USD } from "../../src/swarm/coordinator/context.js";

/*
 * A cloud model call's hold is its real worst case on its token price (run 6: glm-5.3 held ~66 cSats
 * per call and 402'd buyers with ~100 cSats): the prompt as tokens (bytes / 3 + template allowance)
 * at the input price, and max_tokens + allowance at the output price. The reasoning a cloud host
 * asks the provider for past max_tokens is never billed (#554), so it is not held.
 */
const cSats = (msat: number) => msat / 1000;
const worst = (model: string, inputBytes: number, maxTokens: number) => {
  const p = modelTokenPrice(model)!;
  const usd = ((Math.ceil(inputBytes / CLOUD_PROMPT_BYTES_PER_TOKEN) + WORK_PROMPT_TOKEN_ALLOWANCE) * p.input + (maxTokens + OUTPUT_TOKEN_ALLOWANCE) * p.output) / 1e6;
  return usdToMsat(usd, FALLBACK_BTC_USD) * INFERENCE_RESERVE_MARGIN;
};

describe("cloud model call hold", () => {
  for (const id of ["glm-5.3", "deepseek-v4.1-flash"]) {
    it(`${id}: holds prompt × input price + max_tokens × output price (catalog price)`, () => {
      expect(BUILTIN_CLOUD_MODELS.some((m) => m.id === id)).toBe(true);
      const r = inferenceCallReserve({ model: id, taskClass: "any", timeoutMs: 180_000, inputBytes: 16_000, maxTokens: 2048 });
      expect(r.floorMsat).toBe(0);
      expect(r.reserveMsat).toBeGreaterThanOrEqual(Math.floor(worst(id, 16_000, 2048)));
      expect(r.reserveMsat).toBeLessThanOrEqual(Math.ceil(worst(id, 16_000, 2048)) + 2);
      // Still covers the ledger's billable output (max_tokens + allowance) at the output price.
      const p = modelTokenPrice(id)!;
      expect(r.tokenMsat).toBeGreaterThanOrEqual(usdToMsat(((2048 + OUTPUT_TOKEN_ALLOWANCE) * p.output) / 1e6, FALLBACK_BTC_USD));
    });
  }

  it("glm-5.3: a run-6-sized helper call holds well under 66 cSats, so ~100 cSats runs two at once", () => {
    const r = inferenceCallReserve({ model: "glm-5.3", taskClass: "any", timeoutMs: 180_000, inputBytes: 16_000, maxTokens: 2048 });
    const old = usdToMsat((((16_000 + PROMPT_TOKEN_ALLOWANCE) * modelTokenPrice("glm-5.3")!.input + (2048 + OUTPUT_TOKEN_ALLOWANCE) * modelTokenPrice("glm-5.3")!.output) / 1e6), FALLBACK_BTC_USD) * INFERENCE_RESERVE_MARGIN;
    expect(cSats(old)).toBeGreaterThan(60);
    expect(cSats(r.reserveMsat)).toBeLessThan(45);
    expect(2 * cSats(r.reserveMsat)).toBeLessThan(100);
  });

  it("deepseek holds less than glm for the same call (its catalog price is lower)", () => {
    const a = inferenceCallReserve({ model: "glm-5.3", taskClass: "any", timeoutMs: 180_000, inputBytes: 16_000, maxTokens: 2048 });
    const b = inferenceCallReserve({ model: "deepseek-v4.1-flash", taskClass: "any", timeoutMs: 180_000, inputBytes: 16_000, maxTokens: 2048 });
    expect(b.reserveMsat).toBeLessThan(a.reserveMsat);
  });

  it("a local model keeps its byte bound (unchanged)", () => {
    const r = inferenceCallReserve({ model: "qwen3-coder:30b", taskClass: "any", timeoutMs: 180_000, inputBytes: 16_000, maxTokens: 2048 });
    expect(r.tokenMsat).toBeGreaterThan(0);
    expect(r.reserveMsat).toBeGreaterThanOrEqual(Math.ceil(Math.max(r.tokenMsat, r.floorMsat)));
  });

  it("the buyer's maxCSats still caps it", () => {
    expect(inferenceCallReserve({ model: "glm-5.3", taskClass: "any", timeoutMs: 180_000, inputBytes: 16_000, maxTokens: 2048, maxCSats: 5 }).reserveMsat).toBe(5_000);
  });
});
