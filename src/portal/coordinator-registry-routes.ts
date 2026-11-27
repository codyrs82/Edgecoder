// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// HTTP routes of the signed coordinator registry (split out of coordinator-registry.ts, which holds
// the pool, health checker and service).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { registerRegistryBillingRoute } from "./coordinator-registry-billing.js";
import type { RegistryStore, StoredMember } from "./coordinator-registry-store.js";
import {
  applicationSchema,
  keyRotationSchema,
  registryServiceFromEnv,
  type CoordinatorRegistryService,
  type OperatorAccount,
  type ServiceResult
} from "./coordinator-registry.js";
/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

export interface RegistryPasskey {
  options(user: { userId: string; email?: string }): Promise<{ ok: true; challengeId: string; options: unknown } | { ok: false; status: number; error: string }>;
  verify(user: { userId: string }, body: unknown): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
}

export interface RegistryRouteDeps {
  service: CoordinatorRegistryService;
  /** Resolves the system admin (owner), or sends 401/403 and resolves null. */
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<{ userId: string; email?: string } | null>;
  /** The signed-in user, or null. */
  currentUser: (req: FastifyRequest) => Promise<{ userId: string; email?: string } | null>;
  /** WebAuthn assertion by the acting user's own passkey (null: passkeys not configured). */
  passkey: RegistryPasskey | null;
}

const nodeBody = z.object({ nodeId: z.string().min(1).max(256) });

function send(reply: FastifyReply, r: ServiceResult<Record<string, unknown>>, ok: () => unknown) {
  if (!r.ok) return reply.code(r.status).send({ error: r.error, ...(r.problems ? { problems: r.problems } : {}) });
  return reply.send(ok());
}

function memberView(m: StoredMember) {
  return {
    nodeId: m.nodeId,
    keyFingerprints: m.keyFingerprints,
    urls: m.urls,
    region: m.region,
    operator: { id: m.operatorUserId, name: m.operatorName, kind: m.operatorKind },
    status: m.status,
    createdAtMs: m.createdAtMs,
    admittedAtMs: m.admittedAtMs,
    probationStartedAtMs: m.probationStartedAtMs,
    cleanDays: m.cleanDays,
    suspensionReason: m.suspensionReason,
    billingEnabled: m.billingEnabled === true
  };
}

/**
 *   GET  /network/registry                                 signed registry (public; 503 until the key is set)
 *   GET  /network/registry/public-key                      the registry key's public half and keyId
 *   GET  /network/portal-keys                              the portal's action-signing public keys
 *   POST /portal/api/coordinators/registry/apply           operator: apply (key challenge now; pending)
 *   POST /portal/api/coordinators/registry/rotate-key      operator: new key, signed by the current key
 *   GET  /portal/api/coordinators/registry/mine            operator: own members and their status
 *   GET  /admin/network/registry                           owner: every member, health, audit chain check
 *   GET  /admin/network/registry/audit                     owner: the audit trail and its chain check
 *   POST /admin/network/registry/passkey-options           owner: a passkey challenge for one approval
 *   POST /admin/network/registry/approve                   owner: { nodeId, publicKeyFingerprint?, challengeId, response }
 *   POST /admin/network/registry/suspend                   owner: { nodeId, reason }
 *   POST /admin/network/registry/billing                   owner: { nodeId, enabled, challengeId?, response? } (passkey to turn on)
 */
export function registerRegistryRoutes(app: FastifyInstance, { service, requireAdmin, currentUser, passkey }: RegistryRouteDeps): void {
  app.get("/network/registry", async (_req, reply) => {
    const doc = service.signed();
    if (!doc) return reply.code(503).send({ error: "registry_not_configured" });
    return reply.header("cache-control", "public, max-age=30").send(doc);
  });

  app.get("/network/registry/public-key", async (_req, reply) => {
    const key = service.publicKey();
    if (!key) return reply.code(503).send({ error: "registry_not_configured" });
    return reply.send(key);
  });

  // The portal's action-signing public keys, for convenience. The same list is inside the signed
  // registry, which is what coordinators trust.
  app.get("/network/portal-keys", async (_req, reply) => {
    return reply.header("cache-control", "public, max-age=60").send({ keys: service.portalActionKeys(), format: "ed25519-raw-base64" });
  });

  app.post("/portal/api/coordinators/registry/apply", async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const parsed = applicationSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_application", issues: parsed.error.issues.map((i) => i.path.join(".")) });
    const r = await service.apply(parsed.data, user.userId);
    return send(reply, r, () => ({ ok: true, member: r.ok ? memberView(r.member) : null }));
  });

  app.post("/portal/api/coordinators/registry/rotate-key", async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const parsed = keyRotationSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const r = await service.rotateKey(parsed.data, user.userId);
    return send(reply, r, () => ({ ok: true, member: r.ok ? memberView(r.member) : null }));
  });

  app.get("/portal/api/coordinators/registry/mine", async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    await service.load().catch(() => undefined);
    return reply.send({ maxPerOperator: service.maxMembersPerOperator, members: service.members().filter((m) => m.operatorUserId === user.userId).map(memberView) });
  });

  app.get("/admin/network/registry", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    await service.load().catch(() => undefined);
    const { chain } = await service.auditTrail(1);
    return reply.send({
      configured: service.configured,
      maxPerOperator: service.maxMembersPerOperator,
      auditChain: chain,
      members: service.members().map((m) => ({ ...memberView(m), contact: m.contact, health: service.memberHealth(m.nodeId)?.health ?? null }))
    });
  });

  app.get("/admin/network/registry/audit", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const q = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }).safeParse(req.query ?? {});
    return reply.send(await service.auditTrail(q.success ? q.data.limit : 200));
  });

  app.post("/admin/network/registry/passkey-options", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    if (!passkey) return reply.code(503).send({ error: "passkeys_not_configured" });
    const r = await passkey.options(admin);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return reply.send({ challengeId: r.challengeId, options: r.options });
  });

  app.post("/admin/network/registry/approve", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const body = z
      .object({
        nodeId: z.string().min(1).max(256),
        publicKeyFingerprint: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
        challengeId: z.string().min(10).max(64).optional(),
        credentialId: z.string().max(1024).optional(),
        response: z.unknown().optional()
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    // The owner's passkey, asserted for this approval (a session step-up is not enough).
    if (!passkey) return reply.code(503).send({ error: "passkeys_not_configured" });
    if (!body.data.challengeId || body.data.response === undefined) return reply.code(403).send({ error: "passkey_required", detail: "Confirm the approval with your passkey." });
    const v = await passkey.verify(admin, { challengeId: body.data.challengeId, credentialId: body.data.credentialId, response: body.data.response });
    if (!v.ok) return reply.code(v.status).send({ error: v.error });
    const r = await service.approve(body.data.nodeId, admin.userId, { publicKeyFingerprint: body.data.publicKeyFingerprint });
    return send(reply, r, () => ({ ok: true, member: r.ok ? memberView(r.member) : null }));
  });

  registerRegistryBillingRoute(app, { service, requireAdmin, passkey, view: memberView });

  app.post("/admin/network/registry/suspend", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const parsed = nodeBody.extend({ reason: z.string().trim().min(1).max(500).default("suspended_by_owner") }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const r = await service.suspend(parsed.data.nodeId, admin.userId, parsed.data.reason);
    return send(reply, r, () => ({ ok: true, member: r.ok ? memberView(r.member) : null }));
  });
}

/**
 * Portal wiring: the service from REGISTRY_* env and the portal Postgres, the routes (admin =
 * system admin), and the health loop (only when a signing key is set, and not under tests).
 */
export function registerPortalRegistry(
  app: FastifyInstance,
  deps: {
    requireOpsUser: (req: FastifyRequest, reply: FastifyReply) => Promise<{ user: { userId: string; email?: string }; access: { isSystemAdmin: boolean } } | null>;
    currentUser: (req: FastifyRequest) => Promise<{ userId: string; email?: string } | null>;
    store?: RegistryStore;
    operatorAccount?: (userId: string) => Promise<OperatorAccount>;
    passkey: RegistryPasskey | null;
  },
  env: NodeJS.ProcessEnv = process.env
): CoordinatorRegistryService {
  const service = registryServiceFromEnv(env, {
    log: (msg, extra) => app.log.info({ extra }, msg),
    store: deps.store,
    operatorAccount: deps.operatorAccount
  });
  registerRegistryRoutes(app, {
    service,
    currentUser: deps.currentUser,
    passkey: deps.passkey,
    requireAdmin: async (req, reply) => {
      const principal = await deps.requireOpsUser(req, reply);
      if (!principal) return null;
      if (!principal.access.isSystemAdmin) {
        reply.code(403).send({ error: "system_admin_required" });
        return null;
      }
      return principal.user;
    }
  });
  if (service.configured && !env.VITEST && env.NODE_ENV !== "test") service.start();
  app.addHook("onClose", async () => service.stop());
  return service;
}
