// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";

export type ModelProviderKind =
  | "edgecoder-local"
  | "ollama-local"
  | "ollama-edge"
  | "ollama-coordinator";

export interface GenerateRequest {
  prompt: string;
  maxTokens?: number;
}

export interface GenerateResponse {
  text: string;
  provider: ModelProviderKind;
}

export interface ModelProvider {
  readonly kind: ModelProviderKind;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  health(): Promise<boolean>;
}

export class EdgeCoderLocalProvider implements ModelProvider {
  readonly kind: ModelProviderKind = "edgecoder-local";

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    // Deterministic offline stub: keep generated output executable for local loops.
    const prompt = req.prompt ?? "";

    // Match structured code prompt from codePrompt()
    const structuredCodeMatch = prompt.match(
      /You are a coding assistant\. Write (python|javascript) code that implements the following plan\.\n\nTask: ([\s\S]*?)\n\nPlan:\n([\s\S]*?)\n\nOutput ONLY executable/
    );
    if (structuredCodeMatch) {
      const language = structuredCodeMatch[1];
      const task = structuredCodeMatch[2].trim();
      const looksLikeCode =
        task.includes("\n") ||
        /\b(print\(|console\.log|def |function |for |if |return|const |let |var )\b/.test(task);
      if (looksLikeCode) {
        return { text: task, provider: this.kind };
      }
      if (language === "python") {
        return {
          text: `print(${JSON.stringify(`edgecoder-local:${task}`)})`,
          provider: this.kind
        };
      }
      return {
        text: `console.log(${JSON.stringify(`edgecoder-local:${task}`)});`,
        provider: this.kind
      };
    }

    // Match legacy code prompt format
    const codeMatch = prompt.match(/^Write (python|javascript) code for this task:\n([\s\S]*)$/);
    if (codeMatch) {
      const language = codeMatch[1];
      const task = codeMatch[2].trim();
      const looksLikeCode =
        task.includes("\n") ||
        /\b(print\(|console\.log|def |function |for |if |return|const |let |var )\b/.test(task);
      if (looksLikeCode) {
        return { text: task, provider: this.kind };
      }
      if (language === "python") {
        return {
          text: `print(${JSON.stringify(`edgecoder-local:${task}`)})`,
          provider: this.kind
        };
      }
      return {
        text: `console.log(${JSON.stringify(`edgecoder-local:${task}`)});`,
        provider: this.kind
      };
    }

    // Match structured plan prompt from planPrompt()
    if (prompt.startsWith("You are a coding assistant. Create a step-by-step plan")) {
      const taskMatch = prompt.match(/Task: ([\s\S]*)$/);
      const task = taskMatch ? taskMatch[1].trim() : "";
      return {
        text: `1. Parse task requirements\n2. Generate minimal valid code\n3. Execute and report\nTask: ${task.slice(0, 120)}`,
        provider: this.kind
      };
    }

    // Match legacy plan prompt format
    if (prompt.startsWith("Create a short plan for this coding task:")) {
      const task = prompt.replace("Create a short plan for this coding task:\n", "").trim();
      return {
        text: `1. Parse task requirements\n2. Generate minimal valid code\n3. Execute and report\nTask: ${task.slice(0, 120)}`,
        provider: this.kind
      };
    }

    // Match structured reflect prompt from reflectPrompt()
    if (prompt.startsWith("You are a coding assistant. The following code failed")) {
      const taskMatch = prompt.match(/Task: ([\s\S]*?)\n\nFailed code:\n([\s\S]*?)\n\nError output:/);
      if (taskMatch) {
        const task = taskMatch[1].trim();
        return {
          text: `print(${JSON.stringify(`edgecoder-local:fixed:${task}`)})`,
          provider: this.kind
        };
      }
    }

    return {
      text: `edgecoder-local:${prompt.slice(0, 120)}`,
      provider: this.kind
    };
  }

  async health(): Promise<boolean> {
    return true;
  }
}

export class OllamaLocalProvider implements ModelProvider {
  readonly kind: ModelProviderKind = "ollama-local";
  private readonly model: string;
  constructor(
    private readonly endpoint = process.env.OLLAMA_GENERATE_ENDPOINT ??
      "http://127.0.0.1:11434/api/generate",
    model = process.env.OLLAMA_MODEL ?? "qwen3.5:9b"
  ) {
    this.model = model;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const response = await request(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt: req.prompt,
        stream: false,
        // Agents plan and write code from explicit prompts; a thinking model's reasoning pass made
        // each call ~17x slower (qwen3.5:9b: 41 s vs 2.4 s). OLLAMA_THINK=1 turns it back on.
        think: process.env.OLLAMA_THINK === "1"
      })
    });

    const payload = (await response.body.json().catch(() => ({}))) as { response?: string; error?: string };
    // Ollama answers a missing model or a bad request with an error body; returning "" made the
    // worker run empty code and report success with no output.
    if (response.statusCode >= 400 || payload.error) {
      throw new Error(`ollama (${this.model}): ${payload.error ?? `HTTP ${response.statusCode}`}`);
    }
    return {
      text: payload.response ?? "",
      provider: this.kind
    };
  }

  async health(): Promise<boolean> {
    try {
      const tagsEndpoint = process.env.OLLAMA_TAGS_ENDPOINT ?? "http://127.0.0.1:11434/api/tags";
      const res = await request(tagsEndpoint, { method: "GET" });
      return res.statusCode >= 200 && res.statusCode < 300;
    } catch {
      return false;
    }
  }
}

const DEFAULT_EDGE_MODEL = process.env.OLLAMA_EDGE_MODEL ?? "qwen3.5:9b";
const DEFAULT_COORDINATOR_MODEL = process.env.OLLAMA_COORDINATOR_MODEL ?? "qwen3.5:9b";

export class ProviderRegistry {
  private active: ModelProvider;
  private readonly providers: Map<ModelProviderKind, ModelProvider>;

  constructor(
    edgecoder = new EdgeCoderLocalProvider(),
    ollama = new OllamaLocalProvider(),
    ollamaEdge = new OllamaLocalProvider(undefined, DEFAULT_EDGE_MODEL),
    ollamaCoordinator = new OllamaLocalProvider(undefined, DEFAULT_COORDINATOR_MODEL)
  ) {
    this.providers = new Map<ModelProviderKind, ModelProvider>([
      ["edgecoder-local", edgecoder],
      ["ollama-local", ollama],
      ["ollama-edge", ollamaEdge],
      ["ollama-coordinator", ollamaCoordinator]
    ]);
    this.active = edgecoder;
  }

  use(kind: ModelProviderKind): void {
    const provider = this.providers.get(kind);
    if (provider) {
      this.active = provider;
    }
  }

  current(): ModelProvider {
    return this.active;
  }

  availableProviders(): ModelProviderKind[] {
    return [...this.providers.keys()];
  }
}
