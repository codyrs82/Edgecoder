// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type {
  ModelSwapResponse,
  ModelStatusResponse,
  ModelListEntry,
} from "../common/types.js";
import type { PullTracker } from "./pull-tracker.js";

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

export async function ollamaTags(): Promise<OllamaTagsResponse> {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!res.ok) throw new Error(`ollama_tags_failed: ${res.status}`);
  return res.json() as Promise<OllamaTagsResponse>;
}

export async function swapModel(
  targetModel: string,
  currentModel: string,
  tracker?: PullTracker,
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

  // Model not installed — trigger streaming pull
  tracker?.startPull(targetModel);

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: targetModel, stream: true }),
    });

    if (!res.ok || !res.body) {
      tracker?.failPull("pull_request_failed");
      return {
        previous: currentModel,
        active: currentModel,
        status: "error",
        paramSize: 0,
        error: "pull_failed",
      };
    }

    // Process streaming NDJSON in background — don't block the response
    processStreamingPull(res.body, tracker).catch(() => {
      tracker?.failPull("stream_read_error");
    });
  } catch {
    tracker?.failPull("pull_fetch_error");
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

async function processStreamingPull(
  body: ReadableStream<Uint8Array>,
  tracker?: PullTracker,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as {
            status?: string;
            completed?: number;
            total?: number;
            error?: string;
          };
          if (parsed.error) {
            tracker?.failPull(parsed.error);
            return;
          }
          if (parsed.status) {
            tracker?.updateProgress(
              parsed.status,
              parsed.completed ?? 0,
              parsed.total ?? 0,
            );
          }
        } catch {
          // skip malformed JSON
        }
      }
    }
    tracker?.completePull();
  } catch {
    tracker?.failPull("stream_interrupted");
  }
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

  // If configured activeModel isn't among installed tags, resolve to the best match
  const names = tags.models.map((m) => m.name);
  const base = activeModel.split(":")[0];
  const exactMatch = names.includes(activeModel);
  const latestMatch = !exactMatch && names.find((n) => n === `${base}:latest`);
  const prefixMatch = !exactMatch && !latestMatch && names.find((n) => n.startsWith(base + ":"));
  const resolvedActive = exactMatch ? activeModel : (latestMatch ?? prefixMatch ?? names[0] ?? activeModel);

  return tags.models.map((m) => ({
    modelId: m.name,
    paramSize: parseParamSize(m.details.parameter_size)
      || paramSizeFromBytes(m.size),
    quantization: m.details.quantization_level,
    installed: true,
    active: m.name === resolvedActive,
    source: "ollama" as const,
  }));
}
