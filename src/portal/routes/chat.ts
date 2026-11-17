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
import type { Served } from "../../common/served.js";
import type { ReplyUsage } from "../reply-usage.js";

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

/**
 * How long a chat may stay silent before the browser gets the SSE head and a first heartbeat, and
 * how often a heartbeat (an SSE comment) follows. A refusal inside the grace keeps its HTTP status.
 * Without this, a reply whose first token took over a minute (the coordinator's own CPU model after
 * a restart) sent the browser nothing at all, and iOS Safari gave up with "Load failed".
 */
export const CHAT_KEEPALIVE = { graceMs: 4_000, intervalMs: 15_000 };

/** The reply to one /portal/api/chat: an HTTP error while nothing was sent, then SSE with heartbeats. */
export interface ChatResponse {
  /** Whether the SSE head went out (errors are then events, not statuses). */
  readonly streaming: boolean;
  /** A data event (sends the head first if needed). */
  send(o: unknown): void;
  /** A note for the page's "Thinking..." line (sent with the SSE head, when that goes out). */
  status(text: string): void;
  /** A failure before any reply: an HTTP status while nothing was sent, else an error event and the end. */
  fail(status: number, body: Record<string, unknown>): FastifyReply;
  /** [DONE] and the end of the stream. */
  end(): FastifyReply;
}

export function chatResponse(reply: FastifyReply, timing: { graceMs: number; intervalMs: number } = CHAT_KEEPALIVE): ChatResponse {
  let streaming = false;
  let interval: NodeJS.Timeout | undefined;
  let pendingStatus: string | undefined;
  const open = () => !reply.raw.writableEnded && !reply.raw.destroyed;
  const head = () => {
    if (streaming) return;
    streaming = true;
    // From here the response is ours: Fastify must never try to send a status or an error body on
    // it. Without this, an error thrown after the stream began (a failed save) went to Fastify's
    // error handler, whose writeHead threw ERR_HTTP_HEADERS_SENT and took the portal process down,
    // cutting the browser's stream after the full reply (2026-11-17).
    reply.hijack();
    writeSseHead(reply);
    if (pendingStatus !== undefined && open()) reply.raw.write(`data: ${JSON.stringify({ status: pendingStatus })}\n\n`);
  };
  const ping = () => {
    if (open()) reply.raw.write(": keepalive\n\n");
  };
  const grace = setTimeout(() => {
    if (!open()) return;
    head();
    ping();
    interval = setInterval(ping, timing.intervalMs);
  }, timing.graceMs);
  const stop = () => {
    clearTimeout(grace);
    if (interval) clearInterval(interval);
  };
  reply.raw.on("close", stop);
  const send = (o: unknown) => {
    head();
    if (open()) reply.raw.write(`data: ${JSON.stringify(o)}\n\n`);
  };
  const end = () => {
    stop();
    head();
    if (open()) {
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    }
    return reply;
  };
  return {
    get streaming() {
      return streaming;
    },
    send,
    status(text) {
      if (streaming) send({ status: text });
      else pendingStatus = text;
    },
    fail(status, body) {
      if (!streaming) {
        stop();
        return reply.code(status).send(body);
      }
      send({ ...body, httpStatus: status });
      return end();
    },
    end,
  };
}

/** The out-of-cSats answer for Auto (#405 wording on the page: "Couldn't run: out of cSats", Buy cSats). */
export const OUT_OF_CSATS_CODE = "out_of_csats";

/** #39: sent when no coordinator can serve the chat. The chat page shows `error` as it is. */
export const NO_COMPUTE_BODY = { error: "No compute is available right now. Try again in a moment.", code: "no_compute_available" } as const;

/** The coordinator's own chat reports its model, token counts and timings once, at the end. */
export interface DefaultChatUsage {
  model?: string;
  promptTokens?: number;
  outputTokens?: number;
  promptMs?: number;
  genMs?: number;
}
type DefaultChatEvent = { content?: string; warning?: string; usage?: DefaultChatUsage };

export type { ReplyUsage } from "../reply-usage.js";

/** A network / own-machine / reserved reply's usage from the backend's final piece. */
export function networkReplyUsage(compute: ChatCompute, done: Extract<ChatPiece, { done: true }> | undefined): ReplyUsage {
  const cSats = done?.cSatsSpent ?? 0;
  const where = done?.where ?? computeLabel(compute);
  const served = done?.served
    ? {
        ...done.served,
        ...(done.served.promptTokens === undefined && done.promptTokens !== undefined ? { promptTokens: done.promptTokens } : {}),
        ...(done.served.outputTokens === undefined && done.outputTokens !== undefined ? { outputTokens: done.outputTokens } : {}),
      }
    : undefined;
  const model = done?.servedBy ?? ("model" in compute && compute.model ? compute.model : undefined);
  return { cSats, where, calls: [{ cSats, where, ...(model ? { model } : {}), ...(served ? { served } : {}) }] };
}

/** The coordinator's own chat (free): "EdgeCoder's model" with its counts and timings. */
export function defaultReplyUsage(u: DefaultChatUsage | undefined): ReplyUsage {
  const where = "EdgeCoder's model";
  const served: Served = {
    label: "EdgeCoder",
    own: false,
    computeClass: "edgecoder",
    tier: null,
    hardware: where,
    region: null,
    country: null,
    ...(u?.promptTokens !== undefined ? { promptTokens: u.promptTokens } : {}),
    ...(u?.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
    ...(u?.promptMs !== undefined ? { promptMs: u.promptMs } : {}),
    ...(u?.genMs !== undefined ? { genMs: u.genMs } : {}),
  };
  return { cSats: 0, where, calls: [{ cSats: 0, where, ...(u?.model ? { model: u.model } : {}), served }] };
}

function usageNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

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
    const u = parsed.usage as Record<string, unknown> | undefined;
    if (u && typeof u === "object") {
      const usage: DefaultChatUsage = {};
      if (typeof u.model === "string" && u.model) usage.model = u.model.slice(0, 200);
      for (const k of ["promptTokens", "outputTokens", "promptMs", "genMs"] as const) {
        const v = usageNumber(u[k]);
        if (v !== undefined) usage[k] = v;
      }
      yield { usage };
    }
  }
}

/** Errors raised before a request reached the coordinator: nothing ran there, so another one may be tried. */
function failedBeforeSend(err: unknown): boolean {
  const code = String((err as { code?: unknown } | null)?.code ?? "");
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "UND_ERR_CONNECT_TIMEOUT";
}

/** #16: Chat API: model list and streaming chat (/portal/api/models, /portal/api/chat). Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerChatApiRoutes(
  app: FastifyInstance,
  deps: Omit<ChatApiRoutesDeps, "ownMachineModels"> & {
    /** Models on the user's own online machines, best first (Auto tries them first, free). */
    ownMachineModels?: (userId: string) => Promise<string[]>;
    /** Tests: shorter heartbeat timing. */
    chatKeepalive?: { graceMs: number; intervalMs: number };
  },
): void {
  const { PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal, getCurrentUser, store } = deps;
  // #39: server.ts passes the directory. Without one (tests), build it over the discovered list,
  // which the caller has already put through the coordinator URL policy.
  const capacity: ChatCapacityDirectory =
    (deps.chatCapacity as ChatCapacityDirectory | undefined) ??
    createChatCapacityDirectory({ candidates: discoverCoordinatorUrlsForPortal, allowed: () => true, serviceToken: PORTAL_SERVICE_TOKEN });

  /** Saves the assistant's reply; a failure is logged, never thrown (the reply already reached the browser). */
  async function saveReply(req: FastifyRequest, conversationId: string, content: string, cSatsSpent: number | undefined, usage: ReplyUsage): Promise<void> {
    if (!store || content.length === 0) return;
    try {
      await store.addMessage({ messageId: randomUUID(), conversationId, role: "assistant", content, ...(cSatsSpent !== undefined ? { creditsSpent: cSatsSpent } : {}), usageMeta: usage });
    } catch (err) {
      req.log.error({ err, conversationId }, "portal_chat_save_reply_failed");
    }
  }

  /** A chat on a chosen compute, through networkBackend for the user's account; streams {content} then {done, cSatsSpent}. */
  async function runOnNetwork(
    req: FastifyRequest,
    reply: FastifyReply,
    out: ChatResponse,
    userId: string,
    conversationId: string,
    compute: ChatCompute,
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
    /** Auto only: where the chat goes when this compute turns it down before any reply (given the refusal, if any). */
    fallback?: (refusal: unknown) => Promise<unknown>
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
        if (fallback) return fallback(undefined);
        if (known === 0) return out.fail(502, { error: "no_coordinators_available", compute: computeLabel(compute) });
        return out.fail(503, { ...NO_COMPUTE_BODY, compute: computeLabel(compute) });
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
      if (ac.signal.aborted) return reply; // the browser went away
      // Auto: nothing ran and nothing was charged, so the next place in line is asked.
      if (fallback) {
        req.log.info({ compute: computeLabel(compute), reason: (refusal as Error | undefined)?.message?.slice(0, 200) }, "portal_auto_chat_fallback");
        return fallback(refusal);
      }
      const status = refusal instanceof ChatBackendError ? refusal.status : 502;
      return out.fail(status >= 400 && status < 600 ? status : 502, { error: (refusal as Error | undefined)?.message ?? "all_coordinators_failed", compute: computeLabel(compute) });
    }
    const send = out.send;
    let fullContent = "";
    let cSatsSpent: number | undefined;
    let donePiece: Extract<ChatPiece, { done: true }> | undefined;
    const take = (p: ChatPiece) => {
      if ("delta" in p && p.delta) {
        fullContent += p.delta;
        send({ content: p.delta });
      } else if ("done" in p) {
        cSatsSpent = p.cSatsSpent;
        donePiece = p;
      }
    };
    try {
      if (!first.done) take(first.value);
      for (let r = await pieces.next(); !r.done; r = await pieces.next()) take(r.value);
    } catch (err) {
      req.log.warn({ err }, "portal_network_chat_failed");
      send({ error: (err as Error).message || "stream_interrupted" });
    }
    const usage = networkReplyUsage(compute, donePiece);
    await saveReply(req, conversationId, fullContent, cSatsSpent, usage);
    send({ done: true, compute: computeLabel(compute), ...(cSatsSpent !== undefined ? { cSatsSpent } : {}), usage });
    return out.end();
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
      /** The page's Retry: the same message again; it is not saved a second time when it is already the last one. */
      resend: z.boolean().optional(),
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

    // Save user message (a Retry of the last one is not saved twice)
    const last = body.resend ? (await store.getConversationMessages(body.conversationId, 1)).at(-1) : undefined;
    if (!(last && last.role === "user" && last.content === body.message)) {
      await store.addMessage({
        messageId: randomUUID(),
        conversationId: body.conversationId,
        role: "user",
        content: body.message
      });
    }

    // Build message history from conversation
    // Only a bounded tail of the conversation is loaded and sent upstream.
    const history = boundChatHistory(await store.getConversationMessages(body.conversationId, CHAT_HISTORY_MAX_MESSAGES));
    const messages = history.map((m) => ({ role: m.role, content: m.content }));

    const chatPayload: Record<string, unknown> = { messages };
    if (body.model) chatPayload.model = body.model;
    // From here a slow first token keeps the browser's request alive (heartbeats after a short grace).
    const out = chatResponse(reply, deps.chatKeepalive ?? CHAT_KEEPALIVE);
    try {
      if (body.compute?.target === "auto") return await runAuto(req, reply, out, user.userId, body.conversationId, body.compute, messages, chatPayload);
      if (body.compute) return await runOnNetwork(req, reply, out, user.userId, body.conversationId, body.compute, messages);
      return await runDefaultChat(req, reply, out, body.conversationId, chatPayload);
    } catch (err) {
      // Every path ends with a terminator: an unexpected error is an error event and [DONE], never
      // a dropped connection (or, before the head, a plain 500).
      req.log.error({ err }, "portal_chat_failed");
      return out.fail(500, { error: "chat_failed" });
    }
  });

  /**
   * Auto (the page's default): your own online machines first (free), then the network's best fit.
   * When the network turns it down for cSats the answer is that, in words the page turns into
   * "Couldn't run: out of cSats" with Buy cSats; any other refusal goes to the coordinator's own chat.
   */
  async function runAuto(
    req: FastifyRequest,
    reply: FastifyReply,
    out: ChatResponse,
    userId: string,
    conversationId: string,
    compute: ChatCompute,
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
    chatPayload: Record<string, unknown>,
  ) {
    const network = () =>
      runOnNetwork(req, reply, out, userId, conversationId, compute, messages, async (refusal) => {
        if (refusal instanceof ChatBackendError && refusal.status === 402) {
          return out.fail(402, { error: refusal.message, code: OUT_OF_CSATS_CODE, compute: computeLabel(compute) });
        }
        out.status("Answering with EdgeCoder's own model (free, slower)...");
        return runDefaultChat(req, reply, out, conversationId, chatPayload);
      });
    const own = deps.ownMachineModels ? await deps.ownMachineModels(userId).catch(() => [] as string[]) : [];
    // Which way Auto went (your own machine's model, or none found): the log answers "why not mine?".
    req.log.info({ ownModels: own.slice(0, 5) }, "portal_auto_chat_own_machines");
    if (own.length === 0) return network();
    return runOnNetwork(req, reply, out, userId, conversationId, { target: "mine", model: own[0] }, messages, network);
  }

  /** The coordinator's own chat (POST /portal/chat): a named model there, or its default. */
  async function runDefaultChat(req: FastifyRequest, reply: FastifyReply, out: ChatResponse, conversationId: string, chatPayload: Record<string, unknown>) {
    if (!store) return out.fail(503, { error: "portal_database_not_configured" });
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
        if (known === 0) return out.fail(502, { error: "no_coordinators_available" });
        return out.fail(503, { ...NO_COMPUTE_BODY });
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
      return out.fail(502, {
        error: "all_coordinators_failed",
        triedCount: tried.length,
      });
    }

    // Stream SSE response from coordinator to browser
    let fullContent = "";
    let usage: DefaultChatUsage | undefined;
    const relay = (e: DefaultChatEvent) => {
      if (e.usage) usage = e.usage;
      if (e.warning) out.send({ warning: e.warning });
      if (e.content) {
        fullContent += e.content;
        out.send({ content: e.content });
      }
    };
    try {
      relay(stream.first);
      for await (const e of stream.events) relay(e);
    } catch {
      // Tokens already reached the browser, so this is not retried on another coordinator.
      out.send({ error: "stream_interrupted" });
    }

    const replyUsage = defaultReplyUsage(usage);
    await saveReply(req, conversationId, fullContent, undefined, replyUsage);
    out.send({ done: true, usage: replyUsage });
    return out.end();
  }
}
