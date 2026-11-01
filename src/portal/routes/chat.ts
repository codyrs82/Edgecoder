// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import type { ChatApiRoutesDeps } from "../server.js";

/** #16: Chat API: model list and streaming chat (/portal/api/models, /portal/api/chat). Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerChatApiRoutes(app: FastifyInstance, { PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal, getCurrentUser, store }: ChatApiRoutesDeps): void {
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

    const body = z.object({
      conversationId: z.string().min(1),
      message: z.string().min(1),
      model: z.string().optional(),
    }).parse(req.body);

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
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

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
