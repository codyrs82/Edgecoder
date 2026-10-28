// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { z } from "zod";
import type { ReviewRoutesDeps } from "../server.js";

/** #16: Review queue API (/portal/api/reviews). Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerReviewRoutes(app: FastifyInstance, { EXTERNAL_HTTP_TIMEOUT_MS, PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal, getCurrentUser, store }: ReviewRoutesDeps): void {
  app.get("/portal/api/reviews", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });

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
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });

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
      const errBody = await res.body.text();
      return reply.code(502).send({ error: "coordinator_error", detail: errBody });
    } catch (err) {
      return reply.code(502).send({ error: "coordinator_request_failed", detail: String(err) });
    }
  });

  app.post("/portal/api/reviews/:taskId/decision", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });

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
        const payload = await res.body.json();
        return reply.send({ ok: true, detail: payload });
      }
      const errBody = await res.body.text();
      return reply.code(502).send({ error: "coordinator_error", detail: errBody });
    } catch (err) {
      return reply.code(502).send({ error: "coordinator_request_failed", detail: String(err) });
    }
  });
}
