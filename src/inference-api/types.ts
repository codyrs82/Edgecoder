// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The one chat format behind every compatible endpoint (OpenAI /v1/chat/completions and
 * Anthropic /v1/messages, on this machine and hosted): Ollama's chat format, which is what runs
 * the model in the end, locally or on a network agent.
 */

import type { ServedBy } from "../swarm/served-by.js";
import type { RoutingHints } from "./job-descriptor.js";

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
  /** For model "auto": what the client said about the job (body `edgecoder`, x-edgecoder-* headers, session). */
  hints?: RoutingHints;
}

/** What a backend yields: text as it is generated, the tool calls, then the end. */
export type ChatPiece =
  | { delta: string }
  | { toolCalls: ToolCall[] }
  | {
      done: true;
      cSatsSpent?: number;
      stopReason?: "stop" | "length";
      /** Where it ran, when Auto chose. */
      where?: string;
      /** Token counts as billed (the model's own counts, bounded by the coordinator); absent when unknown. */
      promptTokens?: number;
      outputTokens?: number;
      /** Where the call ran (the serving machine's masked label, hardware, region, timings). */
      served?: ServedBy;
    };

export class ChatBackendError extends Error {
  /** `retryAfterSec`: when a 429/503 should be tried again (sent as Retry-After). */
  constructor(message: string, readonly status: number, readonly retryAfterSec?: number) {
    super(message);
  }
}

export type ChatBackend = (req: ChatRequest, signal?: AbortSignal) => AsyncGenerator<ChatPiece>;
