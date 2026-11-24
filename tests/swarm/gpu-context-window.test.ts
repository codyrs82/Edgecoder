import { afterEach, describe, expect, it } from "vitest";
import { defaultServing, gpuContextWindow, parallelInferenceFor, servedContextWindow } from "../../src/swarm/parallelism.js";
import { fitModel, forgetModelFacts, kvBytesPer8kSlot, learnModelFacts, memoryBudgetBytes, modelFactsFromModelInfo, planServing } from "../../src/swarm/memory-budget.js";

const GB = 1024 ** 3;

/** Ollama /api/show model_info (trimmed) of real models. */
const QWEN3_CODER_30B = {
  "general.architecture": "qwen3moe",
  "qwen3moe.block_count": 48,
  "qwen3moe.attention.head_count": 32,
  "qwen3moe.attention.head_count_kv": 4,
  "qwen3moe.attention.key_length": 128,
  "qwen3moe.attention.value_length": 128,
  "qwen3moe.embedding_length": 2048,
  "qwen3moe.context_length": 262_144
};
const QWEN3_8B = {
  "general.architecture": "qwen3",
  "qwen3.block_count": 36,
  "qwen3.attention.head_count": 32,
  "qwen3.attention.head_count_kv": 8,
  "qwen3.attention.key_length": 128,
  "qwen3.attention.value_length": 128,
  "qwen3.embedding_length": 4096,
  "qwen3.context_length": 40_960
};
const QWEN25_CODER_7B = {
  "general.architecture": "qwen2",
  "qwen2.block_count": 28,
  "qwen2.attention.head_count": 28,
  "qwen2.attention.head_count_kv": 4,
  "qwen2.embedding_length": 3584,
  "qwen2.context_length": 32_768
};

afterEach(() => forgetModelFacts());

describe("model facts from Ollama /api/show", () => {
  it("KV cache per 8k tokens (f16) and native context from the GGUF metadata", () => {
    // 48 layers x 4 KV heads x (128 + 128) x 2 bytes = 96 KiB a token: 0.75 GB per 8k.
    expect(modelFactsFromModelInfo(QWEN3_CODER_30B)).toEqual({ kvBytesPer8k: 0.75 * GB, contextLength: 262_144 });
    // Head size from embedding / heads when key_length is missing: 3584 / 28 = 128.
    expect(modelFactsFromModelInfo(QWEN25_CODER_7B)).toEqual({ kvBytesPer8k: 0.4375 * GB, contextLength: 32_768 });
    // Per-layer KV heads (an array) are summed.
    expect(modelFactsFromModelInfo({ "general.architecture": "x", "x.block_count": 2, "x.attention.head_count": 8, "x.attention.head_count_kv": [8, 0], "x.attention.key_length": 64 }).kvBytesPer8k).toBe(8 * 128 * 2 * 8192);
    expect(modelFactsFromModelInfo(undefined)).toEqual({});
    expect(modelFactsFromModelInfo({ "x.block_count": 2 })).toEqual({});
    expect(modelFactsFromModelInfo({ "general.architecture": "x", "x.context_length": 4096 })).toEqual({ contextLength: 4096 });
  });

  it("learned facts replace the parameter estimate", () => {
    expect(kvBytesPer8kSlot("qwen3-coder:30b")).toBeCloseTo(3.6 * GB, -3);
    expect(learnModelFacts("qwen3-coder:30b", modelFactsFromModelInfo(QWEN3_CODER_30B))).toBe(true);
    expect(learnModelFacts("qwen3-coder:30b", modelFactsFromModelInfo(QWEN3_CODER_30B))).toBe(false); // nothing new
    expect(kvBytesPer8kSlot("qwen3-coder:30b")).toBe(0.75 * GB);
    learnModelFacts("llama3.2", { kvBytesPer8k: GB, sizeBytes: Number.NaN });
    expect(kvBytesPer8kSlot("llama3.2:latest")).toBe(GB);
  });
});

describe("GPU-aware default context window", () => {
  it("4x RX 5700 (32 GB VRAM, 23 GB RAM) with qwen3-coder:30b: at least 32k, and the memory budget keeps it", () => {
    learnModelFacts("qwen3-coder:30b", { sizeBytes: 19.3 * GB, ...modelFactsFromModelInfo(QWEN3_CODER_30B) });
    const vram = 32 * GB;
    // The slots come from RAM: 23 GB holds no second 30B context, so one; 64k (the ceiling).
    expect(parallelInferenceFor(23 * GB, undefined, { modelParamsB: 30 })).toBe(1);
    const slots = 2; // e.g. OLLAMA_NUM_PARALLEL=2
    const s = defaultServing(23 * GB, undefined, { modelParamsB: 30, slots, discreteGpu: { vramBytes: vram, count: 4 }, weightsBytes: 19.3 * GB, kvBytesPer8k: 0.75 * GB, nativeContext: 262_144 });
    expect(s).toEqual({ contextWindow: 32_768, slots: 2, basis: "gpu" });
    expect(defaultServing(23 * GB, undefined, { modelParamsB: 30, slots: 1, discreteGpu: { vramBytes: vram, count: 4 }, weightsBytes: 19.3 * GB, kvBytesPer8k: 0.75 * GB })).toMatchObject({ contextWindow: 65_536, slots: 1 });
    // The budget (90% of the VRAM) agrees: nothing comes down, and the model is served.
    const budget = memoryBudgetBytes(23 * GB, 60, vram);
    expect(fitModel("qwen3-coder:30b", { budgetBytes: budget, wantContext: 32_768, wantSlots: 2 })).toMatchObject({ fits: true, contextWindow: 32_768, slots: 2 });
    expect(planServing({ installed: [{ name: "qwen3-coder:30b", sizeBytes: 19.3 * GB }], loaded: [], budgetBytes: budget, contextWindow: 32_768, kvSlots: 2 }).serving.map((m) => m.model)).toEqual(["qwen3-coder:30b"]);
    // By RAM, as before, it was the smallest window.
    expect(servedContextWindow(23 * GB, undefined, { modelParamsB: 30, slots: 1 })).toBe(8192);
  });

  it("before Ollama described the model (parameter estimates only): still on the GPU, a smaller window", () => {
    expect(defaultServing(23 * GB, undefined, { modelParamsB: 30, slots: 2, discreteGpu: { vramBytes: 32 * GB, count: 4 } })).toEqual({ contextWindow: 8192, slots: 2, basis: "gpu" });
  });

  it("8 GB RTX A2000 laptop: an 8B model leaves room for 8k; a 7B coder gets 32k with one slot", () => {
    const vram = 8 * GB;
    const q8 = modelFactsFromModelInfo(QWEN3_8B);
    const slots8 = parallelInferenceFor(32 * GB, undefined, { modelParamsB: 8 }); // 32 GB of RAM: 4
    expect(defaultServing(32 * GB, undefined, { modelParamsB: 8, slots: slots8, discreteGpu: { vramBytes: vram }, weightsBytes: 5.2e9, kvBytesPer8k: q8.kvBytesPer8k, nativeContext: q8.contextLength })).toEqual({ contextWindow: 8192, slots: 1, basis: "gpu" });
    const q7 = modelFactsFromModelInfo(QWEN25_CODER_7B);
    const slots7 = parallelInferenceFor(32 * GB, undefined, { modelParamsB: 7 });
    expect(slots7).toBe(4);
    // Four slots would leave 8k each: one slot at 32k holds an agentic call.
    expect(defaultServing(32 * GB, undefined, { modelParamsB: 7, slots: slots7, discreteGpu: { vramBytes: vram }, weightsBytes: 4.68e9, kvBytesPer8k: q7.kvBytesPer8k, nativeContext: q7.contextLength })).toEqual({ contextWindow: 32_768, slots: 1, basis: "gpu" });
    // Unless the slots are fixed (AGENT_PARALLEL_INFERENCE).
    expect(defaultServing(32 * GB, undefined, { modelParamsB: 7, slots: 2, slotsFixed: true, discreteGpu: { vramBytes: vram }, weightsBytes: 4.68e9, kvBytesPer8k: q7.kvBytesPer8k })).toMatchObject({ contextWindow: 16_384, slots: 2 });
  });

  it("never past the model's own context length or the 64k ceiling", () => {
    expect(gpuContextWindow({ vramBytes: 80 * GB, weightsBytes: 5 * GB, kvBytesPer8k: 0.5 * GB, slots: 1, nativeContext: 16_384 })).toEqual({ contextWindow: 16_384, slots: 1 });
    expect(gpuContextWindow({ vramBytes: 80 * GB, weightsBytes: 5 * GB, kvBytesPer8k: 0.5 * GB, slots: 4 })).toEqual({ contextWindow: 65_536, slots: 4 });
  });

  it("OLLAMA_NUM_PARALLEL sets the KV slots: fewer agent slots gain nothing", () => {
    expect(gpuContextWindow({ vramBytes: 8 * GB, weightsBytes: 4.68e9, kvBytesPer8k: 0.4375 * GB, slots: 2, kvSlotsFloor: 2 })).toEqual({ contextWindow: 16_384, slots: 2 });
  });

  it("a model too big for the VRAM, a CPU host or Apple silicon: sized by RAM as before", () => {
    expect(defaultServing(64 * GB, undefined, { modelParamsB: 70, slots: 1, discreteGpu: { vramBytes: 8 * GB } })).toEqual({ contextWindow: servedContextWindow(64 * GB, undefined, { modelParamsB: 70, slots: 1 }), slots: 1, basis: "memory" });
    for (const [mem, b, slots] of [[3.8, 1.5, 2], [16, 7, 2], [32, 7, 4], [8, 7, 1]] as const) {
      expect(defaultServing(mem * GB, undefined, { modelParamsB: b, slots })).toEqual({ contextWindow: servedContextWindow(mem * GB, undefined, { modelParamsB: b, slots }), slots, basis: "memory" });
    }
    expect(defaultServing(64 * GB, undefined, { slots: 4, discreteGpu: { vramBytes: 24 * GB } })).toMatchObject({ contextWindow: 8192, basis: "memory" }); // model unknown
  });

  it("AGENT_CONTEXT_WINDOW wins", () => {
    expect(defaultServing(23 * GB, 12_288, { modelParamsB: 30, slots: 2, discreteGpu: { vramBytes: 32 * GB, count: 4 }, kvBytesPer8k: 0.75 * GB })).toEqual({ contextWindow: 12_288, slots: 2, basis: "override" });
    expect(defaultServing(8 * GB, 131_072, { modelParamsB: 7, slots: 1 })).toMatchObject({ contextWindow: 131_072, basis: "override" });
    // Out of range: ignored.
    expect(defaultServing(23 * GB, 1000, { modelParamsB: 30, slots: 2, discreteGpu: { vramBytes: 32 * GB, count: 4 }, weightsBytes: 19.3 * GB, kvBytesPer8k: 0.75 * GB })).toMatchObject({ contextWindow: 32_768, basis: "gpu" });
  });
});
