import { describe, expect, it, vi } from "vitest";
import { HostMemoryManager, type MemoryOllama } from "../../src/swarm/memory-manager.js";
import { memoryBudgetBytes } from "../../src/swarm/memory-budget.js";
import { memoryAdmits, noteAgentMemory, resetMemoryAdmission } from "../../src/swarm/coordinator/memory-admission.js";
import type { MemorySnapshot, PressureLevel } from "../../src/swarm/memory-pressure.js";

const GB = 1024 ** 3;

function fakeOllama(installed: Array<[string, number]>, loaded: Array<[string, number, string?]> = []) {
  const state = { loaded: loaded.map(([name, gb, exp]) => ({ name, sizeBytes: gb * GB, expiresAt: exp ?? "2026-11-16T10:00:00Z" })) };
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

function manager(o: MemoryOllama, opts: { ram?: number; level?: () => PressureLevel; maxModels?: number; onCritical?: () => Promise<void>; now?: () => number } = {}) {
  const ram = (opts.ram ?? 48) * GB;
  return new HostMemoryManager({
    ollama: o,
    readPressure: (): MemorySnapshot => ({ level: opts.level?.() ?? "normal", totalBytes: ram, availableBytes: ram / 2, detail: "test" }),
    budgetBytes: memoryBudgetBytes(ram),
    maxModels: opts.maxModels,
    settings: () => ({ primary: "qwen3.5:9b", contextWindow: 32768, slots: 2, kvSlots: 2 }),
    guardEnabled: true,
    onCritical: opts.onCritical,
    now: opts.now,
    recoverMs: 30_000,
  });
}

const INSTALLED: Array<[string, number]> = [["qwen3.5:9b", 6.6], ["qwen2.5-coder:7b", 4.7], ["deepseek-r1:14b", 9], ["qwen3-coder:30b", 18.6], ["nomic-embed-text:latest", 0.3]];

describe("host memory manager", () => {
  it("advertises only what fits the budget, at most the per-host cap, loaded first", async () => {
    const { ollama } = fakeOllama(INSTALLED, [["qwen2.5-coder:7b", 10]]);
    const m = manager(ollama, { maxModels: 2 });
    const all = INSTALLED.map(([n]) => n);
    expect(m.advertised(all)).toEqual(all); // before the first look
    await m.refresh();
    expect(m.advertised(all)).toEqual(["qwen3.5:9b", "qwen2.5-coder:7b"]);
    expect(m.activeModel()).toBe("qwen2.5-coder:7b");
    expect(m.view()).toMatchObject({ servingModels: ["qwen2.5-coder:7b", "qwen3.5:9b"], tooBigModels: ["qwen3-coder:30b"], localOnlyModels: ["deepseek-r1:14b"] });
    const t = m.telemetry()!;
    expect(t.loadedModels).toEqual([{ name: "qwen2.5-coder:7b", bytes: 10 * GB }]);
    expect(t.models.map((x) => x.name)).toEqual(["qwen2.5-coder:7b", "qwen3.5:9b"]);
    expect(t).toMatchObject({ pressure: "normal", paused: false, budgetBytes: memoryBudgetBytes(48 * GB) });
  });

  it("refuses a claim for a model it does not serve, or one that does not fit next to the owner's", async () => {
    const { ollama, unloaded } = fakeOllama(INSTALLED, [["deepseek-r1:14b", 22]]); // the owner's chat model
    const m = manager(ollama);
    await m.refresh();
    const r = await m.admit("qwen3-coder:30b");
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/^memory_model_not_served/);
    // The 9B needs ~14.5 GB; the owner's 22 GB model leaves 6.8 GB: refused, and the owner's model stays.
    const r2 = await m.admit("qwen3.5:9b");
    expect(!r2.ok && r2.error).toMatch(/^memory_(budget|model_not_served)/);
    expect(unloaded).toEqual([]);
  });

  it("unloads an idle network model before loading another, and refuses while it is busy", async () => {
    const { ollama, state, unloaded } = fakeOllama([["qwen3.5:9b", 6.6], ["qwen2.5-coder:1.5b", 1]]);
    const m = manager(ollama, { maxModels: 2 });
    await m.refresh();
    expect(m.advertised(["qwen3.5:9b", "qwen2.5-coder:1.5b"])).toEqual(["qwen3.5:9b", "qwen2.5-coder:1.5b"]);
    const a = await m.admit("qwen2.5-coder:1.5b");
    expect(a.ok).toBe(true);
    // Loaded far bigger than estimated (a long context): 15 GB of the 28.8 GB budget.
    state.loaded.push({ name: "qwen2.5-coder:1.5b", sizeBytes: 15 * GB, expiresAt: "2026-11-16T10:00:00Z" });
    // While it runs, the 9B (~15.7 GB) does not fit next to it: refused, nothing unloaded.
    const busy = await m.admit("qwen3.5:9b");
    expect(busy).toMatchObject({ ok: false, error: expect.stringMatching(/^memory_budget: qwen3.5:9b needs/) });
    expect(unloaded).toEqual([]);
    if (a.ok) a.release();
    // Idle now: unloaded first, then the 9B loads.
    const b = await m.admit("qwen3.5:9b");
    expect(b.ok).toBe(true);
    expect(unloaded).toEqual(["qwen2.5-coder:1.5b"]);
  });

  it("warning pressure: no pulls, refuses calls, unloads idle network models; critical: cancels and keeps only the owner's active model", async () => {
    let level: PressureLevel = "normal";
    let nowMs = 0;
    const onCritical = vi.fn(async () => undefined);
    const { ollama, state, unloaded } = fakeOllama(INSTALLED);
    const m = manager(ollama, { level: () => level, onCritical, now: () => nowMs });
    await m.refresh();
    const a = await m.admit("qwen3.5:9b");
    if (a.ok) a.release();
    state.loaded.push({ name: "qwen3.5:9b", sizeBytes: 14 * GB, expiresAt: "2026-11-16T10:00:00Z" });
    state.loaded.push({ name: "deepseek-r1:14b", sizeBytes: 10 * GB, expiresAt: "2026-11-16T10:04:00Z" }); // owner's
    state.loaded.push({ name: "qwen2.5-coder:1.5b", sizeBytes: 2 * GB, expiresAt: "2026-11-16T10:01:00Z" }); // owner's, older
    expect(m.canPull()).toBe(true);

    level = "warning";
    await m.refresh();
    expect(m.canPull()).toBe(false);
    expect(m.view()).toMatchObject({ pressure: "warning", paused: true, pausedReason: "This machine is low on memory" });
    expect(unloaded).toEqual(["qwen3.5:9b"]); // the agent's idle model; the owner's stay
    expect(await m.admit("qwen2.5-coder:7b")).toMatchObject({ ok: false, error: expect.stringMatching(/^memory_pressure/) });

    level = "critical";
    nowMs = 1_000;
    await m.refresh();
    expect(onCritical).toHaveBeenCalledOnce();
    expect(unloaded).toEqual(["qwen3.5:9b", "qwen2.5-coder:1.5b"]); // all but the owner's most recent
    expect(m.telemetry()).toMatchObject({ pressure: "critical", paused: true });

    // Recovers only after the pressure has stayed down.
    level = "normal";
    nowMs = 2_000;
    await m.refresh();
    expect(m.canPull()).toBe(false);
    nowMs = 40_000;
    await m.refresh();
    expect(m.canPull()).toBe(true);
  });
});

describe("host memory manager with vLLM / MLX (the engine holds its model)", () => {
  // The Chicago VM: 2x A16 pooled (30 GB), vLLM serving qwen3-coder:30b with 2 slots from its KV cache.
  const budget = memoryBudgetBytes(120 * GB, 60, 30 * GB);
  function engineManager(served: () => { model: string; bytes: number } | undefined, level: () => PressureLevel = () => "normal") {
    const ollama = { list: vi.fn(async () => []), loaded: vi.fn(async () => []), unload: vi.fn(async () => undefined) };
    const m = new HostMemoryManager({
      ollama,
      engine: served,
      readPressure: (): MemorySnapshot => ({ level: level(), totalBytes: 120 * GB, availableBytes: 60 * GB, detail: "test" }),
      budgetBytes: budget,
      settings: () => ({ primary: "qwen3-coder:30b", contextWindow: 65536, slots: 2, kvSlots: 2 }),
      guardEnabled: true,
      recoverMs: 30_000,
    });
    return { m, ollama };
  }

  it("reports the served model as loaded, filling the budget, with the engine's slots; never asks Ollama", async () => {
    const { m, ollama } = engineManager(() => ({ model: "qwen3-coder:30b", bytes: budget }));
    await m.refresh();
    const t = m.telemetry()!;
    expect(t.loadedModels).toEqual([{ name: "qwen3-coder:30b", bytes: budget }]);
    expect(t.usedBytes).toBe(budget);
    expect(t.models).toEqual([{ name: "qwen3-coder:30b", bytes: budget, contextWindow: 65536, slots: 2 }]);
    expect(m.advertised(["qwen3-coder:30b"])).toEqual(["qwen3-coder:30b"]);
    expect(m.canPull()).toBe(true);
    expect(ollama.loaded).not.toHaveBeenCalled();
    expect(ollama.list).not.toHaveBeenCalled();

    // The coordinator: calls for the served model up to its slots, no other model on "free" headroom.
    resetMemoryAdmission();
    noteAgentMemory("chi", t, 1_000);
    expect(memoryAdmits("chi", "qwen3-coder:30b", 0, 1_000)).toBe(true);
    expect(memoryAdmits("chi", "qwen3-coder:30b", 1, 1_000)).toBe(true);
    expect(memoryAdmits("chi", "qwen3-coder:30b", 2, 1_000)).toBe(false);
    expect(memoryAdmits("chi", "qwen2.5-coder:7b", 0, 1_000)).toBe(false);
  });

  it("admits only the served model and unloads nothing under pressure", async () => {
    let level: PressureLevel = "normal";
    const { m, ollama } = engineManager(() => ({ model: "qwen3-coder:30b", bytes: budget }), () => level);
    await m.refresh();
    const a = await m.admit("qwen3-coder:30b");
    expect(a.ok).toBe(true);
    if (a.ok) a.release();
    const b = await m.admit("qwen3.5:9b");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toMatch(/^memory_model_not_served/);
    level = "critical";
    await m.refresh();
    expect(ollama.unload).not.toHaveBeenCalled();
    expect(m.telemetry()!.loadedModels.map((l) => l.name)).toEqual(["qwen3-coder:30b"]);
    expect(m.canPull()).toBe(false);
  });

  it("while the engine is down or loading: nothing loaded, nothing served", async () => {
    const { m } = engineManager(() => undefined);
    await m.refresh();
    expect(m.telemetry()!.loadedModels).toEqual([]);
    expect(m.telemetry()!.models).toEqual([]);
    expect((await m.admit("qwen3-coder:30b")).ok).toBe(false);
  });
});

describe("host memory manager: model facts from Ollama", () => {
  it("reads /api/show for installed models (the configured one first) and tells the agent", async () => {
    const { forgetModelFacts, modelFacts } = await import("../../src/swarm/memory-budget.js");
    forgetModelFacts();
    const { ollama } = fakeOllama([["qwen2.5-coder:7b", 4.7], ["qwen3.5:9b", 6.6]]);
    const shown: string[] = [];
    ollama.show = async (name) => {
      shown.push(name);
      return { modelInfo: { "general.architecture": "qwen2", "qwen2.block_count": 28, "qwen2.attention.head_count": 28, "qwen2.attention.head_count_kv": 4, "qwen2.embedding_length": 3584, "qwen2.context_length": 32_768 } };
    };
    let told = 0;
    const m = new HostMemoryManager({
      ollama,
      readPressure: (): MemorySnapshot => ({ level: "normal", totalBytes: 48 * GB, availableBytes: 24 * GB, detail: "test" }),
      budgetBytes: memoryBudgetBytes(48 * GB),
      settings: () => ({ primary: "qwen3.5:9b", contextWindow: 32768, slots: 2, kvSlots: 2 }),
      guardEnabled: true,
      onModelFacts: () => told++,
    });
    // Two refreshes at once: the second waits for the first.
    await Promise.all([m.refresh(), m.refresh()]);
    expect(shown).toEqual(["qwen3.5:9b", "qwen2.5-coder:7b"]);
    expect(told).toBe(1);
    expect(modelFacts("qwen3.5:9b")).toEqual({ sizeBytes: Math.round(6.6 * GB), kvBytesPer8k: 0.4375 * GB, contextLength: 32_768 });
    await m.refresh();
    expect(shown).toHaveLength(2); // read once
    expect(told).toBe(1);
    forgetModelFacts();
  });
});
