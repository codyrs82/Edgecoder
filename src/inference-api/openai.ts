// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** OpenAI chat completions <-> the internal chat format (types.ts), with tool calls. */

import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatPiece, ChatRequest, ToolCall, ToolSpec } from "./types.js";

/** Text out of OpenAI content: a string, or a list of parts (only text parts are kept). */
export function openAiText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  try {
    const v = JSON.parse(String(raw ?? "{}"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

interface OpenAiBody {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>; tool_call_id?: string; name?: string }>;
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export function fromOpenAi(body: OpenAiBody): ChatRequest {
  const toolNameById = new Map<string, string>();
  const messages: ChatMessage[] = [];
  for (const m of body.messages ?? []) {
    const role = m.role === "developer" ? "system" : m.role;
    if (role === "assistant") {
      const calls: ToolCall[] = (m.tool_calls ?? []).map((c) => {
        const name = String(c.function?.name ?? "");
        if (c.id) toolNameById.set(c.id, name);
        return { function: { name, arguments: parseArgs(c.function?.arguments) } };
      });
      messages.push({ role: "assistant", content: openAiText(m.content), ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (role === "tool" || role === "function") {
      messages.push({ role: "tool", content: openAiText(m.content), tool_name: toolNameById.get(m.tool_call_id ?? "") ?? m.name ?? "" });
    } else if (role === "system") {
      messages.push({ role: "system", content: openAiText(m.content) });
    } else {
      messages.push({ role: "user", content: openAiText(m.content) });
    }
  }
  const tools: ToolSpec[] = (body.tools ?? [])
    .filter((t) => (t.type ?? "function") === "function" && t.function?.name)
    .map((t) => ({ type: "function", function: { name: t.function!.name!, ...(t.function!.description ? { description: t.function!.description } : {}), parameters: t.function!.parameters ?? { type: "object", properties: {} } } }));
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  return { messages, ...(tools.length ? { tools } : {}), ...(maxTokens ? { maxTokens } : {}), ...(body.temperature !== undefined ? { temperature: body.temperature } : {}) };
}

const toOpenAiCalls = (calls: ToolCall[], offset = 0) =>
  calls.map((c, i) => ({ index: offset + i, id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "function" as const, function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } }));

/** SSE lines (each "data: …\n\n") for a streamed reply, ending with [DONE]. */
export async function* openAiStream(pieces: AsyncIterable<ChatPiece>, model: string): AsyncGenerator<string> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  yield chunk({ role: "assistant", content: "" }, null);
  let calls = 0;
  for await (const p of pieces) {
    if ("delta" in p) yield chunk({ content: p.delta }, null);
    else if ("toolCalls" in p) {
      yield chunk({ tool_calls: toOpenAiCalls(p.toolCalls, calls) }, null);
      calls += p.toolCalls.length;
    } else if ("done" in p) {
      yield chunk({}, calls ? "tool_calls" : p.stopReason === "length" ? "length" : "stop", p.cSatsSpent !== undefined || p.where ? { edgecoder: { cSatsSpent: p.cSatsSpent, where: p.where } } : {});
    }
  }
  yield "data: [DONE]\n\n";
}

/** A whole (non-streamed) reply. */
export async function openAiResponse(pieces: AsyncIterable<ChatPiece>, model: string) {
  let text = "";
  const calls: ToolCall[] = [];
  let done: Extract<ChatPiece, { done: true }> | undefined;
  for await (const p of pieces) {
    if ("delta" in p) text += p.delta;
    else if ("toolCalls" in p) calls.push(...p.toolCalls);
    else done = p;
  }
  const toolCalls = toOpenAiCalls(calls).map(({ index: _i, ...c }) => c);
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text || (calls.length ? null : ""), ...(calls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: calls.length ? "tool_calls" : done?.stopReason === "length" ? "length" : "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: Math.ceil(text.length / 4), total_tokens: Math.ceil(text.length / 4) },
    ...(done?.cSatsSpent !== undefined || done?.where ? { edgecoder: { cSatsSpent: done?.cSatsSpent, where: done?.where } } : {}),
  };
}
