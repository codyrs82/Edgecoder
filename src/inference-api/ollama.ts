// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** Stream a chat from an Ollama server: text pieces, tool calls, and how it stopped. */

import { request } from "undici";
import type { ChatMessage, ToolCall, ToolSpec } from "./types.js";

/**
 * Context window to ask for: enough for the prompt (about 3 characters a token) and the reply,
 * rounded up to a power of two, between 8k and 32k. Ollama's own default (a few thousand tokens)
 * silently cuts long prompts, such as a coding tool's system prompt and tool list.
 */
/** Smallest context window a network call asks for (contextWindowFor). */
export const MIN_CONTEXT_WINDOW = 8192;

/**
 * Ollama's keep_alive from a setting such as "30m", "1h", "300" (seconds) or "-1" (never unload):
 * a bare number is sent as a number (Ollama reads a string with no unit as an error), anything
 * else as given. Undefined for an empty or malformed setting (Ollama's own default then applies).
 */
export function keepAliveValue(setting: string | undefined): number | string | undefined {
  const v = setting?.trim();
  if (!v) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(v)) return v;
  return undefined;
}

/**
 * Load a model into memory now, so the first real call does not wait for it (several seconds on a
 * CPU, the "cold model" delay). An empty prompt makes Ollama load the model and return without
 * generating. The context window is the one network calls ask for: Ollama reloads a model whose
 * num_ctx changes, so warming it with another size would not help.
 */
export async function warmOllamaModel(host: string, model: string, opts: { keepAlive?: string; timeoutMs?: number } = {}): Promise<void> {
  const keepAlive = keepAliveValue(opts.keepAlive);
  const res = await request(`${host.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: "", stream: false, ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}), options: { num_ctx: MIN_CONTEXT_WINDOW } }),
    headersTimeout: opts.timeoutMs ?? 600_000,
    bodyTimeout: opts.timeoutMs ?? 600_000,
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // plain text
    }
    throw new Error(`ollama: ${msg}`);
  }
}

export function contextWindowFor(messages: ChatMessage[], tools: ToolSpec[] | undefined, maxTokens: number | undefined): number {
  const chars = messages.reduce((n, m) => n + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) + (tools ? JSON.stringify(tools).length : 0);
  const need = Math.ceil(chars / 3) + (maxTokens ?? 4096) + 256;
  let ctx = MIN_CONTEXT_WINDOW;
  while (ctx < need && ctx < 32_768) ctx *= 2;
  return ctx;
}

export type OllamaPiece = { delta: string } | { toolCalls: ToolCall[] } | { doneReason: string; promptTokens?: number; outputTokens?: number };

export async function* ollamaChat(
  host: string,
  req: { model: string; messages: ChatMessage[]; tools?: ToolSpec[]; maxTokens?: number; temperature?: number; /** AGENT_MODEL_KEEP_ALIVE (keepAliveValue). */ keepAlive?: string },
  signal?: AbortSignal,
  /**
   * How long to wait for the first byte and between pieces. Ollama answers only once the model is
   * loaded and the prompt read, which on a CPU with a cold model and a long prompt can take minutes,
   * so a caller with its own deadline (the abort signal) passes it here instead of a fixed limit.
   */
  timeoutMs = 120_000,
): AsyncGenerator<OllamaPiece> {
  const keepAlive = keepAliveValue(req.keepAlive);
  const res = await request(`${host.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      stream: true,
      think: false,
      ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}),
      options: {
        num_ctx: contextWindowFor(req.messages, req.tools, req.maxTokens),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { num_predict: req.maxTokens } : {}),
      },
    }),
    signal,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  if (res.statusCode >= 400) {
    const text = await res.body.text();
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // plain text
    }
    throw new Error(`ollama: ${msg}`);
  }
  let buf = "";
  for await (const part of res.body) {
    buf += Buffer.from(part as Uint8Array).toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let chunk: { message?: { content?: string; tool_calls?: ToolCall[] }; error?: string; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number };
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.message?.content) yield { delta: chunk.message.content };
      if (chunk.message?.tool_calls?.length) yield { toolCalls: chunk.message.tool_calls };
      if (chunk.done) yield { doneReason: chunk.done_reason ?? "stop", promptTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count };
    }
  }
}
