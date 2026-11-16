// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * frontierBackend: a chat backend on the user's own frontier key (docs/frontier-keys.md), next to
 * localBackend and networkBackend (backends.ts). Calls go from this computer straight to the
 * provider's HTTPS API; the provider bills the user, EdgeCoder charges no cSats and keeps only a
 * local spend estimate (frontier-usage.ts).
 *
 * Two wire formats:
 *   - Anthropic Messages API (`POST /v1/messages`, streamed): text, tool use, thinking blocks
 *     (passed back unchanged within a turn's tool loop), refusals, prompt caching.
 *   - OpenAI-compatible Chat Completions (`POST <base>/chat/completions`, streamed), which covers
 *     OpenAI and most other providers.
 * Raw HTTP through undici on purpose: the project carries no provider SDK.
 *
 * Only the IDE provider process (src/apps/ide/provider-server.ts) builds this backend. The agent
 * that runs network work never imports it, and the coordinator refuses frontier ids
 * (frontier-models.ts isFrontierModelId).
 *
 * The key is read per call from the OS credential store and never logged, echoed in an error or
 * put in an event: provider error text is passed through redactApiKeys first.
 */

import { randomUUID } from "node:crypto";
import { request } from "undici";
import { redactApiKeys } from "../common/redaction.js";
import { toOpenAiMessages } from "../apps/ide/hosted-backend.js";
import { ANTHROPIC_DEFAULT_BASE, OPENAI_DEFAULT_BASE, type Effort, type FrontierProvider } from "./frontier-keys.js";
import { estimateCostUsd, priceFor, type Price } from "./frontier-models.js";
import type { Caps, FrontierSpend } from "./frontier-usage.js";
import { ChatBackendError, type ChatBackend, type ChatMessage, type ChatPiece, type ToolCall } from "./types.js";
import type { ServedBy } from "../swarm/served-by.js";

/**
 * Where a frontier call ran, in the same shape as a network call's served-by, so footers and the
 * terminal's usage line show it: "Anthropic · your key", the tokens, the time, and the estimated USD.
 */
export function frontierServed(providerLabel: string, t: { promptTokens: number; outputTokens: number; genMs?: number; usd: number }): ServedBy {
  return {
    label: `${providerLabel} (your key)`,
    own: true,
    computeClass: "frontier",
    tier: null,
    hardware: `${providerLabel} · your key`,
    region: null,
    country: null,
    promptTokens: t.promptTokens,
    outputTokens: t.outputTokens,
    ...(t.genMs !== undefined ? { genMs: Math.round(t.genMs) } : {}),
    usd: t.usd,
  };
}

export const ANTHROPIC_VERSION = "2023-06-01";
/** Server-side refusal fallback ("default" routes by refusal category). */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const EFFORT_MODELS = /^claude-(?:(?:fable|mythos|opus|sonnet|haiku)-5|opus-4-[5-8]|sonnet-4-6)/;

export interface FrontierTarget {
  provider: Pick<FrontierProvider, "id" | "kind" | "baseUrl">;
  model: string;
  /** Read from the credential store per call. */
  apiKey: () => Promise<string>;
  effort?: Effort;
  prices?: Record<string, Price>;
  /** Default 64000 (the reply streams, so a large cap costs nothing unless used). */
  maxTokens?: number;
  /** Retries on 429 / 5xx / overloaded before anything was streamed (default 4). */
  maxRetries?: number;
  /** First backoff (default 1000 ms), doubled each time, with jitter; Retry-After wins when longer. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Retryable = ChatBackendError & { retryable?: boolean };

function retryable(message: string, status: number, retryAfterSec?: number): Retryable {
  const e = new ChatBackendError(message, status, retryAfterSec) as Retryable;
  e.retryable = true;
  return e;
}

function providerName(t: FrontierTarget): string {
  return t.provider.kind === "anthropic" ? "Anthropic" : t.provider.id === "openai" ? "OpenAI" : t.provider.id;
}

/** A provider's error reply as a clear, key-free message. */
function httpError(t: FrontierTarget, status: number, text: string, retryAfterSec?: number): ChatBackendError {
  const name = providerName(t);
  let message = text.slice(0, 500);
  try {
    const j = JSON.parse(text) as { error?: { message?: string; type?: string } | string; message?: string };
    message = typeof j.error === "string" ? j.error : j.error?.message ?? j.message ?? message;
  } catch {
    // plain text
  }
  message = redactApiKeys(message);
  if (status === 401 || status === 403) {
    return new ChatBackendError(`${name} rejected your API key (HTTP ${status}). Check or replace it in Settings → Frontier models (or \`edgecoder keys add ${t.provider.id}\`).`, 401);
  }
  if (status === 404) return new ChatBackendError(`${name} doesn't know the model ${t.model}: ${message}`, 404);
  if (status === 429) return retryable(`${name} is rate-limiting your key: ${message}`, 429, retryAfterSec);
  if (status >= 500) return retryable(`${name} had a server error (HTTP ${status}): ${message}`, 502, retryAfterSec);
  return new ChatBackendError(`${name} refused the request (HTTP ${status}): ${message}`, status);
}

function retryAfter(headers: Record<string, string | string[] | undefined>): number | undefined {
  const v = headers["retry-after"];
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 120) : undefined;
}

async function post(t: FrontierTarget, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), headersTimeout: 300_000, bodyTimeout: 600_000, signal });
  } catch (err) {
    if ((err as Error).name === "AbortError" || signal?.aborted) throw err;
    throw retryable(`Couldn't reach ${providerName(t)}: ${redactApiKeys((err as Error).message)}`, 502);
  }
  if (res.statusCode >= 400) {
    const text = await res.body.text().catch(() => "");
    throw httpError(t, res.statusCode, text, retryAfter(res.headers));
  }
  return res;
}

/** SSE `data:` payloads of a streamed body, as they arrive. */
async function* sseData(body: AsyncIterable<unknown>): AsyncGenerator<string> {
  let buffer = "";
  for await (const part of body) {
    buffer += Buffer.from(part as Uint8Array).toString("utf8");
    let cut: number;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut).replace(/\r$/, "");
      buffer = buffer.slice(cut + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  if (buffer.startsWith("data:")) yield buffer.slice(5).trim();
}

/**
 * Run `attempt` with retries on retryable errors, as long as it has not yielded anything yet (a
 * reply that has started streaming is never repeated).
 */
async function* withRetries(t: FrontierTarget, attempt: () => AsyncGenerator<ChatPiece>, signal?: AbortSignal): AsyncGenerator<ChatPiece> {
  const max = t.maxRetries ?? 4;
  const sleep = t.sleep ?? defaultSleep;
  for (let n = 0; ; n++) {
    let yielded = false;
    try {
      for await (const p of attempt()) {
        yielded = true;
        yield p;
      }
      return;
    } catch (err) {
      const e = err as Retryable;
      if (yielded || !e.retryable || n >= max || signal?.aborted) throw err;
      const backoff = (t.baseDelayMs ?? 1000) * 2 ** n * (0.8 + Math.random() * 0.4);
      await sleep(Math.max(backoff, (e.retryAfterSec ?? 0) * 1000));
    }
  }
}

// --- Anthropic Messages API ---

type Block = Record<string, unknown> & { type: string };

/** The fingerprint of an assistant turn as the agent loop keeps it (text + tool calls). */
export function turnFingerprint(content: string, calls: ToolCall[] | undefined): string {
  return JSON.stringify([content, (calls ?? []).map((c) => [c.function.name, c.function.arguments ?? {}])]);
}

const toolUseId = () => `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

/**
 * The internal conversation as Messages API `system` + `messages`. Assistant turns this backend
 * produced earlier in the same turn are sent back exactly as received (thinking blocks and tool_use
 * ids included), which the API requires within a tool-use loop; tool results answer those ids.
 */
export function toAnthropicMessages(messages: ChatMessage[], raw: Map<string, Block[]> = new Map()): { system: string; messages: Array<{ role: "user" | "assistant"; content: Block[] }> } {
  const system: string[] = [];
  const out: Array<{ role: "user" | "assistant"; content: Block[] }> = [];
  let pending: Array<{ id: string; name: string }> = [];
  const userBlocks = (): Block[] => {
    const last = out[out.length - 1];
    if (last?.role === "user") return last.content;
    const fresh: Block[] = [];
    out.push({ role: "user", content: fresh });
    return fresh;
  };
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content.trim()) system.push(m.content);
      continue;
    }
    if (m.role === "assistant") {
      const kept = raw.get(turnFingerprint(m.content, m.tool_calls));
      let content: Block[];
      if (kept) {
        content = kept;
      } else {
        content = [
          ...(m.content.trim() ? [{ type: "text", text: m.content }] : []),
          ...(m.tool_calls ?? []).map((c) => ({ type: "tool_use", id: toolUseId(), name: c.function.name, input: c.function.arguments ?? {} })),
        ];
      }
      pending = content.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), name: String(b.name) }));
      if (content.length) out.push({ role: "assistant", content });
      continue;
    }
    if (m.role === "tool") {
      const i = pending.findIndex((p) => !m.tool_name || p.name === m.tool_name);
      const call = i >= 0 ? pending.splice(i, 1)[0] : null;
      const blocks = userBlocks();
      if (call) {
        // tool_result blocks go first in the user turn.
        const firstText = blocks.findIndex((b) => b.type !== "tool_result");
        const block: Block = { type: "tool_result", tool_use_id: call.id, content: m.content || "(no output)", ...(/^\[(Error|Rejected)\]/.test(m.content) ? { is_error: true } : {}) };
        if (firstText < 0) blocks.push(block);
        else blocks.splice(firstText, 0, block);
      } else {
        blocks.push({ type: "text", text: `[Tool ${m.tool_name ?? ""} result]: ${m.content}` });
      }
      continue;
    }
    if (m.content.trim()) userBlocks().push({ type: "text", text: m.content });
  }
  // A tool_use left without its result (cancelled turn) would be rejected: answer it.
  if (pending.length) {
    const blocks = userBlocks();
    for (const p of pending) blocks.unshift({ type: "tool_result", tool_use_id: p.id, content: "(not run)", is_error: true });
  }
  if (!out.length || out[0].role !== "user") out.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  return { system: system.join("\n\n"), messages: out };
}

interface AnthropicEvent {
  type: string;
  index?: number;
  message?: { model?: string; usage?: Record<string, number> };
  content_block?: Block;
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; stop_reason?: string; stop_details?: { category?: string | null; explanation?: string } };
  usage?: Record<string, number>;
  error?: { type?: string; message?: string };
}

/** What to send back next time: unchanged blocks, minus a mid-output fallback's discarded part. */
function echoBlocks(blocks: Block[]): Block[] {
  const lastFallback = blocks.map((b) => b.type).lastIndexOf("fallback");
  return blocks.filter((b, i) => {
    if (b.type === "fallback") return false;
    if (i < lastFallback && (b.type === "thinking" || b.type === "redacted_thinking" || b.type === "tool_use")) return false;
    if (b.type === "text" && !String(b.text ?? "")) return false;
    return true;
  });
}

function anthropicBackend(t: FrontierTarget): ChatBackend {
  // Within one turn's tool loop: the raw assistant content of each reply, by fingerprint (bounded).
  const raw = new Map<string, Block[]>();
  const base = (t.provider.baseUrl || ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, "").replace(/\/v1$/, "");
  return (req, signal) =>
    withRetries(
      t,
      async function* () {
        const key = await t.apiKey();
        const started = Date.now();
        const { system, messages } = toAnthropicMessages(req.messages, raw);
        const fallback = FALLBACK_MODELS.has(t.model);
        const body = {
          model: t.model,
          max_tokens: req.maxTokens ?? t.maxTokens ?? 64_000,
          stream: true,
          ...(system ? { system } : {}),
          messages,
          ...(req.tools?.length ? { tools: req.tools.map((x) => ({ name: x.function.name, ...(x.function.description ? { description: x.function.description } : {}), input_schema: x.function.parameters ?? { type: "object", properties: {} } })) } : {}),
          ...(t.effort && EFFORT_MODELS.test(t.model) ? { output_config: { effort: t.effort } } : {}),
          // Automatic prompt caching: the agent loop resends the whole conversation every step.
          cache_control: { type: "ephemeral" },
          ...(fallback ? { fallbacks: "default" } : {}),
        };
        const res = await post(t, `${base}/v1/messages`, { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, ...(fallback ? { "anthropic-beta": FALLBACK_BETA } : {}) }, body, signal);
        const blocks: Block[] = [];
        const json = new Map<number, string>();
        let served = t.model;
        const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
        let stop = "end_turn";
        let refusal: { category?: string | null } | null = null;
        let text = "";
        const takeUsage = (u: Record<string, number> | undefined) => {
          if (!u) return;
          if (typeof u.input_tokens === "number") usage.input = u.input_tokens;
          if (typeof u.output_tokens === "number") usage.output = u.output_tokens;
          if (typeof u.cache_creation_input_tokens === "number") usage.cacheWrite = u.cache_creation_input_tokens;
          if (typeof u.cache_read_input_tokens === "number") usage.cacheRead = u.cache_read_input_tokens;
        };
        for await (const data of sseData(res.body)) {
          let ev: AnthropicEvent;
          try {
            ev = JSON.parse(data) as AnthropicEvent;
          } catch {
            continue;
          }
          if (ev.type === "message_start") {
            if (ev.message?.model) served = ev.message.model;
            takeUsage(ev.message?.usage);
          } else if (ev.type === "content_block_start" && ev.content_block && ev.index !== undefined) {
            const b = { ...ev.content_block };
            if (b.type === "tool_use") json.set(ev.index, "");
            if (b.type === "text" && b.text) {
              text += String(b.text);
              yield { delta: String(b.text) };
            }
            blocks[ev.index] = b;
          } else if (ev.type === "content_block_delta" && ev.index !== undefined && ev.delta) {
            const b = blocks[ev.index];
            if (!b) continue;
            if (ev.delta.type === "text_delta" && ev.delta.text) {
              b.text = String(b.text ?? "") + ev.delta.text;
              text += ev.delta.text;
              yield { delta: ev.delta.text };
            } else if (ev.delta.type === "input_json_delta") {
              json.set(ev.index, (json.get(ev.index) ?? "") + (ev.delta.partial_json ?? ""));
            } else if (ev.delta.type === "thinking_delta") {
              b.thinking = String(b.thinking ?? "") + (ev.delta.thinking ?? "");
            } else if (ev.delta.type === "signature_delta") {
              b.signature = String(b.signature ?? "") + (ev.delta.signature ?? "");
            }
          } else if (ev.type === "message_delta") {
            if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
            if (ev.delta?.stop_reason === "refusal") refusal = ev.delta.stop_details ?? {};
            takeUsage(ev.usage);
          } else if (ev.type === "error") {
            const kind = ev.error?.type ?? "error";
            const msg = redactApiKeys(ev.error?.message ?? kind);
            if (kind === "overloaded_error" || kind === "api_error" || kind === "rate_limit_error") throw retryable(`Anthropic: ${msg}`, kind === "rate_limit_error" ? 429 : 503);
            throw new ChatBackendError(`Anthropic: ${msg}`, 502);
          }
        }
        // Tool calls: strictly parsed, and never run from a reply that was cut off or declined.
        const calls: ToolCall[] = [];
        let bad = false;
        blocks.forEach((b, i) => {
          if (b?.type !== "tool_use") return;
          try {
            const input = JSON.parse(json.get(i) || "{}") as unknown;
            b.input = input && typeof input === "object" ? input : {};
            calls.push({ function: { name: String(b.name), arguments: b.input as Record<string, unknown> } });
          } catch {
            bad = true;
          }
        });
        let note = "";
        if (refusal) note = `\n\n(${served} declined this request${refusal.category ? ` [${refusal.category}]` : ""}. Rephrase it, or switch the lead to another model.)`;
        else if (stop === "max_tokens" && (calls.length || bad)) note = "\n\n(The reply hit the output limit in the middle of a tool call, so it wasn't run. Ask for smaller steps.)";
        else if (bad) note = "\n\n(The model sent a tool call that couldn't be read, so it wasn't run.)";
        const runCalls = note ? [] : calls;
        if (note) {
          text += note;
          yield { delta: note };
        }
        if (runCalls.length) {
          if (raw.size > 64) raw.delete(raw.keys().next().value as string);
          raw.set(turnFingerprint(text, runCalls), echoBlocks(blocks.filter(Boolean)));
          yield { toolCalls: runCalls };
        }
        const { price } = priceFor(t.provider.id, served, t.prices);
        const usd = estimateCostUsd({ inputTokens: usage.input, outputTokens: usage.output, cacheWriteTokens: usage.cacheWrite, cacheReadTokens: usage.cacheRead }, price);
        const promptTokens = usage.input + usage.cacheWrite + usage.cacheRead;
        yield { done: true, cSatsSpent: 0, stopReason: stop === "max_tokens" ? "length" : "stop", promptTokens, outputTokens: usage.output, usd, servedBy: served, served: frontierServed(providerName(t), { promptTokens, outputTokens: usage.output, genMs: Date.now() - started, usd }) };
      },
      signal,
    );
}

// --- OpenAI-compatible Chat Completions ---

interface OpenAiChunk {
  model?: string;
  choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string; type?: string };
}

function openAiBackend(t: FrontierTarget): ChatBackend {
  const base = (t.provider.baseUrl || OPENAI_DEFAULT_BASE).replace(/\/+$/, "");
  let streamOptions = true;
  return (req, signal) =>
    withRetries(
      t,
      async function* () {
        const key = await t.apiKey();
        const started = Date.now();
        const body = {
          model: t.model,
          stream: true,
          ...(streamOptions ? { stream_options: { include_usage: true } } : {}),
          messages: toOpenAiMessages(req.messages),
          ...(req.tools?.length ? { tools: req.tools } : {}),
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        };
        let res;
        try {
          res = await post(t, `${base}/chat/completions`, { authorization: `Bearer ${key}` }, body, signal);
        } catch (err) {
          // Some compatible servers don't take stream_options: once, without it.
          if (streamOptions && err instanceof ChatBackendError && err.status === 400 && /stream_options/i.test(err.message)) {
            streamOptions = false;
            throw retryable(err.message, 400);
          }
          throw err;
        }
        const calls = new Map<number, { name: string; args: string }>();
        let served = t.model;
        let stop: "stop" | "length" = "stop";
        let usage = { input: 0, output: 0, cached: 0 };
        for await (const data of sseData(res.body)) {
          if (!data || data === "[DONE]") continue;
          let chunk: OpenAiChunk;
          try {
            chunk = JSON.parse(data) as OpenAiChunk;
          } catch {
            continue;
          }
          if (chunk.error?.message) {
            const msg = redactApiKeys(chunk.error.message);
            if (/overload|rate|capacity|timeout/i.test(msg)) throw retryable(`${providerName(t)}: ${msg}`, 503);
            throw new ChatBackendError(`${providerName(t)}: ${msg}`, 502);
          }
          if (chunk.model) served = chunk.model;
          for (const c of chunk.choices ?? []) {
            if (c.delta?.content) yield { delta: c.delta.content };
            for (const tc of c.delta?.tool_calls ?? []) {
              const i = tc.index ?? 0;
              const cur = calls.get(i) ?? { name: "", args: "" };
              if (tc.function?.name) cur.name += tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
              calls.set(i, cur);
            }
            if (c.finish_reason === "length") stop = "length";
          }
          if (chunk.usage) {
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
            usage = { input: Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached), output: chunk.usage.completion_tokens ?? 0, cached };
          }
        }
        const toolCalls: ToolCall[] = [];
        let bad = false;
        for (const [, c] of [...calls.entries()].sort(([a], [b]) => a - b)) {
          if (!c.name) continue;
          try {
            const parsed = JSON.parse(c.args || "{}") as unknown;
            toolCalls.push({ function: { name: c.name, arguments: (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown> } });
          } catch {
            bad = true;
          }
        }
        if (stop === "length" && (toolCalls.length || bad)) {
          yield { delta: "\n\n(The reply hit the output limit in the middle of a tool call, so it wasn't run. Ask for smaller steps.)" };
        } else if (bad) {
          yield { delta: "\n\n(The model sent a tool call that couldn't be read, so it wasn't run.)" };
        } else if (toolCalls.length) {
          yield { toolCalls };
        }
        const { price } = priceFor(t.provider.id, t.model, t.prices);
        const usd = estimateCostUsd({ inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cached }, { ...price, cacheRead: price.cacheRead ?? price.input * 0.5 });
        yield { done: true, cSatsSpent: 0, stopReason: stop, promptTokens: usage.input + usage.cached, outputTokens: usage.output, usd, servedBy: served, served: frontierServed(providerName(t), { promptTokens: usage.input + usage.cached, outputTokens: usage.output, genMs: Date.now() - started, usd }) };
      },
      signal,
    );
}

/** A backend on the user's own key for `frontier/<provider>/<model>`. */
export function frontierBackend(t: FrontierTarget): ChatBackend {
  return t.provider.kind === "anthropic" ? anthropicBackend(t) : openAiBackend(t);
}

/**
 * Spend controls around a frontier backend: refuse the call at 100% of the session or daily cap
 * (nothing is sent), warn once at 80%, and record each call's estimated cost.
 */
export function withSpendControls(
  backend: ChatBackend,
  o: { spend: FrontierSpend; sessionKey: string; model: string; caps: () => Caps; onWarn?: (message: string) => void; onCost?: (usd: number, totals: { sessionUsd: number; dayUsd: number }) => void },
): ChatBackend {
  return async function* (req, signal) {
    const c = o.spend.check(o.sessionKey, o.caps());
    if (c.state === "stop") throw new ChatBackendError(c.message!, 402);
    if (c.state === "warn") o.onWarn?.(c.message!);
    for await (const p of backend(req, signal)) {
      if ("done" in p && typeof p.usd === "number") {
        const totals = o.spend.record(o.sessionKey, o.model, p.usd, { inputTokens: p.promptTokens ?? 0, outputTokens: p.outputTokens ?? 0 });
        o.onCost?.(p.usd, totals);
      }
      yield p;
    }
  };
}

/** A cheap check that a key works: the provider's model list (no tokens used). */
export async function testFrontierKey(provider: Pick<FrontierProvider, "id" | "kind" | "baseUrl">, key: string, signal?: AbortSignal): Promise<{ models: string[] }> {
  const t: FrontierTarget = { provider, model: "", apiKey: async () => key };
  const anthropic = provider.kind === "anthropic";
  const url = anthropic ? `${(provider.baseUrl || ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/models?limit=100` : `${(provider.baseUrl || OPENAI_DEFAULT_BASE).replace(/\/+$/, "")}/models`;
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(url, { method: "GET", headers: anthropic ? { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION } : { authorization: `Bearer ${key}` }, headersTimeout: 20_000, bodyTimeout: 20_000, signal });
  } catch (err) {
    throw new ChatBackendError(`Couldn't reach ${providerName(t)}: ${redactApiKeys((err as Error).message)}`, 502);
  }
  const text = await res.body.text().catch(() => "");
  if (res.statusCode >= 400) throw httpError(t, res.statusCode, text);
  try {
    const j = JSON.parse(text) as { data?: Array<{ id?: string }> };
    return { models: (j.data ?? []).map((m) => m.id).filter((m): m is string => typeof m === "string").slice(0, 200) };
  } catch {
    return { models: [] };
  }
}
