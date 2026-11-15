// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HOST_AGREEMENT_VERSION, TERMS_VERSION } from "../../common/legal-notices.js";
import type { PortalRouteDeps } from "./deps.js";

/**
 * Legal acceptance per account (docs/legal/, DRAFT pending legal review):
 *   GET  /portal/api/legal         current versions and what this account accepted
 *   POST /portal/api/legal/accept  { document: "terms" | "host-agreement", version }
 * Sign-up records the Terms (routes/auth.ts); this is for accounts created without the checkbox
 * (single sign-on from an app, older accounts) and for the Host Agreement on the Install agent page.
 */
export function registerLegalRoutes(app: FastifyInstance, { store, getCurrentUser }: PortalRouteDeps): void {
  app.get("/portal/api/legal", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const accepted = await store.getLegalAcceptance(user.userId);
    return reply.send({
      current: { terms: TERMS_VERSION, hostAgreement: HOST_AGREEMENT_VERSION },
      accepted,
      termsCurrent: accepted?.termsVersion === TERMS_VERSION,
      hostAgreementCurrent: accepted?.hostAgreementVersion === HOST_AGREEMENT_VERSION
    });
  });

  app.post("/portal/api/legal/accept", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const parsed = z.object({ document: z.enum(["terms", "host-agreement"]), version: z.string().max(64) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { document, version } = parsed.data;
    const current = document === "terms" ? TERMS_VERSION : HOST_AGREEMENT_VERSION;
    // Only the version on the page today can be accepted: an old tab can't record a stale one.
    if (version !== current) return reply.code(409).send({ error: "version_outdated", current });
    const now = Date.now();
    if (document === "terms") await store.recordTermsAcceptance(user.userId, current, now);
    else await store.recordHostAgreementAcceptance(user.userId, current, now);
    return reply.send({ ok: true, document, version: current, acceptedAtMs: now });
  });
}
