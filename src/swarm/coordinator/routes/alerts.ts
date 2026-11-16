// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Admin routes for this coordinator's alerts (src/swarm/coordinator/alerts.ts), read by the portal's
 * Settings > Network Alerts section with the coordinator admin token:
 *
 *   GET  /admin/alerts          active incidents and recent history (own and shared)
 *   POST /admin/alerts/ack      { source, key, by }: stop reminders for an active incident
 *   POST /admin/alerts/test     { by }: send a test alert through this coordinator's channels
 *
 * Registered in their own plugin behind authorizeAdmin, like /admin/network.
 */
import { z } from "zod";
import type { CoordinatorApp } from "../app.js";
import { authorizeAdmin } from "../auth.js";
import { alertConfig, coordinatorAlerts } from "../alerts.js";

const ackSchema = z.object({ source: z.string().min(1).max(200), key: z.string().min(1).max(300), by: z.string().max(200).optional() });
const testSchema = z.object({ by: z.string().max(200).optional() });

export function registerAlertRoutes(app: CoordinatorApp): void {
  app.register(async (admin) => {
    admin.addHook("onRequest", async (req, reply) => {
      if (!authorizeAdmin(req, reply)) return reply;
    });
    admin.get("/admin/alerts", async (_req, reply) => {
      reply.header("cache-control", "no-store");
      return { ...(await coordinatorAlerts.list()), enabled: alertConfig.enabled };
    });
    admin.post("/admin/alerts/ack", async (req, reply) => {
      const parsed = ackSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const r = await coordinatorAlerts.acknowledge(parsed.data.source, parsed.data.key, parsed.data.by || "admin");
      if (!r) return reply.code(404).send({ error: "alert_not_active" });
      return { ok: true, alert: r };
    });
    admin.post("/admin/alerts/test", async (req, reply) => {
      const parsed = testSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const results = await coordinatorAlerts.sendTest(parsed.data.by || "admin");
      return { ok: results.length > 0 && results.every((r) => r.ok), channels: results };
    });
  });
}
