import { beforeEach, describe, expect, it } from "vitest";
import {
  agentMemory,
  agentMemoryRecord,
  circuitOpen,
  CIRCUIT_BASE_COOLDOWN_MS,
  MEMORY_FRESH_MS,
  memoryAdmits,
  memoryLimited,
  noteAgentMemory,
  noteAgentOutcome,
  noteAgentResult,
  noteDispatched,
  PENDING_LOAD_MS,
  REFUSAL_COOLDOWN_MS,
  resetMemoryAdmission,
} from "../../src/swarm/coordinator/memory-admission.js";
import { heartbeatSchema, memoryTelemetrySchema, registerSchema } from "../../src/swarm/coordinator/schemas.js";
import type { MemoryTelemetry } from "../../src/swarm/memory-budget.js";
import { coldLoadMs, estimate, type AgentView } from "../../src/swarm/coordinator/best-fit.js";

const GB = 1024 ** 3;
const T0 = 1_800_000_000_000;

function tele(over: Partial<MemoryTelemetry> = {}): MemoryTelemetry {
  return {
    totalBytes: 48 * GB,
    availableBytes: 20 * GB,
    pressure: "normal",
    budgetBytes: 28.8 * GB,
    usedBytes: 0,
    loadedModels: [],
    models: [
      { name: "qwen3.5:9b", bytes: 16 * GB, contextWindow: 32768, slots: 2 },
      { name: "deepseek-r1:14b", bytes: 20 * GB, contextWindow: 16384, slots: 2 },
    ],
    atMs: T0,
    ...over,
  };
}

beforeEach(() => resetMemoryAdmission());

describe("memory admission (coordinator)", () => {
  it("admits agents that report nothing (older releases), as before", () => {
    expect(memoryAdmits("old", "qwen3.5:9b", 3, T0)).toBe(true);
  });

  it("refuses a model that does not fit the agent's budget headroom", () => {
    // 9b loaded (16 GB of 28.8): the 14b (20 GB) does not fit next to it.
    noteAgentMemory("a", tele({ usedBytes: 16 * GB, loadedModels: [{ name: "qwen3.5:9b", bytes: 16 * GB }] }), T0);
    expect(memoryAdmits("a", "deepseek-r1:14b", 0, T0)).toBe(false);
    // Nothing loaded: it fits.
    noteAgentMemory("b", tele(), T0);
    expect(memoryAdmits("b", "deepseek-r1:14b", 0, T0)).toBe(true);
    // A model the agent did not size: the conservative 8k x 1 estimate (a 30B is ~22 GB) against 12.8 GB free.
    expect(memoryAdmits("a", "qwen3-coder:30b", 0, T0)).toBe(false);
  });

  it("admits a loaded model up to its slots", () => {
    noteAgentMemory("a", tele({ usedBytes: 16 * GB, loadedModels: [{ name: "qwen3.5:9b", bytes: 16 * GB }] }), T0);
    expect(memoryAdmits("a", "qwen3.5:9b", 0, T0)).toBe(true);
    expect(memoryAdmits("a", "qwen3.5:9b", 1, T0)).toBe(true);
    expect(memoryAdmits("a", "qwen3.5:9b", 2, T0)).toBe(false);
  });

  it("counts a load just dispatched against headroom until it shows as loaded", () => {
    noteAgentMemory("a", tele(), T0);
    noteDispatched("a", "deepseek-r1:14b", T0);
    // 20 GB on its way: the 9b (16 GB) no longer fits the 28.8 GB budget.
    expect(memoryAdmits("a", "qwen3.5:9b", 1, T0 + 1_000)).toBe(false);
    // The pending model itself is admitted up to its slots.
    expect(memoryAdmits("a", "deepseek-r1:14b", 1, T0 + 1_000)).toBe(true);
    expect(memoryAdmits("a", "deepseek-r1:14b", 2, T0 + 1_000)).toBe(false);
    // After PENDING_LOAD_MS without a report, it stops counting.
    noteAgentMemory("a", tele({ atMs: T0 + PENDING_LOAD_MS + 1 }), T0 + PENDING_LOAD_MS + 1);
    expect(memoryAdmits("a", "qwen3.5:9b", 0, T0 + PENDING_LOAD_MS + 1)).toBe(true);
  });

  it("treats warning or critical pressure, or a memory pause, as no capacity until it recovers", () => {
    for (const pressure of ["warning", "critical"] as const) {
      noteAgentMemory("a", tele({ pressure, loadedModels: [{ name: "qwen3.5:9b", bytes: 16 * GB }], usedBytes: 16 * GB }), T0);
      expect(memoryLimited("a", T0)).toBe(true);
      expect(memoryAdmits("a", "qwen3.5:9b", 0, T0)).toBe(false);
    }
    noteAgentMemory("a", tele({ paused: true }), T0);
    expect(memoryAdmits("a", "qwen3.5:9b", 0, T0)).toBe(false);
    noteAgentMemory("a", tele(), T0 + 5_000);
    expect(memoryAdmits("a", "qwen3.5:9b", 0, T0 + 5_000)).toBe(true);
  });

  it("ignores telemetry older than MEMORY_FRESH_MS", () => {
    noteAgentMemory("a", tele({ pressure: "critical" }), T0);
    expect(agentMemory("a", T0 + MEMORY_FRESH_MS + 1)).toBeUndefined();
    expect(memoryAdmits("a", "qwen3.5:9b", 0, T0 + MEMORY_FRESH_MS + 1)).toBe(true);
  });

  it("records peaks and incidents (critical, over budget) for the admin page and load-test reports", () => {
    noteAgentMemory("a", tele({ pressure: "critical", usedBytes: 30 * GB }), T0);
    noteAgentMemory("a", tele(), T0 + 1_000);
    const r = agentMemoryRecord("a")!;
    expect(r.peakPressure).toBe("critical");
    expect(r.peakUsedBytes).toBe(30 * GB);
    expect(r.overBudget).toBe(true);
    expect(r.incidents.map((i) => i.kind).sort()).toEqual(["critical", "over_budget"]);
  });

  it("a memory refusal stops calls for that model to the agent for a while (never a failure)", () => {
    noteAgentResult("a", "qwen3.5:9b", false, "memory_budget: qwen3.5:9b needs 16.0 GB", T0);
    expect(memoryAdmits("a", "qwen3.5:9b", 0, T0 + 1)).toBe(false);
    expect(memoryAdmits("a", "qwen2.5-coder:1.5b", 0, T0 + 1)).toBe(true);
    expect(memoryAdmits("a", "qwen3.5:9b", 0, T0 + REFUSAL_COOLDOWN_MS + 1)).toBe(true);
    for (let i = 0; i < 5; i++) noteAgentResult("a", "qwen3.5:9b", false, "memory_pressure: critical", T0);
    expect(circuitOpen("a", T0)).toBe(false);
  });
});

describe("circuit breaker", () => {
  it("opens after 3 consecutive failures, cools down, doubles per trip, and a success resets it", () => {
    noteAgentOutcome("a", false, T0);
    noteAgentOutcome("a", false, T0 + 1);
    expect(circuitOpen("a", T0 + 2)).toBe(false);
    noteAgentOutcome("a", false, T0 + 2);
    expect(circuitOpen("a", T0 + 3)).toBe(true);
    expect(circuitOpen("a", T0 + 2 + CIRCUIT_BASE_COOLDOWN_MS + 1)).toBe(false);
    const t1 = T0 + 2 * CIRCUIT_BASE_COOLDOWN_MS;
    for (let i = 0; i < 3; i++) noteAgentOutcome("a", false, t1 + i);
    // Second trip: twice as long.
    expect(circuitOpen("a", t1 + 2 + CIRCUIT_BASE_COOLDOWN_MS + 1)).toBe(true);
    expect(circuitOpen("a", t1 + 2 + 2 * CIRCUIT_BASE_COOLDOWN_MS + 1)).toBe(false);
    noteAgentOutcome("a", true, t1 + 3 * CIRCUIT_BASE_COOLDOWN_MS);
    for (let i = 0; i < 2; i++) noteAgentOutcome("a", false, t1 + 3 * CIRCUIT_BASE_COOLDOWN_MS + i);
    expect(circuitOpen("a", t1 + 3 * CIRCUIT_BASE_COOLDOWN_MS + 5)).toBe(false);
  });

  it("a call declined for its context window is neutral", () => {
    for (let i = 0; i < 5; i++) noteAgentResult("a", "m", false, "context_too_long: needs 40000 tokens", T0 + i);
    expect(circuitOpen("a", T0 + 10)).toBe(false);
    for (let i = 0; i < 3; i++) noteAgentResult("a", "m", false, "ollama crashed", T0 + i);
    expect(circuitOpen("a", T0 + 10)).toBe(true);
  });
});

describe("heartbeat memory telemetry parsing", () => {
  it("parses a well-formed report on heartbeat and register", () => {
    const t = tele({ loadedModels: [{ name: "qwen3.5:9b", bytes: 16 * GB }], usedBytes: 16 * GB });
    expect(heartbeatSchema.parse({ agentId: "a", memory: t }).memory).toEqual(t);
    const reg = registerSchema.parse({ agentId: "a", os: "macos", version: "1", mode: "swarm-only", memory: t });
    expect(reg.memory?.pressure).toBe("normal");
  });

  it("drops a malformed report without rejecting the heartbeat", () => {
    const hb = heartbeatSchema.safeParse({ agentId: "a", memory: { pressure: "melting", totalBytes: "lots" } });
    expect(hb.success).toBe(true);
    expect(hb.success && hb.data.memory).toBeUndefined();
    expect(memoryTelemetrySchema.parse({ ...tele(), loadedModels: new Array(100).fill({ name: "x", bytes: 1 }) })).toBeUndefined();
  });
});

describe("best fit: model affinity", () => {
  it("adds a cold-load wait on an agent that would have to load the model", () => {
    const job = { job: "chat", promptTokens: 500, newTokens: 500, expectedOutputTokens: 200 } as any;
    const base: AgentView = { agentId: "x", label: "x", coordinatorId: "c", local: true, computeClass: "apple", tierWeight: 1, models: ["qwen3.5:9b"], slots: 2, freeSlots: 2, verified: true, stale: false, rttMs: 20 };
    const view = { pickupP50Ms: 200, waitingByModel: {}, btcUsd: 100_000 };
    const warm = estimate(job, { ...base, loadedModels: ["qwen3.5:9b"] }, "qwen3.5:9b", view, 1);
    const cold = estimate(job, { ...base, loadedModels: ["qwen2.5-coder:7b"] }, "qwen3.5:9b", view, 1);
    const unknown = estimate(job, base, "qwen3.5:9b", view, 1);
    expect(cold.waitMs - warm.waitMs).toBe(coldLoadMs("qwen3.5:9b"));
    expect(unknown.waitMs).toBe(warm.waitMs);
  });
});
