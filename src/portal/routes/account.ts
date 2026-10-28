// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import type { AccountApiRoutesDeps } from "../server.js";

/** #16: Account, nodes and dashboard API (/me, /nodes/*, /dashboard/*, /ios/*, /portal/api/admin/*). Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerAccountApiRoutes(app: FastifyInstance, { CONTROL_PLANE_ADMIN_TOKEN, CONTROL_PLANE_URL, EXTERNAL_HTTP_TIMEOUT_MS, buildAccessContext, controlPlaneHeaders, deleteDnsRecord, deriveIosDeviceIdFromNodeId, ensureCreditAccountForUser, getCoordinatorHostname, getCurrentUser, loadIosAgentContributionForUser, loadIosNetworkSummary, loadNetworkInsightsForUser, loadWalletSnapshotForUser, sha256Hex, store }: AccountApiRoutesDeps): void {
  app.get("/ios/dashboard", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const [nodes, walletSnapshot, networkSummary] = await Promise.all([
      store.listNodesByOwner(user.userId),
      loadWalletSnapshotForUser(user.userId),
      loadIosNetworkSummary()
    ]);
    const history = (walletSnapshot as any)?.creditHistory ?? [];
    const earned = history
      .filter((tx: any) => tx?.reason === "compute_contribution" && tx?.type === "earn")
      .reduce((sum: number, tx: any) => sum + Number(tx.credits ?? 0), 0);
    const contributedTasks = new Set(
      history
        .filter((tx: any) => tx?.reason === "compute_contribution" && tx?.relatedTaskId)
        .map((tx: any) => String(tx.relatedTaskId))
    );
    return reply.send({
      user: { userId: user.userId, email: user.email, emailVerified: user.emailVerified },
      contribution: {
        earnedCredits: Number(earned.toFixed(3)),
        contributedTaskCount: contributedTasks.size
      },
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId,
        nodeKind: n.nodeKind,
        active: n.active,
        nodeApproved: n.nodeApproved,
        lastSeenMs: n.lastSeenMs
      })),
      walletSnapshot,
      networkSummary
    });
  });

  app.get("/ios/agents/:agentId/contribution", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const params = z.object({ agentId: z.string().min(3) }).parse(req.params);
    const node = await store.getNodeEnrollment(params.agentId);
    if (!node || node.nodeKind !== "agent") {
      return reply.code(404).send({ error: "agent_not_found" });
    }
    if (node.ownerUserId !== user.userId) {
      return reply.code(403).send({ error: "agent_access_forbidden" });
    }

    const agentSnapshot = await loadIosAgentContributionForUser(params.agentId);
    return reply.send({
      agentId: params.agentId,
      node: {
        active: node.active,
        nodeApproved: node.nodeApproved,
        lastSeenMs: node.lastSeenMs
      },
      ...agentSnapshot
    });
  });

  app.get("/me", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const access = await buildAccessContext(user);
    const nodes = await store.listNodesByOwner(user.userId);
    return reply.send({
      user: {
        userId: user.userId,
        email: user.email,
        emailVerified: user.emailVerified,
        uiTheme: user.uiTheme,
        displayName: user.displayName,
        role: user.role,
        roles: {
          isSystemAdmin: access.isSystemAdmin,
          isCoordinatorAdmin: access.isCoordinatorAdmin
        }
      },
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId,
        nodeKind: n.nodeKind,
        active: n.active,
        emailVerified: n.emailVerified,
        nodeApproved: n.nodeApproved
      }))
    });
  });

  app.post("/me/theme", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const body = z.object({ theme: z.enum(["warm", "midnight", "emerald"]) }).parse(req.body);
    await store.setUserTheme(user.userId, body.theme);
    return reply.send({ ok: true, theme: body.theme });
  });

  app.get("/portal/api/admin/users", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const access = await buildAccessContext(user);
    if (!access.isSystemAdmin) return reply.code(403).send({ error: "admin_only" });
    const users = await store.listAllUsers();
    return reply.send({
      users: users.map((u) => ({
        userId: u.userId,
        email: u.email,
        role: u.role,
        emailVerified: u.emailVerified,
        createdAtMs: u.createdAtMs
      }))
    });
  });

  app.post("/portal/api/admin/users/:userId/role", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const access = await buildAccessContext(user);
    if (!access.isSystemAdmin) return reply.code(403).send({ error: "admin_only" });
    const { userId } = req.params as { userId: string };
    const body = z.object({ role: z.enum(["user", "admin"]) }).parse(req.body);
    const target = await store.getUserById(userId);
    if (!target) return reply.code(404).send({ error: "user_not_found" });
    await store.setUserRole(userId, body.role);
    return reply.send({ ok: true, userId, role: body.role });
  });

  app.post("/nodes/enroll", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });

    const body = z
      .object({
        nodeId: z.string().min(3),
        nodeKind: z.enum(["agent", "coordinator"]),
        deviceId: z.string().min(3).max(128).optional()
      })
      .parse(req.body);
    const enrollmentDeviceId =
      body.deviceId?.trim().toLowerCase() || (body.nodeKind === "agent" ? deriveIosDeviceIdFromNodeId(body.nodeId) : undefined);
    const registrationToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    let record = await store.upsertNodeEnrollment({
      nodeId: body.nodeId,
      deviceId: enrollmentDeviceId,
      nodeKind: body.nodeKind,
      ownerUserId: user.userId,
      ownerEmail: user.email,
      registrationTokenHash: sha256Hex(registrationToken),
      emailVerified: user.emailVerified
    });
    if (body.nodeKind === "agent" && user.emailVerified && !record.nodeApproved) {
      const approved = await store.setNodeApproval(record.nodeId, true);
      if (approved) {
        record = approved;
      }
    }
    // Link agent ownership so credits earned by this node flow to the user's account
    if (CONTROL_PLANE_URL && CONTROL_PLANE_ADMIN_TOKEN) {
      const accountId = `acct-${user.userId}`;
      await ensureCreditAccountForUser(user);
      request(`${CONTROL_PLANE_URL}/credits/accounts/${encodeURIComponent(accountId)}/agents/link`, {
        method: "POST",
        headers: controlPlaneHeaders(true),
        headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
        bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
        body: JSON.stringify({
          agentId: body.nodeId,
          ownerUserId: user.userId
        })
      }).catch(() => undefined);
    }
    // Assign DNS hostname for coordinator nodes
    let dnsHostname: string | undefined;
    if (body.nodeKind === "coordinator" && store) {
      dnsHostname = getCoordinatorHostname(body.nodeId);
      await store.updateNodeDns({
        nodeId: record.nodeId,
        dnsHostname,
        dnsStatus: "pending",
        dnsIp: null,
      });
    }

    return reply.send({
      ok: true,
      nodeId: record.nodeId,
      deviceId: record.deviceId,
      nodeKind: record.nodeKind,
      emailVerified: record.emailVerified,
      nodeApproved: record.nodeApproved,
      active: record.active,
      registrationToken,
      ...(dnsHostname ? { dnsHostname } : {}),
    });
  });

  app.delete("/nodes/:nodeId", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const params = z.object({ nodeId: z.string().min(3) }).parse(req.params);
    const access = await buildAccessContext(user);
    const existing = await store.getNodeEnrollment(params.nodeId);
    if (!existing) return reply.code(404).send({ error: "node_not_found" });
    if (!access.isSystemAdmin && existing.ownerUserId !== user.userId) {
      return reply.code(403).send({ error: "node_delete_forbidden" });
    }
    // Clean up DNS record for coordinator nodes
    if (existing.nodeKind === "coordinator" && existing.dnsHostname) {
      deleteDnsRecord(existing.nodeId).catch((err) =>
        console.error(`[portal] Failed to delete DNS for ${existing.nodeId}:`, err)
      );
    }

    const ok = await store.deleteNodeEnrollment(params.nodeId);
    if (!ok) return reply.code(404).send({ error: "node_not_found" });
    return reply.send({ ok: true, deletedNodeId: params.nodeId });
  });

  app.get("/nodes/discover-coordinator", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });

    // Authenticate via registration token in Authorization header
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) {
      return reply.code(401).send({ error: "registration_token_required" });
    }

    // Token is accepted as proof of enrollment — coordinator will re-validate
    const coordinators = await store.listActiveCoordinators();
    if (coordinators.length === 0) {
      return reply.send({ coordinatorUrl: null, reason: "no_public_coordinators" });
    }

    // Simple selection: first active coordinator (ordered by most recently seen)
    const selected = coordinators[0];
    return reply.send({
      coordinatorUrl: `https://${selected.dnsHostname}`,
      coordinatorNodeId: selected.nodeId,
      dnsStatus: selected.dnsStatus,
    });
  });

  app.get("/nodes/me", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const nodes = await store.listNodesByOwner(user.userId);
    return reply.send({ nodes });
  });

  app.get("/dashboard/summary", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const [nodes, walletSnapshot] = await Promise.all([store.listNodesByOwner(user.userId), loadWalletSnapshotForUser(user.userId)]);
    // Self-heal: ensure agent ownership is linked for all enrolled nodes
    if (CONTROL_PLANE_URL && CONTROL_PLANE_ADMIN_TOKEN && nodes.length > 0) {
      const accountId = `acct-${user.userId}`;
      for (const node of nodes) {
        request(`${CONTROL_PLANE_URL}/credits/accounts/${encodeURIComponent(accountId)}/agents/link`, {
          method: "POST",
          headers: controlPlaneHeaders(true),
          headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
          bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
          body: JSON.stringify({ agentId: node.nodeId, ownerUserId: user.userId })
        }).catch(() => undefined);
      }
    }
    return reply.send({
      user: { userId: user.userId, email: user.email, emailVerified: user.emailVerified, uiTheme: user.uiTheme },
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId,
        nodeKind: n.nodeKind,
        active: n.active,
        emailVerified: n.emailVerified,
        nodeApproved: n.nodeApproved,
        lastSeenMs: n.lastSeenMs
      })),
      walletSnapshot
    });
  });

  app.get("/dashboard/network-insights", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const insights = await loadNetworkInsightsForUser();
    return reply.send(insights);
  });
}
