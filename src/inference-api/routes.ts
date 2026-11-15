// Copyright (c) 2025 EdgeCoder, LLC
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

function sendError(reply: FastifyReply, format: Format, status: number, message: string, retryAfterSec?: number) {
  if (retryAfterSec !== undefined && (status === 429 || status === 503)) reply.header("retry-after", String(Math.max(1, Math.ceil(retryAfterSec))));
  return format === "anthropic"
    ? reply.code(status).send({ type: "error", error: { type: anthropicErrorType(status), message } })
    : reply.code(status).send({ error: { message, type: openAiErrorType(status), code: status } });
}

/** An error inside a stream that has already started (status 200 sent): the format's error event. */
function streamError(format: Format, status: number, message: string): string {
  return format === "anthropic"
    ? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: anthropicErrorType(status), message } })}\n\n`
    : `data: ${JSON.stringify({ error: { message, type: openAiErrorType(status), code: status } })}\n\ndata: [DONE]\n\n`;
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
export async function respondWith(req: FastifyRequest, reply: FastifyReply, format: Format, backend: ChatBackend, model: string, opts: { keepaliveMs?: number } = {}) {
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
  let lastWriteMs = Date.now();
  const write = (chunk: string) => {
    lastWriteMs = Date.now();
    reply.raw.write(chunk);
  };
  const startStream = () => {
    if (streaming) return;
    streaming = true;
    writeSseHead(reply);
    reply.hijack();
  };
  const keepalive = body.stream
    ? setInterval(() => {
        if (reply.raw.writableEnded || Date.now() - lastWriteMs < keepaliveMs) return;
        startStream();
        write(": keepalive\n\n");
      }, Math.max(5, Math.floor(keepaliveMs / 3)))
    : undefined;
  keepalive?.unref?.();
  try {
    // The first piece decides the status: a request that can't start is an HTTP error, not a broken stream
    // (unless a slow start already opened the stream for keepalives).
    let first: IteratorResult<ChatPiece>;
    try {
      first = await iter.next();
    } catch (err) {
      if (!streaming) return sendError(reply, format, statusOf(err), (err as Error).message, retryAfterOf(err));
      write(streamError(format, statusOf(err), (err as Error).message));
      reply.raw.end();
      return reply;
    }
    async function* all(): AsyncGenerator<ChatPiece> {
      if (!first.done) yield first.value;
      for (;;) {
        const n = await iter.next();
        if (n.done) return;
        yield n.value;
      }
    }
    if (!body.stream) {
      try {
        return reply.send(format === "anthropic" ? await anthropicResponse(all(), model) : await openAiResponse(all(), model));
      } catch (err) {
        return sendError(reply, format, statusOf(err), (err as Error).message, retryAfterOf(err));
      }
    }
    startStream();
    try {
      for await (const line of format === "anthropic" ? anthropicStream(all(), model) : openAiStream(all(), model)) write(line);
    } catch (err) {
      write(streamError(format, statusOf(err), (err as Error).message));
    }
    reply.raw.end();
    return reply;
  } finally {
    if (keepalive) clearInterval(keepalive);
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
    return respondWith(req, reply, format, resolved.backend, resolved.model, { keepaliveMs: opts.keepaliveMs });
  };

  if (formats.openai !== false) app.post(`${prefix}/v1/chat/completions`, { bodyLimit: 16 * 1024 * 1024 }, (req, reply) => run(req, reply, "openai"));
  app.post(`${prefix}/v1/messages`, { bodyLimit: 16 * 1024 * 1024 }, (req, reply) => run(req, reply, "anthropic"));
  app.post(`${prefix}/v1/messages/count_tokens`, { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const ctx = await auth(req, reply, "anthropic");
    if (!ctx) return reply;
    return reply.send({ input_tokens: countTokens((req.body ?? {}) as never) });
  });
}
