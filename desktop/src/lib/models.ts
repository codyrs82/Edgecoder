// Curated model catalog for the EdgeCoder Model Manager (offline fallback).
//
// GENERATED COPY of src/model/catalog.ts. Do not edit here: edit the shared file and run
//   node scripts/sync-model-catalog.mjs
// tests/model/catalog-sync.test.ts fails when the two drift. At runtime the Model Manager
// prefers GET /model/catalog from the inference service and falls back to this list.

export const MODEL_CATALOG_VERSION = "2026-11-01.1";

export type CatalogCategory = "coding" | "general" | "small" | "large";

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
    diskSize: "22 GB",
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
    diskSize: "19 GB",
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
    diskSize: "1.3 GB",
    description: "Ultra-small Qwen 3.5 for edge devices and minimal-footprint deployments.",
    category: "small",
    minMemoryGb: 2,
    contextTokens: 262_144,
    license: "Apache-2.0",
    capabilities: ["tools", "thinking"]
  },
  // ---- Large: datacenter GPUs, one card or several pooled (sizes from the Ollama registry, 2026-11-03) ----
  {
    modelId: "qwen2.5-coder:32b",
    name: "Qwen2.5-Coder 32B",
    paramSize: "32B",
    diskSize: "20 GB",
    description: "Dense 32B coder: strong code generation and repair; a steady choice for one 24-48 GB GPU.",
    category: "large",
    minMemoryGb: 24,
    contextTokens: 32_768,
    license: "Apache-2.0",
    capabilities: ["tools"]
  },
  {
    modelId: "llama3.3:70b",
    name: "Llama 3.3 70B",
    paramSize: "70B",
    diskSize: "43 GB",
    description: "General 70B model with tool calling; fills one 48 GB card.",
    category: "large",
    minMemoryGb: 48,
    contextTokens: 131_072,
    license: "Llama 3.3 Community",
    capabilities: ["tools"]
  },
  {
    modelId: "deepseek-r1:70b",
    name: "DeepSeek-R1 70B (distill)",
    paramSize: "70B",
    diskSize: "43 GB",
    description: "Reasoning model distilled from DeepSeek-R1 onto Llama 3.3 70B; slow and thorough. One 48 GB card.",
    category: "large",
    minMemoryGb: 48,
    contextTokens: 131_072,
    license: "Llama 3.3 Community",
    capabilities: ["thinking"]
  },
  {
    modelId: "gpt-oss:120b",
    name: "gpt-oss 120B MoE",
    paramSize: "117B (5.1B active)",
    diskSize: "65 GB",
    description: "OpenAI's open-weight 120B: strong reasoning and tool use at MoE speed. Two 48 GB cards or one 80 GB.",
    category: "large",
    minMemoryGb: 80,
    contextTokens: 131_072,
    license: "Apache-2.0",
    capabilities: ["tools", "thinking"]
  },
  {
    modelId: "deepseek-coder-v2:236b",
    name: "DeepSeek-Coder-V2 236B MoE",
    paramSize: "236B (21B active)",
    diskSize: "133 GB",
    description: "Large MoE coder. Four 48 GB cards.",
    category: "large",
    minMemoryGb: 160,
    contextTokens: 163_840,
    license: "DeepSeek",
    capabilities: []
  },
  {
    modelId: "qwen3:235b",
    name: "Qwen3 235B MoE",
    paramSize: "235B (22B active)",
    diskSize: "142 GB",
    description: "Frontier-class open MoE for hard reasoning and agent work. Four 48 GB cards.",
    category: "large",
    minMemoryGb: 160,
    contextTokens: 40_960,
    license: "Apache-2.0",
    capabilities: ["tools", "thinking"]
  },
  {
    modelId: "qwen3-coder:480b",
    name: "Qwen3-Coder 480B MoE",
    paramSize: "480B (35B active)",
    diskSize: "290 GB",
    description: "The largest open agentic coder: 256K context, tool calling. Seven or eight 48 GB cards pooled.",
    category: "large",
    recommended: true,
    minMemoryGb: 320,
    contextTokens: 262_144,
    license: "Apache-2.0",
    capabilities: ["tools"]
  }
];

export const CATEGORY_LABELS: Record<CatalogCategory, string> = {
  coding: "Coding",
  general: "General Purpose",
  small: "Small & Fast",
  large: "Large (GPU servers)"
};
