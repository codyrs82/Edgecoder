import { request } from "undici";

export type ModelProviderKind = "edgecoder-local" | "ollama-local";

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

    if (prompt.startsWith("Create a short plan for this coding task:")) {
      const task = prompt.replace("Create a short plan for this coding task:\n", "").trim();
      return {
        text: `1. Parse task requirements\n2. Generate minimal valid code\n3. Execute and report\nTask: ${task.slice(0, 120)}`,
        provider: this.kind
      };
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
    model = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:latest"
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
        stream: false
      })
    });

    const payload = (await response.body.json()) as { response?: string };
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

export class ProviderRegistry {
  private active: ModelProvider;

  constructor(
    private readonly edgecoder = new EdgeCoderLocalProvider(),
    private readonly ollama = new OllamaLocalProvider()
  ) {
    this.active = edgecoder;
  }

  use(kind: ModelProviderKind): void {
    this.active = kind === "ollama-local" ? this.ollama : this.edgecoder;
  }

  current(): ModelProvider {
    return this.active;
  }
}
