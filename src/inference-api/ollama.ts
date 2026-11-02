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
export function contextWindowFor(messages: ChatMessage[], tools: ToolSpec[] | undefined, maxTokens: number | undefined): number {
  const chars = messages.reduce((n, m) => n + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) + (tools ? JSON.stringify(tools).length : 0);
  const need = Math.ceil(chars / 3) + (maxTokens ?? 4096) + 256;
  let ctx = 8192;
  while (ctx < need && ctx < 32_768) ctx *= 2;
  return ctx;
}

export type OllamaPiece = { delta: string } | { toolCalls: ToolCall[] } | { doneReason: string };

export async function* ollamaChat(
  host: string,
  req: { model: string; messages: ChatMessage[]; tools?: ToolSpec[]; maxTokens?: number; temperature?: number },
  signal?: AbortSignal,
): AsyncGenerator<OllamaPiece> {
  const res = await request(`${host.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      stream: true,
      think: false,
      options: {
        num_ctx: contextWindowFor(req.messages, req.tools, req.maxTokens),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { num_predict: req.maxTokens } : {}),
      },
    }),
    signal,
    headersTimeout: 120_000,
    bodyTimeout: 120_000,
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
      let chunk: { message?: { content?: string; tool_calls?: ToolCall[] }; error?: string; done?: boolean; done_reason?: string };
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.message?.content) yield { delta: chunk.message.content };
      if (chunk.message?.tool_calls?.length) yield { toolCalls: chunk.message.tool_calls };
      if (chunk.done) yield { doneReason: chunk.done_reason ?? "stop" };
    }
  }
}
