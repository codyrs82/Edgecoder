// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The one chat format behind every compatible endpoint (OpenAI /v1/chat/completions and
 * Anthropic /v1/messages, on this machine and hosted): Ollama's chat format, which is what runs
 * the model in the end, locally or on a network agent.
 */

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  /** On a tool result: the tool it answers. */
  tool_name?: string;
}

/** A function tool (OpenAI / Ollama shape). */
export interface ToolSpec {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

/** What a backend yields: text as it is generated, the tool calls, then the end. */
export type ChatPiece =
  | { delta: string }
  | { toolCalls: ToolCall[] }
  | { done: true; cSatsSpent?: number; stopReason?: "stop" | "length"; /** Where it ran, when Auto chose. */ where?: string };

export class ChatBackendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type ChatBackend = (req: ChatRequest, signal?: AbortSignal) => AsyncGenerator<ChatPiece>;
