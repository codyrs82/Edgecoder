// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Shared coding sessions over HTTP (sessions.ts), on the IDE provider: 127.0.0.1 and the IDE
 * token only, like every other provider route. Mutations are POST (the desktop's CORS allows GET
 * and POST). Every write names the client (`clientId`, `kind`, `label`); sessions are co-edited,
 * so any attached client may send, answer approvals and change settings.
 *
 *   GET  /v1/ide/sessions[?projectRoot=&published=1]   summaries
 *   POST /v1/ide/sessions                              create (the creator is in control)
 *   GET  /v1/ide/sessions/:id                          snapshot
 *   GET  /v1/ide/sessions/:id/events?since=N&clientId=&kind=&label=   SSE: replay after N, then live
 *   POST /v1/ide/sessions/:id/messages   {text}        start a turn, or queue it while one runs
 *   POST /v1/ide/sessions/:id/unqueue    {queuedId}    remove a queued message before it starts
 *   POST /v1/ide/sessions/:id/approve    {callId, approved, always?}   first answer wins
 *   POST /v1/ide/sessions/:id/control    {release?}    no-op, kept for older clients
 *   POST /v1/ide/sessions/:id/settings   {model? (= leadModel), leadModel?, workerModel?, title?, mode?, autoApprove?}
 *   POST /v1/ide/sessions/:id/publish    {published}   show it live in the desktop app
 *   POST /v1/ide/sessions/:id/trust      {trusted}     trust the session's project folder (workspace-trust.ts)
 *   POST /v1/ide/sessions/:id/cancel | /undo {turnId?} | /clear | /delete
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { writeSseHead } from "../../common/sse.js";
import { SessionError, type ClientRef, type SessionHub } from "./sessions.js";
import { isProjectTrusted, setProjectTrusted } from "./workspace-trust.js";

const STATUS: Record<SessionError["code"], number> = {
  not_found: 404,
  busy: 409,
  invalid: 400,
  checkpoint_gone: 410,
  nothing_to_undo: 409,
};

const client = {
  clientId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  kind: z.enum(["terminal", "desktop", "api"]).default("api"),
  label: z.string().max(80).optional(),
};
const clientSchema = z.object(client);
const idParams = z.object({ id: z.string().uuid() });

function refOf(b: { clientId: string; kind: ClientRef["kind"]; label?: string }): ClientRef {
  return { clientId: b.clientId, kind: b.kind, ...(b.label ? { label: b.label } : {}) };
}

async function handle(reply: FastifyReply, fn: () => unknown): Promise<unknown> {
  try {
    return reply.send(await fn());
  } catch (err) {
    if (err instanceof SessionError) return reply.status(STATUS[err.code]).send({ error: err.code, message: err.message, ...err.extra });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "invalid", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    throw err;
  }
}

export function registerSessionRoutes(app: FastifyInstance, hub: SessionHub): void {
  app.get("/v1/ide/sessions", (req, reply) =>
    handle(reply, () => {
      const q = z.object({ projectRoot: z.string().max(4096).optional(), published: z.enum(["0", "1"]).optional() }).parse(req.query ?? {});
      return { sessions: hub.list({ projectRoot: q.projectRoot, ...(q.published ? { published: q.published === "1" } : {}) }) };
    }));

  app.post("/v1/ide/sessions", (req, reply) =>
    handle(reply, () => {
      const b = z
        .object({
          ...client,
          projectRoot: z.string().min(1).max(4096).refine((p) => isAbsolute(p), "projectRoot must be an absolute path"),
          model: z.string().min(1).max(200).optional(),
          workerModel: z.string().min(1).max(200).optional(),
          title: z.string().max(120).optional(),
          autoApprove: z.enum(["none", "edits"]).optional(),
          mode: z.enum(["ask", "auto-edits", "auto"]).optional(),
          published: z.boolean().optional(),
        })
        .parse(req.body ?? {});
      if (!existsSync(b.projectRoot) || !statSync(b.projectRoot).isDirectory()) throw new SessionError("invalid", `${b.projectRoot} isn't a folder.`);
      const s = hub.create({ projectRoot: b.projectRoot, model: b.model, workerModel: b.workerModel, title: b.title, autoApprove: b.autoApprove, mode: b.mode, client: refOf(b) });
      if (b.published) hub.publish(s.id, true, refOf(b));
      return { ...hub.snapshot(s.id), trusted: isProjectTrusted(s.projectRoot) };
    }));

  app.get("/v1/ide/sessions/:id", (req, reply) =>
    handle(reply, () => {
      const { id } = idParams.parse(req.params);
      const snap = hub.snapshot(id);
      return { ...snap, trusted: isProjectTrusted(snap.session.projectRoot) };
    }));

  app.get("/v1/ide/sessions/:id/events", async (req, reply) => {
    const p = idParams.safeParse(req.params);
    const q = z.object({ ...client, since: z.coerce.number().int().min(0).default(0) }).safeParse(req.query ?? {});
    if (!p.success || !q.success) return reply.status(400).send({ error: "invalid" });
    let unsubscribe: (() => void) | null = null;
    try {
      hub.snapshot(p.data.id);
    } catch (err) {
      if (err instanceof SessionError) return reply.status(STATUS[err.code]).send({ error: err.code, message: err.message });
      throw err;
    }
    writeSseHead(reply);
    reply.raw.write(": connected\n\n");
    const write = (e: unknown) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    unsubscribe = hub.subscribe(p.data.id, refOf(q.data), q.data.since, write);
    // Keep idle connections (proxies, SSH tunnels) open.
    const ping = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n");
    }, 15_000);
    reply.raw.on("close", () => {
      clearInterval(ping);
      unsubscribe?.();
    });
    return reply;
  });

  app.post("/v1/ide/sessions/:id/messages", (req, reply) =>
    handle(reply, () => {
      const { id } = idParams.parse(req.params);
      const b = z.object({ ...client, text: z.string().min(1).max(100_000) }).parse(req.body ?? {});
      return hub.send(id, b.text, refOf(b));
    }));

  app.post("/v1/ide/sessions/:id/unqueue", (req, reply) =>
    handle(reply, () => {
      const { id } = idParams.parse(req.params);
      const b = z.object({ ...client, queuedId: z.string().min(1).max(100) }).parse(req.body ?? {});
      return { removed: hub.unqueue(id, b.queuedId, refOf(b)) };
    }));

  app.post("/v1/ide/sessions/:id/approve", (req, reply) =>
    handle(reply, () => {
      const { id } = idParams.parse(req.params);
      const b = z.object({ ...client, callId: z.string().min(1).max(100), approved: z.boolean(), always: z.boolean().default(false) }).parse(req.body ?? {});
      // A second answer (another client answered first) is not an error: it changes nothing.
      const applied = hub.approve(id, b.callId, b.approved, refOf(b), b.always);
      return { ok: true, applied, ...(applied ? {} : { reason: "already_answered" }) };
    }));

  app.post("/v1/ide/sessions/:id/control", (req, reply) =>
    handle(reply, () => {
      const { id } = idParams.parse(req.params);
      const b = z.object({ ...client, release: z.boolean().default(false) }).parse(req.body ?? {});
      if (b.release) {
        hub.release(id, refOf(b));
        return { controller: hub.snapshot(id).controller };
      }
      return { controller: hub.takeControl(id, refOf(b)) };
    }));

  app.post("/v1/ide/sessions/:id/settings", (req, reply) =>
    handle(reply, () => {
      const { id } = idParams.parse(req.params);
      const b = z.object({ ...client, model: z.string().min(1).max(200).optional(), leadModel: z.string().min(1).max(200).optional(), workerModel: z.string().min(1).max(200).optional(), title: z.string().max(120).optional(), autoApprove: z.enum(["none", "edits"]).optional(), mode: z.enum(["ask", "auto-edits", "auto"]).optional() }).parse(req.body ?? {});
      const s = hub.update(id, { model: b.model, leadModel: b.leadModel, workerModel: b.workerModel, title: b.title, autoApprove: b.autoApprove, mode: b.mode }, refOf(b));
      return { session: s };
    }));

  app.post("/v1/ide/sessions/:id/publish", (req, reply) =>
    handle(reply, () => {
      const { id } = idParams.parse(req.params);
      const b = z.object({ ...client, published: z.boolean() }).parse(req.body ?? {});
      hub.publish(id, b.published, refOf(b));
      return { ok: true, published: b.published };
    }));

  app.post("/v1/ide/sessions/:id/trust", (req, reply) =>
    handle(reply, () => {
      const { id } = idParams.parse(req.params);
      const b = z.object({ ...client, trusted: z.boolean() }).parse(req.body ?? {});
      const root = hub.snapshot(id).session.projectRoot;
      hub.assertControl(id, refOf(b));
      setProjectTrusted(root, b.trusted);
      return { projectRoot: root, trusted: isProjectTrusted(root) };
    }));

  app.post("/v1/ide/sessions/:id/cancel", (req, reply) =>
    handle(reply, () => {
      const { id } = idParams.parse(req.params);
      return { stopped: hub.cancel(id, refOf(clientSchema.parse(req.body ?? {}))) };
    }));

  app.post("/v1/ide/sessions/:id/undo", (req, reply) =>
    handle(reply, () => {
      const { id } = idParams.parse(req.params);
      const b = z.object({ ...client, turnId: z.string().uuid().optional() }).parse(req.body ?? {});
      return hub.undo(id, refOf(b), b.turnId);
    }));

  app.post("/v1/ide/sessions/:id/clear", (req, reply) =>
    handle(reply, () => {
      const { id } = idParams.parse(req.params);
      hub.clear(id, refOf(clientSchema.parse(req.body ?? {})));
      return { ok: true };
    }));

  app.post("/v1/ide/sessions/:id/delete", (req, reply) =>
    handle(reply, () => {
      const { id } = idParams.parse(req.params);
      hub.remove(id, refOf(clientSchema.parse(req.body ?? {})));
      return { ok: true };
    }));
}
