import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_CLOUD_MODELS, cloudModelSpec, configureCloudCatalog, providerCostUsd } from "../../src/cloud-host/catalog.js";
import { configureCloudPricing, costPlusPrice, DEFAULT_CLOUD_MARGIN_PCT, effectiveCloudMargin, minCloudMargin, modelTokenPrice } from "../../src/economy/cloud-pricing.js";
import { cSatsPerMTokens, inferenceCostMsat, inferenceReserveMsat, splitJobCost, usdToMsat } from "../../src/economy/job-pricing.js";

/*
 * Cloud models are priced at the provider's USD price plus a margin, converted at the BTC/USD of
 * the moment, through the existing per-token formula (inferenceCostMsat `price`): never below the
 * provider's cost, also after the 5 % network fee.
 */

const glm = BUILTIN_CLOUD_MODELS.find((m) => m.id === "glm-5.3")!;
const ds = BUILTIN_CLOUD_MODELS.find((m) => m.id === "deepseek-v4.1-flash")!;

afterEach(() => {
  configureCloudPricing({ marginPct: DEFAULT_CLOUD_MARGIN_PCT, feeBps: 500 });
  configureCloudCatalog(undefined);
});

const cost = (o: { price?: ReturnType<typeof costPlusPrice>; prompt: number; out: number; cached?: number; btcUsd: number; paramsB?: number }) =>
  inferenceCostMsat({ promptTokens: o.prompt, outputTokens: o.out, cachedPromptTokens: o.cached, price: o.price, paramsB: o.paramsB ?? 744, btcUsd: o.btcUsd, durationMs: 5_000, computeClass: "cloud", tierWeight: 1, perSecondCostMsat: 0 });

describe("cost-plus price", () => {
  it("is the provider price × (1 + margin): GLM-5.3 at 30 %", () => {
    const p = costPlusPrice(glm, 0.3);
    expect(p.input).toBeCloseTo(1.82, 8);
    expect(p.cachedInput).toBeCloseTo(0.338, 8);
    expect(p.output).toBeCloseTo(5.72, 8);
    // Rounded up, never down.
    expect(p.input).toBeGreaterThanOrEqual(1.4 * 1.3);
    expect(p.output).toBeGreaterThanOrEqual(4.4 * 1.3);
    configureCloudPricing({ marginPct: 30, feeBps: 500 });
    expect(modelTokenPrice("glm-5.3")).toEqual(p);
    expect(modelTokenPrice("GLM-5.3:latest")).toEqual(modelTokenPrice("glm-5.3"));
    expect(modelTokenPrice("qwen3-coder:30b")).toBeUndefined(); // other models keep their size band
  });

  it("the margin never goes below what keeps the host's share after the fee at cost", () => {
    expect(minCloudMargin(500)).toBeCloseTo(0.05 / 0.95, 12);
    expect(effectiveCloudMargin(0, 500)).toBeCloseTo(0.0526316, 6);
    expect(effectiveCloudMargin(30, 500)).toBe(0.3);
    expect(effectiveCloudMargin(30, 0)).toBe(0.3);
    configureCloudPricing({ marginPct: 0, feeBps: 500 });
    const p = modelTokenPrice("deepseek-v4.1-flash")!;
    // Host gets 95 %: 95 % of the price still covers the provider's price.
    expect(p.input * 0.95).toBeGreaterThanOrEqual(ds.usdPerM.input);
    expect(p.output * 0.95).toBeGreaterThanOrEqual(ds.usdPerM.output);
    expect(p.cachedInput * 0.95).toBeGreaterThanOrEqual(ds.usdPerM.cachedInput);
  });
});

describe("a cloud call through the existing formula", () => {
  it("costs its tokens at the cost-plus price (cached prompt tokens at the cached rate), in msat at the BTC price", () => {
    const price = costPlusPrice(glm, 0.3);
    // 100k prompt (60k cached) + 2k out at BTC 100k: (40k×1.82 + 60k×0.338 + 2k×5.72)/1e6 USD
    const usd = (40_000 * price.input + 60_000 * price.cachedInput + 2_000 * price.output) / 1e6;
    const r = cost({ price, prompt: 100_000, cached: 60_000, out: 2_000, btcUsd: 100_000 });
    expect(r.basis).toBe("tokens");
    expect(r.costMsat).toBe(Math.ceil(usdToMsat(usd, 100_000)));
    // Without the cache report every prompt token is billed at the input rate (dearer, never cheaper).
    expect(cost({ price, prompt: 100_000, out: 2_000, btcUsd: 100_000 }).costMsat).toBeGreaterThan(r.costMsat);
    // A cached count above the prompt count cannot make it cheaper than all-cached.
    expect(cost({ price, prompt: 1_000, cached: 50_000, out: 0, btcUsd: 100_000 }).costMsat).toBe(Math.ceil(usdToMsat((1_000 * price.cachedInput) / 1e6, 100_000)));
  });

  it("is repriced when the BTC rate moves: the same USD costs more sats when BTC falls", () => {
    const price = costPlusPrice(ds, 0.3);
    const at100k = cost({ price, prompt: 10_000, out: 1_000, btcUsd: 100_000 }).costMsat;
    const at50k = cost({ price, prompt: 10_000, out: 1_000, btcUsd: 50_000 }).costMsat;
    const at200k = cost({ price, prompt: 10_000, out: 1_000, btcUsd: 200_000 }).costMsat;
    expect(at50k).toBeGreaterThanOrEqual(2 * at100k - 1);
    expect(at50k).toBeLessThanOrEqual(2 * at100k + 1);
    expect(at200k).toBeLessThan(at100k);
    // The UI price follows the rate too.
    expect(cSatsPerMTokens(552, 100_000, price).input).toBeCloseTo(cSatsPerMTokens(552, 50_000, price).input / 2, 0);
  });

  it("never settles below the provider's cost, also after the network fee (randomized)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (const spec of [glm, ds]) {
      for (const marginPct of [0, 1, 5, 30, 100]) {
        configureCloudPricing({ marginPct, feeBps: 500 });
        const price = modelTokenPrice(spec.id)!;
        for (let i = 0; i < 300; i++) {
          const prompt = Math.floor(rnd() * 200_000);
          const cached = Math.floor(rnd() * prompt);
          const out = Math.floor(rnd() * 8_000);
          const btcUsd = 20_000 + rnd() * 280_000;
          const providerMsat = usdToMsat(providerCostUsd(spec, { promptTokens: prompt, cachedPromptTokens: cached, outputTokens: out }), btcUsd);
          const c = cost({ price, prompt, cached, out, btcUsd }).costMsat;
          expect(c).toBeGreaterThanOrEqual(providerMsat);
          // The host (the platform's own account) keeps cost after the 5 % fee.
          expect(splitJobCost(c, 500).agentMsat).toBeGreaterThanOrEqual(Math.floor(providerMsat));
        }
      }
    }
  });

  it("the reserve bounds the cost at the cost-plus price, all prompt tokens uncached", () => {
    const price = costPlusPrice(glm, 0.3);
    const reserve = inferenceReserveMsat({ paramsB: 744, price, btcUsd: 100_000, promptTokensMax: 50_000, outputTokensMax: 4_000, maxDurationMs: 60_000, floorClasses: [{ computeClass: "cloud", maxTierWeight: 1 }] });
    const worst = cost({ price, prompt: 50_000, out: 4_000, btcUsd: 100_000 }).costMsat;
    expect(reserve.reserveMsat).toBeGreaterThanOrEqual(worst);
    expect(reserve.floorMsat).toBe(0); // the cloud class has no power floor
  });

  it("other models are unchanged (size band, rounded)", () => {
    const withoutPrice = cost({ prompt: 10_000, out: 500, btcUsd: 100_000, paramsB: 30 });
    expect(withoutPrice.costMsat).toBe(Math.round(usdToMsat((10_000 * 0.57 + 500 * 1.66) / 1e6, 100_000)));
  });
});

describe("catalog", () => {
  it("has the two Fireworks models with provider ids, prices and origin", () => {
    expect(cloudModelSpec("glm-5.3")).toMatchObject({ providerModel: "accounts/fireworks/models/glm-5p3", usdPerM: { input: 1.4, cachedInput: 0.26, output: 4.4 }, origin: { country: "CN" } });
    expect(cloudModelSpec("deepseek-v4.1-flash")).toMatchObject({ providerModel: "accounts/fireworks/models/deepseek-v4p1-flash", usdPerM: { input: 0.3, cachedInput: 0.006, output: 1.2 }, origin: { country: "CN" } });
    expect(providerCostUsd(glm, { promptTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(5.8, 9);
  });

  it("CLOUD_MODELS_JSON adds or replaces models and rejects a bad list", () => {
    configureCloudCatalog(JSON.stringify([{ id: "glm-5.3", providerModel: "accounts/fireworks/models/glm-5p3", usdPerM: { input: 1.5, output: 4.6, cachedInput: 0.3 }, contextWindow: 200000, origin: { vendor: "Z.ai", country: "cn" } }, { id: "kimi-k3", providerModel: "accounts/fireworks/models/kimi-k3", usdPerM: { input: 1, output: 3 } }]));
    expect(cloudModelSpec("glm-5.3")?.usdPerM.input).toBe(1.5);
    expect(cloudModelSpec("kimi-k3")).toMatchObject({ usdPerM: { cachedInput: 1 }, origin: { country: "ZZ" } });
    expect(cloudModelSpec("deepseek-v4.1-flash")).toBeDefined();
    expect(() => configureCloudCatalog("{")).toThrow(/CLOUD_MODELS_JSON/);
    expect(() => configureCloudCatalog(JSON.stringify([{ id: "x", providerModel: "y", usdPerM: { input: -1, output: 1 } }]))).toThrow(/usdPerM.input/);
    expect(() => configureCloudCatalog(JSON.stringify([{ id: "x", providerModel: "y", usdPerM: { input: 1, output: 1, cachedInput: 2 } }]))).toThrow(/cachedInput is above/);
  });
});
