// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Model names across inference engines. The network names models by their catalog tag
 * (src/model/catalog.ts, Ollama library tags such as "qwen3-coder:30b"): buyers ask for it,
 * pricing reads its size (paramSizeBillions), best-fit routing and the GPU challenge key on it.
 * vLLM and MLX serve Hugging Face repo ids instead ("Qwen/Qwen3-Coder-30B-A3B-Instruct",
 * "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ", "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit").
 * This maps them, so an agent reports the same catalog tag whatever engine runs the weights.
 *
 * Matching: the repo's base name (the part after the owner), lowercased, with quantization and
 * packaging suffixes (AWQ, GPTQ, FP8, 4bit, MLX, …), "-instruct" and release-date suffixes
 * removed, is compared with the same normalization of each catalog tag's known upstream names.
 * An operator alias (ENGINE_MODEL_ALIASES="repo-id=tag,…") wins over the table; a served id that
 * already is a catalog tag (vLLM `--served-model-name qwen3-coder:30b`) maps to itself.
 */

import { MODEL_CATALOG } from "./catalog.js";

/** Upstream (Hugging Face) model names per catalog tag, without owner or quantization suffix. */
export const UPSTREAM_MODEL_NAMES: Record<string, string[]> = {
  "qwen3-coder:30b": ["Qwen3-Coder-30B-A3B-Instruct"],
  "qwen3-coder:480b": ["Qwen3-Coder-480B-A35B-Instruct"],
  "qwen3-coder-next:latest": ["Qwen3-Coder-Next"],
  "qwen2.5-coder:7b": ["Qwen2.5-Coder-7B-Instruct"],
  "qwen2.5-coder:32b": ["Qwen2.5-Coder-32B-Instruct"],
  "devstral-small-2:24b": ["Devstral-Small-2-24B-Instruct-2512", "Devstral-Small-2-24B"],
  "qwen3.5:35b": ["Qwen3.5-35B-A3B"],
  "qwen3.5:27b": ["Qwen3.5-27B"],
  "qwen3.5:9b": ["Qwen3.5-9B"],
  "qwen3.5:4b": ["Qwen3.5-4B"],
  "qwen3.5:2b": ["Qwen3.5-2B"],
  "qwen3.5:0.8b": ["Qwen3.5-0.8B"],
  "gpt-oss:20b": ["gpt-oss-20b"],
  "gpt-oss:120b": ["gpt-oss-120b"],
  "gemma4:26b": ["gemma-4-26b-it", "gemma-4-26b"],
  "gemma4:e4b": ["gemma-4-e4b-it", "gemma-4-e4b"],
  "deepseek-r1:14b": ["DeepSeek-R1-Distill-Qwen-14B"],
  "deepseek-r1:70b": ["DeepSeek-R1-Distill-Llama-70B"],
  "llama3.3:70b": ["Llama-3.3-70B-Instruct"],
  "deepseek-coder-v2:236b": ["DeepSeek-Coder-V2-Instruct"],
  "qwen3:235b": ["Qwen3-235B-A22B", "Qwen3-235B-A22B-Instruct-2507"]
};

/** Quantization / packaging words dropped from the end of a repo name, in any order and number. */
const SUFFIX = new RegExp(
  "[-_.](" +
    [
      "awq", "gptq", "gguf", "mlx", "dwq", "exl2", "marlin", "bnb", "nf4",
      "fp8", "fp4", "nvfp4", "mxfp4", "bf16", "fp16", "int4", "int8", "w4a16", "w8a8", "w8a16", "dynamic",
      "\\d+(\\.\\d+)?bit", "\\d+(\\.\\d+)?bpw", "q\\d(_k)?(_[msl])?", "g\\d+", "instruct", "it", "\\d{4}"
    ].join("|") +
    ")$",
  "i"
);

/** Comparable form of a model name: base name only, lowercase, quant / instruct / date suffixes removed. */
export function normalizeEngineModelName(id: string): string {
  let s = id.trim().replace(/\/+$/, "");
  s = s.slice(s.lastIndexOf("/") + 1).toLowerCase();
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(SUFFIX, "");
  }
  return s;
}

/** Parse ENGINE_MODEL_ALIASES: "Org/Repo=tag,Other/Repo=tag2" (whitespace and empty items ignored). */
export function parseModelAliases(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of (raw ?? "").split(",")) {
    const i = item.indexOf("=");
    if (i <= 0) continue;
    const id = item.slice(0, i).trim();
    const tag = item.slice(i + 1).trim();
    if (id && tag) out.set(id, tag);
  }
  return out;
}

let tableCache: Map<string, string> | undefined;
function upstreamTable(): Map<string, string> {
  if (!tableCache) {
    tableCache = new Map();
    for (const [tag, names] of Object.entries(UPSTREAM_MODEL_NAMES)) for (const n of names) tableCache.set(normalizeEngineModelName(n), tag);
  }
  return tableCache;
}

/**
 * The catalog tag a served model id stands for, or undefined when it is not a catalog model (the
 * agent then reports nothing, and the network does not route named calls to it).
 */
export function catalogTagForEngineModel(id: string, aliases: Map<string, string> = new Map()): string | undefined {
  const alias = aliases.get(id) ?? aliases.get(id.trim());
  if (alias) return alias;
  if (MODEL_CATALOG.some((m) => m.modelId === id)) return id;
  return upstreamTable().get(normalizeEngineModelName(id));
}

/** The served id (out of `served`) that runs catalog tag `tag`, or undefined. */
export function engineModelForTag(tag: string, served: string[], aliases: Map<string, string> = new Map()): string | undefined {
  return served.find((id) => catalogTagForEngineModel(id, aliases) === tag);
}
