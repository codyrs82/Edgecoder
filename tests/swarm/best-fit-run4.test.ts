import { describe, expect, it } from "vitest";
import { describeJob } from "../../src/inference-api/job-descriptor.js";
import { bestFit, bestFitConfigFromEnv, DEFAULT_BEST_FIT_CONFIG, type AgentView, type NetworkView } from "../../src/swarm/coordinator/best-fit.js";
import { SIMPLE_QA } from "../helpers/job-fixtures.js";
import { agent } from "./helpers/best-fit-network.js";

/*
 * Network validation run 4 (2026-11-25), whole-pool ramp: 16 of 85 simple Auto calls went to the
 * cloud host (session affinity, "fastest that fits (est. 8.6 s vs 47.4 s)") and 7 simple calls
 * spilled onto a 1.5b CPU host that needed ~3 minutes and timed out at 180 s.
 *
 * The cloud is overflow for simple calls, decided before any score: it is not a candidate at all
 * while a non-cloud machine in the call's spill band has a free slot that finishes in time
 * (maxCompletionMs), whatever session affinity or the speed estimate say. A machine that would not
 * finish in time is not room, and is not placed on while the cloud can take the call.
 */

const FLASH = "deepseek-v4.1-flash";
const GLM = "glm-5.3";
const M15 = "qwen2.5-coder:1.5b";
const M9 = "qwen3.5:9b";

/** A "write tests" call like the loadgen's: 149 code lines, ~2.5k prompt tokens, max_tokens 1024 (simple). */
function testsCall() {
  const code = Array.from({ length: 149 }, (_, i) => `export function step${i}(input: number[]): number { return input.reduce((a, b) => a + b * ${i}, 0); }`).join("\n");
  return describeJob({ messages: [{ role: "user", content: `Write unit tests for this module:\n\`\`\`ts\n${code}\n\`\`\`` }], maxTokens: 1_024 }, {});
}
const chatCall = () => describeJob({ ...SIMPLE_QA, maxTokens: 1_024 }, {});

function net(o: { macFree?: number; cpuFree?: number; cpuTps?: number; cloud?: boolean; peerCpuFree?: number } = {}): NetworkView {
  const agents: AgentView[] = [
    agent({ agentId: "mac-crs", computeClass: "apple", models: [M9], slots: 2, freeSlots: o.macFree ?? 0, contextWindow: 32_768, tokensPerSec: 20 }),
    agent({ agentId: "ec-iad", computeClass: "cpu", models: [M15], slots: 2, freeSlots: o.cpuFree ?? 0, contextWindow: 32_768, tokensPerSec: o.cpuTps ?? 30 }),
    ...(o.peerCpuFree !== undefined
      ? [agent({ agentId: "ec-fra", computeClass: "cpu", models: [M15], slots: 2, freeSlots: o.peerCpuFree, contextWindow: 32_768, tokensPerSec: o.cpuTps ?? 30, local: false, coordinatorId: "coord-eu", linkRttMs: 90 })]
      : []),
    ...(o.cloud === false ? [] : [agent({ agentId: "cloud-fireworks-1", computeClass: "cloud", models: [GLM, FLASH], slots: 16, freeSlots: 14, contextWindow: 1_000_000, rttMs: 30 })]),
  ];
  return { agents, pickupP50Ms: 250, waitingByModel: {}, btcUsd: 100_000 };
}
const isCloud = (m?: string) => m === GLM || m === FLASH;

describe("run 4: the cloud is a hard overflow gate for simple calls", () => {
  it("the fixtures are simple calls", () => {
    expect(testsCall().job).toBe("tests");
    expect(bestFit(testsCall(), net({ cpuFree: 2 })).complexityClass).toBe("simple");
    expect(bestFit(chatCall(), net({ cpuFree: 2 })).complexityClass).toBe("simple");
  });

  it("session affinity to the cloud host does not keep a simple call there while a CPU host has a free slot", () => {
    const session = { agentId: "cloud-fireworks-1", model: FLASH, computeClass: "cloud", atMs: 1_000 };
    const r = bestFit(chatCall(), net({ cpuFree: 2 }), DEFAULT_BEST_FIT_CONFIG, session, 2_000);
    expect(r.chosen?.agentId).toBe("ec-iad");
    expect(r.candidates.some((c) => isCloud(c.model))).toBe(false);
    expect(r.affinity.status).toBe("broken");
    // Every network machine full: the cloud takes the overflow, and affinity may keep it there.
    const full = bestFit(chatCall(), net(), DEFAULT_BEST_FIT_CONFIG, session, 2_000);
    expect(isCloud(full.chosen?.model)).toBe(true);
    expect(full.reason).toMatch(/cloud overflow: no machine ≥ 1\.5B has a free slot/);
  });

  it("a faster cloud estimate does not win while a CPU host in the band can finish in time", () => {
    const r = bestFit(testsCall(), net({ cpuFree: 1 }));
    expect(r.chosen?.agentId).toBe("ec-iad");
    expect(r.chosen?.estimate.totalMs).toBeLessThan(DEFAULT_BEST_FIT_CONFIG.maxCompletionMs);
    expect(r.candidates.some((c) => isCloud(c.model))).toBe(false);
  });

  it("an idle host on a peer coordinator counts as room (run 4: fra/lhr idle, US hosts full)", () => {
    const r = bestFit(testsCall(), net({ cpuFree: 0, peerCpuFree: 2 }));
    expect(r.chosen?.agentId).toBe("ec-fra");
    expect(isCloud(r.chosen?.model)).toBe(false);
  });

  it("a CPU host that would not finish before the deadline is not room: the cloud takes the overflow (inf-…-2fce2027)", () => {
    // 6 tok/s on 1.5b: ~880 tokens of tests take ~150 s plus the prompt; run 4's fra host timed out at 180 s.
    const r = bestFit(testsCall(), net({ cpuFree: 2, cpuTps: 6 }));
    expect(isCloud(r.chosen?.model)).toBe(true);
    expect(r.candidates.some((c) => c.agentId === "ec-iad")).toBe(false);
    expect(r.reason).toMatch(/cloud overflow/);
    // The same short chat call still fits the slow host in time: it stays off the cloud.
    expect(isCloud(bestFit(chatCall(), net({ cpuFree: 2, cpuTps: 6 })).chosen?.model)).toBe(false);
  });

  it("with no cloud online, the slow host is still used (nothing else can take it)", () => {
    const r = bestFit(testsCall(), net({ cpuFree: 2, cpuTps: 6, cloud: false }));
    expect(r.chosen?.agentId).toBe("ec-iad");
  });

  it("BEST_FIT_MAX_COMPLETION_MS sets the limit (default 120 s)", () => {
    expect(DEFAULT_BEST_FIT_CONFIG.maxCompletionMs).toBe(120_000);
    expect(bestFitConfigFromEnv({ BEST_FIT_MAX_COMPLETION_MS: "300000" }).maxCompletionMs).toBe(300_000);
    expect(bestFitConfigFromEnv({ BEST_FIT_MAX_COMPLETION_MS: "junk" }).maxCompletionMs).toBe(120_000);
    const lax = { ...DEFAULT_BEST_FIT_CONFIG, maxCompletionMs: 600_000 };
    expect(bestFit(testsCall(), net({ cpuFree: 2, cpuTps: 6 }), lax).chosen?.agentId).toBe("ec-iad");
  });
});
