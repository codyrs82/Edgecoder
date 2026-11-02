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
import { ChatBackendError, type ChatBackend, type ChatPiece } from "./types.js";

export interface CompatRoutes<Ctx> {
  /** Who is calling (from the API key), or null to refuse. */
  authenticate(req: FastifyRequest): Promise<Ctx | null>;
  /** Model ids for /v1/models. */
  models(ctx: Ctx): Promise<string[]>;
  /** What runs a request for the model the tool named, and the model name to report back. */
  resolve(ctx: Ctx, model: string | undefined): Promise<{ backend: ChatBackend; model: string } | { status: number; error: string }>;
}

/** The key a tool sent: "Authorization: Bearer …" (OpenAI, Claude Code's auth token) or "x-api-key" (Anthropic SDKs). */
export function apiKeyOf(req: FastifyRequest): string {
  const auth = String(req.headers.authorization ?? "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(req.headers["x-api-key"] ?? "").trim();
}

type Format = "openai" | "anthropic";

function sendError(reply: FastifyReply, format: Format, status: number, message: string) {
  return format === "anthropic"
    ? reply.code(status).send({ type: "error", error: { type: status === 401 ? "authentication_error" : status === 402 ? "billing_error" : status === 404 ? "not_found_error" : status === 400 ? "invalid_request_error" : "api_error", message } })
    : reply.code(status).send({ error: { message, type: status === 401 ? "invalid_api_key" : "api_error", code: status } });
}

const statusOf = (err: unknown) => (err instanceof ChatBackendError ? err.status : typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 502);

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
    const chat = format === "anthropic" ? fromAnthropic(body as never) : fromOpenAi(body as never);
    const abort = new AbortController();
    req.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    const iter = resolved.backend(chat, abort.signal);
    // The first piece decides the status: a request that can't start is an HTTP error, not a broken stream.
    let first: IteratorResult<ChatPiece>;
    try {
      first = await iter.next();
    } catch (err) {
      return sendError(reply, format, statusOf(err), (err as Error).message);
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
        return reply.send(format === "anthropic" ? await anthropicResponse(all(), resolved.model) : await openAiResponse(all(), resolved.model));
      } catch (err) {
        return sendError(reply, format, statusOf(err), (err as Error).message);
      }
    }
    writeSseHead(reply);
    reply.hijack();
    try {
      for await (const line of format === "anthropic" ? anthropicStream(all(), resolved.model) : openAiStream(all(), resolved.model)) reply.raw.write(line);
    } catch (err) {
      const message = (err as Error).message;
      reply.raw.write(format === "anthropic" ? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n` : `data: ${JSON.stringify({ error: { message } })}\n\ndata: [DONE]\n\n`);
    }
    reply.raw.end();
    return reply;
  };

  if (formats.openai !== false) app.post(`${prefix}/v1/chat/completions`, { bodyLimit: 16 * 1024 * 1024 }, (req, reply) => run(req, reply, "openai"));
  app.post(`${prefix}/v1/messages`, { bodyLimit: 16 * 1024 * 1024 }, (req, reply) => run(req, reply, "anthropic"));
  app.post(`${prefix}/v1/messages/count_tokens`, { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const ctx = await auth(req, reply, "anthropic");
    if (!ctx) return reply;
    return reply.send({ input_tokens: countTokens((req.body ?? {}) as never) });
  });
}
