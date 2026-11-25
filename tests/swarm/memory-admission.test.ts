import { beforeEach, describe, expect, it } from "vitest";
import {
  agentMemory,
  agentMemoryRecord,
  circuitBlocks,
  circuitHalfOpen,
  circuitOpen,
  circuitOpenSince,
  circuitState,
  circuitThreshold,
  CIRCUIT_BASE_COOLDOWN_MS,
  CIRCUIT_MAX_COOLDOWN_MS,
  CIRCUIT_TRIP_RESET_MS,
  onCircuitTrip,
  setCircuitSlotsLookup,
  MEMORY_FRESH_MS,
  memoryAdmits,
  memoryLimited,
  noteAgentMemory,
  noteAgentLapse,
  CIRCUIT_LAPSE_BURST_MS,
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

describe("circuit breaker: lapsed claims", () => {
  it("claims that lapse together (one stall of a host running calls at once) are one failure", () => {
    for (let i = 0; i < 16; i++) noteAgentLapse("cloud", T0 + i * 500);
    expect(circuitState("cloud", T0 + 10_000).recentFailures).toBe(1);
    expect(circuitOpen("cloud", T0 + 10_000)).toBe(false);
  });

  it("separate lapse groups each count, so a host that keeps losing its calls still trips", () => {
    for (let g = 0; g < 3; g++) for (let i = 0; i < 4; i++) noteAgentLapse("bad", T0 + g * CIRCUIT_LAPSE_BURST_MS + i * 100);
    expect(circuitOpen("bad", T0 + 3 * CIRCUIT_LAPSE_BURST_MS)).toBe(true);
  });

  it("a success ends the group: a later lapse is a new failure", () => {
    noteAgentLapse("h", T0);
    noteAgentOutcome("h", true, T0 + 1_000);
    noteAgentLapse("h", T0 + 2_000);
    expect(circuitState("h", T0 + 3_000).recentFailures).toBe(1);
    noteAgentLapse("h", T0 + 2_500);
    expect(circuitState("h", T0 + 3_000).recentFailures).toBe(1);
  });
});

describe("circuit breaker: B4 (open circuit, half-open probe, slots)", () => {
  const trip = (id: string, at: number) => {
    for (let i = 0; i < circuitThreshold(id); i++) noteAgentOutcome(id, false, at + i);
  };
  beforeEach(() => setCircuitSlotsLookup(() => undefined));

  it("a failure reported while the circuit is open is not a new trip", () => {
    trip("a", T0);
    expect(circuitState("a", T0 + 10).trips).toBe(1);
    // Calls it held from before, and waits the open circuit itself caused, come back failed now.
    for (let i = 0; i < 10; i++) noteAgentOutcome("a", false, T0 + 1_000 + i);
    expect(circuitState("a", T0 + 2_000)).toMatchObject({ open: true, trips: 1, recentFailures: 0 });
    expect(circuitOpen("a", T0 + 2 + CIRCUIT_BASE_COOLDOWN_MS + 1)).toBe(false);
  });

  it("after the cool-down it is half open: one call at a time; the probe's success closes it", () => {
    trip("a", T0);
    const after = T0 + 2 + CIRCUIT_BASE_COOLDOWN_MS + 1;
    expect(circuitHalfOpen("a", after)).toBe(true);
    expect(circuitBlocks("a", 0, after)).toBe(false);
    expect(circuitBlocks("a", 1, after)).toBe(true);
    noteAgentOutcome("a", true, after + 5);
    expect(circuitHalfOpen("a", after + 6)).toBe(false);
    expect(circuitBlocks("a", 4, after + 6)).toBe(false);
    expect(circuitState("a", after + 6).trips).toBe(0);
  });

  it("a failed probe opens it again at once, for twice as long, capped", () => {
    trip("a", T0);
    let at = T0 + 2 + CIRCUIT_BASE_COOLDOWN_MS + 1;
    noteAgentOutcome("a", false, at);
    expect(circuitState("a", at)).toMatchObject({ open: true, trips: 2, openUntilMs: at + 2 * CIRCUIT_BASE_COOLDOWN_MS });
    for (let i = 0; i < 6; i++) {
      at = circuitState("a", at).openUntilMs! + 1;
      noteAgentOutcome("a", false, at);
    }
    expect(circuitState("a", at).openUntilMs! - at).toBe(CIRCUIT_MAX_COOLDOWN_MS);
  });

  it("a trip count quiet long enough after its cool-down starts over", () => {
    trip("a", T0);
    const later = T0 + CIRCUIT_BASE_COOLDOWN_MS + CIRCUIT_TRIP_RESET_MS + 10;
    expect(circuitHalfOpen("a", later)).toBe(false);
    noteAgentOutcome("a", false, later);
    expect(circuitOpen("a", later + 1)).toBe(false);
    noteAgentOutcome("a", false, later + 1);
    noteAgentOutcome("a", false, later + 2);
    expect(circuitState("a", later + 3)).toMatchObject({ open: true, trips: 1, openUntilMs: later + 2 + CIRCUIT_BASE_COOLDOWN_MS });
  });

  it("a 16-slot host needs 8 failures in a row, a 2-slot one 3", () => {
    setCircuitSlotsLookup((id) => (id === "cloud" ? 16 : 2));
    expect(circuitThreshold("cloud")).toBe(8);
    expect(circuitThreshold("mac")).toBe(3);
    for (let i = 0; i < 7; i++) noteAgentOutcome("cloud", false, T0 + i);
    expect(circuitOpen("cloud", T0 + 10)).toBe(false);
    noteAgentOutcome("cloud", false, T0 + 8);
    expect(circuitOpen("cloud", T0 + 10)).toBe(true);
  });

  it("tells listeners about each trip, once", () => {
    const heard: string[] = [];
    const stop = onCircuitTrip((id) => heard.push(id));
    trip("a", T0);
    for (let i = 0; i < 5; i++) noteAgentOutcome("a", false, T0 + 100 + i);
    stop();
    expect(heard).toEqual(["a"]);
  });

  it("knows whether the circuit was open during a wait", () => {
    expect(circuitOpenSince("a", T0 - 12_000, T0)).toBe(false);
    trip("a", T0);
    expect(circuitOpenSince("a", T0 - 12_000, T0 + 5)).toBe(true);
    // A wait that began after it closed again was not the breaker's doing.
    const after = T0 + CIRCUIT_BASE_COOLDOWN_MS + 10;
    expect(circuitOpenSince("a", after, after + 12_000)).toBe(false);
  });

  it("a reply that ended inside the model's reasoning (the caller's max_tokens) is neutral", () => {
    for (let i = 0; i < 5; i++) noteAgentResult("a", "deepseek-v4.1-flash", false, "reasoning_only: spent the reply (max_tokens 16) reasoning", T0 + i);
    expect(circuitState("a", T0 + 10)).toMatchObject({ open: false, recentFailures: 0 });
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
