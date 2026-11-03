// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { z } from "zod";
import type { ReviewRoutesDeps } from "../server.js";

/**
 * Review queue API (/portal/api/reviews). Escalations are not scoped per user (the coordinator's
 * list holds every task's code and context, and a decision resolves the task), so every route is
 * operator-only, like /portal/api/escalations. Upstream errors are logged, not returned.
 */
export function registerReviewRoutes(app: FastifyInstance, { EXTERNAL_HTTP_TIMEOUT_MS, PORTAL_SERVICE_TOKEN, buildAccessContext, discoverCoordinatorUrlsForPortal, getCurrentUser, store }: ReviewRoutesDeps): void {
  async function requireOperator(req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): Promise<boolean> {
    const user = await getCurrentUser(req as any);
    if (!user) { reply.code(401).send({ error: "not_authenticated" }); return false; }
    if (!(await buildAccessContext(user)).isSystemAdmin) { reply.code(403).send({ error: "operator_only" }); return false; }
    return true;
  }

  app.get("/portal/api/reviews", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    if (!(await requireOperator(req, reply))) return;

    const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
    if (coordinatorUrls.length === 0) {
      return reply.send({ reviews: [] });
    }
    const coordinatorUrl = coordinatorUrls[0].replace(/\/$/, "");
    const headers: Record<string, string> = {};
    if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;

    try {
      const res = await request(`${coordinatorUrl}/escalate`, {
        method: "GET",
        headers,
        headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
        bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const payload = (await res.body.json()) as {
          escalations?: Array<{
            taskId: string;
            status: string;
            request?: { task?: string; language?: string };
            improvedCode?: string;
          }>;
        };
        const reviews = (payload.escalations ?? []).map((e) => ({
          taskId: e.taskId,
          status: e.status,
          task: e.request?.task ?? "",
          language: e.request?.language ?? "",
          createdAtMs: Date.now()
        }));
        return reply.send({ reviews });
      }
      // If the coordinator doesn't support listing, return empty
      await res.body.text();
      return reply.send({ reviews: [] });
    } catch {
      return reply.send({ reviews: [] });
    }
  });

  app.get("/portal/api/reviews/:taskId", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    if (!(await requireOperator(req, reply))) return;

    const { taskId } = req.params as { taskId: string };
    const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
    if (coordinatorUrls.length === 0) {
      return reply.code(502).send({ error: "no_coordinators_available" });
    }
    const coordinatorUrl = coordinatorUrls[0].replace(/\/$/, "");
    const headers: Record<string, string> = {};
    if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;

    try {
      const res = await request(`${coordinatorUrl}/escalate/${encodeURIComponent(taskId)}`, {
        method: "GET",
        headers,
        headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
        bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
      });
      if (res.statusCode === 404) {
        await res.body.text();
        return reply.code(404).send({ error: "review_not_found" });
      }
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const payload = (await res.body.json()) as {
          taskId: string;
          status: string;
          improvedCode?: string;
          explanation?: string;
          resolvedByModel?: string;
          request?: {
            task?: string;
            failedCode?: string;
            language?: string;
            errorHistory?: string[];
          };
        };
        return reply.send({
          taskId: payload.taskId,
          status: payload.status,
          improvedCode: payload.improvedCode ?? "",
          explanation: payload.explanation ?? "",
          resolvedByModel: payload.resolvedByModel ?? "",
          task: payload.request?.task ?? "",
          failedCode: payload.request?.failedCode ?? "",
          language: payload.request?.language ?? "",
          errorHistory: payload.request?.errorHistory ?? []
        });
      }
      const errBody = await res.body.text().catch(() => "");
      console.warn(`[portal] reviews: coordinator returned ${res.statusCode}: ${errBody.slice(0, 500)}`);
      return reply.code(502).send({ error: "coordinator_error" });
    } catch (err) {
      console.warn(`[portal] reviews: coordinator request failed: ${String(err)}`);
      return reply.code(502).send({ error: "coordinator_request_failed" });
    }
  });

  app.post("/portal/api/reviews/:taskId/decision", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    if (!(await requireOperator(req, reply))) return;

    const { taskId } = req.params as { taskId: string };
    const body = z.object({
      decision: z.enum(["accept", "reject", "edit"]),
      editedCode: z.string().optional()
    }).parse(req.body);

    const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
    if (coordinatorUrls.length === 0) {
      return reply.code(502).send({ error: "no_coordinators_available" });
    }
    const coordinatorUrl = coordinatorUrls[0].replace(/\/$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;

    const status = body.decision === "reject" ? "failed" : "completed";
    const improvedCode = body.decision === "edit" ? body.editedCode : undefined;

    try {
      const res = await request(`${coordinatorUrl}/escalate/${encodeURIComponent(taskId)}/result`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          taskId,
          status,
          improvedCode,
          explanation: `User decision: ${body.decision}`
        }),
        headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
        bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        await res.body.dump();
        return reply.send({ ok: true });
      }
      const errBody = await res.body.text().catch(() => "");
      console.warn(`[portal] reviews: coordinator returned ${res.statusCode}: ${errBody.slice(0, 500)}`);
      return reply.code(502).send({ error: "coordinator_error" });
    } catch (err) {
      console.warn(`[portal] reviews: coordinator request failed: ${String(err)}`);
      return reply.code(502).send({ error: "coordinator_request_failed" });
    }
  });
}
