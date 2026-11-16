// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Security research tier routes (docs/security-research-tier.md):
 *   POST /account/restricted-access/update (portal service token): one entitlement change, applied at
 *     once; a suspension or revocation cancels the account's calls in flight.
 *   GET  /admin/restricted-models (admin token): the restricted list, entitlements held here, calls
 *     in flight and the most recent ended ones.
 */
import { z } from "zod";
import type { CoordinatorApp } from "../app.js";
import { authorizeAdmin, hasPortalServiceToken } from "../auth.js";
import {
  RESTRICTED_LOG_PROMPTS,
  applyEntitlementChange,
  entitlementSchema,
  restrictedCalls,
  restrictedCatalog,
  restrictedEntitlements
} from "../restricted.js";

export function registerRestrictedRoutes(app: CoordinatorApp): void {
  app.post("/account/restricted-access/update", async (req, reply) => {
    const headers = ((req as { headers?: Record<string, unknown> }).headers ?? {}) as Record<string, unknown>;
    // The portal only: the header must be present (with no token configured, development, it would match anything).
    if (headers["x-portal-service-token"] === undefined || !hasPortalServiceToken(headers)) return reply.code(401).send({ error: "portal_service_token_required" });
    const parsed = z.union([entitlementSchema, z.object({ entitlements: z.array(entitlementSchema).max(500) })]).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_entitlement" });
    const changes = "entitlements" in parsed.data ? parsed.data.entitlements : [parsed.data];
    let cancelled = 0;
    for (const c of changes) cancelled += await applyEntitlementChange(c);
    req.log.info({ changes: changes.map((c) => ({ accountId: c.accountId, kind: c.kind, active: c.active })), cancelled }, "restricted_access_updated");
    return reply.send({ ok: true, cancelled });
  });

  app.register(async (admin) => {
    admin.addHook("onRequest", async (req, reply) => {
      if (!authorizeAdmin(req, reply)) return reply;
    });
    admin.get("/admin/restricted-models", async () => {
      // Prompts and outputs are never returned here, even when they are logged.
      const strip = <T extends { prompt?: string; output?: string }>(r: T) => {
        const { prompt: _p, output: _o, ...rest } = r;
        return rest;
      };
      return {
        models: restrictedCatalog.list(),
        logPrompts: RESTRICTED_LOG_PROMPTS,
        entitlementsSyncedAtMs: restrictedEntitlements.lastSyncMs,
        entitlements: restrictedEntitlements.list(),
        active: restrictedCalls.activeWhere(() => true).map(strip),
        recent: restrictedCalls.recent(200).map(strip),
      };
    });
  });
}
