// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The network through the hosted endpoint (https://edgecoder.io/v1, OpenAI API) with the user's own
 * API key, for a computer whose agent isn't enrolled (a server reached over SSH, `edgecoder code`
 * without the desktop app). Requests are billed to the key's account in cSats like the app's.
 *
 * The key is read from EDGECODER_API_KEY or the file EDGECODER_API_KEY_FILE names; it is sent only
 * to the hosted endpoint and never logged.
 */

import { readFileSync } from "node:fs";
import { request } from "undici";
import { ChatBackendError, type ChatBackend, type ChatMessage, type ToolCall } from "../../inference-api/types.js";

export interface HostedConfig {
  /** Origin of the hosted endpoint, without /v1. */
  baseUrl: string;
  apiKey: () => string;
}

/** The hosted endpoint and key from the environment, or null when no key is configured. */
export function hostedConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HostedConfig | null {
  const fromFile = (): string => {
    const file = env.EDGECODER_API_KEY_FILE;
    if (!file) return "";
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return "";
    }
  };
  const key = () => env.EDGECODER_API_KEY?.trim() || fromFile();
  if (!key()) return null;
  // EDGECODER_URL overrides the hosted endpoint (a self-hosted portal).
  const raw = (env.EDGECODER_URL || "https://edgecoder.io").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  // The key goes only to https (or a local test server).
  if (!/^https:\/\//.test(raw) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(raw)) return null;
  return { baseUrl: raw, apiKey: key };
}

/** Ollama-shaped messages as OpenAI wants them: tool results answer the call ids of the reply before them. */
export function toOpenAiMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let pending: Array<{ id: string; name: string }> = [];
  messages.forEach((m, n) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      pending = m.tool_calls.map((c, i) => ({ id: `call_${n}_${i}`, name: c.function.name }));
      out.push({ role: "assistant", content: m.content || null, tool_calls: m.tool_calls.map((c, i) => ({ id: pending[i].id, type: "function", function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } })) });
      return;
    }
    if (m.role === "tool") {
      const i = pending.findIndex((p) => !m.tool_name || p.name === m.tool_name);
      const call = i >= 0 ? pending.splice(i, 1)[0] : null;
      out.push(call ? { role: "tool", tool_call_id: call.id, content: m.content } : { role: "user", content: `[Tool ${m.tool_name ?? ""} result]: ${m.content}` });
      return;
    }
    const images = (m.media ?? []).filter((md) => md.kind === "image");
    if (m.role === "user" && images.length) {
      // OpenAI content parts: the text, then each image as a data URL (PDFs aren't sent here).
      out.push({ role: "user", content: [...(m.content ? [{ type: "text", text: m.content }] : []), ...images.map((md) => ({ type: "image_url", image_url: { url: `data:${md.mediaType};base64,${md.data}` } }))] });
      return;
    }
    out.push({ role: m.role, content: m.content });
  });
  return out;
}

interface OpenAiChunk {
  choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  edgecoder?: { cSatsSpent?: number };
  error?: { message?: string };
}

/** A chat on the hosted endpoint: `model` is a hosted model id (auto, network/<m>[@class], mine/<m>, reserved/<id>/<m>). */
export function hostedBackend(cfg: HostedConfig, model: string): ChatBackend {
  return async function* (req, signal) {
    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(`${cfg.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey()}`, "x-edgecoder-source": "edgecoder code" },
        body: JSON.stringify({
          model,
          stream: true,
          messages: toOpenAiMessages(req.messages),
          ...(req.tools?.length ? { tools: req.tools } : {}),
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          // model "auto": the job hints for the coordinator's best-fit routing (tentacles send them).
          ...(req.hints && Object.keys(req.hints).length ? { edgecoder: req.hints } : {}),
        }),
        headersTimeout: 120_000,
        bodyTimeout: 300_000,
        signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new ChatBackendError(`Couldn't reach ${cfg.baseUrl}: ${(err as Error).message}`, 502);
    }
    if (res.statusCode >= 400) {
      const text = await res.body.text().catch(() => "");
      let message = text.slice(0, 500);
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string };
        message = typeof j.error === "string" ? j.error : j.error?.message ?? message;
      } catch {
        // plain text
      }
      if (res.statusCode === 401) message = "The hosted endpoint refused the API key (EDGECODER_API_KEY). Create a key on the portal under Settings, API keys.";
      throw new ChatBackendError(message || `HTTP ${res.statusCode}`, res.statusCode);
    }
    // Tool calls arrive in pieces per index; their arguments are a JSON string built up across chunks.
    const calls = new Map<number, { name: string; args: string }>();
    let spent: number | undefined;
    let promptTokens: number | undefined;
    let outputTokens: number | undefined;
    let stop: "stop" | "length" = "stop";
    let buffer = "";
    const pieces: Array<{ delta: string }> = [];
    const handle = (line: string) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let chunk: OpenAiChunk;
      try {
        chunk = JSON.parse(data) as OpenAiChunk;
      } catch {
        return;
      }
      if (chunk.error?.message) throw new ChatBackendError(chunk.error.message, 502);
      for (const c of chunk.choices ?? []) {
        if (c.delta?.content) pieces.push({ delta: c.delta.content });
        for (const tc of c.delta?.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const cur = calls.get(i) ?? { name: "", args: "" };
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(i, cur);
        }
        if (c.finish_reason === "length") stop = "length";
      }
      if (chunk.edgecoder?.cSatsSpent !== undefined) spent = chunk.edgecoder.cSatsSpent;
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
    };
    for await (const part of res.body) {
      buffer += Buffer.from(part as Uint8Array).toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handle(line.trim());
      while (pieces.length) yield pieces.shift()!;
    }
    handle(buffer.trim());
    while (pieces.length) yield pieces.shift()!;
    if (calls.size) {
      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, c]) => c.name)
        .map(([, c]) => {
          let args: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(c.args || "{}");
            if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
          } catch {
            // malformed arguments: the tool reports what is missing
          }
          return { function: { name: c.name, arguments: args } };
        });
      if (toolCalls.length) yield { toolCalls };
    }
    yield { done: true, stopReason: stop, ...(spent !== undefined ? { cSatsSpent: spent } : {}), ...(promptTokens !== undefined ? { promptTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
  };
}
