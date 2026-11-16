import { describe, expect, it } from "vitest";
import { UPSTREAM_MODEL_NAMES, catalogTagForEngineModel, engineModelForTag, normalizeEngineModelName, parseModelAliases } from "../../src/model/engine-models.js";
import { MODEL_CATALOG, paramSizeBillions } from "../../src/model/catalog.js";
import { modelWeightsGb } from "../../src/swarm/benchmark.js";

/*
 * vLLM and MLX serve Hugging Face repo ids; the network names models by catalog tag. The same
 * weights must map to the same tag (pricing, routing, the GPU challenge), whatever the quant.
 */

describe("catalog tag for a served model id", () => {
  it.each([
    // vLLM: official weights and the usual quants of Qwen3-Coder 30B-A3B
    ["Qwen/Qwen3-Coder-30B-A3B-Instruct", "qwen3-coder:30b"],
    ["Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", "qwen3-coder:30b"],
    ["cpatonn/Qwen3-Coder-30B-A3B-Instruct-AWQ-4bit", "qwen3-coder:30b"],
    ["QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ", "qwen3-coder:30b"],
    ["btbtyler09/Qwen3-Coder-30B-A3B-Instruct-gptq-4bit", "qwen3-coder:30b"],
    ["Qwen/Qwen2.5-Coder-32B-Instruct-AWQ", "qwen2.5-coder:32b"],
    ["Qwen/Qwen2.5-Coder-7B-Instruct-GPTQ-Int4", "qwen2.5-coder:7b"],
    ["openai/gpt-oss-20b", "gpt-oss:20b"],
    ["mistralai/Devstral-Small-2-24B-Instruct-2512", "devstral-small-2:24b"],
    ["Qwen/Qwen3-235B-A22B-Instruct-2507-FP8", "qwen3:235b"],
    ["meta-llama/Llama-3.3-70B-Instruct", "llama3.3:70b"],
    // MLX community conversions
    ["mlx-community/Qwen2.5-Coder-7B-Instruct-4bit", "qwen2.5-coder:7b"],
    ["mlx-community/Qwen2.5-Coder-7B-Instruct-8bit", "qwen2.5-coder:7b"],
    ["mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit", "qwen3-coder:30b"],
    ["mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ", "qwen3-coder:30b"],
    ["mlx-community/Qwen3-Coder-30B-A3B-Instruct-6bit", "qwen3-coder:30b"],
    ["mlx-community/Qwen2.5-Coder-32B-Instruct-4bit", "qwen2.5-coder:32b"],
    ["mlx-community/gpt-oss-20b-MXFP4-Q8", "gpt-oss:20b"],
    // a local path (mlx_lm.server --model /path/to/dir)
    ["/Users/me/.edgecoder/models/Qwen3-Coder-30B-A3B-Instruct-4bit", "qwen3-coder:30b"]
  ])("%s → %s", (id, tag) => {
    expect(catalogTagForEngineModel(id)).toBe(tag);
  });

  it("does not confuse sizes or families", () => {
    expect(catalogTagForEngineModel("Qwen/Qwen2.5-Coder-14B-Instruct")).toBeUndefined();
    expect(catalogTagForEngineModel("Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8")).toBe("qwen3-coder:480b");
    expect(catalogTagForEngineModel("Qwen/Qwen3-30B-A3B")).toBeUndefined();
    expect(catalogTagForEngineModel("mistralai/Mistral-7B-Instruct-v0.3")).toBeUndefined();
  });

  it("a --served-model-name that is a catalog tag maps to itself", () => {
    expect(catalogTagForEngineModel("qwen3-coder:30b")).toBe("qwen3-coder:30b");
    expect(catalogTagForEngineModel("qwen3-coder:31b")).toBeUndefined();
  });

  it("ENGINE_MODEL_ALIASES wins over the table and covers unknown names", () => {
    const aliases = parseModelAliases(" my-org/coder-ft = qwen3-coder:30b , ,bad, Qwen/Qwen2.5-Coder-7B-Instruct=qwen2.5-coder:32b");
    expect(aliases.size).toBe(2);
    expect(catalogTagForEngineModel("my-org/coder-ft", aliases)).toBe("qwen3-coder:30b");
    expect(catalogTagForEngineModel("Qwen/Qwen2.5-Coder-7B-Instruct", aliases)).toBe("qwen2.5-coder:32b");
  });

  it("every table entry is a catalog tag, and the mapped tag prices and benchmarks like the Ollama one", () => {
    for (const tag of Object.keys(UPSTREAM_MODEL_NAMES)) expect(MODEL_CATALOG.some((m) => m.modelId === tag)).toBe(true);
    const tag = catalogTagForEngineModel("cpatonn/Qwen3-Coder-30B-A3B-Instruct-AWQ-4bit")!;
    expect(paramSizeBillions(tag)).toBe(30);
    expect(modelWeightsGb(tag)).toEqual({ weightsGb: 1.98, activeParamsB: 3.3 });
  });

  it("normalization strips owner, quant, packaging, instruct and date suffixes", () => {
    expect(normalizeEngineModelName("Qwen/Qwen3-235B-A22B-Instruct-2507-FP8")).toBe("qwen3-235b-a22b");
    expect(normalizeEngineModelName("mlx-community/Qwen2.5-Coder-7B-Instruct-4bit")).toBe("qwen2.5-coder-7b");
  });
});

describe("served id for a catalog tag", () => {
  it("finds the served id that runs the tag", () => {
    const served = ["mlx-community/Qwen2.5-Coder-7B-Instruct-4bit", "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit"];
    expect(engineModelForTag("qwen3-coder:30b", served)).toBe("mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit");
    expect(engineModelForTag("gpt-oss:20b", served)).toBeUndefined();
  });
});
