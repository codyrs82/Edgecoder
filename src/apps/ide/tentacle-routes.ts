// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * A session's tentacles over HTTP (tentacles.ts), next to the session routes and under the same
 * rules: the IDE token, loopback, and only the client in control may write.
 *
 *   GET  /v1/ide/sessions/:id/tentacles                    {config, spentCSats, tentacles}
 *   POST /v1/ide/sessions/:id/tentacles/config             {enabled?, maxParallel?, budgetCSats?, perTentacleCSats?, workerModel?, localFirst?}
 *   POST /v1/ide/sessions/:id/tentacles/:tid/cancel
 *   POST /v1/ide/sessions/:id/tentacles/:tid/merge         {approved}   a passed patch waiting for approval
 *
 * `:id` may also be a desktop Code view chat that runs helpers (POST /v1/ide/chat with `helpers`):
 * it has no session in the hub and no controlling client, only the IDE token, like the chat itself.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { SessionError, type ClientRef, type SessionHub } from "./sessions.js";
import { TentacleError, type TentacleManager } from "./tentacles.js";

const client = {
  clientId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  kind: z.enum(["terminal", "desktop", "api", "remote"]).default("api"),
  label: z.string().max(80).optional(),
};
const params = z.object({ id: z.string().uuid() });
const tParams = z.object({ id: z.string().uuid(), tid: z.string().regex(/^t[0-9a-f]{7}$/) });

function refOf(b: { clientId: string; kind: ClientRef["kind"]; label?: string }): ClientRef {
  return { clientId: b.clientId, kind: b.kind, ...(b.label ? { label: b.label } : {}) };
}

async function handle(reply: FastifyReply, fn: () => unknown): Promise<unknown> {
  try {
    return reply.send(await fn());
  } catch (err) {
    if (err instanceof SessionError) return reply.status(err.code === "not_found" ? 404 : err.code === "invalid" ? 400 : 409).send({ error: err.code, message: err.message, ...err.extra });
    if (err instanceof TentacleError) return reply.status(err.code === "not_found" ? 404 : err.code === "budget" ? 402 : err.code === "invalid" ? 400 : 409).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "invalid", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    throw err;
  }
}

export function registerTentacleRoutes(app: FastifyInstance, hub: SessionHub, tentacles: TentacleManager, opts: { isChat?: (id: string) => boolean } = {}): void {
  /** A hub session's writes need the client in control; a Code view chat's only the token. */
  const control = (id: string, ref: ClientRef) => {
    if (!opts.isChat?.(id)) hub.assertControl(id, ref);
  };
  app.get("/v1/ide/sessions/:id/tentacles", (req, reply) =>
    handle(reply, () => {
      const { id } = params.parse(req.params);
      if (!opts.isChat?.(id)) hub.snapshot(id); // 404 for an unknown session
      return tentacles.list(id);
    }));

  app.post("/v1/ide/sessions/:id/tentacles/config", (req, reply) =>
    handle(reply, () => {
      const { id } = params.parse(req.params);
      const b = z
        .object({
          ...client,
          enabled: z.boolean().optional(),
          maxParallel: z.number().int().min(1).max(16).optional(),
          budgetCSats: z.number().min(0).max(1e7).optional(),
          perTentacleCSats: z.number().min(0).max(1e7).optional(),
          workerModel: z.string().min(1).max(200).optional(),
          localFirst: z.boolean().optional(),
        })
        .parse(req.body ?? {});
      control(id, refOf(b));
      const { clientId: _c, kind: _k, label: _l, ...patch } = b;
      return { config: tentacles.configure(id, patch) };
    }));

  app.post("/v1/ide/sessions/:id/tentacles/:tid/cancel", (req, reply) =>
    handle(reply, () => {
      const { id, tid } = tParams.parse(req.params);
      const b = z.object(client).parse(req.body ?? {});
      control(id, refOf(b));
      return { cancelled: tentacles.cancel(id, tid) };
    }));

  app.post("/v1/ide/sessions/:id/tentacles/:tid/merge", (req, reply) =>
    handle(reply, () => {
      const { id, tid } = tParams.parse(req.params);
      const b = z.object({ ...client, approved: z.boolean() }).parse(req.body ?? {});
      control(id, refOf(b));
      return { tentacle: tentacles.decide(id, tid, b.approved) };
    }));
}
