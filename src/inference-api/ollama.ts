// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/** Stream a chat from an Ollama server: text pieces, tool calls, and how it stopped. */

import { request } from "undici";
import type { ChatMessage, ToolCall, ToolSpec } from "./types.js";

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
 * generating. The context window must be the one the agent serves calls with (numCtx): Ollama
 * reloads a model whose num_ctx changes, so warming it with another size would not help.
 */
export async function warmOllamaModel(host: string, model: string, opts: { keepAlive?: string; timeoutMs?: number; numCtx?: number; /** Also generate a few tokens (first-generation set-up, not just the load). */ generate?: boolean } = {}): Promise<void> {
  const keepAlive = keepAliveValue(opts.keepAlive);
  const res = await request(`${host.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: opts.generate ? "Say OK." : "",
      stream: false,
      ...(opts.generate ? { think: false } : {}),
      ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}),
      options: { num_ctx: opts.numCtx ?? MIN_CONTEXT_WINDOW, ...(opts.generate ? { num_predict: 4, temperature: 0 } : {}) },
    }),
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

/** Tokens a call needs: the prompt (about 3 characters a token), the reply, and a margin. */
export function contextNeeded(messages: ChatMessage[], tools: unknown[] | undefined, maxTokens: number | undefined): number {
  const chars = messages.reduce((n, m) => n + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) + (tools ? JSON.stringify(tools).length : 0);
  return Math.ceil(chars / 3) + (maxTokens ?? 4096) + 256;
}

/**
 * Context window to ask for when the caller has no fixed one (local chat): enough for the prompt
 * and the reply, rounded up to a power of two, between `floor` (8k) and 32k. Ollama's own default
 * (a few thousand tokens) silently cuts long prompts, such as a coding tool's system prompt and
 * tool list. Ollama reloads a model whose num_ctx changes, so a network agent serves every call
 * with one fixed window instead (ollamaChat's numCtx; src/swarm/parallelism.ts).
 */
export function contextWindowFor(messages: ChatMessage[], tools: ToolSpec[] | undefined, maxTokens: number | undefined, floor = MIN_CONTEXT_WINDOW): number {
  const need = contextNeeded(messages, tools, maxTokens);
  let ctx = Math.max(MIN_CONTEXT_WINDOW, floor);
  while (ctx < need && ctx < 32_768) ctx *= 2;
  return ctx;
}

export type OllamaPiece = { delta: string } | { toolCalls: ToolCall[] } | { doneReason: string; promptTokens?: number; outputTokens?: number; /** Ollama's load_duration: time spent loading the model for this call. */ loadMs?: number; /** prompt_eval_duration and eval_duration: reading the prompt and writing the reply. */ promptMs?: number; genMs?: number };

export async function* ollamaChat(
  host: string,
  req: { model: string; messages: ChatMessage[]; tools?: ToolSpec[]; maxTokens?: number; temperature?: number; /** AGENT_MODEL_KEEP_ALIVE (keepAliveValue). */ keepAlive?: string; /** A fixed context window (a network agent's); unset = sized per call. */ numCtx?: number },
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
        num_ctx: req.numCtx ?? contextWindowFor(req.messages, req.tools, req.maxTokens),
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
      let chunk: { message?: { content?: string; tool_calls?: ToolCall[] }; error?: string; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number; load_duration?: number; prompt_eval_duration?: number; eval_duration?: number };
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.message?.content) yield { delta: chunk.message.content };
      if (chunk.message?.tool_calls?.length) yield { toolCalls: chunk.message.tool_calls };
      if (chunk.done) {
        const ms = (ns: unknown) => (typeof ns === "number" && Number.isFinite(ns) && ns > 0 ? Math.round(ns / 1e6) : undefined);
        const loadMs = ms(chunk.load_duration);
        const promptMs = ms(chunk.prompt_eval_duration);
        const genMs = ms(chunk.eval_duration);
        yield { doneReason: chunk.done_reason ?? "stop", promptTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count, ...(loadMs !== undefined ? { loadMs } : {}), ...(promptMs !== undefined ? { promptMs } : {}), ...(genMs !== undefined ? { genMs } : {}) };
      }
    }
  }
}
