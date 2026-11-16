// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Remote model control routes (../model-control.ts).
 *
 *   POST /agent-control/agents/:agentId/commands   portal service token; { accountId, action, args }
 *   POST /agent-control/machines                    portal service token; { accountId, agentIds? }
 *   POST /agent-control/agents/:agentId/report      the agent itself (signed request); { state?, result? }
 */

import { z } from "zod";
import { pgStore } from "../../../db/store.js";
import { modelControlRequestSchema, MODEL_CONTROL_ACTIONS } from "../../../model/remote-control/protocol.js";
import type { CoordinatorApp } from "../app.js";
import { identity, coordinatorKeys, securityLog } from "../context.js";
import { requireAgentSelf, requirePortalServiceToken } from "../auth.js";
import { verifiedAccountOf } from "../agent-accounts.js";
import { agentCapabilities } from "../agent-state.js";
import { acceptModelControlReport, machineView, sendModelControlCommand } from "../model-control.js";

const accountId = z.string().min(1).max(160).regex(/^acct-[A-Za-z0-9_-]+$/);
const agentIdParam = z.object({ agentId: z.string().min(1).max(128) });

const reportSchema = z
  .object({
    state: z.record(z.string(), z.unknown()).optional(),
    result: z
      .object({
        commandId: z.string().min(8).max(64),
        status: z.enum(["accepted", "progress", "done", "refused", "failed"]),
        error: z.string().max(80).optional(),
        message: z.string().max(300).optional(),
        progressPct: z.number().min(0).max(100).optional()
      })
      .optional()
  })
  .strict();

export function registerModelControlRoutes(app: CoordinatorApp): void {
  app.post("/agent-control/agents/:agentId/commands", async (req, reply) => {
    if (!requirePortalServiceToken(req as never, reply)) return;
    const { agentId } = agentIdParam.parse(req.params);
    const body = z.object({ accountId, action: z.enum(MODEL_CONTROL_ACTIONS), args: z.record(z.string(), z.unknown()).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_command" });
    const request = modelControlRequestSchema.safeParse({ action: body.data.action, args: body.data.args ?? {} });
    if (!request.success) return reply.code(400).send({ error: "invalid_command", detail: request.error.issues[0]?.message });
    const ownerAccountId = await verifiedAccountOf(agentId);
    const decision = sendModelControlCommand({
      agentId,
      accountId: body.data.accountId,
      ownerAccountId,
      request: request.data,
      coordinatorId: identity.peerId,
      privateKeyPem: coordinatorKeys.privateKeyPem
    });
    if (!decision.ok) {
      if (decision.error === "not_your_machine") {
        securityLog.log({
          level: securityLog.severity("model_control_not_owner"),
          event: "model_control_not_owner",
          source: { type: "system", id: body.data.accountId },
          details: { agentId, action: body.data.action, via: "portal" },
          action: "reject_command",
          coordinatorId: identity.peerId
        });
      }
      return reply.code(decision.status).send({ error: decision.error, message: decision.message });
    }
    return reply.send({ ok: true, commandId: decision.entry.commandId, status: decision.entry.status, coordinatorId: identity.peerId });
  });

  app.post("/agent-control/machines", async (req, reply) => {
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
      const view = await machineView(agentId);
      const cap = agentCapabilities.get(agentId);
      machines.push({
        ...view,
        audit: view.audit.filter((e) => e.accountId === body.data.accountId),
        lastSeenMs: cap?.lastSeenMs ?? null,
        coordinatorId: identity.peerId
      });
    }
    return reply.send({ coordinatorId: identity.peerId, machines });
  });

  app.post("/agent-control/agents/:agentId/report", async (req, reply) => {
    const { agentId } = agentIdParam.parse(req.params);
    if (!(await requireAgentSelf(req, reply, agentId))) return;
    const body = reportSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_report" });
    const r = acceptModelControlReport(agentId, body.data);
    return reply.code(r.ok ? 200 : 400).send(r);
  });
}
