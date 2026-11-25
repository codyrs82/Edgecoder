// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The compatible endpoints any tool can point at: OpenAI (/v1/models, /v1/chat/completions) and
 * Anthropic (/v1/messages, /v1/messages/count_tokens). Shared by the per-connection ports on this
 * machine and the hosted endpoint; what runs a request (and who pays) comes from `resolve`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { writeSseHead } from "../common/sse.js";
import { anthropicResponse, anthropicStream, countTokens, fromAnthropic } from "./anthropic.js";
import { fromOpenAi, openAiResponse, openAiStream } from "./openai.js";
import { routingHintsFrom } from "./job-descriptor.js";
import { ChatBackendError, type ChatBackend, type ChatPiece } from "./types.js";

export interface CompatRoutes<Ctx> {
  /** Who is calling (from the API key), or null to refuse. */
  authenticate(req: FastifyRequest): Promise<Ctx | null>;
  /** Model ids for /v1/models. */
  models(ctx: Ctx): Promise<string[]>;
  /** What runs a request for the model the tool named, and the model name to report back. */
  resolve(ctx: Ctx, model: string | undefined): Promise<{ backend: ChatBackend; model: string } | { status: number; error: string }>;
  /** Idle time before a streamed reply sends an SSE keepalive comment (default STREAM_KEEPALIVE_MS). */
  keepaliveMs?: number;
  /** Non-streamed replies: commit 200 and send whitespace keepalives once a call runs this long (off when unset). */
  wholeKeepalive?: WholeKeepalive;
}

/**
 * Keepalive for non-streamed (`stream: false`) replies behind a proxy with a first-byte timeout
 * (Cloudflare: 100 s, then a 524). Once a call has run `afterMs` without an answer, the response is
 * committed as 200 application/json and a space is written every `everyMs` until the body is ready
 * (JSON allows leading whitespace, so OpenAI and Anthropic clients parse it as usual). A call that
 * then fails can no longer change the status: the body is the format's error object instead
 * (OpenAI `{"error":{"message","type","code"}}`, Anthropic `{"type":"error","error":{"type","message"}}`),
 * which the SDKs read as an error. Only a call that has not committed yet can answer 503 + Retry-After.
 */
export interface WholeKeepalive {
  afterMs: number;
  everyMs: number;
}
export const WHOLE_KEEPALIVE_AFTER_MS = 20_000;
export const WHOLE_KEEPALIVE_EVERY_MS = 15_000;

/**
 * PORTAL_NONSTREAM_KEEPALIVE_AFTER_MS (0 = off) and PORTAL_NONSTREAM_KEEPALIVE_MS for the hosted
 * endpoint; null when off.
 */
export function wholeKeepaliveFromEnv(env: NodeJS.ProcessEnv = process.env): WholeKeepalive | null {
  const num = (raw: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number((raw ?? "").trim() || NaN);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const afterMs = num(env.PORTAL_NONSTREAM_KEEPALIVE_AFTER_MS, WHOLE_KEEPALIVE_AFTER_MS, 0, 600_000);
  if (afterMs === 0) return null;
  return { afterMs, everyMs: num(env.PORTAL_NONSTREAM_KEEPALIVE_MS, WHOLE_KEEPALIVE_EVERY_MS, 1_000, 90_000) };
}

/** The key a tool sent: "Authorization: Bearer …" (OpenAI, Claude Code's auth token) or "x-api-key" (Anthropic SDKs). */
export function apiKeyOf(req: FastifyRequest): string {
  const auth = String(req.headers.authorization ?? "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(req.headers["x-api-key"] ?? "").trim();
}

export type Format = "openai" | "anthropic";

function anthropicErrorType(status: number): string {
  return status === 401 ? "authentication_error" : status === 402 ? "billing_error" : status === 404 ? "not_found_error" : status === 400 ? "invalid_request_error" : status === 429 ? "rate_limit_error" : status === 503 ? "overloaded_error" : "api_error";
}

function openAiErrorType(status: number): string {
  return status === 401 ? "invalid_api_key" : status === 503 ? "no_capacity" : status === 429 ? "rate_limit_exceeded" : "api_error";
}

/**
 * Cloudflare, in front of the hosted endpoint, replaces an origin's 502 and 504 with its own HTML
 * error page (network test 2026-11-24: ~70 "Cloudflare 502" pages with no request id were the
 * coordinator's own JSON errors, e.g. "The machine running deepseek-v4.1-flash reported: ...").
 * Those are answered as 503 with a short Retry-After and type "upstream_error", so the client gets
 * the JSON error and can retry.
 */
export const UPSTREAM_ERROR_RETRY_AFTER_SEC = 2;
function edgeSafe(status: number): number {
  return status === 502 || status === 504 ? 503 : status;
}

/** A non-streamed reply's error body once 200 has been committed (see WholeKeepalive). */
function wholeError(format: Format, rawStatus: number, message: string, openAiType?: string): string {
  const status = edgeSafe(rawStatus);
  if (status !== rawStatus) openAiType ??= "upstream_error";
  return format === "anthropic"
    ? JSON.stringify({ type: "error", error: { type: anthropicErrorType(status), message } })
    : JSON.stringify({ error: { message, type: openAiType ?? openAiErrorType(status), code: status } });
}

function sendError(reply: FastifyReply, format: Format, rawStatus: number, message: string, retryAfterSec?: number, openAiType?: string) {
  const status = edgeSafe(rawStatus);
  if (status !== rawStatus) {
    retryAfterSec ??= UPSTREAM_ERROR_RETRY_AFTER_SEC;
    openAiType ??= "upstream_error";
  }
  if (retryAfterSec !== undefined && (status === 429 || status === 503)) reply.header("retry-after", String(Math.max(1, Math.ceil(retryAfterSec))));
  return format === "anthropic"
    ? reply.code(status).send({ type: "error", error: { type: anthropicErrorType(status), message } })
    : reply.code(status).send({ error: { message, type: openAiType ?? openAiErrorType(status), code: status } });
}

/** An error inside a stream that has already started (status 200 sent): the format's error event. */
function streamError(format: Format, status: number, message: string, openAiType?: string): string {
  return format === "anthropic"
    ? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: anthropicErrorType(status), message } })}\n\n`
    : `data: ${JSON.stringify({ error: { message, type: openAiType ?? openAiErrorType(status), code: status } })}\n\ndata: [DONE]\n\n`;
}

/** What a request still open when the server stops is told (the client may send it again). */
export const RESTARTING_MESSAGE = "EdgeCoder is restarting and could not finish this request; send it again.";
const RESTART_RETRY_AFTER_SEC = 5;

/** Requests being answered now; drainOpenRequests ends them cleanly when the server stops. */
const openRequests = new Set<{ stop: () => void }>();

/** How many compatible-API requests are being answered now. */
export function openRequestCount(): number {
  return openRequests.size;
}

/**
 * Stopping the server (a deploy, a restart): wait up to `graceMs` for the requests being answered
 * to finish, then end the rest with an error the client can act on (a 503 with retry-after when
 * nothing was sent yet, else the format's error event and, for OpenAI, [DONE]) instead of the
 * connection being cut under them ("terminated" with no error). Returns how many were ended early.
 */
export async function drainOpenRequests(graceMs: number, pollMs = 250): Promise<number> {
  const until = Date.now() + Math.max(0, graceMs);
  while (openRequests.size > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, until - Date.now()))));
  const left = [...openRequests];
  for (const r of left) r.stop();
  return left.length;
}

const statusOf = (err: unknown) => (err instanceof ChatBackendError ? err.status : typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 502);
const retryAfterOf = (err: unknown) => (err instanceof ChatBackendError ? err.retryAfterSec : undefined);

/**
 * Streamed requests that wait this long for their first piece (queued for an agent, a model
 * loading) start the event stream and send SSE comments until it comes, so a proxy in front
 * (Cloudflare: 100 s to the first byte) does not cut them. Comments are also sent whenever the
 * stream is otherwise idle that long. A request that then can't start ends with the format's error
 * event instead of an HTTP status.
 */
export const STREAM_KEEPALIVE_MS = 15_000;

/** Run a request on a backend and answer in the tool's format, streamed or whole. */
export async function respondWith(req: FastifyRequest, reply: FastifyReply, format: Format, backend: ChatBackend, model: string, opts: { keepaliveMs?: number; wholeKeepalive?: WholeKeepalive | null } = {}) {
  const body = (req.body ?? {}) as { stream?: boolean };
  const chat = format === "anthropic" ? fromAnthropic(body as never) : fromOpenAi(body as never);
  const hints = routingHintsFrom(body, req.headers as Record<string, unknown>);
  if (Object.keys(hints).length) chat.hints = hints;
  const abort = new AbortController();
  // The client went away when the response closes before it ended (the request's own "close"
  // fires as soon as its body has been read, which aborted fast requests).
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) abort.abort();
  });
  const iter = backend(chat, abort.signal);
  const keepaliveMs = Math.max(10, opts.keepaliveMs ?? STREAM_KEEPALIVE_MS);
  // Streams only: the event stream is started early (keepalive) when the first piece is slow.
  let streaming = false;
  // Answered (or cut short by a drain): nothing more is written.
  let finished = false;
  let lastWriteMs = Date.now();
  const write = (chunk: string) => {
    if (finished || reply.raw.writableEnded || reply.raw.destroyed) return;
    lastWriteMs = Date.now();
    reply.raw.write(chunk);
  };
  const end = () => {
    if (finished) return;
    finished = true;
    if (!reply.raw.writableEnded) reply.raw.end();
  };
  const startStream = () => {
    if (streaming || finished) return;
    streaming = true;
    writeSseHead(reply);
    reply.hijack();
  };
  const keepalive = body.stream
    ? setInterval(() => {
        if (finished || reply.raw.writableEnded || Date.now() - lastWriteMs < keepaliveMs) return;
        startStream();
        write(": keepalive\n\n");
      }, Math.max(5, Math.floor(keepaliveMs / 3)))
    : undefined;
  keepalive?.unref?.();
  // Non-streamed only: 200 + JSON head committed early, whitespace sent until the body is ready.
  let whole = false;
  let wholeTicker: ReturnType<typeof setInterval> | undefined;
  const wk = !body.stream && opts.wholeKeepalive ? opts.wholeKeepalive : undefined;
  const wholeStart = wk
    ? setTimeout(() => {
        if (finished || whole || reply.raw.writableEnded || reply.raw.headersSent) return;
        whole = true;
        const kept: Record<string, string | number | string[]> = {};
        for (const [k, v] of Object.entries(reply.getHeaders())) {
          if (v !== undefined && k.toLowerCase() !== "content-length") kept[k] = v as string | number | string[];
        }
        reply.raw.writeHead(200, { ...kept, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
        reply.hijack();
        write(" ");
        wholeTicker = setInterval(() => write(" "), Math.max(10, wk.everyMs));
        wholeTicker.unref?.();
      }, Math.max(0, wk.afterMs))
    : undefined;
  wholeStart?.unref?.();
  const stopWhole = () => {
    if (wholeStart) clearTimeout(wholeStart);
    if (wholeTicker) clearInterval(wholeTicker);
  };
  /** End a committed non-streamed reply with this body. */
  const endWhole = (json: string) => {
    stopWhole();
    write(json);
    end();
    return reply;
  };
  // The server is stopping: end this request with an error the client can act on, then stop the backend.
  const open = {
    stop: () => {
      openRequests.delete(open);
      if (finished) return;
      if (whole) {
        endWhole(wholeError(format, 503, RESTARTING_MESSAGE, "server_restarting"));
      } else if (streaming) {
        write(streamError(format, 503, RESTARTING_MESSAGE, "server_restarting"));
        end();
      } else {
        finished = true;
        sendError(reply, format, 503, RESTARTING_MESSAGE, RESTART_RETRY_AFTER_SEC, "server_restarting");
      }
      abort.abort();
    },
  };
  openRequests.add(open);
  try {
    // The first piece decides the status: a request that can't start is an HTTP error, not a broken stream
    // (unless a slow start already opened the stream for keepalives).
    let first: IteratorResult<ChatPiece>;
    try {
      first = await iter.next();
    } catch (err) {
      if (finished) return reply;
      if (whole) return endWhole(wholeError(format, statusOf(err), (err as Error).message));
      if (!streaming) {
        finished = true;
        return sendError(reply, format, statusOf(err), (err as Error).message, retryAfterOf(err));
      }
      write(streamError(format, statusOf(err), (err as Error).message));
      end();
      return reply;
    }
    if (finished) return reply;
    async function* all(): AsyncGenerator<ChatPiece> {
      if (!first.done) yield first.value;
      for (;;) {
        const n = await iter.next();
        if (n.done) return;
        yield n.value;
      }
    }
    if (!body.stream) {
      let answer: unknown;
      try {
        answer = format === "anthropic" ? await anthropicResponse(all(), model) : await openAiResponse(all(), model);
      } catch (err) {
        if (finished) return reply;
        if (whole) return endWhole(wholeError(format, statusOf(err), (err as Error).message));
        stopWhole();
        finished = true;
        return sendError(reply, format, statusOf(err), (err as Error).message, retryAfterOf(err));
      }
      if (finished) return reply;
      if (whole) return endWhole(JSON.stringify(answer));
      stopWhole();
      finished = true;
      return reply.send(answer);
    }
    startStream();
    try {
      for await (const line of format === "anthropic" ? anthropicStream(all(), model) : openAiStream(all(), model)) {
        if (finished) break;
        write(line);
      }
    } catch (err) {
      write(streamError(format, statusOf(err), (err as Error).message));
    }
    end();
    return reply;
  } finally {
    openRequests.delete(open);
    if (keepalive) clearInterval(keepalive);
    stopWhole();
  }
}

export function registerCompatRoutes<Ctx>(app: FastifyInstance, opts: CompatRoutes<Ctx>, prefix = "", formats: { openai?: boolean } = {}): void {
  const auth = async (req: FastifyRequest, reply: FastifyReply, format: Format): Promise<Ctx | null> => {
    const ctx = await opts.authenticate(req);
    if (!ctx) sendError(reply, format, 401, "Invalid API key. Use the key shown on EdgeCoder's Connect to compute page.");
    return ctx;
  };

  if (formats.openai !== false) app.get(`${prefix}/v1/models`, async (req, reply) => {
    const ctx = await auth(req, reply, "openai");
    if (!ctx) return reply;
    const ids = await opts.models(ctx);
    const created = Math.floor(Date.now() / 1000);
    // OpenAI's list shape; Anthropic clients read "data[].id" too.
    return reply.send({ object: "list", data: ids.map((id) => ({ id, object: "model", created, owned_by: "edgecoder", type: "model", display_name: id })) });
  });

  const run = async (req: FastifyRequest, reply: FastifyReply, format: Format) => {
    const ctx = await auth(req, reply, format);
    if (!ctx) return reply;
    const body = (req.body ?? {}) as { model?: string; stream?: boolean; messages?: unknown };
    if (!Array.isArray(body.messages) || body.messages.length === 0) return sendError(reply, format, 400, "messages is required");
    const resolved = await opts.resolve(ctx, body.model);
    if ("error" in resolved) return sendError(reply, format, resolved.status, resolved.error);
    return respondWith(req, reply, format, resolved.backend, resolved.model, { keepaliveMs: opts.keepaliveMs, wholeKeepalive: opts.wholeKeepalive });
  };

  if (formats.openai !== false) app.post(`${prefix}/v1/chat/completions`, { bodyLimit: 16 * 1024 * 1024 }, (req, reply) => run(req, reply, "openai"));
  app.post(`${prefix}/v1/messages`, { bodyLimit: 16 * 1024 * 1024 }, (req, reply) => run(req, reply, "anthropic"));
  app.post(`${prefix}/v1/messages/count_tokens`, { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const ctx = await auth(req, reply, "anthropic");
    if (!ctx) return reply;
    return reply.send({ input_tokens: countTokens((req.body ?? {}) as never) });
  });
}
