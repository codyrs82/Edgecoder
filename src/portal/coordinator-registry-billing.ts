// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// Per-member billing through EdgeCoder's ledger service (phase 4, src/ledger-service). A community
// member's `billingEnabled` is off until the owner turns it on with a passkey assertion made for
// that change (the same flow as an approval); the seeds bill for it once it is also `active` (past
// probation). Turning it off needs no passkey. Suspension and reinstatement clear it
// (coordinator-registry.ts). The signed registry carries the flag; seeds read it at their next
// refresh, and can stop billing for a member at once on their own (POST /admin/ledger-service/members/disable).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CoordinatorRegistryService, ServiceResult } from "./coordinator-registry.js";
import type { RegistryPasskey } from "./coordinator-registry-routes.js";
import type { StoredMember } from "./coordinator-registry-store.js";

export async function setMemberBilling(
  service: Pick<CoordinatorRegistryService, "load" | "members" | "store">,
  nodeId: string,
  actorUserId: string,
  enabled: boolean,
  nowMs: number
): Promise<ServiceResult<{ member: StoredMember }>> {
  await service.load();
  const cur = service.members().find((m) => m.nodeId === nodeId);
  if (!cur) return { ok: false, status: 404, error: "not_found" };
  if (cur.operatorKind !== "community") return { ok: false, status: 409, error: "platform_coordinator" };
  const admitted = (m: StoredMember) => m.status === "probation" || m.status === "active";
  if (enabled && !admitted(cur)) return { ok: false, status: 409, error: "not_admitted", problems: [cur.status] };
  if ((cur.billingEnabled === true) === enabled) return { ok: true, member: cur };
  const saved = await service.store.transact(nodeId, (row) => {
    if (!row || (row.billingEnabled === true) === enabled || (enabled && !admitted(row))) return { member: null };
    return {
      member: { ...row, billingEnabled: enabled, updatedAtMs: nowMs },
      audit: { atMs: nowMs, actorUserId, action: enabled ? "billing_enabled" : "billing_disabled", nodeId, detail: { status: row.status, ...(enabled ? { confirmedWith: "passkey" } : {}) } }
    };
  });
  await service.load();
  if (!saved || (saved.billingEnabled === true) !== enabled) return { ok: false, status: 409, error: "changed_concurrently" };
  return { ok: true, member: saved };
}

/** POST /admin/network/registry/billing  owner: { nodeId, enabled, challengeId?, credentialId?, response? } (passkey to turn on). */
export function registerRegistryBillingRoute(
  app: FastifyInstance,
  deps: {
    service: CoordinatorRegistryService;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<{ userId: string; email?: string } | null>;
    passkey: RegistryPasskey | null;
    view: (m: StoredMember) => unknown;
  }
): void {
  app.post("/admin/network/registry/billing", async (req, reply) => {
    const admin = await deps.requireAdmin(req, reply);
    if (!admin) return;
    const body = z
      .object({
        nodeId: z.string().min(1).max(256),
        enabled: z.boolean(),
        challengeId: z.string().min(10).max(64).optional(),
        credentialId: z.string().max(1024).optional(),
        response: z.unknown().optional()
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    if (body.data.enabled) {
      if (!deps.passkey) return reply.code(503).send({ error: "passkeys_not_configured" });
      if (!body.data.challengeId || body.data.response === undefined) return reply.code(403).send({ error: "passkey_required", detail: "Confirm billing with your passkey." });
      const v = await deps.passkey.verify(admin, { challengeId: body.data.challengeId, credentialId: body.data.credentialId, response: body.data.response });
      if (!v.ok) return reply.code(v.status).send({ error: v.error });
    }
    const r = await deps.service.setBilling(body.data.nodeId, admin.userId, body.data.enabled);
    if (!r.ok) return reply.code(r.status).send({ error: r.error, ...(r.problems ? { problems: r.problems } : {}) });
    return reply.send({ ok: true, member: deps.view(r.member) });
  });
}
