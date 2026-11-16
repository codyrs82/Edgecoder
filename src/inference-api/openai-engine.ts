// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Local OpenAI-compatible inference engines: vLLM (datacenter NVIDIA GPUs) and MLX (`mlx_lm.server`,
 * Apple silicon), next to the default Ollama (src/inference-api/ollama.ts).
 *
 * Both serve `GET /v1/models` and `POST /v1/chat/completions` (streamed as server-sent events,
 * with OpenAI tool calls). The agent never starts, stops or pulls models into them: the engine is
 * started on its own (a systemd unit for vLLM, docs/inference-engines.md), loads its model at
 * start, and the agent only checks that it is up and serving the configured model.
 *
 * What differs per engine (ENGINE_PRESETS):
 * - vLLM reports the served context length (`max_model_len` in /v1/models) and its KV-cache size
 *   (`vllm:cache_config_info` in /metrics), and batches calls (continuous batching, paged
 *   attention), so one agent serves several calls at once.
 * - mlx_lm.server reports neither (its /v1/models lists every MLX model in the Hugging Face cache,
 *   loaded or not), and batches only since mlx-lm 0.28.4 (and only calls without a `seed`), so it
 *   defaults to one slot.
 *
 * Every piece this yields has the shape ollamaChat yields (OllamaPiece), so the inference runner,
 * the benchmark and billing do not care which engine ran the call.
 */

import { request } from "undici";
import type { OllamaPiece } from "./ollama.js";
import type { ChatMessage, ToolCall, ToolSpec } from "./types.js";

export type InferenceEngineKind = "ollama" | "vllm" | "mlx";
export type OpenAiEnginePreset = Exclude<InferenceEngineKind, "ollama">;

export interface EnginePresetSpec {
  label: string;
  defaultUrl: string;
  /** Env names of the URL, slot count and model id for this engine. */
  urlEnv: string;
  slotsEnv: string;
  modelEnv: string;
  /** Slots when none is configured: "derive" = from the engine's KV-cache size (vLLM). */
  defaultSlots: number | "derive";
  /** /v1/models carries max_model_len. */
  reportsContextLength: boolean;
  /** /v1/models lists models that are not loaded (mlx: the whole HF cache), so the configured model matters. */
  listsUnloadedModels: boolean;
}

export const ENGINE_PRESETS: Record<OpenAiEnginePreset, EnginePresetSpec> = {
  vllm: { label: "vLLM", defaultUrl: "http://127.0.0.1:8000", urlEnv: "VLLM_URL", slotsEnv: "VLLM_MAX_SLOTS", modelEnv: "VLLM_MODEL", defaultSlots: "derive", reportsContextLength: true, listsUnloadedModels: false },
  mlx: { label: "MLX", defaultUrl: "http://127.0.0.1:8080", urlEnv: "MLX_URL", slotsEnv: "MLX_MAX_SLOTS", modelEnv: "MLX_MODEL", defaultSlots: 1, reportsContextLength: false, listsUnloadedModels: true }
};

/** An OpenAI-compatible engine the agent talks to. */
export interface OpenAiEngine {
  preset: OpenAiEnginePreset;
  url: string;
  /** vLLM `--api-key` (sent as a bearer token); unset = none. */
  apiKey?: string;
}

export type EngineConfig =
  | { kind: "ollama" }
  | (OpenAiEngine & {
      kind: OpenAiEnginePreset;
      /** VLLM_MAX_SLOTS / MLX_MAX_SLOTS (1-16), when set. */
      maxSlots?: number;
      /** VLLM_MODEL / MLX_MODEL: the served model id the agent must find; unset = the first catalog model served. */
      model?: string;
    });

/**
 * The engine from the agent's env: EDGECODER_ENGINE (ollama | vllm | mlx; default ollama), then
 * the preset's URL / slots / model variables. Throws on an unknown engine or a bad slot count, so
 * a typo does not silently fall back to Ollama.
 */
export function resolveEngine(env: Record<string, string | undefined>): EngineConfig {
  const raw = (env.EDGECODER_ENGINE ?? "").trim().toLowerCase();
  if (!raw || raw === "ollama") return { kind: "ollama" };
  if (raw !== "vllm" && raw !== "mlx") throw new Error(`EDGECODER_ENGINE must be ollama, vllm or mlx (got "${raw}")`);
  const spec = ENGINE_PRESETS[raw];
  const url = (env[spec.urlEnv]?.trim() || spec.defaultUrl).replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new Error(`${spec.urlEnv} must be an http(s) URL`);
  const slotsRaw = env[spec.slotsEnv]?.trim();
  let maxSlots: number | undefined;
  if (slotsRaw) {
    maxSlots = Number(slotsRaw);
    if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > 16) throw new Error(`${spec.slotsEnv} must be an integer from 1 to 16`);
  }
  const model = env[spec.modelEnv]?.trim() || undefined;
  const apiKey = raw === "vllm" ? env.VLLM_API_KEY?.trim() || undefined : undefined;
  return { kind: raw, preset: raw, url, ...(apiKey ? { apiKey } : {}), ...(maxSlots !== undefined ? { maxSlots } : {}), ...(model ? { model } : {}) };
}

function headers(engine: OpenAiEngine): Record<string, string> {
  return { "content-type": "application/json", ...(engine.apiKey ? { authorization: `Bearer ${engine.apiKey}` } : {}) };
}

/** An HTTP or stream error from the engine. `contextOverflow`: the call is longer than the served context. */
export class EngineError extends Error {
  constructor(message: string, readonly status: number, readonly contextOverflow = false) {
    super(message);
  }
}

/** vLLM: "This model's maximum context length is 65536 tokens. However, you requested …"; also newer wordings. */
export function isContextOverflowMessage(msg: string): boolean {
  return /maximum context length|context length|max_model_len|prompt is too long|too many tokens|exceeds the (model'?s )?(maximum|context)|input tokens? .*exceed/i.test(msg);
}

function errorText(body: string): string {
  try {
    const j = JSON.parse(body) as { message?: unknown; error?: unknown; detail?: unknown };
    if (typeof j.message === "string") return j.message;
    if (typeof j.error === "string") return j.error;
    if (j.error && typeof j.error === "object" && typeof (j.error as { message?: unknown }).message === "string") return (j.error as { message: string }).message;
    if (typeof j.detail === "string") return j.detail;
    if (j.detail !== undefined) return JSON.stringify(j.detail).slice(0, 500);
  } catch {
    // plain text
  }
  return body.slice(0, 500);
}

function engineError(engine: OpenAiEngine, status: number, body: string): EngineError {
  const msg = errorText(body) || `HTTP ${status}`;
  return new EngineError(`${ENGINE_PRESETS[engine.preset].label}: ${msg}`, status, status === 400 || status === 413 ? isContextOverflowMessage(msg) : false);
}

export interface EngineModel {
  id: string;
  /** vLLM's max_model_len (the served context length). */
  maxModelLen?: number;
}

/** GET /v1/models. Throws when the engine cannot be reached or answers an error. */
export async function listEngineModels(engine: OpenAiEngine, timeoutMs = 5_000): Promise<EngineModel[]> {
  const res = await request(`${engine.url}/v1/models`, { method: "GET", headers: headers(engine), headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) throw engineError(engine, res.statusCode, text);
  const body = JSON.parse(text) as { data?: Array<{ id?: unknown; max_model_len?: unknown }> };
  return (body.data ?? [])
    .filter((m) => typeof m.id === "string" && m.id)
    .map((m) => ({ id: m.id as string, ...(typeof m.max_model_len === "number" && m.max_model_len > 0 ? { maxModelLen: Math.floor(m.max_model_len) } : {}) }))
    .slice(0, 200);
}

/**
 * vLLM's KV-cache size in tokens (num_gpu_blocks × block_size from the `vllm:cache_config_info`
 * metric), or undefined when /metrics does not say (an older vLLM, metrics off, MLX).
 */
export async function engineKvCacheTokens(engine: OpenAiEngine, timeoutMs = 5_000): Promise<number | undefined> {
  if (engine.preset !== "vllm") return undefined;
  try {
    const res = await request(`${engine.url}/metrics`, { method: "GET", headers: headers(engine), headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) return undefined;
    return kvTokensFromMetrics(text);
  } catch {
    return undefined;
  }
}

/** Parse num_gpu_blocks × block_size out of vLLM's Prometheus text. */
export function kvTokensFromMetrics(text: string): number | undefined {
  const line = text.split("\n").find((l) => l.startsWith("vllm:cache_config_info{"));
  if (!line) return undefined;
  const label = (k: string) => Number(new RegExp(`[{,]${k}="(\\d+)"`).exec(line)?.[1]);
  const blocks = label("num_gpu_blocks");
  const size = label("block_size");
  return Number.isFinite(blocks) && Number.isFinite(size) && blocks > 0 && size > 0 ? blocks * size : undefined;
}

/**
 * The internal chat format (Ollama's) as OpenAI messages: assistant tool calls get ids, and each
 * tool result answers the earliest unanswered call of the same name (else the earliest
 * unanswered call), which is how the internal format pairs them.
 */
export function toOpenAiMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const open: Array<{ id: string; name: string }> = [];
  let n = 0;
  return messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c) => {
        const id = `call_${n++}`;
        open.push({ id, name: c.function.name });
        return { id, type: "function", function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } };
      });
      return { role: "assistant", content: m.content || null, tool_calls: calls };
    }
    if (m.role === "tool") {
      const i = Math.max(0, open.findIndex((c) => c.name === m.tool_name));
      const call = open.splice(i, 1)[0];
      return { role: "tool", content: m.content, tool_call_id: call?.id ?? `call_${n++}`, ...(m.tool_name ? { name: m.tool_name } : {}) };
    }
    return { role: m.role, content: m.content };
  });
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    // A model that wrote broken JSON: keep what it wrote, so the caller can see it.
    return { _raw: raw };
  }
}

export interface EngineChatRequest {
  /** The served model id (not the catalog tag). */
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  /** Only for reproducible runs (the benchmark): mlx_lm.server does not batch a call with a seed. */
  seed?: number;
}

type SseChunk = {
  choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: unknown;
  message?: unknown;
};

/**
 * Stream a chat completion. Yields text pieces as they come, the tool calls (once complete, before
 * the end), then the end with the token counts (`usage`, requested with stream_options) and the
 * timings: promptMs from the request to the first generated piece, genMs from there to the end.
 */
export async function* openAiEngineChat(engine: OpenAiEngine, req: EngineChatRequest, signal?: AbortSignal, timeoutMs = 120_000): AsyncGenerator<OllamaPiece> {
  const started = Date.now();
  const res = await request(`${engine.url}/v1/chat/completions`, {
    method: "POST",
    headers: headers(engine),
    body: JSON.stringify({
      model: req.model,
      messages: toOpenAiMessages(req.messages),
      ...(req.tools?.length ? { tools: req.tools } : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      // Ollama's think:false: hybrid-thinking models (Qwen3 / Qwen3.5) answer without a reasoning pass.
      chat_template_kwargs: { enable_thinking: false }
    }),
    signal,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  });
  if (res.statusCode < 200 || res.statusCode >= 300) throw engineError(engine, res.statusCode, await res.body.text());

  const calls = new Map<number, { name: string; args: string }>();
  let finish: string | undefined;
  let usage: { promptTokens?: number; outputTokens?: number } = {};
  let firstAt: number | undefined;
  let buf = "";
  let ended = false;
  const handle = function* (data: string): Generator<OllamaPiece> {
    if (data === "[DONE]") {
      ended = true;
      return;
    }
    let chunk: SseChunk;
    try {
      chunk = JSON.parse(data) as SseChunk;
    } catch {
      return;
    }
    if (chunk.error !== undefined || (chunk.message !== undefined && !chunk.choices)) {
      const msg = errorText(data);
      throw new EngineError(`${ENGINE_PRESETS[engine.preset].label}: ${msg}`, 500, isContextOverflowMessage(msg));
    }
    for (const c of chunk.choices ?? []) {
      const text = c.delta?.content;
      if (text) {
        firstAt ??= Date.now();
        yield { delta: text };
      }
      for (const t of c.delta?.tool_calls ?? []) {
        firstAt ??= Date.now();
        const i = t.index ?? calls.size;
        const cur = calls.get(i) ?? { name: "", args: "" };
        if (t.function?.name) cur.name += t.function.name;
        if (t.function?.arguments) cur.args += t.function.arguments;
        calls.set(i, cur);
      }
      if (c.finish_reason) finish = c.finish_reason;
    }
    if (chunk.usage) {
      usage = {
        ...(typeof chunk.usage.prompt_tokens === "number" ? { promptTokens: chunk.usage.prompt_tokens } : {}),
        ...(typeof chunk.usage.completion_tokens === "number" ? { outputTokens: chunk.usage.completion_tokens } : {})
      };
    }
  };
  for await (const part of res.body) {
    buf += Buffer.from(part as Uint8Array).toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      yield* handle(l.slice(5).trim());
    }
    if (ended) break;
  }
  if (!ended && buf.trim().startsWith("data:")) yield* handle(buf.trim().slice(5).trim());
  const toolCalls: ToolCall[] = [...calls.entries()].sort((a, b) => a[0] - b[0]).filter(([, c]) => c.name).map(([, c]) => ({ function: { name: c.name, arguments: parseArgs(c.args) } }));
  if (toolCalls.length) yield { toolCalls };
  const end = Date.now();
  yield {
    doneReason: finish === "length" ? "length" : "stop",
    ...usage,
    ...(firstAt !== undefined ? { promptMs: firstAt - started, genMs: Math.max(0, end - firstAt) } : {})
  };
}

export interface EngineGeneration {
  response: string;
  /** Generated tokens (the engine's usage count, else the number of streamed pieces). */
  evalCount?: number;
  /** Decode time: first to last generated piece, scaled up by one token's share. */
  evalDurationMs?: number;
}

/**
 * One greedy (temperature 0, fixed seed) generation for the GPU benchmark and challenges, timed
 * like Ollama's eval_duration: decoding only, without the prompt.
 */
export async function engineGenerate(engine: OpenAiEngine, input: { model: string; prompt: string; seed: number; maxTokens: number; timeoutMs: number }): Promise<EngineGeneration> {
  let response = "";
  let pieces = 0;
  let first: number | undefined;
  let last: number | undefined;
  let outputTokens: number | undefined;
  for await (const p of openAiEngineChat(engine, { model: input.model, messages: [{ role: "user", content: input.prompt }], maxTokens: input.maxTokens, temperature: 0, seed: input.seed }, undefined, input.timeoutMs)) {
    if ("delta" in p) {
      const now = Date.now();
      first ??= now;
      last = now;
      pieces++;
      response += p.delta;
    } else if ("doneReason" in p) outputTokens = p.outputTokens;
  }
  const count = outputTokens !== undefined && outputTokens > 0 ? outputTokens : pieces;
  const span = first !== undefined && last !== undefined ? last - first : 0;
  return {
    response,
    ...(count > 0 ? { evalCount: count } : {}),
    ...(span > 0 && pieces > 1 ? { evalDurationMs: (span * pieces) / (pieces - 1) } : {})
  };
}
