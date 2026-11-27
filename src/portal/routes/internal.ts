// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { InternalRoutesDeps } from "../server.js";
import { dnsLabelConflicts } from "../dns-manager.js";
import { moduleLogger } from "../../common/logger.js";
import { QUIET_ROUTE, logQuietRouteRefusals } from "../quiet-routes.js";

export { QUIET_ROUTE };

const logger = moduleLogger("portal-internal");

/** #16: Service-to-service /internal/* routes (#40); registered inside the token-checked plugin. Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerInternalRoutes(internal: FastifyInstance, { autoRequestHost, callerKind, deleteDnsRecord, deriveIosDeviceIdFromNodeId, hostApprovedFor, requireControlPlaneAdmin, requireInternalToken, resolveIpIntelligence, secureCompare, sha256Hex, store }: InternalRoutesDeps): void {
  /**
   * The calling coordinator's enrolled node id, from x-coordinator-node-id plus its own registration
   * token (x-coordinator-registration-token, the COORDINATOR_REGISTRATION_TOKEN the portal issued
   * for it). Null when either is missing or they do not match a coordinator enrollment.
   */
  async function callingCoordinator(headers: Record<string, unknown>): Promise<string | null> {
    const nodeId = typeof headers["x-coordinator-node-id"] === "string" ? headers["x-coordinator-node-id"].trim() : "";
    const token = typeof headers["x-coordinator-registration-token"] === "string" ? headers["x-coordinator-registration-token"].trim() : "";
    if (!store || nodeId.length < 3 || token.length < 10) return null;
    const node = await store.getNodeEnrollment(nodeId);
    if (!node || node.nodeKind !== "coordinator") return null;
    return secureCompare(node.registrationTokenHash, sha256Hex(token)) ? node.nodeId : null;
  }

  internal.addHook("onRequest", async (req, reply) => {
    if (!requireInternalToken(req as any, reply)) return reply;
  });

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
      return reply.code(404).send({
        allowed: false,
        reason: "node_not_enrolled",
        ...(tokenNode && tokenNode.nodeKind === body.nodeKind ? { tokenNode: { nodeId: tokenNode.nodeId, ownerEmail: tokenNode.ownerEmail } } : {})
      });
    }
    if (node.nodeKind !== body.nodeKind) {
      return reply.code(403).send({ allowed: false, reason: "node_kind_mismatch" });
    }
    if (!secureCompare(node.registrationTokenHash, sha256Hex(body.registrationToken))) {
      return reply.code(403).send({ allowed: false, reason: "registration_token_invalid" });
    }
    // Who validated: a platform-token call clears the record; a coordinator-token call that names
    // its own enrollment sets it (what /internal/nodes/lookup scopes the coordinator token by).
    const kind = callerKind(req as any);
    const validatedByCoordinator = kind === "coordinator" ? (await callingCoordinator(req.headers as Record<string, unknown>)) ?? undefined : null;
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
    return reply.send({
      allowed: refreshed.active,
      reason,
      node: {
        nodeId: refreshed.nodeId,
        deviceId: refreshed.deviceId,
        nodeKind: refreshed.nodeKind,
        ownerUserId: refreshed.ownerUserId,
        ownerEmail: refreshed.ownerEmail,
        emailVerified: refreshed.emailVerified,
        nodeApproved: refreshed.nodeApproved,
        // Host approval (src/portal/host-requests.ts): false = this node runs only its owner's own work.
        hostApproved,
        active: refreshed.active,
        sourceIp: refreshed.lastIp,
        countryCode: refreshed.lastCountryCode,
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
    const scopedTo = callerKind(req as any) === "coordinator" ? await callingCoordinator(req.headers as Record<string, unknown>) : undefined;
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
    const nodes = await store.listPendingNodes({ nodeKind: query.nodeKind, limit: query.limit });
    return reply.send({
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId,
        nodeKind: n.nodeKind,
        ownerEmail: n.ownerEmail,
        emailVerified: n.emailVerified,
        nodeApproved: n.nodeApproved,
        active: n.active,
        sourceIp: n.lastIp,
        countryCode: n.lastCountryCode,
        vpnDetected: n.lastVpnDetected ?? false,
        lastSeenMs: n.lastSeenMs,
        updatedAtMs: n.updatedAtMs
      }))
    });
  });

  internal.get("/internal/stats/counts", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    if (!requireInternalToken(req as any, reply)) return;
    const counts = await store.getStatsCounts();
    return reply.send(counts);
  });
}
