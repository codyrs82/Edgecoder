// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { z } from "zod";

/**
 * Account setting: share chat context to improve EdgeCoder (opt-in, default off).
 *   GET /me/chat-sharing  -> { shareChatForImprovement, updatedAtMs }
 *   PUT /me/chat-sharing  { shareChatForImprovement: boolean }
 * Chat stays encrypted at rest either way (src/portal/chat-crypto.ts); the flag records consent, and
 * PortalStore.listSharedChatMessages only returns messages of users who have it on.
 */
export type ChatSharingStore = {
  getChatSharing(userId: string): Promise<{ shareChatForImprovement: boolean; updatedAtMs: number | null }>;
  setChatSharing(userId: string, share: boolean, atMs?: number): Promise<void>;
};

export function registerChatSharingRoutes(
  app: FastifyInstance,
  { store, getCurrentUser }: { store: ChatSharingStore | null; getCurrentUser: (req: any) => Promise<{ userId: string } | null> }
): void {
  app.get("/me/chat-sharing", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    return reply.send(await store.getChatSharing(user.userId));
  });

  app.put("/me/chat-sharing", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const body = z.object({ shareChatForImprovement: z.boolean() }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: "Send { shareChatForImprovement: true | false }." });
    const atMs = Date.now();
    await store.setChatSharing(user.userId, body.data.shareChatForImprovement, atMs);
    return reply.send({ shareChatForImprovement: body.data.shareChatForImprovement, updatedAtMs: atMs });
  });
}
