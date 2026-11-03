// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { writeSseHead } from "../../common/sse.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import type { ChatApiRoutesDeps } from "../server.js";
import { networkBackend } from "../../inference-api/backends.js";
import { ChatBackendError, type ChatPiece } from "../../inference-api/types.js";
import { accountIdFor, chatComputeSchema, computeLabel, networkTargetFor, portalNetworkDeps, type ChatCompute } from "./compute.js";

/** #16: Chat API: model list and streaming chat (/portal/api/models, /portal/api/chat). Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerChatApiRoutes(app: FastifyInstance, deps: ChatApiRoutesDeps): void {
  const { PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal, getCurrentUser, store } = deps;

  /** A chat on a chosen compute, through networkBackend for the user's account; streams {content} then {done, cSatsSpent}. */
  async function runOnNetwork(
    req: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    conversationId: string,
    compute: ChatCompute,
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>
  ) {
    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());
    const pieces = networkBackend(portalNetworkDeps(deps, accountIdFor(userId)), networkTargetFor(compute))({ messages }, ac.signal);
    // Wait for the first piece so a refusal (no machine, not enough cSats, lease ended) is a plain HTTP error.
    let first: IteratorResult<ChatPiece>;
    try {
      first = await pieces.next();
    } catch (err) {
      const status = err instanceof ChatBackendError ? err.status : 502;
      return reply.code(status >= 400 && status < 600 ? status : 502).send({ error: (err as Error).message, compute: computeLabel(compute) });
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
      model: z.string().optional(),
      /** Run on the network for this account (billed in cSats), your own machines, or a lease; omitted: the coordinator's default chat. */
      compute: chatComputeSchema.optional(),
    }).safeParse(req.body);
    if (!parsedBody.success) return reply.code(400).send({ error: "invalid_chat_request" });
    const body = parsedBody.data;

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
    const history = await store.getConversationMessages(body.conversationId);
    const messages = history.map((m) => ({ role: m.role, content: m.content }));

    if (body.compute) return runOnNetwork(req, reply, user.userId, body.conversationId, body.compute, messages);

    // Discover coordinators
    const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
    if (coordinatorUrls.length === 0) {
      return reply.code(502).send({ error: "no_coordinators_available" });
    }

    // Call coordinator's portal chat endpoint (streams Ollama via SSE)
    const chatHeaders: Record<string, string> = { "content-type": "application/json" };
    if (PORTAL_SERVICE_TOKEN) chatHeaders["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;

    const chatPayload: Record<string, unknown> = { messages };
    if (body.model) chatPayload.model = body.model;

    // Try each coordinator until one responds with 2xx
    let coordinatorRes;
    let lastError = "";
    for (const rawUrl of coordinatorUrls) {
      const coordinatorUrl = rawUrl.replace(/\/$/, "");
      try {
        coordinatorRes = await request(`${coordinatorUrl}/portal/chat`, {
          method: "POST",
          headers: chatHeaders,
          body: JSON.stringify(chatPayload),
          headersTimeout: 120_000, // allow time for cold model loads (~70s)
          bodyTimeout: 0, // no body timeout for streaming
        });
        if (coordinatorRes.statusCode >= 200 && coordinatorRes.statusCode < 300) {
          break; // success — stream this response
        }
        // Non-2xx: consume body, try next coordinator
        lastError = await coordinatorRes.body.text().catch(() => "");
        coordinatorRes = null;
      } catch (err) {
        lastError = String(err);
        coordinatorRes = null;
      }
    }

    if (!coordinatorRes) {
      return reply.code(502).send({
        error: "all_coordinators_failed",
        detail: lastError,
        triedCount: coordinatorUrls.length,
      });
    }

    // Stream SSE response from coordinator to browser
    writeSseHead(reply);

    let fullContent = "";
    try {
      for await (const chunk of coordinatorRes.body) {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        for (const line of text.split("\n")) {
          const trimmed = line.replace(/^data:\s*/, "").trim();
          if (!trimmed) continue;
          if (trimmed === "[DONE]") break;
          try {
            const parsed = JSON.parse(trimmed) as { content?: string; warning?: string };
            if (parsed.warning) {
              reply.raw.write(`data: ${JSON.stringify({ warning: parsed.warning })}\n\n`);
            }
            if (parsed.content) {
              fullContent += parsed.content;
              reply.raw.write(`data: ${JSON.stringify({ content: parsed.content })}\n\n`);
            }
          } catch {
            // skip unparseable lines
          }
        }
      }
    } catch {
      reply.raw.write(`data: ${JSON.stringify({ error: "stream_interrupted" })}\n\n`);
    }

    // Save assistant message
    if (fullContent.length > 0) {
      await store.addMessage({
        messageId: randomUUID(),
        conversationId: body.conversationId,
        role: "assistant",
        content: fullContent
      });
    }

    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
  });
}
