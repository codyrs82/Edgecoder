import { describe, expect, it } from "vitest";
import { describeJob } from "../../src/inference-api/job-descriptor.js";
import {
  bestFit, coldLoadMs, COMPLEX_FALLBACK_MIN_B, complexityClassOf, DEFAULT_BEST_FIT_CONFIG, bestFitConfigFromEnv, outputRoomFor,
  parseReasoningMinTokens, reasoningMinTokensFor, type AgentView, type NetworkView,
} from "../../src/swarm/coordinator/best-fit.js";
import { agentRoutable, AGENT_SILENT_MS, coldLoadKm, noteAgentPull } from "../../src/swarm/coordinator/dispatch.js";
import { COLD_PENALTY_MIN_LOAD_MS, nearestFreeHolder } from "../../src/swarm/coordinator/locality.js";
import { regionDistanceKm } from "../../src/common/geo-regions.js";
import { MULTI_FILE_REFACTOR, SIMPLE_QA, TOOLS } from "../helpers/job-fixtures.js";
import { agent } from "./helpers/best-fit-network.js";

/*
 * Network validation run 3 / 3b (2026-11-25): C3 locality under load, C4 Auto on a silent agent,
 * C5 small max_tokens on reasoning cloud models, D5 complex calls with no host of their floor.
 */

const FLASH = "deepseek-v4.1-flash";
const GLM = "glm-5.3";
const M15 = "qwen2.5-coder:1.5b";
const M7 = "qwen2.5-coder:7b";
const M14 = "qwen2.5-coder:14b";

describe("C3: locality against warm models", () => {
  it("a cold load counts as the distance it clearly outweighs: 4 round trips, twice over", () => {
    expect(coldLoadMs(M15)).toBe(1_600);
    // 1,600 ms x 70 km/ms / (4 x 2) = 14,000 km (the old weighting made it 112,000 km: any warm host on Earth won).
    expect(coldLoadKm(coldLoadMs(M15))).toBe(14_000);
    expect(coldLoadKm(coldLoadMs(M7))).toBe(33_250);
  });

  it("idle: a cold near host loses to an idle warm one only when the load clearly exceeds the extra round trips (models that load slowly)", () => {
    const iadCold = { agentId: "iad", free: 2, slots: 2, region: "iad", cold: true };
    // A 14B model (6.6 s of load, 57,750 km): fra (~6,500 km from an iad buyer) warm and idle wins.
    expect(coldLoadMs(M14)).toBeGreaterThanOrEqual(COLD_PENALTY_MIN_LOAD_MS);
    expect(nearestFreeHolder([{ agentId: "fra", free: 2, slots: 2, region: "fra", warm: true }, iadCold], "iad", M14)?.agentId).toBe("fra");
    // Run 17: a 1.5b model (1.6 s of load, once) is loaded on the nearest host: the cold term does not
    // apply below COLD_PENALTY_MIN_LOAD_MS (the iad host had stayed cold while lax, gru, nrt, jnb got every call).
    expect(coldLoadMs(M15)).toBeLessThan(COLD_PENALTY_MIN_LOAD_MS);
    expect(nearestFreeHolder([{ agentId: "fra", free: 2, slots: 2, region: "fra", warm: true }, iadCold], "iad", M15)?.agentId).toBe("iad");
    expect(nearestFreeHolder([{ agentId: "syd", free: 2, slots: 2, region: "syd", warm: true }, iadCold], "iad", M15)?.agentId).toBe("iad");
  });

  it("under load: once the warm host is running calls, the nearby idle host wins (it warms up where the demand is)", () => {
    const iadCold = { agentId: "iad", free: 2, slots: 2, region: "iad", cold: true };
    // Run 3: the warm host had 1 of 2 slots busy; the nearest host still lost (6,500 + 750 km vs 112,000 km).
    const fraBusy = { agentId: "fra", free: 1, slots: 2, region: "fra", warm: true };
    expect(nearestFreeHolder([fraBusy, iadCold], "iad", M15)?.agentId).toBe("iad");
    // Even a warm host next door to the buyer loses only on distance and load, not on the cold load.
    const ordBusy = { agentId: "ord", free: 1, slots: 2, region: "ord", warm: true };
    expect(nearestFreeHolder([ordBusy, iadCold], "iad", M15)?.agentId).toBe("iad");
    // An idle warm host nearby still wins for a model that loads slowly: ord is ~950 km away, far less than 57,750 km.
    expect(nearestFreeHolder([{ ...ordBusy, free: 2 }, iadCold], "iad", M14)?.agentId).toBe("ord");
  });
});

describe("C4: an agent that has gone silent is not counted on", () => {
  it("heard from within AGENT_SILENT_MS (heartbeat or pull): routable; silent longer: not", () => {
    const now = 1_000_000_000;
    expect(AGENT_SILENT_MS).toBe(30_000);
    expect(agentRoutable("agent-c4-x", now - 29_000, now)).toBe(true);
    // Run 3: Auto placed two calls on a Mac last heard from 45 s before (the 2-minute window still counted it).
    expect(agentRoutable("agent-c4-x", now - 45_000, now)).toBe(false);
    // A pull is being heard from too.
    noteAgentPull("agent-c4-x", { inferenceSlots: 2, freeInferenceSlots: 2 }, now - 1_000);
    expect(agentRoutable("agent-c4-x", now - 45_000, now)).toBe(true);
  });

  it("best fit never places on a stale agent", () => {
    const view: NetworkView = {
      agents: [
        agent({ agentId: "mac-silent", computeClass: "apple", models: [M7], slots: 2, freeSlots: 2, tokensPerSec: 25, stale: true }),
        agent({ agentId: "cpu-live", computeClass: "cpu", models: [M15], slots: 2, freeSlots: 2, tokensPerSec: 18 }),
      ],
      pickupP50Ms: 250, waitingByModel: {}, btcUsd: 100_000,
    };
    const r = bestFit(describeJob(SIMPLE_QA, {}), view);
    expect(r.chosen?.agentId).toBe("cpu-live");
  });
});

/** The cloud host plus the two Macs, with their free slots. */
function pool(o: { mac7Free?: number; mac9Free?: number; cpu?: boolean; cloud?: boolean } = {}): NetworkView {
  const agents: AgentView[] = [
    agent({ agentId: "mac-maw", computeClass: "apple", models: [M7], slots: 2, freeSlots: o.mac7Free ?? 2, contextWindow: 32_768, tokensPerSec: 25 }),
    agent({ agentId: "mac-crs", computeClass: "apple", models: ["qwen3.5:9b"], slots: 2, freeSlots: o.mac9Free ?? 2, contextWindow: 32_768, tokensPerSec: 20 }),
    ...(o.cpu === false ? [] : [agent({ agentId: "ec-iad", computeClass: "cpu", models: [M15], slots: 2, freeSlots: 2, contextWindow: 8_192, tokensPerSec: 18 })]),
    ...(o.cloud === false ? [] : [agent({ agentId: "cloud-fireworks-1", computeClass: "cloud", models: [GLM, FLASH], slots: 16, freeSlots: 16, contextWindow: 1_000_000, rttMs: 30 })]),
  ];
  return { agents, pickupP50Ms: 250, waitingByModel: {}, btcUsd: 100_000 };
}
const isCloud = (m?: string) => m === GLM || m === FLASH;

describe("C5: reasoning models and max_tokens (AUTO_REASONING_MIN_TOKENS, off by default since run 4)", () => {
  const C5 = { ...DEFAULT_BEST_FIT_CONFIG, reasoningMinTokens: parseReasoningMinTokens("1024") };
  it("unset: no filter (the cloud host adds a reasoning allowance); a number or pairs set one", () => {
    expect(reasoningMinTokensFor(GLM)).toBeUndefined();
    expect(reasoningMinTokensFor(FLASH)).toBeUndefined();
    expect(outputRoomFor(GLM, 40)).toBe(true);
    expect(reasoningMinTokensFor(GLM, C5)).toBe(1_024);
    expect(reasoningMinTokensFor(M7, C5)).toBeUndefined();
    expect(outputRoomFor(GLM, 40, C5)).toBe(false);
    expect(outputRoomFor(GLM, 1_024, C5)).toBe(true);
    expect(outputRoomFor(GLM, undefined, C5)).toBe(true); // the provider's default cap
    expect(outputRoomFor(M7, 16, C5)).toBe(true);
    expect(parseReasoningMinTokens("2048")).toEqual({ [GLM]: 2_048, [FLASH]: 2_048 });
    expect(parseReasoningMinTokens(`${GLM}=4096, kimi-k3=1500`)).toEqual({ [GLM]: 4_096, "kimi-k3": 1_500 });
    expect(parseReasoningMinTokens(`1024, ${FLASH}=0`)).toEqual({ [GLM]: 1_024 });
    expect(parseReasoningMinTokens("off")).toEqual({});
    expect(parseReasoningMinTokens("")).toEqual({});
    expect(parseReasoningMinTokens("junk, glm-5.3=abc")).toEqual({});
    expect(bestFitConfigFromEnv({ AUTO_REASONING_MIN_TOKENS: "2048" }).reasoningMinTokens[FLASH]).toBe(2_048);
    expect(bestFitConfigFromEnv({}).reasoningMinTokens).toEqual({});
  });

  it("with a filter set, a top-tier call with max_tokens 40 is not placed on a reasoning cloud model; with 4096 it is", () => {
    const small = describeJob({ ...MULTI_FILE_REFACTOR, maxTokens: 40 }, { complexity: "very_high" });
    expect(isCloud(bestFit(small, pool(), C5).chosen?.model)).toBe(false);
    // Off (the default): the cloud host gives the thinking room on top of the 40 tokens.
    expect(isCloud(bestFit(small, pool()).chosen?.model)).toBe(true);
    const big = describeJob({ ...MULTI_FILE_REFACTOR, maxTokens: 4_096 }, { complexity: "very_high" });
    expect(isCloud(bestFit(big, pool(), C5).chosen?.model)).toBe(true);
  });

  it("run 3 (1f643318): a simple call with every Mac busy, max_tokens 1024 under a 2048 budget, stays on the network", () => {
    const cfg = { ...DEFAULT_BEST_FIT_CONFIG, reasoningMinTokens: parseReasoningMinTokens("2048") };
    const job = describeJob({ ...SIMPLE_QA, maxTokens: 1_024 }, { minParamsB: 7 });
    const r = bestFit(job, pool({ mac7Free: 0, mac9Free: 0 }), cfg);
    expect(isCloud(r.chosen?.model)).toBe(false);
    // Without the budget the cloud overflow is allowed again.
    expect(isCloud(bestFit(job, pool({ mac7Free: 0, mac9Free: 0 })).chosen?.model)).toBe(true);
  });

  it("only reasoning models fit and a filter is set: the refusal says which max_tokens they need", () => {
    const job = describeJob({ ...MULTI_FILE_REFACTOR, tools: TOOLS, maxTokens: 64 }, { complexity: "very_high" });
    const r = bestFit(job, { ...pool({ cpu: false }), agents: pool({ cpu: false }).agents.filter((a) => a.computeClass === "cloud") }, C5);
    expect(r.chosen).toBeNull();
    expect(r.rejected).toMatch(/deepseek-v4\.1-flash needs max_tokens ≥ 1024, glm-5\.3 needs max_tokens ≥ 1024/);
  });
});

describe("D5: a complex call with nothing of its floor online", () => {
  const complexJob = () => describeJob(MULTI_FILE_REFACTOR, {});

  it("takes the biggest model with a free slot (7b) instead of queueing behind the busy 9b", () => {
    const job = complexJob();
    expect(complexityClassOf(job).cls).toBe("complex");
    const r = bestFit(job, pool({ mac9Free: 0, cloud: false }));
    expect(r.chosen).toMatchObject({ model: M7, belowFloor: true });
    expect(r.capacity).toBe("spill");
    expect(r.reason).toMatch(/nothing ≥ 14B is available/);
  });

  it("the 9b when it has room; never below COMPLEX_FALLBACK_MIN_B; queues for the biggest when nothing that size is free", () => {
    expect(bestFit(complexJob(), pool({ cloud: false })).chosen).toMatchObject({ model: "qwen3.5:9b", belowFloor: true });
    expect(COMPLEX_FALLBACK_MIN_B).toBe(7);
    // Both Macs full, the 1.5b CPU free: a complex call does not drop to 1.5b; it waits for the 9b (auto-replace moves it).
    const r = bestFit(complexJob(), pool({ mac7Free: 0, mac9Free: 0, cloud: false }));
    expect(r.chosen).toMatchObject({ model: "qwen3.5:9b", belowFloor: true });
    expect(r.capacity).toBe("queued");
  });
});
