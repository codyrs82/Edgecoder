// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PortalRouteDeps } from "./deps.js";

/** Longest conversation title, in characters. */
export const CONVERSATION_TITLE_MAX_CHARS = 200;
/** GET .../messages returns at most this many of the latest messages. */
export const CONVERSATION_MESSAGES_PAGE = 500;

/** #16: chat conversation CRUD (/portal/api/conversations). Moved unchanged from server.ts. */
export function registerConversationRoutes(app: FastifyInstance, { store, getCurrentUser }: PortalRouteDeps): void {
  app.get("/portal/api/conversations", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const conversations = await store.listConversations(user.userId);
    return reply.send({ conversations });
  });

  app.post("/portal/api/conversations", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const parsed = z.object({ title: z.string().max(CONVERSATION_TITLE_MAX_CHARS).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_title", maxChars: CONVERSATION_TITLE_MAX_CHARS });
    const body = parsed.data;
    const conversationId = randomUUID();
    await store.createConversation({ conversationId, userId: user.userId, title: body.title });
    return reply.send({ conversationId });
  });

  app.get("/portal/api/conversations/:id/messages", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { id } = req.params as { id: string };
    if ((await store.getConversationOwner(id)) !== user.userId) return reply.code(404).send({ error: "not_found" });
    const messages = await store.getConversationMessages(id, CONVERSATION_MESSAGES_PAGE);
    return reply.send({ messages });
  });

  app.patch("/portal/api/conversations/:id", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { id } = req.params as { id: string };
    if ((await store.getConversationOwner(id)) !== user.userId) return reply.code(404).send({ error: "not_found" });
    const parsed = z.object({ title: z.string().min(1).max(CONVERSATION_TITLE_MAX_CHARS) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_title", maxChars: CONVERSATION_TITLE_MAX_CHARS });
    const body = parsed.data;
    await store.renameConversation(id, body.title);
    return reply.send({ ok: true });
  });

  app.delete("/portal/api/conversations/:id", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { id } = req.params as { id: string };
    if ((await store.getConversationOwner(id)) !== user.userId) return reply.code(404).send({ error: "not_found" });
    await store.deleteConversation(id);
    return reply.send({ ok: true });
  });
}
