import { describe, expect, it } from "vitest";
import { describeJob } from "../../src/inference-api/job-descriptor.js";
import { bestFit, contentionFactor, DEFAULT_BEST_FIT_CONFIG, estimate, type AgentView, type NetworkView } from "../../src/swarm/coordinator/best-fit.js";
import { agent } from "./helpers/best-fit-network.js";

/*
 * Network validation run 5 (2026-11-25): simple "tests" calls (~2.5k prompt tokens, max_tokens 1024)
 * spilled onto 1.5b CPU hosts when every model ≥ 7B was full, with estimates of 115-119 s, just
 * under the 120 s gate (BEST_FIT_MAX_COMPLETION_MS), and ran past the 180 s deadline:
 * inf-1795600164112-dd9f5233, inf-1795600150374-63365602, inf-1795600194381-5d19286e.
 *
 * The prompt was counted (ttft 37-38 s of the estimate is its prefill). What the estimate left out:
 * the host was already running another such call (2-slot CPU hosts, busy 1/2 in the agents
 * snapshot), and a CPU host's cores are shared by every call it runs, so each ran at about half the
 * measured single-call speed. The estimate now counts the calls already running on the machine.
 */

const FLASH = "deepseek-v4.1-flash";
const M15 = "qwen2.5-coder:1.5b";
const M9 = "qwen3.5:9b";

function testsCall() {
  const code = Array.from({ length: 149 }, (_, i) => `export function step${i}(input: number[]): number { return input.reduce((a, b) => a + b * ${i}, 0); }`).join("\n");
  return describeJob({ messages: [{ role: "user", content: `Write unit tests for this module:\n\`\`\`ts\n${code}\n\`\`\`` }], maxTokens: 1_024 }, {});
}

/** The run-5 pool at 1795600164: the 9b Mac full, 1.5b CPU hosts with `cpu` free slots each, the cloud host free. */
function net(cpu: number[], tps = 14): NetworkView {
  const agents: AgentView[] = [
    agent({ agentId: "mac-crs", computeClass: "apple", models: [M9], slots: 2, freeSlots: 0, contextWindow: 32_768, tokensPerSec: 20 }),
    ...cpu.map((free, i) => agent({ agentId: `ec-st${i + 1}`, computeClass: "cpu", models: [M15], slots: 2, freeSlots: free, contextWindow: 32_768, tokensPerSec: tps })),
    agent({ agentId: "cloud-fireworks-1", computeClass: "cloud", models: [FLASH], slots: 16, freeSlots: 12, contextWindow: 1_000_000, rttMs: 30 }),
  ];
  return { agents, pickupP50Ms: 50, waitingByModel: {}, btcUsd: 100_000 };
}

describe("run 5: a call's estimate counts the calls already running on the machine", () => {
  it("contention: CPU calls share the cores; a cloud host and a one-slot machine are not slowed", () => {
    expect(contentionFactor({ computeClass: "cpu", slots: 2, freeSlots: 2 })).toBe(1);
    expect(contentionFactor({ computeClass: "cpu", slots: 2, freeSlots: 1 })).toBe(2);
    // Calls queued for it will run beside it too; never more than the other slots.
    expect(contentionFactor({ computeClass: "cpu", slots: 2, freeSlots: 2 }, 1)).toBe(2);
    expect(contentionFactor({ computeClass: "cpu", slots: 2, freeSlots: 0 }, 3)).toBe(2);
    expect(contentionFactor({ computeClass: "apple", slots: 2, freeSlots: 1 })).toBe(1.5);
    expect(contentionFactor({ computeClass: "cloud", slots: 16, freeSlots: 2 })).toBe(1);
    expect(contentionFactor({ computeClass: "cpu", slots: 1, freeSlots: 0 })).toBe(1);
  });

  it("the run-5 shape: idle the host is just in time; with one call running it is not", () => {
    const job = testsCall();
    const v = net([2]);
    const idle = estimate(job, v.agents[1], M15, v, 1);
    expect(idle.totalMs).toBeGreaterThan(100_000);
    expect(idle.totalMs).toBeLessThan(DEFAULT_BEST_FIT_CONFIG.maxCompletionMs);
    const busy = net([1]);
    const shared = estimate(job, busy.agents[1], M15, busy, 1);
    expect(shared.totalMs).toBeGreaterThan(DEFAULT_BEST_FIT_CONFIG.maxCompletionMs);
    expect(shared.ttftMs).toBeGreaterThan(idle.ttftMs);
  });

  it("every ≥7B host full and the 1.5b CPU hosts each running a call: the cloud takes it, not a 1.5b spill", () => {
    const r = bestFit(testsCall(), net([1, 1, 1, 0]));
    expect(r.chosen?.model).toBe(FLASH);
    expect(r.reason).toMatch(/cloud overflow: no machine ≥ 1\.5B has a free slot that finishes within 120\.0 s/);
    expect(r.candidates.some((c) => c.model === M15)).toBe(false);
  });

  it("an idle 1.5b CPU host is still room (contract), and wins over a busy one", () => {
    const r = bestFit(testsCall(), net([1, 2, 1]));
    expect(r.chosen?.agentId).toBe("ec-st2");
    expect(r.chosen?.estimate.totalMs).toBeLessThan(DEFAULT_BEST_FIT_CONFIG.maxCompletionMs);
  });
});
