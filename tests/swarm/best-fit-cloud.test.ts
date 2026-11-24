import { describe, expect, it } from "vitest";
import { describeJob } from "../../src/inference-api/job-descriptor.js";
import { AUTO_CLOUD_MIN_COMPLEXITY, DEFAULT_BEST_FIT_CONFIG, bestFit, bestFitConfigFromEnv, contextWindowOf, decodeTps, jobWantsPremiumCloud, jobWantsTopTier, type BestFitConfig, type NetworkView } from "../../src/swarm/coordinator/best-fit.js";
import { autoMayUseCloudModel, parseAutoCloudModels, type AutoCloudModels } from "../../src/cloud-host/catalog.js";
import { AGENTIC_LOOP, MULTI_FILE_REFACTOR, SIMPLE_QA } from "../helpers/job-fixtures.js";
import { agent, currentNetwork } from "./helpers/best-fit-network.js";

// Auto and cloud models (owner decision 2026-11-23: automatic, no per-model switch): every catalog
// cloud model whose host is online is a candidate by default, for top-tier jobs or as the fallback
// when no other machine meets the job; Flash before the premium GLM-5.3. AUTO_CLOUD_MODELS only
// narrows it ("off" = none).

const FLASH = "deepseek-v4.1-flash";
const GLM = "glm-5.3";

const cloudHost = (models = [GLM, FLASH]) => agent({ agentId: "cloud1", computeClass: "cloud", models, slots: 16, freeSlots: 16, contextWindow: 1_000_000, rttMs: 30 });
function withCloudHost(over: { gpuFree?: number; gpuWaiting?: number } = {}, models?: string[]): NetworkView {
  const view = currentNetwork(over);
  view.agents.push(cloudHost(models));
  return view;
}
/** Tonight's network (2026-11-23): the A100 gone; 1.5b CPUs, a 7b and a 9b, and the cloud host. */
function smallNetwork(withCloud = true, models?: string[]): NetworkView {
  const cpus = Array.from({ length: 8 }, (_, i) => agent({ agentId: `cpu${i + 1}`, computeClass: "cpu", models: ["qwen2.5-coder:1.5b"], tokensPerSec: 18, contextWindow: 16_384 }));
  return {
    agents: [
      ...cpus,
      agent({ agentId: "mac7", computeClass: "apple", models: ["qwen2.5-coder:7b"], tokensPerSec: 22, contextWindow: 32_768 }),
      agent({ agentId: "gpu9", computeClass: "gpu", models: ["qwen3.5:9b"], tokensPerSec: 40, contextWindow: 32_768 }),
      ...(withCloud ? [cloudHost(models)] : []),
    ],
    pickupP50Ms: 250,
    waitingByModel: {},
    btcUsd: 100_000,
  };
}
const cfgWith = (models: AutoCloudModels): BestFitConfig => ({ ...DEFAULT_BEST_FIT_CONFIG, autoCloudModels: models });
const hard = (hints: Record<string, unknown> = {}) => describeJob(MULTI_FILE_REFACTOR, { complexity: "very_high", ...hints });
/** A bot's agent step: tools, the bot floor (BOT_AGENT_MIN_PARAMS_B = 14) sent as minParamsB. */
const botStep = (hints: Record<string, unknown> = {}) => describeJob(AGENTIC_LOOP, { job: "agentic", needsTools: true, complexity: "low", minParamsB: 14, ...hints });
const cloudOf = (r: ReturnType<typeof bestFit>) => r.candidates.filter((c) => c.computeClass === "cloud").map((c) => c.model);
const pick = (r: ReturnType<typeof bestFit>) => `${r.chosen?.model}@${r.chosen?.computeClass}`;

describe("AUTO_CLOUD_MODELS", () => {
  it("unset or empty is all (the default); off is none; a comma list is only those (lower case, deduplicated)", () => {
    expect(DEFAULT_BEST_FIT_CONFIG.autoCloudModels).toBe("all");
    expect(bestFitConfigFromEnv({}).autoCloudModels).toBe("all");
    expect(bestFitConfigFromEnv({ AUTO_CLOUD_MODELS: "" }).autoCloudModels).toBe("all");
    expect(bestFitConfigFromEnv({ AUTO_CLOUD_MODELS: " OFF " }).autoCloudModels).toBe("off");
    expect(parseAutoCloudModels("none")).toBe("off");
    expect(bestFitConfigFromEnv({ AUTO_CLOUD_MODELS: " DeepSeek-V4.1-Flash , glm-5.3,deepseek-v4.1-flash" }).autoCloudModels).toEqual([FLASH, GLM]);
    expect(parseAutoCloudModels(undefined)).toBe("all");
  });

  it("all: every autoEligible catalog model; a list: the models it names; off: none; never a non-cloud model", () => {
    expect(autoMayUseCloudModel(FLASH, "all")).toBe(true);
    expect(autoMayUseCloudModel(GLM, "all")).toBe(true);
    expect(autoMayUseCloudModel(GLM, [FLASH])).toBe(false);
    expect(autoMayUseCloudModel(FLASH, [FLASH])).toBe(true);
    expect(autoMayUseCloudModel(FLASH, "off")).toBe(false);
    expect(autoMayUseCloudModel("qwen3-coder:30b", ["qwen3-coder:30b"])).toBe(false);
    expect(autoMayUseCloudModel("qwen3-coder:30b", "all")).toBe(false);
  });
});

describe("best fit with a cloud host on the network (default: on)", () => {
  it("a top-tier job may use Flash, and Flash wins it when the network's top tier is busy", () => {
    expect(cloudOf(bestFit(hard(), withCloudHost(), DEFAULT_BEST_FIT_CONFIG))).toEqual([FLASH]);
    expect(pick(bestFit(hard(), withCloudHost({ gpuFree: 0, gpuWaiting: 3 }), DEFAULT_BEST_FIT_CONFIG))).toBe(`${FLASH}@cloud`);
  });

  it("a bot's agent step with only small models online falls back to Flash (tonight's failure)", () => {
    const r = bestFit(botStep(), smallNetwork(), DEFAULT_BEST_FIT_CONFIG);
    expect(pick(r)).toBe(`${FLASH}@cloud`);
    expect(r.requirements.hardMinParamsB).toBe(14);
    expect(r.chosen?.belowFloor).toBe(false);
  });

  it("a bot's agent step stays on the network when a machine there meets its floor", () => {
    const view = smallNetwork();
    view.agents.push(agent({ agentId: "gpu30", computeClass: "gpu", models: ["qwen3-coder:30b"], tokensPerSec: 40, contextWindow: 32_768, tierWeight: 2 }));
    expect(bestFit(botStep(), view, DEFAULT_BEST_FIT_CONFIG).chosen?.computeClass).not.toBe("cloud");
  });

  it("a simple question or a light job a small model can serve never goes to the cloud", () => {
    expect(cloudOf(bestFit(describeJob(SIMPLE_QA, {}), smallNetwork(), DEFAULT_BEST_FIT_CONFIG))).toEqual([]);
    expect(cloudOf(bestFit(describeJob(SIMPLE_QA, {}), withCloudHost(), DEFAULT_BEST_FIT_CONFIG))).toEqual([]);
    expect(cloudOf(bestFit(describeJob(SIMPLE_QA, { complexity: "very_high", job: "classify" }), withCloudHost(), DEFAULT_BEST_FIT_CONFIG))).toEqual([]);
    // Medium complexity, and a 14B+ model online: stays on the network's machines.
    expect(cloudOf(bestFit(describeJob(MULTI_FILE_REFACTOR, { complexity: "medium" }), withCloudHost(), DEFAULT_BEST_FIT_CONFIG))).toEqual([]);
  });

  it("off disables it: the bot step gets an honest error instead of a below-floor model", () => {
    const r = bestFit(botStep(), smallNetwork(), cfgWith("off"));
    expect(r.chosen).toBeNull();
    expect(r.rejectedCode).toBe("size");
    expect(r.rejected).toBe("No machine on the network can run this job right now (needs a model ≥ 14B with tools; online: qwen2.5-coder:1.5b, qwen2.5-coder:7b, qwen3.5:9b; cloud models are off (AUTO_CLOUD_MODELS=off))");
    expect(cloudOf(bestFit(hard(), withCloudHost({ gpuFree: 0, gpuWaiting: 3 }), cfgWith("off")))).toEqual([]);
  });

  it("without a cloud host online the error names what is online", () => {
    const r = bestFit(botStep(), smallNetwork(false), DEFAULT_BEST_FIT_CONFIG);
    expect(r.rejected).toBe("No machine on the network can run this job right now (needs a model ≥ 14B with tools; online: qwen2.5-coder:1.5b, qwen2.5-coder:7b, qwen3.5:9b)");
  });

  it("an explicit list is respected", () => {
    expect(pick(bestFit(botStep(), smallNetwork(), cfgWith([GLM])))).toBe(`${GLM}@cloud`);
    expect(cloudOf(bestFit(hard(), withCloudHost(), cfgWith([GLM])))).toEqual([GLM]);
    expect(cloudOf(bestFit(hard(), withCloudHost(), cfgWith(["some-other-model"])))).toEqual([]);
  });

  it("a price ceiling below the cloud call's estimate leaves it out, and the error says so", () => {
    const flash = bestFit(botStep(), smallNetwork(), DEFAULT_BEST_FIT_CONFIG).chosen!.estimate.cSats;
    const r = bestFit(botStep({ maxCSats: flash / 2 }), smallNetwork(), DEFAULT_BEST_FIT_CONFIG);
    expect(r.chosen).toBeNull();
    expect(r.rejectedCode).toBe("price");
    expect(r.rejected).toMatch(new RegExp(`costs more than the ${flash / 2} cSats ceiling \\(the cheapest, ${FLASH} on cloud, is about`));
    expect(r.cheapestCSats).toBeCloseTo(flash, 2);
  });

  it("GLM-5.3 only when it is the only cloud fit, or the job asks for the best and the price allows it", () => {
    // Both online, a top-tier job: Flash (cheaper), GLM left out.
    expect(cloudOf(bestFit(hard(), withCloudHost(), DEFAULT_BEST_FIT_CONFIG))).toEqual([FLASH]);
    expect(pick(bestFit(botStep(), smallNetwork(), DEFAULT_BEST_FIT_CONFIG))).toBe(`${FLASH}@cloud`);
    // Only GLM online: it is the fit.
    expect(pick(bestFit(botStep(), smallNetwork(true, [GLM]), DEFAULT_BEST_FIT_CONFIG))).toBe(`${GLM}@cloud`);
    // quality best at top-tier complexity: GLM, when the ceiling allows it…
    const best = hard({ quality: "best" });
    expect(jobWantsPremiumCloud(best)).toBe(true);
    expect(jobWantsPremiumCloud(hard())).toBe(false);
    const view = withCloudHost({ gpuFree: 0, gpuWaiting: 3 });
    const r = bestFit(best, view, DEFAULT_BEST_FIT_CONFIG);
    expect(cloudOf(r)).toEqual([GLM]);
    const glm = r.candidates.find((c) => c.model === GLM)!.estimate.cSats;
    // …and Flash when it doesn't.
    const flashOnly = bestFit({ ...best, maxCSats: glm * 0.9 }, view, DEFAULT_BEST_FIT_CONFIG);
    expect(cloudOf(flashOnly)).toEqual([FLASH]);
  });

  it("the top-tier gate is complexity >= AUTO_CLOUD_MIN_COMPLEXITY on non-light work", () => {
    expect(jobWantsTopTier(hard())).toBe(true);
    expect(hard().complexity.score).toBeGreaterThanOrEqual(AUTO_CLOUD_MIN_COMPLEXITY);
    expect(jobWantsTopTier(describeJob(SIMPLE_QA, {}))).toBe(false);
    expect(jobWantsTopTier(describeJob(SIMPLE_QA, { complexity: "very_high", job: "summarize" }))).toBe(false);
  });

  it("a cloud host runs at the hosted API's speed and the model's own window", () => {
    const cloud = { computeClass: "cloud", tokensPerSec: undefined, activeModel: GLM };
    expect(decodeTps(cloud, FLASH)).toBe(60);
    expect(decodeTps({ ...cloud, tokensPerSec: 90 }, FLASH)).toBe(90);
    expect(contextWindowOf({}, FLASH)).toBe(1_000_000);
  });
});
