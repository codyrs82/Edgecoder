// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PortalRouteDeps } from "./deps.js";

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
    const body = z.object({ title: z.string().optional() }).parse(req.body);
    const conversationId = randomUUID();
    await store.createConversation({ conversationId, userId: user.userId, title: body.title });
    return reply.send({ conversationId });
  });

  app.get("/portal/api/conversations/:id/messages", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { id } = req.params as { id: string };
    const messages = await store.getConversationMessages(id);
    return reply.send({ messages });
  });

  app.patch("/portal/api/conversations/:id", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { id } = req.params as { id: string };
    const body = z.object({ title: z.string().min(1) }).parse(req.body);
    await store.renameConversation(id, body.title);
    return reply.send({ ok: true });
  });

  app.delete("/portal/api/conversations/:id", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { id } = req.params as { id: string };
    await store.deleteConversation(id);
    return reply.send({ ok: true });
  });
}
