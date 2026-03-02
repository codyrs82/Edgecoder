// Curated model catalog for the EdgeCoder Model Manager.
// Used by the model browsing UI to display recommended models for one-click install.

export interface CatalogModel {
  modelId: string;
  name: string;
  paramSize: string;
  diskSize: string;
  description: string;
  category: "coding" | "general" | "small";
  recommended?: boolean;
}

export const MODEL_CATALOG: CatalogModel[] = [
  // ---- Coding ----
  {
    modelId: "qwen3.5:35b",
    name: "Qwen 3.5 35B MoE",
    paramSize: "35B (3B active)",
    diskSize: "24 GB",
    description:
      "Top-tier MoE coding model with 256K context, native tool use, and Apache 2.0 license.",
    category: "coding",
    recommended: true,
  },
  {
    modelId: "deepseek-coder-v2:16b",
    name: "DeepSeek Coder V2",
    paramSize: "16B",
    diskSize: "8.9 GB",
    description:
      "High-quality code model with excellent reasoning and long-context understanding.",
    category: "coding",
  },
  {
    modelId: "qwen3.5:4b",
    name: "Qwen 3.5 4B",
    paramSize: "4B",
    diskSize: "3.4 GB",
    description:
      "Compact Qwen 3.5 coding variant with strong multi-language support on modest hardware.",
    category: "coding",
  },

  // ---- General Purpose ----
  {
    modelId: "qwen3.5:9b",
    name: "Qwen 3.5 9B",
    paramSize: "9B",
    diskSize: "6.6 GB",
    description:
      "Balanced general-purpose model with 256K context, multimodal input, and agentic capabilities.",
    category: "general",
    recommended: true,
  },
  {
    modelId: "llama3.1:8b",
    name: "Llama 3.1",
    paramSize: "8B",
    diskSize: "4.7 GB",
    description:
      "Meta's versatile open model with strong instruction-following and reasoning abilities.",
    category: "general",
  },
  {
    modelId: "qwen3.5:27b",
    name: "Qwen 3.5 27B",
    paramSize: "27B",
    diskSize: "17 GB",
    description:
      "High-capacity Qwen 3.5 dense model for demanding general-purpose workloads.",
    category: "general",
  },

  // ---- Small & Fast ----
  {
    modelId: "qwen3.5:2b",
    name: "Qwen 3.5 2B",
    paramSize: "2B",
    diskSize: "2.7 GB",
    description:
      "Lightweight Qwen 3.5 for quick prototyping and resource-constrained environments.",
    category: "small",
    recommended: true,
  },
  {
    modelId: "qwen3.5:0.8b",
    name: "Qwen 3.5 0.8B",
    paramSize: "0.8B",
    diskSize: "1.0 GB",
    description:
      "Ultra-small Qwen 3.5 for edge devices and minimal-footprint deployments.",
    category: "small",
  },
  {
    modelId: "llama3.2:3b",
    name: "Llama 3.2",
    paramSize: "3B",
    diskSize: "2.0 GB",
    description:
      "Smallest Llama 3.2 variant balancing capability and resource efficiency.",
    category: "small",
  },
];

export const CATEGORY_LABELS: Record<string, string> = {
  coding: "Coding",
  general: "General Purpose",
  small: "Small & Fast",
};
