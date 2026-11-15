import { describe, expect, it } from "vitest";
import { describeJob, JOB_TYPES } from "../../src/inference-api/job-descriptor.js";
import {
  DEFAULT_BEST_FIT_CONFIG,
  activeParamsB,
  bestFit,
  bestFitConfigFromEnv,
  decodeTps,
  effectiveWeights,
  requirementsFor,
  routedLine,
  type NetworkView,
} from "../../src/swarm/coordinator/best-fit.js";
import { AGENTIC_LOOP, CLASSIFY, LONG_LOG_SUMMARY, MULTI_FILE_REFACTOR, ONE_LINE_FIX, SIMPLE_QA, SINGLE_EDIT } from "../helpers/job-fixtures.js";
import { agent, currentNetwork } from "./helpers/best-fit-network.js";

const pick = (req: Parameters<typeof describeJob>[0], view: NetworkView = currentNetwork(), hints = {}) => bestFit(describeJob(req, hints), view);
const where = (r: ReturnType<typeof bestFit>) => `${r.chosen?.model}@${r.chosen?.computeClass}`;

describe("best fit on the current network (9 CPU 1.5b, a 1-slot GPU 30b, Macs 7b/14b/1.5b)", () => {
  it("a simple question goes to a mid-size model, not a 1.5b and not the big GPU model", () => {
    const r = pick(SIMPLE_QA);
    expect(where(r)).toBe("qwen2.5-coder:7b@apple");
    expect(r.requirements.minParamsB).toBe(3);
    expect(r.reason).toMatch(/^chat · complexity low/);
  });

  it("classification and extraction run on a small fast model", () => {
    expect(where(pick(CLASSIFY))).toBe("qwen2.5-coder:1.5b@apple");
    expect(pick(SIMPLE_QA, currentNetwork(), { job: "extract" }).chosen?.paramsB).toBe(1.5);
  });

  it("a multi-file refactor and an agent loop get the 30B coder (complexity sets the minimum)", () => {
    const refactor = pick(MULTI_FILE_REFACTOR);
    expect(where(refactor)).toBe("qwen3-coder:30b@gpu");
    expect(refactor.requirements.minParamsB).toBe(14);
    const agentic = pick(AGENTIC_LOOP);
    expect(where(agentic)).toBe("qwen3-coder:30b@gpu");
    expect(agentic.requirements.needsTools).toBe(true);
    // The 1.5b models never qualify for these.
    expect(agentic.candidates.every((c) => c.paramsB >= 14)).toBe(true);
  });

  it("a long log is summarized by a model whose window holds it (the CPU agents' 16k windows do not)", () => {
    const r = pick(LONG_LOG_SUMMARY);
    expect(r.chosen?.computeClass).not.toBe("cpu");
    expect(r.candidates.some((c) => c.computeClass === "cpu")).toBe(false);
  });

  it("every job type picks something sensible", () => {
    for (const job of JOB_TYPES) {
      const r = pick(SIMPLE_QA, currentNetwork(), { job });
      expect(r.chosen, job).not.toBeNull();
      expect(r.chosen!.paramsB, job).toBeGreaterThanOrEqual(r.requirements.minParamsB);
      if (job === "classify" || job === "extract" || job === "summarize") expect(r.chosen!.paramsB, job).toBeLessThan(7);
      if (job === "agentic" || job === "refactor") expect(r.chosen!.paramsB, job).toBe(30);
    }
  });

  it("load shifts the choice: with the GPU busy and calls queued, a code edit moves to the 14B Mac", () => {
    expect(where(pick(SINGLE_EDIT))).toBe("qwen3-coder:30b@gpu");
    const busy = pick(SINGLE_EDIT, currentNetwork({ gpuFree: 0, gpuWaiting: 3 }));
    expect(where(busy)).toBe("qwen2.5-coder:14b@apple");
    const gpu = busy.candidates.find((c) => c.computeClass === "gpu")!;
    expect(gpu.estimate.waitMs).toBeGreaterThan(10_000);
    expect(busy.chosen!.estimate.waitMs).toBeLessThan(1_000);
  });

  it("high complexity holds out for the capable model even under load (quality outweighs the wait)", () => {
    expect(where(pick(MULTI_FILE_REFACTOR, currentNetwork({ gpuFree: 0, gpuWaiting: 3 })))).toBe("qwen3-coder:30b@gpu");
  });

  it("a price ceiling is respected", () => {
    const free = pick(SINGLE_EDIT);
    const ceiling = 0.2;
    expect(free.chosen!.estimate.cSats).toBeGreaterThan(ceiling);
    const capped = pick(SINGLE_EDIT, currentNetwork(), { maxCSats: ceiling });
    expect(capped.chosen).not.toBeNull();
    expect(capped.chosen!.estimate.cSats).toBeLessThanOrEqual(ceiling);
    expect(capped.candidates.every((c) => c.estimate.cSats <= ceiling)).toBe(true);
    const none = pick(SINGLE_EDIT, currentNetwork(), { maxCSats: 0.000001 });
    expect(none.chosen).toBeNull();
    expect(none.rejected).toMatch(/cSats ceiling/);
  });

  it("context fit: a call bigger than every window is refused with the reason; a client's minContext counts", () => {
    const huge = pick({ messages: [{ role: "user", content: "x ".repeat(150_000) }] });
    expect(huge.chosen).toBeNull();
    expect(huge.rejected).toMatch(/context window/);
    const r = pick(CLASSIFY, currentNetwork(), { minContext: 20_000 });
    expect(r.candidates.some((c) => c.computeClass === "cpu")).toBe(false);
  });

  it("tools: an agent turn never goes to a model that does not call tools", () => {
    const view = currentNetwork();
    view.agents.push(agent({ agentId: "r1", computeClass: "gpu", models: ["deepseek-r1:70b"], tokensPerSec: 30 }));
    const r = bestFit(describeJob(AGENTIC_LOOP), view);
    expect(r.candidates.some((c) => c.model === "deepseek-r1:70b")).toBe(false);
    const noTools: NetworkView = { ...view, agents: [agent({ agentId: "r1", computeClass: "gpu", models: ["deepseek-r1:70b"] })] };
    expect(bestFit(describeJob(AGENTIC_LOOP), noTools).rejected).toMatch(/tools/);
  });

  it("nothing meets the minimum: the biggest available model answers, marked", () => {
    const small: NetworkView = { ...currentNetwork(), agents: currentNetwork().agents.filter((a) => a.models[0].endsWith("1.5b") || a.models[0].endsWith(":7b")) };
    const r = bestFit(describeJob(MULTI_FILE_REFACTOR), small);
    expect(r.chosen?.model).toBe("qwen2.5-coder:7b");
    expect(r.chosen?.belowFloor).toBe(true);
    expect(r.reason).toMatch(/nothing ≥ 14B is available/);
  });

  it("stale and failing agents lose; a measured speed beats the class default", () => {
    const view = currentNetwork();
    view.agents.find((a) => a.agentId === "gpu1")!.stale = true;
    expect(pick(MULTI_FILE_REFACTOR, view).chosen?.model).toBe("qwen2.5-coder:14b");
    const flaky = currentNetwork();
    flaky.agents.push(agent({ agentId: "mac7b", computeClass: "apple", models: ["qwen2.5-coder:7b"], tokensPerSec: 22, contextWindow: 32_768, failRate: 0.8 }));
    expect(pick(SIMPLE_QA, flaky).chosen?.agentId).toBe("mac7");
    expect(decodeTps({ computeClass: "cpu", tokensPerSec: 40, activeModel: "qwen2.5-coder:7b" }, "qwen2.5-coder:14b")).toBe(20);
    expect(activeParamsB("qwen3-coder:30b")).toBe(3.3);
    expect(activeParamsB("qwen2.5-coder:1.5b")).toBe(1.5);
  });

  it("keeps the best agent per (model, class): nine CPU agents are one candidate", () => {
    const r = pick(CLASSIFY);
    expect(r.candidates.filter((c) => c.model === "qwen2.5-coder:1.5b" && c.computeClass === "cpu")).toHaveLength(1);
  });

  it("explains itself", () => {
    const r = pick(SINGLE_EDIT, currentNetwork({ gpuFree: 0, gpuWaiting: 3 }));
    expect(routedLine(r)).toMatch(/^routed to qwen2\.5-coder:14b on apple because code edit · complexity low \(0\.\d\d\)/);
    expect(r.chosen!.parts).toEqual({ quality: expect.any(Number), latency: expect.any(Number), price: expect.any(Number), reliability: expect.any(Number) });
  });
});

describe("session affinity", () => {
  const followUp = { messages: [...AGENTIC_LOOP.messages, { role: "assistant" as const, content: "", tool_calls: [{ function: { name: "edit_file", arguments: {} } }] }, { role: "tool" as const, tool_name: "edit_file", content: "ok" }], tools: AGENTIC_LOOP.tools };
  const sessionOn = (agentId: string, model: string, computeClass: string) => ({ agentId, model, computeClass, atMs: 1_000 });

  it("keeps the last turn's machine while its wait is shorter than re-reading the prompt elsewhere", () => {
    const view = currentNetwork();
    // A long conversation: re-reading it costs seconds.
    const long = { ...followUp, messages: [{ role: "system" as const, content: "context ".repeat(6_000) }, ...followUp.messages] };
    const job = describeJob(long);
    const r = bestFit(job, view, DEFAULT_BEST_FIT_CONFIG, sessionOn("mac14", "qwen2.5-coder:14b", "apple"), 2_000);
    expect(r.chosen?.agentId).toBe("mac14");
    expect(r.affinity.status).toBe("kept");
    expect(r.reason).toMatch(/session affinity: prompt cached/);
  });

  it("breaks it when that machine is busy and the prompt is cheap to re-read", () => {
    const view = currentNetwork();
    view.agents.find((a) => a.agentId === "mac14")!.freeSlots = 0;
    view.waitingByModel["qwen2.5-coder:14b"] = 4;
    const r = bestFit(describeJob(followUp), view, DEFAULT_BEST_FIT_CONFIG, sessionOn("mac14", "qwen2.5-coder:14b", "apple"), 2_000);
    expect(r.chosen?.agentId).toBe("gpu1");
    expect(r.affinity).toMatchObject({ status: "broken", reason: expect.stringMatching(/busy/) });
  });

  it("breaks it when the machine is stale, failing, or its context is too small", () => {
    const job = describeJob(followUp);
    const stale = currentNetwork();
    stale.agents.find((a) => a.agentId === "mac14")!.stale = true;
    expect(bestFit(job, stale, DEFAULT_BEST_FIT_CONFIG, sessionOn("mac14", "qwen2.5-coder:14b", "apple"), 2_000).affinity.reason).toMatch(/offline/);
    const failing = currentNetwork();
    failing.agents.find((a) => a.agentId === "mac14")!.failRate = 0.9;
    expect(bestFit(job, failing, DEFAULT_BEST_FIT_CONFIG, sessionOn("mac14", "qwen2.5-coder:14b", "apple"), 2_000).affinity.reason).toMatch(/failing/);
    const small = currentNetwork();
    small.agents.find((a) => a.agentId === "mac14")!.contextWindow = 2_048;
    expect(bestFit(job, small, DEFAULT_BEST_FIT_CONFIG, sessionOn("mac14", "qwen2.5-coder:14b", "apple"), 2_000).affinity.reason).toMatch(/context/);
  });

  it("breaks it when the job no longer fits last turn's model, and forgets it after the TTL", () => {
    const job = describeJob(followUp);
    const r = bestFit(job, currentNetwork(), DEFAULT_BEST_FIT_CONFIG, sessionOn("cpu1", "qwen2.5-coder:1.5b", "cpu"), 2_000);
    expect(r.affinity).toMatchObject({ status: "broken", reason: expect.stringMatching(/no longer fits/) });
    const old = bestFit(job, currentNetwork(), DEFAULT_BEST_FIT_CONFIG, sessionOn("mac14", "qwen2.5-coder:14b", "apple"), 1_000 + DEFAULT_BEST_FIT_CONFIG.sessionTtlMs + 1);
    expect(old.affinity.status).toBe("none");
  });
});

describe("requirements, weights and config", () => {
  it("complexity raises the minimum model and moves weight to quality and reliability", () => {
    const low = describeJob(SIMPLE_QA, { job: "code_edit", complexity: "low" });
    const high = describeJob(SIMPLE_QA, { job: "code_edit", complexity: "very_high" });
    expect(requirementsFor(low).minParamsB).toBe(7);
    expect(requirementsFor(high).minParamsB).toBe(30);
    const wl = effectiveWeights(low);
    const wh = effectiveWeights(high);
    expect(wh.quality).toBeGreaterThan(wl.quality);
    expect(wh.reliability).toBeGreaterThan(wl.reliability);
    expect(wh.latency).toBeLessThan(wl.latency);
    expect(wh.price).toBeLessThan(wl.price);
    expect(wh.quality + wh.latency + wh.price + wh.reliability).toBeCloseTo(1, 2);
    // Light jobs stay small even when complex.
    expect(requirementsFor(describeJob(SIMPLE_QA, { job: "classify", complexity: "very_high" })).minParamsB).toBe(7);
    // "best" wants bigger models; "fast" and "batch" move weight to speed and price.
    expect(requirementsFor(describeJob(SIMPLE_QA, { job: "code_edit", quality: "best" })).enoughParamsB).toBeGreaterThan(requirementsFor(low).enoughParamsB);
    expect(effectiveWeights(describeJob(SIMPLE_QA, { quality: "fast" })).latency).toBeGreaterThan(effectiveWeights(describeJob(SIMPLE_QA)).latency);
    expect(effectiveWeights(describeJob(SIMPLE_QA, { latency: "batch" })).latency).toBeLessThan(effectiveWeights(describeJob(SIMPLE_QA)).latency);
  });

  it("quality best moves a code edit to the biggest coder", () => {
    expect(pick(ONE_LINE_FIX, currentNetwork({ gpuFree: 0, gpuWaiting: 1 }), { quality: "best" }).chosen?.model).toBe("qwen3-coder:30b");
  });

  it("reads BEST_FIT_* with defaults for anything missing or out of range", () => {
    expect(bestFitConfigFromEnv({})).toEqual(DEFAULT_BEST_FIT_CONFIG);
    const c = bestFitConfigFromEnv({ BEST_FIT_W_QUALITY: "1", BEST_FIT_W_PRICE: "-2", BEST_FIT_PREFER_MS: "250", BEST_FIT_PEERS: "0", BEST_FIT_COMPLEXITY_SHIFT: "9", BEST_FIT_OVERSIZE_PENALTY: "0.5" });
    expect(c.weights).toEqual({ ...DEFAULT_BEST_FIT_CONFIG.weights, quality: 1 });
    expect(c).toMatchObject({ preferMs: 250, peers: false, complexityShift: 1, oversizePenalty: 0.5 });
  });

  it("weights from the config change the choice: price only picks the cheapest that fits", () => {
    const priceOnly = { ...DEFAULT_BEST_FIT_CONFIG, complexityShift: 0, weights: { quality: 0, latency: 0, price: 1, reliability: 0 } };
    const r = bestFit(describeJob(SINGLE_EDIT), currentNetwork(), priceOnly);
    const cheapest = Math.min(...r.candidates.map((c) => c.estimate.cSats));
    expect(r.chosen!.estimate.cSats).toBe(cheapest);
  });

  it("scores peer coordinators' agents with the link round trip", () => {
    const view = currentNetwork();
    view.agents.push(agent({ agentId: "peer-gpu", computeClass: "gpu.dc", models: ["qwen3-coder:30b"], tokensPerSec: 120, contextWindow: 65_536, local: false, coordinatorId: "coord-b", linkRttMs: 80 }));
    const r = bestFit(describeJob(MULTI_FILE_REFACTOR), view);
    expect(r.chosen).toMatchObject({ agentId: "peer-gpu", local: false, coordinatorId: "coord-b" });
    expect(r.chosen!.estimate.rttMs).toBe(120);
  });
});
