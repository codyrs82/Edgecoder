// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { writeSseHead } from "../../common/sse.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import type { ChatApiRoutesDeps } from "../server.js";
import { networkBackend } from "../../inference-api/backends.js";
import { ChatBackendError, type ChatPiece } from "../../inference-api/types.js";
import type { Transport } from "../../apps/ide/network-inference.js";
import { accountIdFor, chatComputeSchema, computeLabel, networkTargetFor, portalNetworkDeps, type ChatCompute } from "./compute.js";
import { createChatCapacityDirectory, type ChatCapacityDirectory } from "../chat-capacity.js";
import { clientRegionOf, type CoordinatorChoice } from "../../common/coordinator-choice.js";
import { moduleLogger } from "../../common/logger.js";

const logger = moduleLogger("portal-chat");

/** Longest chat message accepted, in characters. */
export const CHAT_MESSAGE_MAX_CHARS = 32_000;
/** At most this many of the latest messages are sent upstream as context... */
export const CHAT_HISTORY_MAX_MESSAGES = 40;
/** ...and no more than this many characters of them (the newest are kept). */
export const CHAT_HISTORY_MAX_CHARS = 120_000;

/** The newest messages that fit the character budget, oldest first; the newest one is always kept. */
export function boundChatHistory<T extends { content: string }>(messages: T[], maxChars = CHAT_HISTORY_MAX_CHARS): T[] {
  const kept: T[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    used += messages[i].content.length;
    if (kept.length > 0 && used > maxChars) break;
    kept.unshift(messages[i]);
  }
  return kept;
}

/** #39: a chat is tried on at most this many coordinators (the pick, then one retry). */
export const CHAT_MAX_COORDINATOR_ATTEMPTS = 2;

/** #39: sent when no coordinator can serve the chat. The chat page shows `error` as it is. */
export const NO_COMPUTE_BODY = { error: "No compute is available right now. Try again in a moment.", code: "no_compute_available" } as const;

type DefaultChatEvent = { content?: string; warning?: string };
interface OpenedDefaultChat {
  first: DefaultChatEvent;
  events: AsyncGenerator<DefaultChatEvent>;
}

/** The `data:` payloads of an SSE body, one per line, whatever the chunk boundaries. */
export async function* sseDataLines(body: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  let buffer = "";
  // A character split across two chunks is decoded whole.
  const utf8 = new TextDecoder();
  for await (const chunk of body) {
    buffer += typeof chunk === "string" ? chunk : utf8.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/^data:\s*/, "").trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
  }
  const rest = buffer.replace(/^data:\s*/, "").trim();
  if (rest) yield rest;
}

/** The content and warning events of a coordinator /portal/chat stream, up to [DONE]. */
async function* defaultChatEvents(body: AsyncIterable<Buffer | string>): AsyncGenerator<DefaultChatEvent> {
  for await (const line of sseDataLines(body)) {
    if (line === "[DONE]") return;
    let parsed: DefaultChatEvent;
    try {
      parsed = JSON.parse(line) as DefaultChatEvent;
    } catch {
      continue; // skip unparseable lines
    }
    if (!parsed || typeof parsed !== "object") continue;
    const content = typeof parsed.content === "string" && parsed.content ? parsed.content : undefined;
    const warning = typeof parsed.warning === "string" && parsed.warning ? parsed.warning : undefined;
    if (content || warning) yield { ...(warning ? { warning } : {}), ...(content ? { content } : {}) };
  }
}

/** Errors raised before a request reached the coordinator: nothing ran there, so another one may be tried. */
function failedBeforeSend(err: unknown): boolean {
  const code = String((err as { code?: unknown } | null)?.code ?? "");
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "UND_ERR_CONNECT_TIMEOUT";
}

/** #16: Chat API: model list and streaming chat (/portal/api/models, /portal/api/chat). Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerChatApiRoutes(app: FastifyInstance, deps: ChatApiRoutesDeps): void {
  const { PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal, getCurrentUser, store } = deps;
  // #39: server.ts passes the directory. Without one (tests), build it over the discovered list,
  // which the caller has already put through the coordinator URL policy.
  const capacity: ChatCapacityDirectory =
    (deps.chatCapacity as ChatCapacityDirectory | undefined) ??
    createChatCapacityDirectory({ candidates: discoverCoordinatorUrlsForPortal, allowed: () => true, serviceToken: PORTAL_SERVICE_TOKEN });

  /** A chat on a chosen compute, through networkBackend for the user's account; streams {content} then {done, cSatsSpent}. */
  async function runOnNetwork(
    req: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    conversationId: string,
    compute: ChatCompute,
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
    /** Auto only: where the chat goes when the network turns it down before any reply (the coordinator's own chat, free). */
    fallback?: () => Promise<unknown>
  ) {
    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());
    const accountId = accountIdFor(userId);
    const tried: string[] = [];
    let pieces: AsyncGenerator<ChatPiece> | undefined;
    let first: IteratorResult<ChatPiece> | undefined;
    let refusal: unknown;
    // #39: run on a coordinator whose agents have the model; if it turns the job down before
    // taking it, try one other. Once a coordinator has accepted the job (and set cSats aside for
    // it) the chat stays there: a second submit could bill twice. When no coordinator lists the
    // model, a reachable one is still asked, so the user gets its exact refusal.
    while (!first && tried.length < CHAT_MAX_COORDINATOR_ATTEMPTS) {
      // Best fit: the coordinator with the most room asks its routing (one coordinator; it may place on peers' agents itself).
      // Latency-aware among the coordinators with room (coordinator-latency.ts); the choice goes with the call.
      const where = { clientRegion: clientRegionOf(req.headers as Record<string, unknown>) };
      const { url, known, choice }: { url: string | null; known: number; choice?: CoordinatorChoice } =
        compute.target === "auto"
          ? tried.length > 0
            ? { url: null, known: 1 }
            : await (capacity.pickAutoChoice ? capacity.pickAutoChoice(where) : capacity.pickAuto().then((url) => ({ url, choice: undefined }))).then(
                (r) => ({ url: r.url, known: r.url ? 1 : 0, choice: r.choice }),
                () => ({ url: null, known: 0 }),
              )
          : compute.target === "network"
            ? await capacity.pick({ kind: "network", model: compute.model, computeClass: compute.computeClass }, tried, where)
            : await capacity.pick({ kind: "network", model: compute.model }, tried).then((r) => ({ url: r.url, known: r.known }));
      if (!url) {
        if (tried.length > 0) break;
        if (fallback) return fallback();
        if (known === 0) return reply.code(502).send({ error: "no_coordinators_available", compute: computeLabel(compute) });
        return reply.code(503).send({ ...NO_COMPUTE_BODY, compute: computeLabel(compute) });
      }
      tried.push(url);
      // Every call of this chat goes to the chosen coordinator.
      const pinned = portalNetworkDeps({ PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal: async () => [url] }, accountId);
      const inner = pinned.transport!;
      // What became of the submit call: its HTTP status, or the error when no answer came back.
      const submit: { status?: number; error?: unknown } = {};
      const transport: Transport = async (method, path, body, signal) => {
        if (path !== "/inference/submit") return inner(method, path, body, signal);
        try {
          const res = await inner(method, path, body, signal);
          submit.status = res.status;
          return res;
        } catch (err) {
          submit.error = err;
          throw err;
        }
      };
      pieces = networkBackend({ ...pinned, transport }, { ...networkTargetFor(compute), ...(choice ? { coordinatorChoice: choice } : {}) })({ messages }, ac.signal);
      // Wait for the first piece so a refusal (no machine, not enough cSats, lease ended) is a plain HTTP error.
      try {
        first = await pieces.next();
      } catch (err) {
        const paymentRequired = err instanceof ChatBackendError && err.status === 402;
        // Keep the preferred coordinator's answer unless the other one says the account is short.
        if (refusal === undefined || paymentRequired) refusal = err;
        const refused = submit.status !== undefined && submit.status !== 200;
        const unreached = submit.status === undefined && failedBeforeSend(submit.error);
        if (unreached || (submit.status ?? 0) >= 500) capacity.markFailed(url);
        // Not enough cSats is the same on every coordinator; anything after acceptance is not retried.
        if (ac.signal.aborted || paymentRequired || !(refused || unreached)) break;
      }
    }
    if (!first || !pieces) {
      // Auto: nothing ran and nothing was charged, so the coordinator's own chat answers instead.
      if (fallback && !ac.signal.aborted) {
        req.log.info({ reason: (refusal as Error | undefined)?.message?.slice(0, 200) }, "portal_auto_chat_fallback");
        return fallback();
      }
      const status = refusal instanceof ChatBackendError ? refusal.status : 502;
      return reply.code(status >= 400 && status < 600 ? status : 502).send({ error: (refusal as Error | undefined)?.message ?? "all_coordinators_failed", compute: computeLabel(compute) });
    }
    writeSseHead(reply);
    const send = (o: unknown) => reply.raw.write(`data: ${JSON.stringify(o)}\n\n`);
    let fullContent = "";
    let cSatsSpent: number | undefined;
    const take = (p: ChatPiece) => {
      if ("delta" in p && p.delta) {
        fullContent += p.delta;
        send({ content: p.delta });
      } else if ("done" in p) cSatsSpent = p.cSatsSpent;
    };
    try {
      if (!first.done) take(first.value);
      for (let r = await pieces.next(); !r.done; r = await pieces.next()) take(r.value);
    } catch (err) {
      req.log.warn({ err }, "portal_network_chat_failed");
      send({ error: (err as Error).message || "stream_interrupted" });
    }
    if (fullContent.length > 0) {
      await store!.addMessage({ messageId: randomUUID(), conversationId, role: "assistant", content: fullContent, ...(cSatsSpent !== undefined ? { creditsSpent: cSatsSpent } : {}) });
    }
    send({ done: true, compute: computeLabel(compute), ...(cSatsSpent !== undefined ? { cSatsSpent } : {}) });
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    return reply;
  }
  /** POST /portal/chat on one coordinator, held until its first event so a dead end can still be retried elsewhere. */
  async function openDefaultChat(url: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<OpenedDefaultChat | { reason: string; retry: boolean }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;
    let res;
    try {
      res = await request(`${url.replace(/\/+$/, "")}/portal/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        headersTimeout: 120_000, // allow time for cold model loads (~70s)
        bodyTimeout: 0, // no body timeout for streaming
        signal,
      });
    } catch (err) {
      return { reason: String(err), retry: true };
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const text = await res.body.text().catch(() => "");
      // A request the coordinator calls malformed or too large would be refused by the next one too.
      return { reason: `HTTP ${res.statusCode} ${text}`, retry: ![400, 413, 422].includes(res.statusCode) };
    }
    const events = defaultChatEvents(res.body);
    try {
      const first = await events.next();
      if (first.done) return { reason: "stream ended before any content", retry: true };
      return { events, first: first.value };
    } catch (err) {
      return { reason: String(err), retry: true };
    }
  }

  app.get("/portal/api/models", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });

    const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
    if (coordinatorUrls.length === 0) {
      return reply.send({ local: [], swarm: [] });
    }
    const coordinatorUrl = coordinatorUrls[0].replace(/\/$/, "");
    const hdrs: Record<string, string> = {};
    if (PORTAL_SERVICE_TOKEN) hdrs["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;

    let local: Array<{ name: string; parameterSize: string; quantization: string; running: boolean }> = [];
    let swarm: Array<{ model: string; paramSize: number; agentCount: number }> = [];

    // Fetch Ollama tags via coordinator proxy
    try {
      const tagsRes = await request(`${coordinatorUrl}/portal/models`, {
        method: "GET",
        headers: hdrs,
        headersTimeout: 5_000,
      });
      if (tagsRes.statusCode >= 200 && tagsRes.statusCode < 300) {
        const data = (await tagsRes.body.json()) as { local?: typeof local; swarm?: typeof swarm };
        local = data.local ?? [];
        swarm = data.swarm ?? [];
      } else {
        await tagsRes.body.text().catch(() => "");
      }
    } catch {
      // coordinator unreachable
    }

    // Fallback: try swarm models directly if coordinator didn't return them
    if (swarm.length === 0) {
      try {
        const swarmRes = await request(`${coordinatorUrl}/models/available`, {
          method: "GET",
          headers: hdrs,
          headersTimeout: 5_000,
        });
        if (swarmRes.statusCode >= 200 && swarmRes.statusCode < 300) {
          swarm = (await swarmRes.body.json()) as typeof swarm;
        } else {
          await swarmRes.body.text().catch(() => "");
        }
      } catch {
        // ignore
      }
    }

    return reply.send({ local, swarm });
  });

  app.post("/portal/api/chat", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });

    const parsedBody = z.object({
      conversationId: z.string().min(1),
      message: z.string().min(1),
      model: z.string().max(200).optional(),
      /** Run on the network for this account (billed in cSats), your own machines, or a lease; omitted: the coordinator's default chat. */
      compute: chatComputeSchema.optional(),
    }).safeParse(req.body);
    if (!parsedBody.success) return reply.code(400).send({ error: "invalid_chat_request" });
    const body = parsedBody.data;
    if (body.message.length > CHAT_MESSAGE_MAX_CHARS) {
      return reply.code(413).send({ error: "message_too_long", maxChars: CHAT_MESSAGE_MAX_CHARS });
    }

    // Only the owner may post into (and thereby read back) a conversation (audit auth#1).
    if ((await store.getConversationOwner(body.conversationId)) !== user.userId) {
      return reply.code(404).send({ error: "conversation_not_found" });
    }

    // Save user message
    await store.addMessage({
      messageId: randomUUID(),
      conversationId: body.conversationId,
      role: "user",
      content: body.message
    });

    // Build message history from conversation
    // Only a bounded tail of the conversation is loaded and sent upstream.
    const history = boundChatHistory(await store.getConversationMessages(body.conversationId, CHAT_HISTORY_MAX_MESSAGES));
    const messages = history.map((m) => ({ role: m.role, content: m.content }));

    const chatPayload: Record<string, unknown> = { messages };
    if (body.model) chatPayload.model = body.model;
    // Auto (the page's default): the network's best fit, else the coordinator's own chat.
    if (body.compute?.target === "auto") {
      return runOnNetwork(req, reply, user.userId, body.conversationId, body.compute, messages, () => runDefaultChat(req, reply, body.conversationId, chatPayload));
    }
    if (body.compute) return runOnNetwork(req, reply, user.userId, body.conversationId, body.compute, messages);
    return runDefaultChat(req, reply, body.conversationId, chatPayload);
  });

  /** The coordinator's own chat (POST /portal/chat): a named model there, or its default. */
  async function runDefaultChat(req: FastifyRequest, reply: FastifyReply, conversationId: string, chatPayload: Record<string, unknown>) {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());

    // #39: send the chat to a coordinator that reports a model to answer with, preferring the
    // configured primary. If it fails before anything was streamed, try one other.
    const tried: string[] = [];
    let lastError = "";
    let stream: OpenedDefaultChat | undefined;
    while (!stream && tried.length < CHAT_MAX_COORDINATOR_ATTEMPTS) {
      const { url, known } = await capacity.pick({ kind: "chat" }, tried);
      if (!url) {
        if (tried.length > 0) break;
        if (known === 0) return reply.code(502).send({ error: "no_coordinators_available" });
        return reply.code(503).send(NO_COMPUTE_BODY);
      }
      tried.push(url);
      const opened = await openDefaultChat(url, chatPayload, ac.signal);
      if ("events" in opened) {
        stream = opened;
        break;
      }
      lastError = opened.reason;
      if (ac.signal.aborted) return reply; // the browser went away
      capacity.markFailed(url);
      if (!opened.retry) break;
    }

    if (!stream) {
      // Upstream error text stays in the log; the client gets a fixed error.
      logger.warn({ coordinators: tried.length, lastError: lastError.slice(0, 500) }, "chat: all coordinators failed");
      return reply.code(502).send({
        error: "all_coordinators_failed",
        triedCount: tried.length,
      });
    }

    // Stream SSE response from coordinator to browser
    writeSseHead(reply);

    let fullContent = "";
    const relay = (e: DefaultChatEvent) => {
      if (e.warning) reply.raw.write(`data: ${JSON.stringify({ warning: e.warning })}\n\n`);
      if (e.content) {
        fullContent += e.content;
        reply.raw.write(`data: ${JSON.stringify({ content: e.content })}\n\n`);
      }
    };
    try {
      relay(stream.first);
      for await (const e of stream.events) relay(e);
    } catch {
      // Tokens already reached the browser, so this is not retried on another coordinator.
      reply.raw.write(`data: ${JSON.stringify({ error: "stream_interrupted" })}\n\n`);
    }

    // Save assistant message
    if (fullContent.length > 0) {
      await store.addMessage({
        messageId: randomUUID(),
        conversationId,
        role: "assistant",
        content: fullContent
      });
    }

    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    return reply;
  }
}
