// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { InternalRoutesDeps } from "../server.js";

/** #16: Service-to-service /internal/* routes (#40); registered inside the token-checked plugin. Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerInternalRoutes(internal: FastifyInstance, { deleteDnsRecord, deriveIosDeviceIdFromNodeId, getCoordinatorHostname, isDnsConfigured, requireInternalToken, resolveIpIntelligence, secureCompare, sha256Hex, store, syncCoordinatorDns }: InternalRoutesDeps): void {
  internal.addHook("onRequest", async (req, reply) => {
    if (!requireInternalToken(req as any, reply)) return reply;
  });

  internal.post("/internal/nodes/validate", async (req, reply) => {
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
      return reply.code(404).send({ allowed: false, reason: "node_not_enrolled" });
    }
    if (node.nodeKind !== body.nodeKind) {
      return reply.code(403).send({ allowed: false, reason: "node_kind_mismatch" });
    }
    if (!secureCompare(node.registrationTokenHash, sha256Hex(body.registrationToken))) {
      return reply.code(403).send({ allowed: false, reason: "registration_token_invalid" });
    }
    const intelligence = await resolveIpIntelligence(body.sourceIp);
    await store.touchNodeValidation({
      nodeId: node.nodeId,
      sourceIp: body.sourceIp,
      countryCode: intelligence.countryCode,
      vpnDetected: intelligence.vpnDetected
    });
    const refreshed = await store.getNodeEnrollment(node.nodeId);
    if (!refreshed) return reply.code(404).send({ allowed: false, reason: "node_missing_after_touch" });

    // Sync DNS for coordinator nodes (fire-and-forget)
    if (
      refreshed.nodeKind === "coordinator" &&
      refreshed.active &&
      body.sourceIp &&
      isDnsConfigured() &&
      store
    ) {
      syncCoordinatorDns({
        nodeId: refreshed.nodeId,
        sourceIp: body.sourceIp,
        currentDnsIp: refreshed.dnsIp ?? null,
        dnsLastUpdatedMs: refreshed.dnsLastUpdatedMs ?? null,
      })
        .then(async (result) => {
          const hostname = refreshed.dnsHostname || getCoordinatorHostname(refreshed.nodeId);
          await store.updateNodeDns({
            nodeId: refreshed.nodeId,
            dnsHostname: hostname,
            dnsStatus: result.dnsStatus,
            dnsIp: result.dnsIp,
          });
        })
        .catch((err) =>
          console.error(`[portal] DNS sync failed for ${refreshed.nodeId}:`, err)
        );
    }

    const reason = !refreshed.emailVerified
      ? "email_unverified"
      : !refreshed.nodeApproved
        ? "node_pending_coordinator_approval"
        : refreshed.active
          ? "ok"
          : "node_inactive";

    return reply.send({
      allowed: refreshed.active,
      reason,
      node: {
        nodeId: refreshed.nodeId,
        deviceId: refreshed.deviceId,
        nodeKind: refreshed.nodeKind,
        ownerEmail: refreshed.ownerEmail,
        emailVerified: refreshed.emailVerified,
        nodeApproved: refreshed.nodeApproved,
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
    const params = z.object({ nodeId: z.string() }).parse(req.params);
    const body = z.object({ approved: z.boolean() }).parse(req.body);
    const updated = await store.setNodeApproval(params.nodeId, body.approved);
    if (!updated) return reply.code(404).send({ error: "node_not_found" });

    // If coordinator is being deactivated, remove DNS record
    if (
      updated &&
      updated.nodeKind === "coordinator" &&
      !body.approved &&
      updated.dnsHostname
    ) {
      deleteDnsRecord(updated.nodeId).catch((err) =>
        console.error(`[portal] DNS delete failed for ${updated.nodeId}:`, err)
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

  internal.post("/internal/nodes/lookup", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    if (!requireInternalToken(req as any, reply)) return;
    const body = z.object({ nodeIds: z.array(z.string()).max(200) }).parse(req.body);
    const nodes = await Promise.all(body.nodeIds.map((nodeId) => store.getNodeEnrollment(nodeId)));
    return reply.send({
      nodes: nodes.filter((n): n is NonNullable<typeof n> => Boolean(n)).map((n) => ({
        nodeId: n.nodeId,
        nodeKind: n.nodeKind,
        ownerEmail: n.ownerEmail,
        emailVerified: n.emailVerified,
        nodeApproved: n.nodeApproved,
        active: n.active,
        sourceIp: n.lastIp,
        countryCode: n.lastCountryCode,
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
