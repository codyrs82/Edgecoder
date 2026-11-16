// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Bots on the web, coordinator routes (../bot-relay.ts, src/common/bot-relay.ts).
 *
 *   POST /agent-control/bots                           portal service token; { accountId, agentIds? }
 *   POST /agent-control/agents/:agentId/bot-commands   portal service token; { accountId, botId, action, args }
 *   POST /agent-control/bot-commands/:commandId        portal service token; { accountId } -> the result
 *   POST /agent-control/agents/:agentId/bots/report    the agent itself (signed); { snapshot? , result? }
 */

import { z } from "zod";
import { pgStore } from "../../../db/store.js";
import { BOT_CONTROL_ACTIONS, MAX_SNAPSHOT_BYTES, botControlRequestSchema, botIdSchema, type BotsSnapshot } from "../../../common/bot-relay.js";
import type { CoordinatorApp } from "../app.js";
import { identity, coordinatorKeys, securityLog } from "../context.js";
import { requireAgentSelf, requirePortalServiceToken } from "../auth.js";
import { verifiedAccountOf } from "../agent-accounts.js";
import { agentCapabilities } from "../agent-state.js";
import { acceptBotResult, acceptBotSnapshot, botCommandState, botMachineView, sendBotCommand } from "../bot-relay.js";

const accountId = z.string().min(1).max(160).regex(/^acct-[A-Za-z0-9_-]+$/);
const agentIdParam = z.object({ agentId: z.string().min(1).max(128) });

const snapshotSchema = z
  .object({
    v: z.literal(1),
    machineName: z.string().max(80),
    controls: z.enum(["on", "view"]),
    generatedAtMs: z.number().int().nonnegative(),
    bots: z.array(z.object({ id: botIdSchema, name: z.string().max(60) }).passthrough()).max(30)
  })
  .strict();

const reportSchema = z
  .object({
    snapshot: snapshotSchema.optional(),
    result: z
      .object({
        commandId: z.string().min(8).max(64),
        status: z.enum(["done", "refused", "failed"]),
        error: z.string().max(80).optional(),
        message: z.string().max(300).optional(),
        data: z.unknown().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export function registerBotRelayRoutes(app: CoordinatorApp): void {
  app.post("/agent-control/bots", async (req, reply) => {
    if (!requirePortalServiceToken(req as never, reply)) return;
    const body = z.object({ accountId, agentIds: z.array(z.string().min(1).max(128)).max(100).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const candidates = new Set<string>(body.data.agentIds ?? []);
    if (pgStore) {
      try {
        for (const o of await pgStore.listAgentOwnershipByAccount(body.data.accountId)) candidates.add(o.agentId);
      } catch {
        /* the named ids are still checked below */
      }
    }
    const machines = [];
    for (const agentId of [...candidates].slice(0, 100)) {
      // Each machine is checked against the verified mapping, whatever the caller listed.
      if ((await verifiedAccountOf(agentId)) !== body.data.accountId) continue;
      const view = botMachineView(agentId);
      if (!view.snapshot && !view.connected) continue;
      machines.push({ ...view, lastSeenMs: agentCapabilities.get(agentId)?.lastSeenMs ?? null, coordinatorId: identity.peerId });
    }
    return reply.send({ coordinatorId: identity.peerId, machines });
  });

  app.post("/agent-control/agents/:agentId/bot-commands", async (req, reply) => {
    if (!requirePortalServiceToken(req as never, reply)) return;
    const { agentId } = agentIdParam.parse(req.params);
    const body = z.object({ accountId, botId: botIdSchema, action: z.enum(BOT_CONTROL_ACTIONS), args: z.record(z.string(), z.unknown()).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_command" });
    const request = botControlRequestSchema.safeParse({ action: body.data.action, args: body.data.args ?? {} });
    if (!request.success) return reply.code(400).send({ error: "invalid_command", detail: request.error.issues[0]?.message });
    const decision = sendBotCommand({
      agentId,
      botId: body.data.botId,
      accountId: body.data.accountId,
      ownerAccountId: await verifiedAccountOf(agentId),
      request: request.data,
      coordinatorId: identity.peerId,
      privateKeyPem: coordinatorKeys.privateKeyPem
    });
    if (!decision.ok) {
      if (decision.error === "not_your_machine") {
        securityLog.log({
          level: securityLog.severity("bot_control_not_owner"),
          event: "bot_control_not_owner",
          source: { type: "system", id: body.data.accountId },
          details: { agentId, action: body.data.action, via: "portal" },
          action: "reject_command",
          coordinatorId: identity.peerId
        });
      }
      return reply.code(decision.status).send({ error: decision.error, message: decision.message });
    }
    return reply.send({ ok: true, commandId: decision.commandId, coordinatorId: identity.peerId });
  });

  app.post("/agent-control/bot-commands/:commandId", async (req, reply) => {
    if (!requirePortalServiceToken(req as never, reply)) return;
    const params = z.object({ commandId: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/) }).safeParse(req.params);
    const body = z.object({ accountId }).safeParse(req.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request" });
    const state = botCommandState(params.data.commandId, body.data.accountId);
    if (!state) return reply.code(404).send({ error: "unknown_command" });
    return reply.send(state);
  });

  app.post("/agent-control/agents/:agentId/bots/report", { bodyLimit: MAX_SNAPSHOT_BYTES + 64 * 1024 }, async (req, reply) => {
    const { agentId } = agentIdParam.parse(req.params);
    if (!(await requireAgentSelf(req, reply, agentId))) return;
    const body = reportSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_report" });
    if (body.data.snapshot) {
      // Kept only for a machine with a verified owner: nobody else could ever read it.
      if (!(await verifiedAccountOf(agentId))) return reply.code(403).send({ error: "no_verified_owner" });
      const r = acceptBotSnapshot(agentId, body.data.snapshot as unknown as BotsSnapshot);
      if (!r.ok) return reply.code(413).send(r);
    }
    if (body.data.result) {
      const r = acceptBotResult(agentId, body.data.result);
      if (!r.ok) return reply.code(r.error === "result_too_large" ? 413 : 404).send(r);
    }
    return reply.send({ ok: true });
  });
}
