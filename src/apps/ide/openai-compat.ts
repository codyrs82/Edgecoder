export interface OpenAiChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface ParsedRequest {
  task: string;
  model: string;
  stream: boolean;
}

export interface OpenAiChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop" | "length";
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAiStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: null | "stop";
  }>;
}

export interface OpenAiModelsResponse {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    created: number;
    owned_by: string;
  }>;
}

export function parseOpenAiRequest(body: OpenAiChatRequest): ParsedRequest {
  const userMessages = body.messages.filter((m) => m.role === "user");
  const task = userMessages.length > 0
    ? userMessages[userMessages.length - 1].content
    : "";

  return {
    task,
    model: body.model,
    stream: body.stream ?? false
  };
}

export function formatOpenAiResponse(
  requestId: string,
  model: string,
  content: string
): OpenAiChatResponse {
  return {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

export function formatOpenAiStreamChunk(
  requestId: string,
  model: string,
  content: string,
  finishReason: null | "stop" = null
): OpenAiStreamChunk {
  return {
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: content || undefined },
        finish_reason: finishReason
      }
    ]
  };
}

export function formatOpenAiModelsResponse(
  modelIds: string[]
): OpenAiModelsResponse {
  return {
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model" as const,
      created: Math.floor(Date.now() / 1000),
      owned_by: "edgecoder"
    }))
  };
}
