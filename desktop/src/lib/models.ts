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
    modelId: "qwen2.5-coder:7b",
    name: "Qwen 2.5 Coder",
    paramSize: "7B",
    diskSize: "4.7 GB",
    description:
      "State-of-the-art code generation and completion with strong multi-language support.",
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
    modelId: "codellama:7b",
    name: "Code Llama",
    paramSize: "7B",
    diskSize: "3.8 GB",
    description:
      "Meta's code-specialised Llama model with infilling and instruction-following support.",
    category: "coding",
  },

  // ---- General Purpose ----
  {
    modelId: "llama3.1:8b",
    name: "Llama 3.1",
    paramSize: "8B",
    diskSize: "4.7 GB",
    description:
      "Meta's versatile open model with strong instruction-following and reasoning abilities.",
    category: "general",
    recommended: true,
  },
  {
    modelId: "mistral:7b",
    name: "Mistral",
    paramSize: "7B",
    diskSize: "4.1 GB",
    description:
      "Efficient general-purpose model with sliding-window attention and solid performance.",
    category: "general",
  },
  {
    modelId: "gemma2:9b",
    name: "Gemma 2",
    paramSize: "9B",
    diskSize: "5.4 GB",
    description:
      "Google's lightweight open model optimised for helpfulness and safety.",
    category: "general",
  },

  // ---- Small & Fast ----
  {
    modelId: "qwen2.5:0.5b",
    name: "Qwen 2.5 Tiny",
    paramSize: "0.5B",
    diskSize: "0.4 GB",
    description:
      "Ultra-light model for quick prototyping and low-resource environments.",
    category: "small",
    recommended: true,
  },
  {
    modelId: "phi3:mini",
    name: "Phi-3 Mini",
    paramSize: "3.8B",
    diskSize: "2.3 GB",
    description:
      "Microsoft's compact model with surprisingly strong reasoning for its size.",
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
