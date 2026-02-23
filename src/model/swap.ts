import type {
  ModelSwapResponse,
  ModelStatusResponse,
  ModelListEntry,
} from "../common/types.js";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

export interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model: string;
    size: number;
    digest: string;
    details: {
      parameter_size: string;
      quantization_level: string;
    };
    modified_at: string;
  }>;
}

function parseParamSize(sizeStr: string): number {
  const match = sizeStr.match(/([\d.]+)\s*[Bb]/);
  return match ? parseFloat(match[1]) : 0;
}

function paramSizeFromBytes(sizeBytes: number): number {
  return Math.round((sizeBytes / 1e9) * 10) / 10;
}

async function ollamaTags(): Promise<OllamaTagsResponse> {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!res.ok) throw new Error(`ollama_tags_failed: ${res.status}`);
  return res.json() as Promise<OllamaTagsResponse>;
}

export async function swapModel(
  targetModel: string,
  currentModel: string,
): Promise<ModelSwapResponse> {
  let tags: OllamaTagsResponse;
  try {
    tags = await ollamaTags();
  } catch {
    return {
      previous: currentModel,
      active: currentModel,
      status: "error",
      paramSize: 0,
      error: "ollama_not_running: Start Ollama with: ollama serve",
    };
  }

  const installed = tags.models.find((m) => m.name === targetModel);
  if (installed) {
    const paramSize = parseParamSize(installed.details.parameter_size)
      || paramSizeFromBytes(installed.size);
    return {
      previous: currentModel,
      active: targetModel,
      status: "ready",
      paramSize,
    };
  }

  // Model not installed — trigger pull
  try {
    await fetch(`${OLLAMA_HOST}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: targetModel, stream: false }),
    });
  } catch {
    return {
      previous: currentModel,
      active: currentModel,
      status: "error",
      paramSize: 0,
      error: "pull_failed",
    };
  }

  return {
    previous: currentModel,
    active: currentModel,
    status: "pulling",
    paramSize: 0,
    progress: 0,
  };
}

export async function getModelStatus(
  activeModel: string,
): Promise<ModelStatusResponse> {
  try {
    const tags = await ollamaTags();
    const found = tags.models.find((m) => m.name === activeModel);
    if (!found) {
      return {
        model: activeModel,
        paramSize: 0,
        status: "no_model",
        ollamaHealthy: true,
      };
    }
    const paramSize = parseParamSize(found.details.parameter_size)
      || paramSizeFromBytes(found.size);
    return {
      model: activeModel,
      paramSize,
      status: "ready",
      ollamaHealthy: true,
    };
  } catch {
    return {
      model: activeModel,
      paramSize: 0,
      status: "error",
      ollamaHealthy: false,
    };
  }
}

export async function listModels(
  activeModel: string,
): Promise<ModelListEntry[]> {
  let tags: OllamaTagsResponse;
  try {
    tags = await ollamaTags();
  } catch {
    return [];
  }

  return tags.models.map((m) => ({
    modelId: m.name,
    paramSize: parseParamSize(m.details.parameter_size)
      || paramSizeFromBytes(m.size),
    quantization: m.details.quantization_level,
    installed: true,
    active: m.name === activeModel,
    source: "ollama" as const,
  }));
}
