// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { RobotQueue } from "./robot-queue.js";

/* ------------------------------------------------------------------ */
/*  Zod request-body schemas (exported for direct unit-testing)       */
/* ------------------------------------------------------------------ */

export const robotAgentRegisterSchema = z.object({
  agentId: z.string().min(1),
  payoutAddress: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  robotKind: z.string().min(1)
});

export const robotAgentHeartbeatSchema = z.object({
  agentId: z.string().min(1)
});

export const robotTaskCreateSchema = z.object({
  clientAccountId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  taskKind: z.enum(["physical", "compute", "hybrid"]),
  resourceRequirements: z.array(z.string()).default([]),
  amountSats: z.number().int().positive().max(100_000_000),
  timeoutMs: z.number().int().positive().optional(),
  proofSchema: z.record(z.string(), z.unknown()).optional()
});

export const robotClaimSchema = z.object({
  agentId: z.string().min(1)
});

export const robotProofSchema = z.object({
  payload: z.unknown()
});

export const robotDisputeSchema = z.object({
  reason: z.string().min(1)
});

/* ------------------------------------------------------------------ */
/*  Route registration                                                */
/* ------------------------------------------------------------------ */

export function registerRobotRoutes(
  app: FastifyInstance,
  queue: RobotQueue,
  deps: {
    hasMeshToken: (headers: Record<string, unknown>) => boolean;
    hasPortalServiceToken: (headers: Record<string, unknown>) => boolean;
    lightningProvider: {
      createInvoice(input: {
        amountSats: number;
        memo: string;
        expiresInSeconds: number;
      }): Promise<{
        invoiceRef: string;
        paymentHash: string;
        expiresAtMs: number;
      }>;
      checkSettlement(
        invoiceRef: string
      ): Promise<{ settled: boolean; txRef?: string }>;
    };
  }
): void {
  /* ---- Agent registration ---- */
  app.post("/robot/agents/register", async (req, reply) => {
    if (!deps.hasMeshToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = robotAgentRegisterSchema.parse(req.body);
    const agent = queue.registerAgent(body);
    return { ok: true, agent };
  });

  /* ---- Agent heartbeat ---- */
  app.post("/robot/agents/heartbeat", async (req, reply) => {
    if (!deps.hasMeshToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = robotAgentHeartbeatSchema.parse(req.body);
    queue.heartbeat(body.agentId);
    return { ok: true };
  });

  /* ---- Task creation (portal-service only) ---- */
  app.post("/robot/tasks", async (req, reply) => {
    if (!deps.hasPortalServiceToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = robotTaskCreateSchema.parse(req.body);
    const invoice = await deps.lightningProvider.createInvoice({
      amountSats: body.amountSats,
      memo: `robot_task:${body.clientAccountId}`,
      expiresInSeconds: 900
    });
    const task = queue.createTask({
      ...body,
      invoiceRef: invoice.invoiceRef
    });
    return { ok: true, task, invoice };
  });

  /* ---- Available tasks for an agent ---- */
  app.get("/robot/tasks/available", async (req, reply) => {
    if (!deps.hasMeshToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const agentId = (req.query as Record<string, string>).agentId;
    if (!agentId) return reply.code(400).send({ error: "agentId_required" });
    const tasks = queue.listAvailableTasks(agentId);
    return { ok: true, tasks };
  });

  /* ---- Get single task ---- */
  app.get("/robot/tasks/:taskId", async (req, reply) => {
    if (!deps.hasMeshToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { taskId } = req.params as { taskId: string };
    const task = queue.getTask(taskId);
    if (!task) return { ok: false, error: "task_not_found" };
    return { ok: true, task };
  });

  /* ---- Claim task ---- */
  app.post("/robot/tasks/:taskId/claim", async (req, reply) => {
    if (!deps.hasMeshToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { taskId } = req.params as { taskId: string };
    const body = robotClaimSchema.parse(req.body);
    try {
      const task = queue.claimTask(taskId, body.agentId);
      return { ok: true, task };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: msg });
    }
  });

  /* ---- Submit proof ---- */
  app.post("/robot/tasks/:taskId/proof", async (req, reply) => {
    if (!deps.hasMeshToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { taskId } = req.params as { taskId: string };
    const agentId = (req.query as Record<string, string>).agentId;
    if (!agentId) return reply.code(400).send({ error: "agentId_required" });
    const body = robotProofSchema.parse(req.body);
    try {
      const task = queue.submitProof(taskId, agentId, body.payload);
      return { ok: true, task };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: msg });
    }
  });

  /* ---- Settle task (portal-service only) ---- */
  app.post("/robot/tasks/:taskId/settle", async (req, reply) => {
    if (!deps.hasPortalServiceToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { taskId } = req.params as { taskId: string };
    try {
      const task = queue.settleTask(taskId);
      return { ok: true, task };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: msg });
    }
  });

  /* ---- Dispute task (portal-service only) ---- */
  app.post("/robot/tasks/:taskId/dispute", async (req, reply) => {
    if (!deps.hasPortalServiceToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { taskId } = req.params as { taskId: string };
    const body = robotDisputeSchema.parse(req.body);
    try {
      const task = queue.disputeTask(taskId, body.reason);
      return { ok: true, task };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: msg });
    }
  });

  /* ---- Agent earnings ---- */
  app.get("/robot/agents/:agentId/earnings", async (req, reply) => {
    if (!deps.hasMeshToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { agentId } = req.params as { agentId: string };
    const earnings = queue.getEarnings(agentId);
    const totalAccrued = earnings
      .filter((e) => e.status === "accrued")
      .reduce((s, e) => s + e.earnedSats, 0);
    const totalSwept = earnings
      .filter((e) => e.status === "swept")
      .reduce((s, e) => s + e.earnedSats, 0);
    return { ok: true, earnings, totalAccrued, totalSwept };
  });

  /* ---- Sweep payout aggregation (portal-service only) ---- */
  app.post("/robot/sweep", async (req, reply) => {
    if (!deps.hasPortalServiceToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const payouts = queue.pendingSweepPayouts();
    if (payouts.length === 0) {
      return { ok: true, message: "no_payouts_pending", payouts: [] };
    }
    return { ok: true, pendingPayouts: payouts };
  });
}
