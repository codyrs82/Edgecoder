// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** Anthropic Messages API (what Claude Code speaks) <-> the internal chat format, with tool use. */

import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatPiece, ChatRequest, ToolCall, ToolSpec } from "./types.js";

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

const textOf = (content: unknown) =>
  blocks(content)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

interface AnthropicBody {
  model?: string;
  system?: unknown;
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: Array<{ name?: string; description?: string; input_schema?: unknown; type?: string }>;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export function fromAnthropic(body: AnthropicBody): ChatRequest {
  const messages: ChatMessage[] = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: "system", content: system });
  const toolNameById = new Map<string, string>();
  for (const m of body.messages ?? []) {
    const bs = blocks(m.content);
    if (m.role === "assistant") {
      const calls: ToolCall[] = [];
      for (const b of bs) {
        if (b.type === "tool_use") {
          toolNameById.set(b.id ?? "", b.name ?? "");
          calls.push({ function: { name: b.name ?? "", arguments: (b.input as Record<string, unknown>) ?? {} } });
        }
      }
      messages.push({ role: "assistant", content: textOf(bs), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: tool results become tool messages (in order), the rest is the user's text.
    for (const b of bs) {
      if (b.type === "tool_result") {
        const out = typeof b.content === "string" ? b.content : textOf(b.content);
        messages.push({ role: "tool", content: b.is_error ? `Error: ${out}` : out, tool_name: toolNameById.get(b.tool_use_id ?? "") ?? "" });
      }
    }
    const text = textOf(bs);
    if (text || !bs.some((b) => b.type === "tool_result")) messages.push({ role: "user", content: text });
  }
  const tools: ToolSpec[] = (body.tools ?? [])
    .filter((t) => t.name && (!t.type || t.type === "custom"))
    .map((t) => ({ type: "function", function: { name: t.name!, ...(t.description ? { description: t.description } : {}), parameters: t.input_schema ?? { type: "object", properties: {} } } }));
  return { messages, ...(tools.length ? { tools } : {}), ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}), ...(body.temperature !== undefined ? { temperature: body.temperature } : {}) };
}

/** Rough token count (about 4 characters a token) for /v1/messages/count_tokens. */
export function countTokens(body: AnthropicBody): number {
  const req = fromAnthropic(body);
  const chars = req.messages.reduce((n, m) => n + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) + (req.tools ? JSON.stringify(req.tools).length : 0);
  return Math.ceil(chars / 4);
}

const toolUseId = () => `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
const stopReason = (calls: number, done?: Extract<ChatPiece, { done: true }>) => (calls ? "tool_use" : done?.stopReason === "length" ? "max_tokens" : "end_turn");

/** Server-sent events for a streamed reply, in the Messages API's order. */
export async function* anthropicStream(pieces: AsyncIterable<ChatPiece>, model: string): AsyncGenerator<string> {
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  yield ev("message_start", { message: { id: `msg_${randomUUID().replace(/-/g, "")}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let index = 0;
  let textOpen = false;
  let calls = 0;
  let outChars = 0;
  for await (const p of pieces) {
    if ("delta" in p) {
      if (!textOpen) {
        yield ev("content_block_start", { index, content_block: { type: "text", text: "" } });
        textOpen = true;
      }
      outChars += p.delta.length;
      yield ev("content_block_delta", { index, delta: { type: "text_delta", text: p.delta } });
    } else if ("toolCalls" in p) {
      if (textOpen) {
        yield ev("content_block_stop", { index });
        textOpen = false;
        index++;
      }
      for (const c of p.toolCalls) {
        yield ev("content_block_start", { index, content_block: { type: "tool_use", id: toolUseId(), name: c.function.name, input: {} } });
        yield ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.function.arguments ?? {}) } });
        yield ev("content_block_stop", { index });
        index++;
        calls++;
      }
    } else if ("done" in p) {
      if (textOpen) {
        yield ev("content_block_stop", { index });
        textOpen = false;
      }
      yield ev("message_delta", { delta: { stop_reason: stopReason(calls, p), stop_sequence: null }, usage: { output_tokens: Math.ceil(outChars / 4) }, ...(p.cSatsSpent !== undefined || p.where ? { edgecoder: { cSatsSpent: p.cSatsSpent, where: p.where } } : {}) });
    }
  }
  yield ev("message_stop", {});
}

/** A whole (non-streamed) reply. */
export async function anthropicResponse(pieces: AsyncIterable<ChatPiece>, model: string) {
  let text = "";
  const calls: ToolCall[] = [];
  let done: Extract<ChatPiece, { done: true }> | undefined;
  for await (const p of pieces) {
    if ("delta" in p) text += p.delta;
    else if ("toolCalls" in p) calls.push(...p.toolCalls);
    else done = p;
  }
  return {
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content: [...(text ? [{ type: "text", text }] : []), ...calls.map((c) => ({ type: "tool_use", id: toolUseId(), name: c.function.name, input: c.function.arguments ?? {} }))],
    stop_reason: stopReason(calls.length, done),
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: Math.ceil(text.length / 4) },
    ...(done?.cSatsSpent !== undefined || done?.where ? { edgecoder: { cSatsSpent: done?.cSatsSpent, where: done?.where } } : {}),
  };
}
