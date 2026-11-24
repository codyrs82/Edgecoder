import { describe, expect, it } from "vitest";
import { describeJob } from "../../src/inference-api/job-descriptor.js";
import { bestFit, PULL_FRESH_MS, pullsWork, reliabilityOf, UNPROVEN_PULL_FACTOR, type NetworkView } from "../../src/swarm/coordinator/best-fit.js";
import { SIMPLE_QA } from "../helpers/job-fixtures.js";
import { agent, currentNetwork } from "./helpers/best-fit-network.js";

/*
 * #523: an agent that heartbeats but has never pulled work (or not recently) is not capacity Auto can
 * count on: a proven alternative wins. #526: among otherwise equal agents, the one nearest the buyer.
 */

const withPulls = (view: NetworkView, ages: Record<string, number | null>): NetworkView => ({
  ...view,
  agents: view.agents.map((a) => (a.agentId in ages ? { ...a, pullAgeMs: ages[a.agentId] } : { ...a, pullAgeMs: 1_000 })),
});

describe("pull confidence", () => {
  it("knows which agents pull work", () => {
    expect(pullsWork({ pullAgeMs: undefined })).toBe(true); // a peer's agent: not known, no penalty
    expect(pullsWork({ pullAgeMs: 2_000 })).toBe(true);
    expect(pullsWork({ pullAgeMs: PULL_FRESH_MS + 1 })).toBe(false);
    expect(pullsWork({ pullAgeMs: null })).toBe(false);
    const a = agent({ agentId: "x", computeClass: "apple", models: ["qwen2.5-coder:7b"] });
    expect(reliabilityOf({ ...a, pullAgeMs: null })).toBeCloseTo(reliabilityOf({ ...a, pullAgeMs: 10 }) * UNPROVEN_PULL_FACTOR, 6);
  });

  it("the 2026-11-24 case: the only 7b holder never pulled, so Auto takes a proven alternative", () => {
    const job = describeJob(SIMPLE_QA);
    // Everyone pulls: the 7b Mac is the best fit.
    expect(bestFit(job, withPulls(currentNetwork(), {})).chosen?.agentId).toBe("mac7");
    // The 7b Mac never pulled: another model wins, and the 7b is ranked lower.
    const r = bestFit(job, withPulls(currentNetwork(), { mac7: null }));
    expect(r.chosen?.agentId).not.toBe("mac7");
    expect(r.chosen!.paramsB).toBeGreaterThanOrEqual(r.requirements.minParamsB);
    // So does one that stopped pulling a while ago.
    expect(bestFit(job, withPulls(currentNetwork(), { mac7: PULL_FRESH_MS * 4 })).chosen?.agentId).not.toBe("mac7");
  });

  it("an unproven agent is still used when nothing else fits", () => {
    const view: NetworkView = { agents: [{ ...agent({ agentId: "only", computeClass: "apple", models: ["qwen2.5-coder:7b"] }), pullAgeMs: null }], pickupP50Ms: 250, waitingByModel: {}, btcUsd: 100_000 };
    expect(bestFit(describeJob(SIMPLE_QA), view).chosen?.agentId).toBe("only");
  });
});

describe("buyer locality", () => {
  it("between two equal agents, the one nearest the buyer is preferred", () => {
    const twins: NetworkView = {
      agents: [
        { ...agent({ agentId: "far", computeClass: "cpu", models: ["qwen2.5-coder:7b"], tokensPerSec: 10 }), clientRttMs: 150 },
        { ...agent({ agentId: "near", computeClass: "cpu", models: ["qwen2.5-coder:7b"], tokensPerSec: 10 }), clientRttMs: 2 },
      ],
      pickupP50Ms: 250,
      waitingByModel: {},
      btcUsd: 100_000,
    };
    const r = bestFit(describeJob(SIMPLE_QA), twins);
    expect(r.chosen?.agentId).toBe("near");
    expect(r.chosen!.estimate.rttMs).toBe(40 + 2);
  });
});
