// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * "Code from your phone", coordinator routes (../code-relay.ts, src/common/code-relay.ts).
 *
 *   POST /agent-control/code                            portal service token; { accountId, agentIds? }
 *                                                       -> the account's machines with their code snapshots
 *   POST /agent-control/agents/:agentId/code-commands   portal service token; { accountId, action, args }
 *   POST /agent-control/code-commands/:commandId        portal service token; { accountId } -> the result
 *   POST /agent-control/agents/:agentId/code/report     the agent itself (signed); { snapshot?, result? }
 */

import { z } from "zod";
import { pgStore } from "../../../db/store.js";
import { CODE_CONTROL_ACTIONS, MAX_CODE_PROJECTS, MAX_CODE_SESSIONS, MAX_CODE_SNAPSHOT_BYTES, codeControlRequestSchema, projectIdSchema, type CodeSnapshot } from "../../../common/code-relay.js";
import type { CoordinatorApp } from "../app.js";
import { identity, coordinatorKeys, securityLog } from "../context.js";
import { requireAgentSelf, requirePortalServiceToken } from "../auth.js";
import { verifiedAccountOf } from "../agent-accounts.js";
import { agentCapabilities } from "../agent-state.js";
import { acceptCodeResult, acceptCodeSnapshot, codeCommandState, codeMachineView, sendCodeCommand } from "../code-relay.js";

const accountId = z.string().min(1).max(160).regex(/^acct-[A-Za-z0-9_-]+$/);
const agentIdParam = z.object({ agentId: z.string().min(1).max(128) });

const snapshotSchema = z
  .object({
    v: z.literal(1),
    machineName: z.string().max(80),
    controls: z.enum(["on", "view"]),
    account: accountId,
    generatedAtMs: z.number().int().nonnegative(),
    // Projects are named by an opaque id and folder names only: nothing else is kept.
    projects: z.array(z.object({ projectId: projectIdSchema, name: z.string().max(255), parent: z.string().max(255), branch: z.string().max(255).optional() }).strict()).max(MAX_CODE_PROJECTS),
    sessions: z.array(z.object({ id: z.string().uuid(), projectId: projectIdSchema, title: z.string().max(200), projectName: z.string().max(255) }).passthrough()).max(MAX_CODE_SESSIONS)
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

export function registerCodeRelayRoutes(app: CoordinatorApp): void {
  app.post("/agent-control/code", async (req, reply) => {
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
      const view = codeMachineView(agentId, body.data.accountId);
      if (!view.snapshot && !view.connected) continue;
      machines.push({ ...view, lastSeenMs: agentCapabilities.get(agentId)?.lastSeenMs ?? null, coordinatorId: identity.peerId });
    }
    return reply.send({ coordinatorId: identity.peerId, machines });
  });

  app.post("/agent-control/agents/:agentId/code-commands", async (req, reply) => {
    if (!requirePortalServiceToken(req as never, reply)) return;
    const { agentId } = agentIdParam.parse(req.params);
    const body = z.object({ accountId, action: z.enum(CODE_CONTROL_ACTIONS), args: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_command" });
    const request = codeControlRequestSchema.safeParse({ action: body.data.action, args: body.data.args ?? {} });
    if (!request.success) return reply.code(400).send({ error: "invalid_command", detail: request.error.issues[0]?.message });
    const decision = sendCodeCommand({
      agentId,
      accountId: body.data.accountId,
      ownerAccountId: await verifiedAccountOf(agentId),
      request: request.data,
      coordinatorId: identity.peerId,
      privateKeyPem: coordinatorKeys.privateKeyPem
    });
    if (!decision.ok) {
      if (decision.error === "not_your_machine") {
        securityLog.log({
          level: securityLog.severity("code_control_not_owner"),
          event: "code_control_not_owner",
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

  app.post("/agent-control/code-commands/:commandId", async (req, reply) => {
    if (!requirePortalServiceToken(req as never, reply)) return;
    const params = z.object({ commandId: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/) }).safeParse(req.params);
    const body = z.object({ accountId }).safeParse(req.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request" });
    // Only the account that asked: anyone else gets the same answer as for an unknown command.
    const state = codeCommandState(params.data.commandId, body.data.accountId);
    if (!state) return reply.code(404).send({ error: "unknown_command" });
    return reply.send(state);
  });

  app.post("/agent-control/agents/:agentId/code/report", { bodyLimit: MAX_CODE_SNAPSHOT_BYTES + 64 * 1024 }, async (req, reply) => {
    const { agentId } = agentIdParam.parse(req.params);
    if (!(await requireAgentSelf(req, reply, agentId))) return;
    const body = reportSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_report" });
    if (body.data.snapshot) {
      // Kept only for the machine's verified owner, and only when it was made for that account.
      const owner = await verifiedAccountOf(agentId);
      if (!owner) return reply.code(403).send({ error: "no_verified_owner" });
      if (owner !== body.data.snapshot.account) return reply.code(403).send({ error: "not_the_owner" });
      const r = acceptCodeSnapshot(agentId, body.data.snapshot as unknown as CodeSnapshot);
      if (!r.ok) return reply.code(413).send(r);
    }
    if (body.data.result) {
      const r = acceptCodeResult(agentId, body.data.result);
      if (!r.ok) return reply.code(r.error === "result_too_large" ? 413 : 404).send(r);
    }
    return reply.send({ ok: true });
  });
}
