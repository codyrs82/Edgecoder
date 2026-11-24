// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The desktop app's Code view chats, mirrored as sessions so the owner's phone and the web Code
 * page (code-remote.ts) can read and continue them.
 *
 * The app keeps each chat (IndexedDB) and runs its own turns over POST /v1/ide/chat, with
 * everything that view has (attachments, web, helpers, Full access). The provider keeps a mirror:
 *
 *   POST /v1/ide/code-chats/sync    {chatId, projectRoot, title?, mode?, model?, messages}  -> {sessionId}
 *   POST /v1/ide/code-chats/forget  {chatId}   the chat was deleted in the app: its mirror goes too
 *
 * The app syncs when a chat opens and after each turn; the mirror gets the messages it lacks (by id).
 * Syncing marks the folder as used in the Code view (workspace-trust.ts markCodeProject), which
 * opens it to the phone but never trusts its own tooling.
 *
 * While the app runs a turn, /v1/ide/chat shows it as the mirror's running turn (desktopTurnFor):
 * the phone sees it live, may stop it and answer its approvals (the ones a phone turn could). A
 * message from the phone runs a turn here (SessionHub, remote rules) over the whole chat; the app
 * follows the mirror's events and adds those messages to its own copy.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApprovalAnswer, ApprovalAsk } from "./agent-loop.js";
import type { DesktopTurn, SessionHub } from "./sessions.js";
import type { ToolName } from "./tool-types.js";
import { markCodeProject } from "./workspace-trust.js";

export const MAX_SYNC_MESSAGES = 2_000;
/** A long chat with big replies: well above Fastify's 1 MB default. */
export const SYNC_BODY_LIMIT = 16 * 1024 * 1024;

const messageSchema = z.object({
  id: z.string().min(1).max(100),
  role: z.enum(["user", "assistant"]),
  content: z.string().max(400_000),
  at: z.number().finite().nonnegative(),
  turnId: z.string().uuid().optional(),
  changedFiles: z.array(z.string().max(4096)).max(500).optional(),
  plan: z.boolean().optional(),
});

export const syncSchema = z.object({
  chatId: z.string().uuid(),
  projectRoot: z.string().min(1).max(4096).refine((p) => isAbsolute(p), "projectRoot must be an absolute path"),
  title: z.string().max(200).optional(),
  mode: z.enum(["ask", "auto-edits", "auto", "plan", "full"]).optional(),
  model: z.string().min(1).max(200).optional(),
  messages: z.array(messageSchema).max(MAX_SYNC_MESSAGES),
});

export function registerDesktopChatRoutes(app: FastifyInstance, hub: SessionHub): void {
  app.post("/v1/ide/code-chats/sync", { bodyLimit: SYNC_BODY_LIMIT }, async (req, reply) => {
    const b = syncSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid", message: b.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    let isDir = false;
    try {
      isDir = existsSync(b.data.projectRoot) && statSync(b.data.projectRoot).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return reply.status(400).send({ error: "invalid", message: "projectRoot isn't a folder." });
    const known = hub.desktopChat(b.data.chatId);
    // A chat stays with the folder it was made in.
    if (known && known.projectRoot !== b.data.projectRoot) return reply.status(409).send({ error: "other_project", sessionId: known.id });
    markCodeProject(b.data.projectRoot);
    const s = hub.syncDesktopChat({
      chatId: b.data.chatId,
      projectRoot: b.data.projectRoot,
      messages: b.data.messages,
      ...(b.data.title ? { title: b.data.title } : {}),
      ...(b.data.mode ? { mode: b.data.mode } : {}),
      ...(b.data.model ? { model: b.data.model } : {}),
    });
    return reply.send({ sessionId: s.id, messages: s.transcript.length });
  });

  app.post("/v1/ide/code-chats/forget", async (req, reply) => {
    const b = z.object({ chatId: z.string().uuid() }).safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid" });
    const s = hub.desktopChat(b.data.chatId);
    if (s) hub.remove(s.id, { clientId: "desktop-chat", kind: "desktop" });
    return reply.send({ removed: !!s });
  });
}

/** The mirror's view of the app's turn for `chatId` (null: no mirror yet, or a turn already runs there). */
export function desktopTurnFor(hub: SessionHub, chatId: string | undefined, turnId: string, abort: AbortController): DesktopTurn | null {
  if (!chatId) return null;
  const s = hub.desktopChat(chatId);
  return s ? hub.beginDesktopTurn(s.id, turnId, abort) : null;
}

/**
 * A call in the app's turn waits for its first answer: the app's (`register` hands over the answer
 * function, /v1/ide/tool-approval calls it), the phone's (through the mirror), or no after `timeoutMs`.
 * An answer from the app takes the call off the mirror's pending list.
 */
export function firstAnswer(
  call: { id: string; tool: ToolName; args: Record<string, unknown>; ask?: ApprovalAsk },
  mirror: DesktopTurn | null,
  register: (answer: (approved: ApprovalAnswer) => void) => void,
  unregister: () => void,
  timeoutMs: number,
): Promise<ApprovalAnswer> {
  return new Promise<ApprovalAnswer>((resolve) => {
    let settled = false;
    // The phone answers one call at a time (true/false); only the app answers "run".
    const settle = (approved: ApprovalAnswer, fromMirror = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregister();
      if (!fromMirror) mirror?.answered(call.id, approved !== false);
      resolve(approved);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    register((approved) => settle(approved));
    void mirror?.ask(call.id, call.tool, call.args, call.ask).then((approved) => settle(approved, true));
  });
}
