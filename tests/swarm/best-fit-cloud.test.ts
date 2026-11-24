import { describe, expect, it } from "vitest";
import { describeJob } from "../../src/inference-api/job-descriptor.js";
import { AUTO_CLOUD_MIN_COMPLEXITY, DEFAULT_BEST_FIT_CONFIG, bestFit, bestFitConfigFromEnv, contextWindowOf, decodeTps, jobWantsTopTier, type BestFitConfig, type NetworkView } from "../../src/swarm/coordinator/best-fit.js";
import { autoMayUseCloudModel, parseAutoCloudModels } from "../../src/cloud-host/catalog.js";
import { MULTI_FILE_REFACTOR, SIMPLE_QA } from "../helpers/job-fixtures.js";
import { agent, currentNetwork } from "./helpers/best-fit-network.js";

// Auto and cloud models: off unless AUTO_CLOUD_MODELS names an autoEligible model, and then only
// for jobs that would otherwise go to the network's top tier.

const FLASH = "deepseek-v4.1-flash";
const GLM = "glm-5.3";

function withCloudHost(over: { gpuFree?: number; gpuWaiting?: number } = {}): NetworkView {
  const view = currentNetwork(over);
  view.agents.push(agent({ agentId: "cloud1", computeClass: "cloud", models: [GLM, FLASH], slots: 16, freeSlots: 16, contextWindow: 1_000_000, rttMs: 30 }));
  return view;
}
const cfgWith = (models: string[]): BestFitConfig => ({ ...DEFAULT_BEST_FIT_CONFIG, autoCloudModels: models });
const hard = (hints: Record<string, unknown> = {}) => describeJob(MULTI_FILE_REFACTOR, { complexity: "very_high", ...hints });
const cloudOf = (r: ReturnType<typeof bestFit>) => r.candidates.filter((c) => c.computeClass === "cloud").map((c) => c.model);

describe("AUTO_CLOUD_MODELS", () => {
  it("is empty (off) by default and parsed as a lower-case comma list", () => {
    expect(DEFAULT_BEST_FIT_CONFIG.autoCloudModels).toEqual([]);
    expect(bestFitConfigFromEnv({}).autoCloudModels).toEqual([]);
    expect(bestFitConfigFromEnv({ AUTO_CLOUD_MODELS: "" }).autoCloudModels).toEqual([]);
    expect(bestFitConfigFromEnv({ AUTO_CLOUD_MODELS: " DeepSeek-V4.1-Flash , glm-5.3,deepseek-v4.1-flash" }).autoCloudModels).toEqual([FLASH, GLM]);
    expect(parseAutoCloudModels(undefined)).toEqual([]);
  });

  it("only autoEligible catalog models count (Flash yes, GLM-5.3 no, unknown ids no)", () => {
    expect(autoMayUseCloudModel(FLASH, [FLASH, GLM])).toBe(true);
    expect(autoMayUseCloudModel(GLM, [FLASH, GLM])).toBe(false);
    expect(autoMayUseCloudModel(FLASH, [])).toBe(false);
    expect(autoMayUseCloudModel("qwen3-coder:30b", ["qwen3-coder:30b"])).toBe(false);
  });
});

describe("best fit with a cloud host on the network", () => {
  it("off (the default): a cloud host is never a candidate, even for the hardest job", () => {
    const r = bestFit(hard(), withCloudHost(), DEFAULT_BEST_FIT_CONFIG);
    expect(r.chosen?.computeClass).not.toBe("cloud");
    expect(cloudOf(r)).toEqual([]);
  });

  it("on: a top-tier job may use Flash, never GLM-5.3 even when listed", () => {
    const r = bestFit(hard(), withCloudHost(), cfgWith([FLASH, GLM]));
    expect(cloudOf(r)).toEqual([FLASH]);
  });

  it("on: Flash wins a top-tier job when the network's top tier is busy", () => {
    const r = bestFit(hard(), withCloudHost({ gpuFree: 0, gpuWaiting: 3 }), cfgWith([FLASH]));
    expect(`${r.chosen?.model}@${r.chosen?.computeClass}`).toBe(`${FLASH}@cloud`);
  });

  it("on: a simple question or a light job never goes to the cloud", () => {
    expect(cloudOf(bestFit(describeJob(SIMPLE_QA, {}), withCloudHost(), cfgWith([FLASH])))).toEqual([]);
    expect(cloudOf(bestFit(describeJob(SIMPLE_QA, { complexity: "very_high", job: "classify" }), withCloudHost(), cfgWith([FLASH])))).toEqual([]);
    // Medium complexity stays on the network's machines.
    expect(cloudOf(bestFit(describeJob(MULTI_FILE_REFACTOR, { complexity: "medium" }), withCloudHost(), cfgWith([FLASH])))).toEqual([]);
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
