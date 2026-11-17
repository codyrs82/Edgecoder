// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The one chat format behind every compatible endpoint (OpenAI /v1/chat/completions and
 * Anthropic /v1/messages, on this machine and hosted): Ollama's chat format, which is what runs
 * the model in the end, locally or on a network agent.
 */

import type { ServedBy } from "../swarm/served-by.js";
import type { RoutingHints } from "./job-descriptor.js";
import type { Complexity } from "./job-complexity.js";

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  /** On a tool result: the tool it answers. */
  tool_name?: string;
  /**
   * On a user message: images / PDFs attached in the desktop composer. Only frontier backends send
   * them (frontier.ts); the IDE strips them before any other backend (attachments.ts withoutMedia).
   */
  media?: ChatMedia[];
}

/** An image or PDF on a user message, base64 without a data: prefix. */
export interface ChatMedia {
  kind: "image" | "pdf";
  mediaType: string;
  data: string;
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
  /** For Auto: the step's complexity when a caller already estimated it (so it isn't estimated twice). */
  complexity?: Complexity;
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
      /** Frontier calls (the user's own key): estimated USD, billed by the provider, never in cSats. */
      usd?: number;
      /** Frontier calls: the model that answered (a server-side fallback may differ from the one asked). */
      servedBy?: string;
    };

export class ChatBackendError extends Error {
  /**
   * `retryAfterSec`: when a 429/503 should be tried again (sent as Retry-After). `info`: a network
   * failure as data (network-inference.ts NetworkFailureInfo), so Auto can word it.
   */
  constructor(message: string, readonly status: number, readonly retryAfterSec?: number, readonly info?: { code: string; reason?: string; neededCSats?: number; computeClass?: string }) {
    super(message);
  }
}

export type ChatBackend = (req: ChatRequest, signal?: AbortSignal) => AsyncGenerator<ChatPiece>;
