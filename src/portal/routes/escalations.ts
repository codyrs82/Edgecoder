// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getHumanEscalation,
  listHumanEscalations,
  updateHumanEscalation,
  countPendingHumanEscalations,
} from "../../escalation/human-store.js";
import type { HumanEscalationResponse } from "../../escalation/types.js";
import type { PortalRouteDeps } from "./deps.js";

// ---------------------------------------------------------------------------
// Human Escalation API — surfaces tasks that exhausted all automated
// resolvers and need human operator input.
// ---------------------------------------------------------------------------

export function registerEscalationRoutes(app: FastifyInstance, { getCurrentUser }: Pick<PortalRouteDeps, "getCurrentUser">): void {
  /**
   * GET /portal/api/escalations — list pending human escalations.
   */
  app.get("/portal/api/escalations", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const pending = listHumanEscalations("pending_human");
    return reply.send({ escalations: pending });
  });

  /**
   * GET /portal/api/escalations/pending-count — lightweight polling endpoint
   * that returns the number of escalations awaiting human input.
   */
  app.get("/portal/api/escalations/pending-count", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    return reply.send({ count: countPendingHumanEscalations() });
  });

  /**
   * GET /portal/api/escalations/:id — get full details for a single escalation.
   */
  app.get("/portal/api/escalations/:id", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { id } = req.params as { id: string };
    const entry = getHumanEscalation(id);
    if (!entry) return reply.code(404).send({ error: "escalation_not_found" });
    return reply.send({ escalation: entry });
  });

  /**
   * POST /portal/api/escalations/:id/respond — submit a human response.
   *
   * Body: { action: "provide_context" | "edit_code" | "abandon", context?: string, editedCode?: string }
   */
  app.post("/portal/api/escalations/:id/respond", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { id } = req.params as { id: string };
    const entry = getHumanEscalation(id);
    if (!entry) return reply.code(404).send({ error: "escalation_not_found" });
    if (entry.status !== "pending_human") {
      return reply.code(409).send({ error: "escalation_not_pending" });
    }

    const body = z.object({
      action: z.enum(["provide_context", "edit_code", "abandon"]),
      context: z.string().optional(),
      editedCode: z.string().optional(),
    }).parse(req.body) as HumanEscalationResponse;

    if (body.action === "abandon") {
      updateHumanEscalation(id, {
        status: "abandoned",
        respondedByUserId: user.userId,
      });
      return reply.send({ ok: true, status: "abandoned" });
    }

    if (body.action === "edit_code") {
      if (!body.editedCode) {
        return reply.code(400).send({ error: "editedCode_required_for_edit_code_action" });
      }
      updateHumanEscalation(id, {
        status: "resolved",
        humanEditedCode: body.editedCode,
        respondedByUserId: user.userId,
      });
      return reply.send({ ok: true, status: "resolved", improvedCode: body.editedCode });
    }

    // action === "provide_context"
    if (!body.context) {
      return reply.code(400).send({ error: "context_required_for_provide_context_action" });
    }
    updateHumanEscalation(id, {
      status: "human_responded",
      humanContext: body.context,
      respondedByUserId: user.userId,
    });
    return reply.send({ ok: true, status: "human_responded", humanContext: body.context });
  });
}
