import { describe, expect, it } from "vitest";
import { estimateModelBytes, fitModel, memoryBudgetBytes, memoryBudgetPct, ollamaMaxLoadedFor, ollamaMemorySafetyEnv, ollamaParallelFor, planLoad, planServing } from "../../src/swarm/memory-budget.js";

const GB = 1024 ** 3;
const gb = (b: number) => Math.round((b / GB) * 10) / 10;
const RAM = [16, 32, 48, 64] as const;

describe("memory budget", () => {
  it("is 60% of RAM by default, AGENT_MEMORY_BUDGET_PCT 10-90, 90% of a discrete GPU's VRAM", () => {
    expect(RAM.map((r) => gb(memoryBudgetBytes(r * GB)))).toEqual([9.6, 19.2, 28.8, 38.4]);
    expect(memoryBudgetPct(undefined)).toBe(60);
    expect(memoryBudgetPct("50")).toBe(50);
    expect(memoryBudgetPct("95")).toBe(60);
    expect(memoryBudgetPct("abc")).toBe(60);
    expect(gb(memoryBudgetBytes(48 * GB, 50))).toBe(24);
    expect(gb(memoryBudgetBytes(32 * GB, 60, 24 * GB))).toBe(21.6);
  });

  it("estimates weights + runtime + KV cache (num_ctx x slots)", () => {
    // 7B / 9B / 14B / 30B at 8k x 1, 32k x 2, 32k x 4, 64k x 4 (GB).
    const table = (m: string) => [[8192, 1], [32768, 2], [32768, 4], [65536, 4]].map(([c, s]) => gb(estimateModelBytes(m, { numCtx: c, slots: s }).totalBytes));
    expect(table("qwen2.5-coder:7b")).toEqual([5.5, 11.4, 18.1, 31.6]);
    expect(table("qwen3.5:9b")).toEqual([7, 14.5, 23.2, 40.5]);
    expect(table("deepseek-r1:14b")).toEqual([10.6, 22.3, 35.8, 62.7]);
    expect(table("qwen3-coder:30b")).toEqual([22.1, 47.3, 76.1, 133.7]);
    // The model's file size wins over the parameter estimate; quant in the tag changes the weights.
    expect(gb(estimateModelBytes("qwen3.5:9b", { sizeBytes: 6.6 * GB, numCtx: 8192, slots: 1 }).totalBytes)).toBe(8.2);
    expect(estimateModelBytes("llama3:8b-q8_0", { numCtx: 8192, slots: 1 }).weightsBytes).toBeGreaterThan(estimateModelBytes("llama3:8b", { numCtx: 8192, slots: 1 }).weightsBytes);
  });

  it("the incident: ten models at 32k-64k context never fit a 48 GB Mac's budget together", () => {
    const budget = memoryBudgetBytes(48 * GB);
    const total = ["qwen3.5:9b", "deepseek-r1:14b", "qwen2.5-coder:7b"].reduce((s, m) => s + estimateModelBytes(m, { numCtx: 65536, slots: 4 }).totalBytes, 0);
    expect(total).toBeGreaterThan(budget * 4);
  });

  it("fits big models by lowering the window, then the slots, per RAM size", () => {
    const fit = (m: string, ram: number, slots: number, fixed?: number) => {
      const f = fitModel(m, { budgetBytes: memoryBudgetBytes(ram * GB), wantContext: 32768, wantSlots: slots, fixedKvSlots: fixed });
      return [f.fits, f.contextWindow, f.slots];
    };
    // 9B: 16 GB -> 8k x 2; 32 / 48 GB -> 32k x 2; 64 GB -> 32k x 4.
    expect(fit("qwen3.5:9b", 16, 2, 2)).toEqual([true, 8192, 2]);
    expect(fit("qwen3.5:9b", 32, 2, 2)).toEqual([true, 32768, 2]);
    expect(fit("qwen3.5:9b", 48, 2, 2)).toEqual([true, 32768, 2]);
    expect(fit("qwen3.5:9b", 64, 4, 4)).toEqual([true, 32768, 4]);
    // 14B: does not fit 16 GB; 32 GB -> 16k; 48 GB -> 32k x 2.
    expect(fit("deepseek-r1:14b", 16, 2, 2)[0]).toBe(false);
    expect(fit("deepseek-r1:14b", 32, 2, 2)).toEqual([true, 16384, 2]);
    expect(fit("deepseek-r1:14b", 48, 2, 2)).toEqual([true, 32768, 2]);
    // 30B: only from 48 GB, at 8k.
    expect(fit("qwen3-coder:30b", 32, 2, 2)[0]).toBe(false);
    expect(fit("qwen3-coder:30b", 48, 2, 2)).toEqual([true, 8192, 2]);
    expect(fit("qwen3-coder:30b", 64, 4, 4)).toEqual([true, 8192, 4]);
    // 7B: fits everywhere.
    expect(fit("qwen2.5-coder:7b", 16, 2, 2)).toEqual([true, 16384, 2]);
    // Without a fixed Ollama slot count the slots come down too (after the window reaches 8k).
    expect(fit("deepseek-r1:14b", 16, 4)).toEqual([true, 2048, 1]);
    expect(fitModel("qwen3.5:9b", { budgetBytes: 9 * GB, wantContext: 32768, wantSlots: 4 })).toMatchObject({ fits: true, contextWindow: 8192, slots: 2 });
    // An explicit 64k window on a 48 GB Mac comes down to what fits.
    expect(fitModel("qwen3.5:9b", { budgetBytes: memoryBudgetBytes(48 * GB), wantContext: 65536, wantSlots: 4, fixedKvSlots: 4 })).toMatchObject({ fits: true, contextWindow: 32768 });
  });

  it("advertises only models that fit on their own, as many as fit together, loaded first, capped", () => {
    const installed = ["qwen3.5:9b", "qwen2.5-coder:7b", "deepseek-r1:14b", "qwen3-coder:30b", "qwen2.5-coder:1.5b"].map((name) => ({ name }));
    const p48 = planServing({ installed, loaded: [], preferred: "qwen3.5:9b", budgetBytes: memoryBudgetBytes(48 * GB), contextWindow: 32768, kvSlots: 2, maxModels: 2 });
    expect(p48.serving.map((m) => m.model)).toEqual(["qwen3.5:9b", "qwen2.5-coder:7b"]);
    expect(p48.tooBig).toEqual(["qwen3-coder:30b"]);
    expect(p48.localOnly).toEqual(["deepseek-r1:14b", "qwen2.5-coder:1.5b"]);
    // 16 GB at 8k x 2: the 9B alone; the 14B and 30B do not fit.
    const p16 = planServing({ installed, loaded: [], preferred: "qwen3.5:9b", budgetBytes: memoryBudgetBytes(16 * GB), contextWindow: 8192, kvSlots: 2, maxModels: 1 });
    expect(p16.serving.map((m) => m.model)).toEqual(["qwen3.5:9b"]);
    expect(p16.tooBig).toEqual(["deepseek-r1:14b", "qwen3-coder:30b"]);
    // A loaded model is served first (affinity).
    const loaded = planServing({ installed, loaded: [{ name: "deepseek-r1:14b", sizeBytes: 20 * GB }], preferred: "qwen3.5:9b", budgetBytes: memoryBudgetBytes(48 * GB), contextWindow: 32768, kvSlots: 2, maxModels: 2 });
    expect(loaded.serving[0]).toMatchObject({ model: "deepseek-r1:14b", loaded: true });
    // No cap: as many as fit together.
    const all = planServing({ installed, loaded: [], preferred: "qwen3.5:9b", budgetBytes: memoryBudgetBytes(64 * GB), contextWindow: 8192, kvSlots: 1 });
    expect(all.serving.length).toBeGreaterThan(2);
  });

  it("unloads idle models before loading, never the owner's or a busy one, else refuses", () => {
    const budget = memoryBudgetBytes(48 * GB);
    const loaded = [
      { name: "qwen2.5-coder:7b", sizeBytes: 11 * GB, expiresAt: "2026-11-16T10:05:00Z" },
      { name: "qwen3.5:9b", sizeBytes: 14 * GB, expiresAt: "2026-11-16T10:01:00Z" },
    ];
    // Fits next to nothing else: unload the least recently used idle one first.
    expect(planLoad({ model: "deepseek-r1:14b", needBytes: 15 * GB, budgetBytes: budget, loaded })).toMatchObject({ ok: true, unload: ["qwen3.5:9b"] });
    // Busy model kept: the other goes.
    expect(planLoad({ model: "deepseek-r1:14b", needBytes: 14 * GB, budgetBytes: budget, loaded, busy: new Set(["qwen3.5:9b"]) })).toMatchObject({ ok: true, unload: ["qwen2.5-coder:7b"] });
    // Both busy or the owner's: refused, nothing unloaded.
    const refused = planLoad({ model: "deepseek-r1:14b", needBytes: 15 * GB, budgetBytes: budget, loaded, busy: new Set(["qwen3.5:9b"]), protectedModels: new Set(["qwen2.5-coder:7b"]) });
    expect(refused.ok).toBe(false);
    expect(refused.unload).toEqual([]);
    expect(refused.reason).toMatch(/^memory_budget: deepseek-r1:14b needs 15.0 GB/);
    // Already loaded: nothing to do; fits as is: nothing unloaded.
    expect(planLoad({ model: "qwen3.5:9b", needBytes: 14 * GB, budgetBytes: budget, loaded })).toMatchObject({ ok: true, unload: [] });
    expect(planLoad({ model: "qwen2.5-coder:1.5b", needBytes: 2 * GB, budgetBytes: budget, loaded })).toMatchObject({ ok: true, unload: [] });
  });

  it("Ollama env for the hosts EdgeCoder starts: 1 model up to 32 GB, 2 above", () => {
    expect(RAM.map((r) => ollamaMaxLoadedFor(r * GB))).toEqual([1, 1, 2, 2]);
    expect(ollamaMaxLoadedFor(512 * GB)).toBe(2);
    expect(RAM.map((r) => ollamaParallelFor(r * GB))).toEqual([2, 2, 2, 4]);
    expect(ollamaMemorySafetyEnv(48 * GB)).toEqual({ OLLAMA_MAX_LOADED_MODELS: "2", OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0" });
  });
});
