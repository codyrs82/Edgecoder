// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The cloud host's backend: an OpenAI-compatible hosted model API (Fireworks first:
 * https://api.fireworks.ai/inference/v1), called with the platform's one key.
 *
 * It streams a chat completion (server-sent events, OpenAI tool calls) and yields the pieces the
 * local engines yield (OllamaPiece: text, tool calls, then the end with token counts), so the
 * inference runner, chunk posting and billing do not care that the model runs elsewhere. Token
 * counts are the provider's own (`usage`, requested with stream_options.include_usage), including
 * the prompt tokens it served from its cache (usage.prompt_tokens_details.cached_tokens).
 *
 * Failures:
 * - 429 and 5xx (and a connection that fails before any answer) are retried with exponential
 *   backoff and jitter, honouring Retry-After, up to `maxRetries`, but only before anything was
 *   streamed: a retry after the first piece would repeat the reply.
 * - 401 / 403 are CloudApiError kind "auth" (a bad or revoked key): never retried; the host counts
 *   them and pauses (host.ts).
 * - 400 / 413 that say the prompt is too long are context overflows (the runner hands the call to
 *   another agent, like a local engine's).
 * - A reply that is reasoning only (GLM-5.3 and DeepSeek V4.1 Flash stream their thinking as
 *   `reasoning_content` before the answer; a small max_tokens can end the call inside it) is
 *   CloudApiError "reasoning_only" (REASONING_ONLY_ERROR): the caller's output cap was too small,
 *   not a host failure, so the coordinator neither retries it elsewhere nor counts it against the
 *   host. It carries the provider's token counts (the provider bills the reasoning).
 * - Reasoning allowance (reasoningChat): for a reasoning model the provider is asked for the
 *   caller's max_tokens plus an allowance for the thinking (the provider's max_tokens counts both),
 *   and the answer passed on is capped at the caller's max_tokens (finish "length"). A reply that is
 *   still reasoning only is asked once more with twice the allowance before it fails.
 * The key is sent only in the Authorization header and is scrubbed from any error text.
 */
import { request } from "undici";
import { EngineError, isContextOverflowMessage, toOpenAiMessages } from "../inference-api/openai-engine.js";
import type { OllamaPiece } from "../inference-api/ollama.js";
import type { ChatMessage, ToolCall, ToolSpec } from "../inference-api/types.js";

export interface RemoteBackendConfig {
  /** Provider name for messages ("Fireworks"). */
  label: string;
  /** OpenAI-compatible base URL, without /chat/completions (e.g. https://api.fireworks.ai/inference/v1). */
  baseUrl: string;
  apiKey: string;
  /** Retries of a 429 / 5xx / failed connection before anything streamed. Default 3. */
  maxRetries?: number;
  /** First backoff; doubles per retry, with jitter. Default 500 ms. */
  retryBaseMs?: number;
  /** Longest single wait, Retry-After included. Default 15 s. */
  retryMaxMs?: number;
  /** Tests: replace the wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Sent as `reasoning_effort` when set (CLOUD_HOST_REASONING_EFFORT); unset: the provider's default. */
  reasoningEffort?: string;
}

/** The error text of a reply that was reasoning only (no answer, no tool call). */
export const REASONING_ONLY_ERROR = "reasoning_only";

export type CloudErrorKind = "auth" | "rate_limit" | "server" | "bad_request" | "network";

/** An error from the provider. An EngineError, so a context overflow is handled like a local engine's. */
export class CloudApiError extends EngineError {
  constructor(
    message: string,
    status: number,
    readonly kind: CloudErrorKind,
    contextOverflow = false,
    /** The provider's token counts, when it answered before failing (it bills them). */
    readonly usage?: { promptTokens?: number; outputTokens?: number; cachedPromptTokens?: number }
  ) {
    super(message, status, contextOverflow);
  }
}


export interface RemoteChatRequest {
  /** The provider's model id. */
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  /**
   * Answer tokens passed on at most (estimated from the stream: a piece is about a token, at least
   * one per 4 characters); past it the stream is closed and the reply ends as "length". Set by
   * reasoningChat to the caller's own max_tokens while the provider is asked for more.
   */
  contentCap?: number;
}

/** Tokens in a piece of streamed text, roughly: the pieces seen, at least one per 4 characters. */
const estTokens = (pieces: number, chars: number) => Math.max(pieces, Math.ceil(chars / 4));

function scrub(text: string, key: string): string {
  return key ? text.split(key).join("[redacted]") : text;
}

function errorText(body: string): string {
  try {
    const j = JSON.parse(body) as { message?: unknown; error?: unknown; detail?: unknown };
    if (typeof j.message === "string") return j.message;
    if (typeof j.error === "string") return j.error;
    if (j.error && typeof j.error === "object" && typeof (j.error as { message?: unknown }).message === "string") return (j.error as { message: string }).message;
    if (typeof j.detail === "string") return j.detail;
  } catch {
    // plain text
  }
  return body.slice(0, 300);
}

/** The provider's HTTP error as a CloudApiError (kind, retryable or not, context overflow). */
export function httpError(cfg: Pick<RemoteBackendConfig, "label" | "apiKey">, status: number, body: string): CloudApiError {
  const msg = scrub(errorText(body) || `HTTP ${status}`, cfg.apiKey).slice(0, 300);
  if (status === 401 || status === 403) return new CloudApiError(`cloud_provider_auth: ${cfg.label} refused the API key (HTTP ${status}): ${msg}`, status, "auth");
  if (status === 429) return new CloudApiError(`cloud_provider_rate_limited: ${cfg.label} HTTP 429: ${msg}`, status, "rate_limit");
  if (status >= 500) return new CloudApiError(`cloud_provider_error: ${cfg.label} HTTP ${status}: ${msg}`, status, "server");
  const overflow = (status === 400 || status === 413) && isContextOverflowMessage(msg);
  return new CloudApiError(`cloud_provider_error: ${cfg.label} HTTP ${status}: ${msg}`, status, "bad_request", overflow);
}

const retryable = (e: CloudApiError) => e.kind === "rate_limit" || e.kind === "server" || e.kind === "network";

/** Retry-After as ms (seconds or an HTTP date); undefined when absent or unreadable. */
export function retryAfterMs(header: string | string[] | undefined, nowMs = Date.now()): number | undefined {
  const v = Array.isArray(header) ? header[0] : header;
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

/** Backoff before retry `attempt` (0-based): base × 2^attempt with ±25 % jitter, or Retry-After; capped. */
export function backoffMs(attempt: number, cfg: Pick<RemoteBackendConfig, "retryBaseMs" | "retryMaxMs">, retryAfter?: number, random = Math.random): number {
  const max = cfg.retryMaxMs ?? 15_000;
  if (retryAfter !== undefined) return Math.min(max, retryAfter);
  const base = (cfg.retryBaseMs ?? 500) * 2 ** attempt;
  return Math.min(max, Math.round(base * (0.75 + random() * 0.5)));
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { _raw: raw };
  }
}

type SseChunk = {
  choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null } | null;
  error?: unknown;
};

/**
 * Stream one chat completion from the provider. `timeoutMs` bounds the wait for the first byte
 * and between pieces; the caller's `signal` bounds the whole call (the subtask's deadline).
 */
export async function* remoteChat(cfg: RemoteBackendConfig, req: RemoteChatRequest, signal?: AbortSignal, timeoutMs = 120_000): AsyncGenerator<OllamaPiece> {
  const started = Date.now();
  const sleep = cfg.sleep ?? defaultSleep;
  const maxRetries = Math.max(0, cfg.maxRetries ?? 3);
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const contentCap = req.contentCap !== undefined && req.contentCap > 0 ? Math.floor(req.contentCap) : undefined;
  const body = JSON.stringify({
    model: req.model,
    messages: toOpenAiMessages(req.messages),
    ...(req.tools?.length ? { tools: req.tools } : {}),
    stream: true,
    stream_options: { include_usage: true },
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {})
  });

  let res: Awaited<ReturnType<typeof request>> | undefined;
  for (let attempt = 0; ; attempt++) {
    let err: CloudApiError;
    let wait: number | undefined;
    try {
      const r = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${cfg.apiKey}` },
        body,
        signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs
      });
      if (r.statusCode >= 200 && r.statusCode < 300) {
        res = r;
        break;
      }
      err = httpError(cfg, r.statusCode, await r.body.text().catch(() => ""));
      wait = retryAfterMs(r.headers["retry-after"]);
    } catch (e) {
      if (signal?.aborted) throw e;
      err = new CloudApiError(`cloud_provider_unreachable: ${cfg.label}: ${scrub(String((e as Error)?.message ?? e), cfg.apiKey).slice(0, 200)}`, 0, "network");
    }
    if (!retryable(err) || attempt >= maxRetries) throw err;
    await sleep(backoffMs(attempt, cfg, wait), signal);
  }

  const calls = new Map<number, { name: string; args: string }>();
  let finish: string | undefined;
  let usage: { promptTokens?: number; outputTokens?: number; cachedPromptTokens?: number } = {};
  let firstAt: number | undefined;
  let reasoningChars = 0;
  let reasoningPieces = 0;
  let contentChars = 0;
  let contentPieces = 0;
  /** The answer reached contentCap: nothing more is passed on and the stream is closed. */
  let capped = false;
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
    if (chunk.error !== undefined && !chunk.choices) {
      const msg = scrub(errorText(data), cfg.apiKey);
      throw new CloudApiError(`cloud_provider_error: ${cfg.label}: ${msg}`, 500, "server", isContextOverflowMessage(msg));
    }
    for (const c of chunk.choices ?? []) {
      const thought = c.delta?.reasoning_content ?? c.delta?.reasoning ?? "";
      if (thought) {
        reasoningChars += thought.length;
        reasoningPieces++;
      }
      let text = c.delta?.content;
      if (text && contentCap !== undefined && !capped) {
        const left = contentCap - estTokens(contentPieces, contentChars);
        if (estTokens(1, text.length) > left) {
          text = text.slice(0, Math.max(0, left) * 4);
          capped = true;
        }
      } else if (capped) text = "";
      if (text) {
        firstAt ??= Date.now();
        contentChars += text.length;
        contentPieces++;
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
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
      usage = {
        ...(typeof chunk.usage.prompt_tokens === "number" ? { promptTokens: chunk.usage.prompt_tokens } : {}),
        ...(typeof chunk.usage.completion_tokens === "number" ? { outputTokens: chunk.usage.completion_tokens } : {}),
        ...(typeof cached === "number" && cached > 0 ? { cachedPromptTokens: cached } : {})
      };
    }
  };
  for await (const part of res.body) {
    buf += Buffer.from(part as Uint8Array).toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const l = line.trim();
      if (l.startsWith("data:")) yield* handle(l.slice(5).trim());
      if (capped) break;
    }
    // Capped: close the stream (leaving the loop ends the request) rather than wait for the rest.
    if (ended || capped) break;
  }
  if (!ended && !capped && buf.trim().startsWith("data:")) yield* handle(buf.trim().slice(5).trim());
  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, c]) => c.name)
    .map(([, c]) => ({ function: { name: c.name, arguments: parseArgs(c.args) } }));
  if (toolCalls.length) yield { toolCalls };
  // Thinking and no answer: the output cap ran out inside the reasoning (or the model stopped there).
  if (firstAt === undefined && reasoningChars > 0) {
    const cap = req.maxTokens !== undefined ? ` (max_tokens ${req.maxTokens})` : "";
    throw new CloudApiError(`${REASONING_ONLY_ERROR}: ${req.model} spent the reply${cap} reasoning and gave no answer; send a larger max_tokens`, 400, "bad_request", false, usage);
  }
  const end = Date.now();
  // Closed at the cap, the provider's counts never came: the tokens streamed so far, estimated.
  if (capped && usage.outputTokens === undefined) {
    const promptChars = JSON.stringify(toOpenAiMessages(req.messages)).length + (req.tools?.length ? JSON.stringify(req.tools).length : 0);
    usage = { promptTokens: Math.ceil(promptChars / 4), outputTokens: estTokens(reasoningPieces, reasoningChars) + estTokens(contentPieces, contentChars) };
  }
  yield {
    doneReason: finish === "length" || capped ? "length" : "stop",
    ...usage,
    ...(firstAt !== undefined ? { promptMs: firstAt - started, genMs: Math.max(0, end - firstAt) } : {})
  };
}

/** A reply that was reasoning only (REASONING_ONLY_ERROR). */
export function isReasoningOnly(err: unknown): err is CloudApiError {
  return err instanceof CloudApiError && err.message.startsWith(`${REASONING_ONLY_ERROR}:`);
}

/**
 * A call on a reasoning model with room to think: the provider is asked for the caller's max_tokens
 * plus `allowance` (its max_tokens counts the thinking too), and the answer passed on is capped at
 * the caller's max_tokens (remoteChat contentCap). A reply that is reasoning only is asked once more
 * with twice the allowance (nothing was passed on yet), then fails as reasoning_only. `onBilled`
 * gets the provider's counts of a reasoning-only attempt that was asked again (the provider bills
 * it). No max_tokens (the provider's default cap) or no allowance: one plain remoteChat.
 */
export async function* reasoningChat(
  cfg: RemoteBackendConfig,
  req: RemoteChatRequest,
  allowance: number,
  signal?: AbortSignal,
  timeoutMs = 120_000,
  onBilled?: (usage: NonNullable<CloudApiError["usage"]>) => void
): AsyncGenerator<OllamaPiece> {
  const max = req.maxTokens;
  if (max === undefined || !(allowance > 0)) return yield* remoteChat(cfg, req, signal, timeoutMs);
  const attempt = (room: number) => remoteChat(cfg, { ...req, maxTokens: max + room, contentCap: max }, signal, timeoutMs);
  try {
    return yield* attempt(allowance);
  } catch (err) {
    if (!isReasoningOnly(err) || signal?.aborted) throw err;
    if (err.usage) onBilled?.(err.usage);
  }
  try {
    return yield* attempt(allowance * 2);
  } catch (err) {
    if (!isReasoningOnly(err)) throw err;
    throw new CloudApiError(`${REASONING_ONLY_ERROR}: ${req.model} gave no answer within ${max} tokens after up to ${allowance * 2} tokens of reasoning (asked twice); send a larger max_tokens or a lower reasoning effort`, 400, "bad_request", false, err.usage);
  }
}

/** GET /models with the key: is it accepted? (The auth-pause probe.) Never throws. */
export async function probeKey(cfg: Pick<RemoteBackendConfig, "baseUrl" | "apiKey">, timeoutMs = 10_000): Promise<{ ok: boolean; status: number }> {
  try {
    const r = await request(`${cfg.baseUrl.replace(/\/+$/, "")}/models`, { method: "GET", headers: { authorization: `Bearer ${cfg.apiKey}` }, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    await r.body.text().catch(() => "");
    return { ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode };
  } catch {
    return { ok: false, status: 0 };
  }
}
