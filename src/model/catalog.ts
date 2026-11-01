// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Curated catalog of Ollama models users can install from the Model Manager.
 *
 * Single source of truth. The inference service serves it at GET /model/catalog; the
 * desktop app bundles a copy in desktop/src/lib/models.ts as its offline fallback
 * (tests/model/catalog-sync.test.ts fails if the two drift). Verify the tags still
 * exist upstream with `npm run models:verify-catalog` (needs network access to
 * registry.ollama.ai).
 *
 * Every `modelId` must be an official ollama.com library tag (`name:tag`). Sizes are
 * the default (Q4_K_M unless noted) download sizes as listed on ollama.com.
 */

export const MODEL_CATALOG_VERSION = "2026-11-01";

export type CatalogCategory = "coding" | "general" | "small";

export interface CatalogModel {
  /** Official Ollama library tag, e.g. "qwen3.5:9b". */
  modelId: string;
  name: string;
  /** Human-readable parameter count; "(xB active)" for mixture-of-experts models. */
  paramSize: string;
  /** Approximate download size of the default quantization. */
  diskSize: string;
  description: string;
  category: CatalogCategory;
  recommended?: boolean;
  /** Minimum system RAM (or unified memory) in GB to run the default quantization comfortably. */
  minMemoryGb: number;
  /** Context window in tokens, as published by the model vendor. */
  contextTokens: number;
  license: string;
  /** Ollama capability labels: tools, thinking, vision. */
  capabilities: Array<"tools" | "thinking" | "vision">;
}

export const MODEL_CATALOG: CatalogModel[] = [
  // ---- Coding ----
  {
    modelId: "qwen3-coder:30b",
    name: "Qwen3-Coder 30B MoE",
    paramSize: "30B (3.3B active)",
    diskSize: "19 GB",
    description:
      "Agentic coding model: 256K context, native tool calling, repository-scale edits. The best local coder for a 24-32 GB machine.",
    category: "coding",
    recommended: true,
    minMemoryGb: 24,
    contextTokens: 262_144,
    license: "Apache-2.0",
    capabilities: ["tools"]
  },
  {
    modelId: "devstral-small-2:24b",
    name: "Devstral Small 2 24B",
    paramSize: "24B",
    diskSize: "15 GB",
    description:
      "Mistral's agentic coding model (SWE-Bench tuned) with 384K context. Needs Ollama 0.13.3 or newer.",
    category: "coding",
    minMemoryGb: 24,
    contextTokens: 393_216,
    license: "Apache-2.0",
    capabilities: ["tools", "vision"]
  },
  {
    modelId: "qwen3.5:35b",
    name: "Qwen 3.5 35B MoE",
    paramSize: "35B (3B active)",
    diskSize: "24 GB",
    description:
      "Qwen 3.5's mixture-of-experts flagship for local use: strong coding and reasoning, 256K context, tool use and thinking modes.",
    category: "coding",
    minMemoryGb: 32,
    contextTokens: 262_144,
    license: "Apache-2.0",
    capabilities: ["tools", "thinking", "vision"]
  },
  {
    modelId: "qwen2.5-coder:7b",
    name: "Qwen2.5-Coder 7B",
    paramSize: "7B",
    diskSize: "4.7 GB",
    description:
      "Dense coding model that fits 8 GB machines. Older generation, still the best coder at this size.",
    category: "coding",
    minMemoryGb: 8,
    contextTokens: 32_768,
    license: "Apache-2.0",
    capabilities: ["tools"]
  },

  // ---- General Purpose ----
  {
    modelId: "qwen3.5:9b",
    name: "Qwen 3.5 9B",
    paramSize: "9B",
    diskSize: "6.6 GB",
    description:
      "EdgeCoder's default. Balanced general-purpose model with 256K context, vision, tool use and thinking.",
    category: "general",
    recommended: true,
    minMemoryGb: 12,
    contextTokens: 262_144,
    license: "Apache-2.0",
    capabilities: ["tools", "thinking", "vision"]
  },
  {
    modelId: "gpt-oss:20b",
    name: "GPT-OSS 20B MoE",
    paramSize: "21B (3.6B active)",
    diskSize: "14 GB",
    description:
      "OpenAI's open-weight reasoning model with adjustable reasoning effort and 128K context. Runs in 16 GB.",
    category: "general",
    minMemoryGb: 16,
    contextTokens: 131_072,
    license: "Apache-2.0",
    capabilities: ["tools", "thinking"]
  },
  {
    modelId: "gemma4:26b",
    name: "Gemma 4 26B",
    paramSize: "26B",
    diskSize: "17 GB",
    description: "Google's Gemma 4 mid-size model: multimodal (text and image), tool use, long context.",
    category: "general",
    minMemoryGb: 24,
    contextTokens: 131_072,
    license: "Gemma Terms of Use",
    capabilities: ["tools", "vision"]
  },
  {
    modelId: "deepseek-r1:14b",
    name: "DeepSeek-R1 14B (distill)",
    paramSize: "14B",
    diskSize: "9.0 GB",
    description: "Reasoning-first distilled model; good for debugging and step-by-step analysis.",
    category: "general",
    minMemoryGb: 16,
    contextTokens: 131_072,
    license: "MIT",
    capabilities: ["tools", "thinking"]
  },
  {
    modelId: "qwen3.5:27b",
    name: "Qwen 3.5 27B",
    paramSize: "27B",
    diskSize: "17 GB",
    description: "High-capacity dense Qwen 3.5 for demanding general-purpose and coding workloads.",
    category: "general",
    minMemoryGb: 24,
    contextTokens: 262_144,
    license: "Apache-2.0",
    capabilities: ["tools", "thinking", "vision"]
  },

  // ---- Small & Fast ----
  {
    modelId: "qwen3.5:4b",
    name: "Qwen 3.5 4B",
    paramSize: "4B",
    diskSize: "3.4 GB",
    description: "Compact Qwen 3.5 with tool use and thinking; the default for 8 GB seeds and laptops.",
    category: "small",
    recommended: true,
    minMemoryGb: 8,
    contextTokens: 262_144,
    license: "Apache-2.0",
    capabilities: ["tools", "thinking", "vision"]
  },
  {
    modelId: "gemma4:e4b",
    name: "Gemma 4 E4B",
    paramSize: "4B effective",
    diskSize: "6.6 GB",
    description: "Google's on-device Gemma 4 (quantization-aware). Multimodal, strong for its size.",
    category: "small",
    minMemoryGb: 8,
    contextTokens: 131_072,
    license: "Gemma Terms of Use",
    capabilities: ["tools", "vision"]
  },
  {
    modelId: "qwen3.5:2b",
    name: "Qwen 3.5 2B",
    paramSize: "2B",
    diskSize: "2.7 GB",
    description: "Lightweight Qwen 3.5 for quick prototyping and resource-constrained environments.",
    category: "small",
    minMemoryGb: 4,
    contextTokens: 262_144,
    license: "Apache-2.0",
    capabilities: ["tools", "thinking", "vision"]
  },
  {
    modelId: "qwen3.5:0.8b",
    name: "Qwen 3.5 0.8B",
    paramSize: "0.8B",
    diskSize: "1.0 GB",
    description: "Ultra-small Qwen 3.5 for edge devices and minimal-footprint deployments.",
    category: "small",
    minMemoryGb: 2,
    contextTokens: 262_144,
    license: "Apache-2.0",
    capabilities: ["tools", "thinking"]
  }
];

export const CATEGORY_LABELS: Record<CatalogCategory, string> = {
  coding: "Coding",
  general: "General Purpose",
  small: "Small & Fast"
};

/** Default model for a host with `memoryGb` of RAM: the recommended entry that fits, largest first. */
export function defaultModelForMemory(memoryGb: number, catalog: CatalogModel[] = MODEL_CATALOG): string {
  const fits = catalog
    .filter((m) => m.minMemoryGb <= memoryGb)
    .sort((a, b) => b.minMemoryGb - a.minMemoryGb);
  return (fits.find((m) => m.recommended) ?? fits[0] ?? catalog[catalog.length - 1]).modelId;
}

/** Catalog entry for an installed Ollama tag; "name:latest" matches the catalog's default size for that name. */
export function catalogEntryForTag(tag: string, catalog: CatalogModel[] = MODEL_CATALOG): CatalogModel | undefined {
  const exact = catalog.find((m) => m.modelId === tag);
  if (exact) return exact;
  const [name, suffix] = tag.split(":");
  if (suffix && suffix !== "latest") return undefined;
  return catalog.find((m) => m.modelId.split(":")[0] === name);
}
