import { describe, expect, it } from "vitest";
import type { Subtask } from "../../src/common/types.js";
import { HostMemoryManager, type MemoryOllama } from "../../src/swarm/memory-manager.js";
import { planServing } from "../../src/swarm/memory-budget.js";
import { agentHasModel, agentHasModelForOwner, ownerOnlyModels, subtaskModelEligible } from "../../src/swarm/model-catalog.js";
import { memoryAdmits, noteAgentMemory, resetMemoryAdmission } from "../../src/swarm/coordinator/memory-admission.js";
import { agentCapabilities } from "../../src/swarm/coordinator/agent-state.js";
import { claimRule, mayTakeNow, ownerOnlyCall } from "../../src/swarm/coordinator/dispatch.js";
import { isOwnAccountCall } from "../../src/swarm/direct-work-policy.js";
import type { MemorySnapshot, PressureLevel } from "../../src/swarm/memory-pressure.js";

/*
 * A Linux laptop with an 8 GB RTX A2000 (2026-11-17): the owner set qwen3.5:9b active, but its
 * memory budget serves only qwen3.5:4b on the network, so "My machines · qwen3.5:9b" was refused
 * ("None of your own machines has qwen3.5:9b"). The owner comes first: the agent reports the
 * models it keeps off the network apart (ownerModels), and only its owner's own calls run them.
 */

const GB = 1024 ** 3;
const BUDGET = 5 * GB;

describe("planServing: owner-only models", () => {
  it("lists every installed model it does not serve, with its estimated bytes and why", () => {
    const installed = [{ name: "qwen3.5:4b", sizeBytes: 3.4 * GB }, { name: "qwen3.5:9b", sizeBytes: 6.6 * GB }, { name: "qwen2.5-coder:1.5b", sizeBytes: 1 * GB }];
    const p = planServing({ installed, loaded: [], preferred: "qwen3.5:4b", budgetBytes: BUDGET, contextWindow: 8192, kvSlots: 1, maxModels: 1 });
    expect(p.serving.map((m) => m.model)).toEqual(["qwen3.5:4b"]);
    expect(p.tooBig).toEqual(["qwen3.5:9b"]);
    expect(p.localOnly).toEqual(["qwen2.5-coder:1.5b"]);
    expect(p.ownerOnly.map((m) => [m.model, m.reason])).toEqual([["qwen3.5:9b", "too_big"], ["qwen2.5-coder:1.5b", "model_limit"]]);
    const nine = p.ownerOnly.find((m) => m.model === "qwen3.5:9b")!;
    expect(nine.bytes).toBeGreaterThan(BUDGET);
  });
});

function fakeOllama(installed: Array<[string, number]>, loaded: Array<[string, number]> = []) {
  const state = { loaded: loaded.map(([name, gb]) => ({ name, sizeBytes: gb * GB, expiresAt: "2026-11-17T10:00:00Z" })) };
  const unloaded: string[] = [];
  const ollama: MemoryOllama = {
    list: async () => installed.map(([name, gb]) => ({ name, sizeBytes: gb * GB })),
    loaded: async () => state.loaded.map((m) => ({ ...m })),
    unload: async (m) => {
      unloaded.push(m);
      state.loaded = state.loaded.filter((l) => l.name !== m);
    },
  };
  return { ollama, state, unloaded };
}

function laptop(o: MemoryOllama, level: () => PressureLevel = () => "normal") {
  return new HostMemoryManager({
    ollama: o,
    readPressure: (): MemorySnapshot => ({ level: level(), totalBytes: 16 * GB, availableBytes: 8 * GB, detail: "test" }),
    budgetBytes: BUDGET,
    settings: () => ({ primary: "qwen3.5:9b", contextWindow: 8192, slots: 1, kvSlots: 1 }),
    guardEnabled: true,
    recoverMs: 30_000,
  });
}

describe("agent admission for the owner's own call on an owner-only model", () => {
  it("reports the owner-only model apart from the served list", async () => {
    const { ollama } = fakeOllama([["qwen3.5:4b", 3.4], ["qwen3.5:9b", 6.6]]);
    const m = laptop(ollama);
    expect(m.ownerOnlyModels(["qwen3.5:4b", "qwen3.5:9b"])).toEqual([]); // before the first plan
    await m.refresh();
    expect(m.advertised(["qwen3.5:4b", "qwen3.5:9b"])).toEqual(["qwen3.5:4b"]);
    expect(m.ownerOnlyModels(["qwen3.5:4b", "qwen3.5:9b"])).toEqual(["qwen3.5:9b"]);
    expect(m.telemetry()!.ownerModels).toEqual([{ name: "qwen3.5:9b", bytes: expect.any(Number) }]);
    expect(m.view().ownerModels).toMatchObject([{ name: "qwen3.5:9b", reason: "too_big" }]);
  });

  it("network work is refused on it; the owner's call is admitted, unloading idle network models, and the model stays the owner's", async () => {
    const { ollama, state, unloaded } = fakeOllama([["qwen3.5:4b", 3.4], ["qwen3.5:9b", 6.6]]);
    const m = laptop(ollama);
    await m.refresh();
    // Network work on the 4b loads it (it becomes a network model).
    const net = await m.admit("qwen3.5:4b");
    expect(net.ok).toBe(true);
    state.loaded.push({ name: "qwen3.5:4b", sizeBytes: 4 * GB, expiresAt: "2026-11-17T10:00:00Z" });
    if (net.ok) net.release();
    // Another account's call on the 9b: not served here.
    const other = await m.admit("qwen3.5:9b");
    expect(!other.ok && other.error).toMatch(/^memory_model_not_served/);
    // The owner's own call: no budget refusal; the idle network 4b makes room.
    const own = await m.admit("qwen3.5:9b", { own: true });
    expect(own.ok).toBe(true);
    expect(unloaded).toEqual(["qwen3.5:4b"]);
    if (own.ok) own.release();
    // Now loaded, the 9b is the owner's: a later network load never unloads it.
    state.loaded = [{ name: "qwen3.5:9b", sizeBytes: 7 * GB, expiresAt: "2026-11-17T10:00:00Z" }];
    const again = await m.admit("qwen3.5:4b");
    expect(again.ok).toBe(false);
    expect(unloaded).toEqual(["qwen3.5:4b"]);
  });

  it("critical memory pressure still refuses the owner's call", async () => {
    let level: PressureLevel = "normal";
    const { ollama } = fakeOllama([["qwen3.5:4b", 3.4], ["qwen3.5:9b", 6.6]]);
    const m = laptop(ollama, () => level);
    await m.refresh();
    level = "critical";
    await m.refresh();
    const r = await m.admit("qwen3.5:9b", { own: true });
    expect(!r.ok && r.error).toMatch(/^memory_pressure/);
  });

  it("an own call is one for this agent's account only", () => {
    expect(isOwnAccountCall("acct-patrick", "acct-patrick")).toBe(true);
    expect(isOwnAccountCall("acct-other", "acct-patrick")).toBe(false);
    expect(isOwnAccountCall(undefined, "acct-patrick")).toBe(false);
    expect(isOwnAccountCall("acct-patrick", undefined)).toBe(false);
  });
});

function call(id: string, onlyAccountId?: string): Subtask {
  return {
    id,
    taskId: `task-${id}`,
    kind: "inference",
    language: "python",
    input: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    timeoutMs: 60_000,
    snapshotRef: "inference",
    requestedModel: "qwen3.5:9b",
    projectMeta: { projectId: "p", resourceClass: "gpu", priority: 60, computeClass: "any", ...(onlyAccountId ? { onlyAccountId } : {}) },
  };
}

describe("coordinator: owner-only models route only the owner's own calls", () => {
  const cap = { localModelCatalog: ["qwen3.5:4b"], modelsReported: true, activeModel: "qwen3.5:4b", ownerModels: ["qwen3.5:9b", "qwen3.5:4b"] };

  it("keeps them apart from the routable catalog", () => {
    expect(ownerOnlyModels(cap)).toEqual(["qwen3.5:9b"]);
    expect(agentHasModel(cap, "qwen3.5:9b")).toBe(false);
    expect(agentHasModelForOwner(cap, "qwen3.5:9b")).toBe(true);
    expect(subtaskModelEligible(cap, call("x"))).toBe(false);
    expect(subtaskModelEligible(cap, call("x"), { owner: true })).toBe(true);
    // An older agent reports none.
    expect(ownerOnlyModels({ localModelCatalog: ["qwen3.5:4b"], modelsReported: true })).toEqual([]);
  });

  it("claimRule: the owning account's call may take the owner-only model; another account's or a network call may not", () => {
    const agentId = "nvidia-1-gpu-test";
    agentCapabilities.set(agentId, { ...cap, os: "linux", version: "t", mode: "swarm-only", localModelEnabled: true, localModelProvider: "ollama-local", clientType: "t", swarmEnabled: true, ideEnabled: false, maxConcurrentTasks: 4, connectedPeers: new Set(), lastSeenMs: Date.now(), sandboxMode: "none" } as never);
    try {
      const capability = agentCapabilities.get(agentId);
      expect(claimRule(agentId, capability, "acct-patrick")(call("own", "acct-patrick"))).toBe(true);
      expect(claimRule(agentId, capability, "acct-patrick")(call("other", "acct-someone-else"))).toBe(false);
      expect(claimRule(agentId, capability, "acct-patrick")(call("network"))).toBe(false);
      expect(ownerOnlyCall(agentId, call("own", "acct-patrick"))).toBe(true);
      expect(ownerOnlyCall(agentId, call("network"))).toBe(false);
    } finally {
      agentCapabilities.delete(agentId);
    }
  });

  it("memory admission: no headroom check for the owner's call on it, but critical pressure refuses", () => {
    resetMemoryAdmission();
    const agentId = "nvidia-mem-test";
    const now = Date.now();
    const t = { totalBytes: 16 * GB, pressure: "normal" as const, budgetBytes: BUDGET, usedBytes: 4 * GB, loadedModels: [{ name: "qwen3.5:4b", bytes: 4 * GB }], models: [{ name: "qwen3.5:4b", bytes: 4 * GB, contextWindow: 8192, slots: 1 }], ownerModels: [{ name: "qwen3.5:9b", bytes: 8 * GB }], atMs: now };
    noteAgentMemory(agentId, t, now);
    expect(memoryAdmits(agentId, "qwen3.5:9b", 0, now)).toBe(false);
    expect(memoryAdmits(agentId, "qwen3.5:9b", 0, now, { ownerOnly: true })).toBe(true);
    // Warning: the agent itself stops pulling; the coordinator does not rule the owner out for it.
    noteAgentMemory(agentId, { ...t, pressure: "critical", paused: true }, now + 1);
    expect(memoryAdmits(agentId, "qwen3.5:9b", 0, now + 1, { ownerOnly: true })).toBe(false);
    resetMemoryAdmission();
  });

  it("mayTakeNow lets the owner's call reach an agent whose budget headroom is too small for it", () => {
    resetMemoryAdmission();
    const agentId = "nvidia-take-test";
    const now = Date.now();
    agentCapabilities.set(agentId, { ...cap, os: "linux", version: "t", mode: "swarm-only", localModelEnabled: true, localModelProvider: "ollama-local", clientType: "t", swarmEnabled: true, ideEnabled: false, maxConcurrentTasks: 4, connectedPeers: new Set(), lastSeenMs: now, sandboxMode: "none" } as never);
    noteAgentMemory(agentId, { totalBytes: 16 * GB, pressure: "normal", budgetBytes: BUDGET, usedBytes: 4 * GB, loadedModels: [{ name: "qwen3.5:4b", bytes: 4 * GB }], models: [{ name: "qwen3.5:4b", bytes: 4 * GB, contextWindow: 8192, slots: 1 }], atMs: now }, now);
    try {
      expect(mayTakeNow(agentId, call("own2", "acct-patrick"), new Map(), now)).toBe(true);
    } finally {
      agentCapabilities.delete(agentId);
      resetMemoryAdmission();
    }
  });
});
