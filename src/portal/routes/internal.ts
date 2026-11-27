// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { InternalRoutesDeps } from "../server.js";
import { dnsLabelConflicts } from "../dns-manager.js";
import { moduleLogger } from "../../common/logger.js";
import { QUIET_ROUTE, logQuietRouteRefusals } from "../quiet-routes.js";
import { installRawBodyCapture } from "../../security/request-signing.js";
import { enrollCoordinatorCredential, type CoordinatorCaller, type CoordinatorCredentialStore } from "../coordinator-credentials.js";

export { QUIET_ROUTE };

const logger = moduleLogger("portal-internal");

/** #16: Service-to-service /internal/* routes (#40); registered inside the token-checked plugin. Moved unchanged from server.ts; server.ts passes in what it needs. */
type SignedAuthDeps = {
  /** onRequest gate that defers a coordinator signature to verifyInternalCaller (internal-auth.ts). */
  gateInternal?: (req: any, reply: any) => boolean;
  /** preValidation: verifies a coordinator signature in full and checks its scope. */
  verifyInternalCaller?: (req: any, reply: any) => Promise<boolean>;
  signedCoordinatorOf?: (req: any) => CoordinatorCaller | null;
  /** Per-coordinator credentials (admin list / enrol / revoke); absent: those routes answer 503. */
  credentialStore?: CoordinatorCredentialStore | null;
};

export function registerInternalRoutes(internal: FastifyInstance, deps: InternalRoutesDeps & SignedAuthDeps): void {
  const { autoRequestHost, callerKind, deleteDnsRecord, deriveIosDeviceIdFromNodeId, hostApprovedFor, requireControlPlaneAdmin, requireInternalToken, resolveIpIntelligence, secureCompare, sha256Hex, store } = deps;
  const signedCoordinatorOf = deps.signedCoordinatorOf ?? (() => null);
  // Coordinator signatures cover the exact body bytes (src/security/service-request-signing.ts).
  installRawBodyCapture(internal);
  /**
   * The calling coordinator's node id. A signed coordinator is the one whose key signed the request
   * (coordinator-credentials.ts). With the deprecated shared token: x-coordinator-node-id plus its
   * own registration token (x-coordinator-registration-token, the COORDINATOR_REGISTRATION_TOKEN the
   * portal issued for it). Null when either is missing or they do not match a coordinator enrollment.
   */
  async function callingCoordinator(req: { headers: unknown }): Promise<string | null> {
    const signedBy = signedCoordinatorOf(req);
    if (signedBy) return signedBy.coordinatorId;
    const headers = req.headers as Record<string, unknown>;
    const nodeId = typeof headers["x-coordinator-node-id"] === "string" ? headers["x-coordinator-node-id"].trim() : "";
    const token = typeof headers["x-coordinator-registration-token"] === "string" ? headers["x-coordinator-registration-token"].trim() : "";
    if (!store || nodeId.length < 3 || token.length < 10) return null;
    const node = await store.getNodeEnrollment(nodeId);
    if (!node || node.nodeKind !== "coordinator") return null;
    return secureCompare(node.registrationTokenHash, sha256Hex(token)) ? node.nodeId : null;
  }

  internal.addHook("onRequest", async (req, reply) => {
    if (!(deps.gateInternal ?? requireInternalToken)(req as any, reply)) return reply;
  });
  if (deps.verifyInternalCaller) {
    const verify = deps.verifyInternalCaller;
    internal.addHook("preValidation", async (req, reply) => {
      if (!(await verify(req as any, reply))) return reply;
    });
  }

  // Coordinators call validate and lookup several times a second: their request lines are dropped
  // (QUIET_ROUTE); refused tokens (401/403) and 5xx still log at warn.
  logQuietRouteRefusals(internal);

  internal.post("/internal/nodes/validate", QUIET_ROUTE, async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    if (!requireInternalToken(req as any, reply)) return;
    const body = z
      .object({
        nodeId: z.string().min(3),
        nodeKind: z.enum(["agent", "coordinator"]),
        registrationToken: z.string().min(10),
        deviceId: z.string().min(3).max(128).optional(),
        sourceIp: z.string().optional()
      })
      .parse(req.body);
    const requestDeviceId = body.deviceId?.trim().toLowerCase() || deriveIosDeviceIdFromNodeId(body.nodeId);
    let node = await store.getNodeEnrollment(body.nodeId);
    if (!node && requestDeviceId) {
      node = await store.getNodeEnrollmentByDeviceId(requestDeviceId);
    }
    if (!node) {
      // The token may belong to another enrolment: the machine named itself differently from the
      // node id it was enrolled as. Say which, so the coordinator can record the attempt for that
      // enrolment's owner (their Nodes page shows it) and tell the agent the name its token is for.
      // Matched by the token's hash only: nobody else's enrolment is ever named.
      const tokenNode = await Promise.resolve(store.getNodeEnrollmentByRegistrationTokenHash?.(sha256Hex(body.registrationToken))).catch(() => null);
      // The shared coordinator token never gets the owner's email (only the node id the token is for).
      const shareEmail = callerKind(req as any) !== "coordinator";
      return reply.code(404).send({
        allowed: false,
        reason: "node_not_enrolled",
        ...(tokenNode && tokenNode.nodeKind === body.nodeKind ? { tokenNode: { nodeId: tokenNode.nodeId, ...(shareEmail ? { ownerEmail: tokenNode.ownerEmail } : {}) } } : {})
      });
    }
    if (node.nodeKind !== body.nodeKind) {
      return reply.code(403).send({ allowed: false, reason: "node_kind_mismatch" });
    }
    // nodes:validate: a signed coordinator validates agents registering to it, and its own node only.
    const signedBy = signedCoordinatorOf(req);
    if (signedBy && node.nodeKind === "coordinator" && node.nodeId !== signedBy.coordinatorId) {
      return reply.code(403).send({ allowed: false, reason: "coordinator_scope_denied" });
    }
    if (!secureCompare(node.registrationTokenHash, sha256Hex(body.registrationToken))) {
      return reply.code(403).send({ allowed: false, reason: "registration_token_invalid" });
    }
    // Who validated: a platform-token call clears the record; a coordinator-token call that names
    // its own enrollment sets it (what /internal/nodes/lookup scopes the coordinator token by).
    const kind = callerKind(req as any);
    const validatedByCoordinator = kind === "coordinator" ? (await callingCoordinator(req)) ?? undefined : null;
    const intelligence = await resolveIpIntelligence(body.sourceIp);
    await store.touchNodeValidation({
      nodeId: node.nodeId,
      sourceIp: body.sourceIp,
      countryCode: intelligence.countryCode,
      vpnDetected: intelligence.vpnDetected,
      validatedByCoordinator
    });
    const refreshed = await store.getNodeEnrollment(node.nodeId);
    if (!refreshed) return reply.code(404).send({ allowed: false, reason: "node_missing_after_touch" });
    // Coordinator DNS names are not updated from validation calls: body.sourceIp is reported by the
    // calling coordinator (and on Fly is an egress address, not the ingress one).

    const reason = !refreshed.emailVerified
      ? "email_unverified"
      : !refreshed.nodeApproved
        ? "node_pending_coordinator_approval"
        : refreshed.active
          ? "ok"
          : "node_inactive";

    const hostApproved = await hostApprovedFor(refreshed.ownerEmail);
    // First connect of a machine whose owner is not a host: file a pending host request (deduped per email).
    if (!hostApproved && !node.lastSeenMs && autoRequestHost) void autoRequestHost({ nodeId: refreshed.nodeId, nodeKind: refreshed.nodeKind, ownerEmail: refreshed.ownerEmail, lastCountryCode: refreshed.lastCountryCode });
    // The shared coordinator token gets no owner email, IP or country (ownerUserId identifies the owner).
    const full = kind !== "coordinator";
    return reply.send({
      allowed: refreshed.active,
      reason,
      node: {
        nodeId: refreshed.nodeId,
        deviceId: refreshed.deviceId,
        nodeKind: refreshed.nodeKind,
        ownerUserId: refreshed.ownerUserId,
        ...(full ? { ownerEmail: refreshed.ownerEmail } : {}),
        emailVerified: refreshed.emailVerified,
        nodeApproved: refreshed.nodeApproved,
        // Host approval (src/portal/host-requests.ts): false = this node runs only its owner's own work.
        hostApproved,
        active: refreshed.active,
        ...(full ? { sourceIp: refreshed.lastIp, countryCode: refreshed.lastCountryCode } : {}),
        vpnDetected: refreshed.lastVpnDetected ?? false
      }
    });
  });

  internal.post("/internal/nodes/:nodeId/approval", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    if (!requireInternalToken(req as any, reply)) return;
    // A mutation: the service or coordinator token is not enough (coordinators hold one of them).
    if (!requireControlPlaneAdmin(req as any, reply)) return;
    const params = z.object({ nodeId: z.string() }).parse(req.params);
    const body = z.object({ approved: z.boolean() }).parse(req.body);
    const updated = await store.setNodeApproval(params.nodeId, body.approved);
    if (!updated) return reply.code(404).send({ error: "node_not_found" });

    // If coordinator is being deactivated, remove DNS record
    if (
      updated &&
      updated.nodeKind === "coordinator" &&
      !body.approved &&
      updated.dnsHostname &&
      dnsLabelConflicts(updated.nodeId, await store.listCoordinatorNodeIds()).length === 0
    ) {
      deleteDnsRecord(updated.nodeId).catch((err) =>
        logger.error({ nodeId: updated.nodeId, err }, "DNS delete failed")
      );
      if (store) {
        await store.updateNodeDns({
          nodeId: updated.nodeId,
          dnsHostname: updated.dnsHostname,
          dnsStatus: "pending",
          dnsIp: null,
        });
      }
    }

    return reply.send({ ok: true, node: updated });
  });

  internal.post("/internal/nodes/lookup", QUIET_ROUTE, async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    if (!requireInternalToken(req as any, reply)) return;
    const body = z.object({ nodeIds: z.array(z.string()).max(200) }).parse(req.body);
    // The shared coordinator token answers only about nodes the caller's own coordinator validated,
    // and without owner email, IP or country. The platform service token keeps the full answer.
    const scopedTo = callerKind(req as any) === "coordinator" ? await callingCoordinator(req) : undefined;
    if (scopedTo === null) return reply.code(403).send({ error: "coordinator_identity_required" });
    const found = (await Promise.all(body.nodeIds.map((nodeId) => store.getNodeEnrollment(nodeId)))).filter((n): n is NonNullable<typeof n> => Boolean(n));
    const nodes = scopedTo === undefined ? found : found.filter((n) => n.lastValidatedByCoordinator === scopedTo);
    const hostApproved = await Promise.all(nodes.map((n) => hostApprovedFor(n.ownerEmail)));
    return reply.send({
      nodes: nodes.map((n, i) => ({
        nodeId: n.nodeId,
        nodeKind: n.nodeKind,
        ...(scopedTo === undefined ? { ownerEmail: n.ownerEmail } : {}),
        emailVerified: n.emailVerified,
        nodeApproved: n.nodeApproved,
        hostApproved: hostApproved[i],
        active: n.active,
        ...(scopedTo === undefined ? { sourceIp: n.lastIp, countryCode: n.lastCountryCode } : {}),
        vpnDetected: n.lastVpnDetected ?? false,
        lastSeenMs: n.lastSeenMs
      }))
    });
  });

  internal.get("/internal/nodes/pending", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    if (!requireInternalToken(req as any, reply)) return;
    const query = z
      .object({
        nodeKind: z.enum(["agent", "coordinator"]).optional(),
        limit: z.coerce.number().int().positive().max(500).default(200)
      })
      .parse(req.query);
    // Like lookup: the shared coordinator token sees only nodes its own coordinator validated, without
    // owner email, IP or country. The platform service token keeps the full list.
    const scopedTo = callerKind(req as any) === "coordinator" ? await callingCoordinator(req) : undefined;
    if (scopedTo === null) return reply.code(403).send({ error: "coordinator_identity_required" });
    const nodes = await store.listPendingNodes({ nodeKind: query.nodeKind, limit: query.limit, ...(scopedTo ? { validatedByCoordinator: scopedTo } : {}) });
    return reply.send({
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId,
        nodeKind: n.nodeKind,
        ...(scopedTo === undefined ? { ownerEmail: n.ownerEmail } : {}),
        emailVerified: n.emailVerified,
        nodeApproved: n.nodeApproved,
        active: n.active,
        ...(scopedTo === undefined ? { sourceIp: n.lastIp, countryCode: n.lastCountryCode } : {}),
        vpnDetected: n.lastVpnDetected ?? false,
        lastSeenMs: n.lastSeenMs,
        updatedAtMs: n.updatedAtMs
      }))
    });
  });

  // Per-coordinator credentials (coordinator-credentials.ts): list, enrol a key, revoke. Admin only.
  const credentialStore = deps.credentialStore ?? null;
  internal.get("/internal/coordinator-credentials", async (req, reply) => {
    if (!requireInternalToken(req as any, reply)) return;
    if (!requireControlPlaneAdmin(req as any, reply)) return;
    if (!credentialStore) return reply.code(503).send({ error: "coordinator_credentials_not_configured" });
    const q = z.object({ coordinatorNodeId: z.string().min(3).optional() }).parse(req.query ?? {});
    return reply.send({ credentials: q.coordinatorNodeId ? await credentialStore.listForCoordinator(q.coordinatorNodeId) : await credentialStore.list() });
  });
  internal.post("/internal/coordinator-credentials", async (req, reply) => {
    if (!requireInternalToken(req as any, reply)) return;
    if (!requireControlPlaneAdmin(req as any, reply)) return;
    if (!credentialStore) return reply.code(503).send({ error: "coordinator_credentials_not_configured" });
    const body = z
      .object({
        coordinatorNodeId: z.string().min(3).max(200),
        publicKeyPem: z.string().max(4096).optional(),
        publicKeyFingerprint: z.string().max(128).optional(),
        scopes: z.array(z.string()).max(10).optional(),
        operatorUserId: z.string().max(200).optional()
      })
      .parse(req.body);
    const result = await enrollCoordinatorCredential(credentialStore, body);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    logger.info({ coordinatorNodeId: body.coordinatorNodeId, credentialId: result.credential.id }, "portal_coordinator_credential_enrolled");
    return reply.send({ ok: true, credential: result.credential });
  });
  internal.post("/internal/coordinator-credentials/revoke", async (req, reply) => {
    if (!requireInternalToken(req as any, reply)) return;
    if (!requireControlPlaneAdmin(req as any, reply)) return;
    if (!credentialStore) return reply.code(503).send({ error: "coordinator_credentials_not_configured" });
    const body = z
      .object({ coordinatorNodeId: z.string().min(3).max(200).optional(), credentialId: z.string().min(3).max(200).optional(), reason: z.string().max(500).optional() })
      .refine((b) => Boolean(b.coordinatorNodeId) !== Boolean(b.credentialId), { message: "name a coordinatorNodeId or a credentialId" })
      .parse(req.body);
    const reason = body.reason?.trim() || "admin_revoked";
    const at = Date.now();
    const revoked = body.credentialId ? ((await credentialStore.revokeById(body.credentialId, reason, at)) ? 1 : 0) : await credentialStore.revokeCoordinator(body.coordinatorNodeId!, reason, at);
    // A coordinator with no rows yet still gets a revoked marker, so it cannot bind a key by itself later.
    if (body.coordinatorNodeId && revoked === 0 && (await credentialStore.listForCoordinator(body.coordinatorNodeId)).length === 0) {
      await credentialStore.insert({
        id: `pcred-revoked-${Date.now().toString(36)}`,
        coordinatorNodeId: body.coordinatorNodeId,
        operatorUserId: "",
        publicKeyFingerprint: "",
        scopes: [],
        source: "admin",
        createdAtMs: at,
        revokedAtMs: at,
        revokedReason: reason,
        lastUsedMs: null
      });
    }
    logger.warn({ coordinatorNodeId: body.coordinatorNodeId, credentialId: body.credentialId, revoked }, "portal_coordinator_credential_revoked");
    return reply.send({ ok: true, revoked });
  });

  internal.get("/internal/stats/counts", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    if (!requireInternalToken(req as any, reply)) return;
    const counts = await store.getStatsCounts();
    return reply.send(counts);
  });
}
