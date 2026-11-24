// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import type { AccountApiRoutesDeps } from "../server.js";
import { API_KEY_PREFIX, hashApiKey } from "./hosted.js";
import { NODE_ID_PATTERN } from "../pages/escape.js";
import { dnsLabelConflicts } from "../dns-manager.js";
import { rejectedAttemptsForOwner } from "../rejected-attempts.js";
import { moduleLogger } from "../../common/logger.js";
import { registerChatSharingRoutes } from "./chat-sharing.js";
import { askEveryCoordinator, getCoordinatorJson } from "../coordinator-fanout.js";

const logger = moduleLogger("portal-account");

/** Credit accounts are named acct-<userId>; a node ID of that form would read that account's ledger. */
export function isReservedNodeId(nodeId: string): boolean {
  return /^acct-/i.test(nodeId);
}

/** #16: Account, nodes and dashboard API (/me, /nodes/*, /dashboard/*, /ios/*, /portal/api/admin/*). Moved unchanged from server.ts; server.ts passes in what it needs. */
/** Agents one account may enrol (PORTAL_MAX_AGENTS_PER_ACCOUNT, default 25). */
export function maxAgentsPerAccount(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PORTAL_MAX_AGENTS_PER_ACCOUNT);
  return Number.isInteger(n) && n >= 1 ? n : 25;
}

export function registerAccountApiRoutes(app: FastifyInstance, { discoverCoordinatorUrlsForPortal, everyCoordinatorUrl, fetchCoordinatorFederatedSummary, CONTROL_PLANE_ADMIN_TOKEN, CONTROL_PLANE_URL, EXTERNAL_HTTP_TIMEOUT_MS, buildAccessContext, controlPlaneHeaders, deleteDnsRecord, deriveIosDeviceIdFromNodeId, ensureCreditAccountForUser, getCoordinatorHostname, getCurrentUser, loadIosAgentRuntime, loadIosNetworkSummary, loadNetworkInsightsForUser, loadWalletSnapshotForUser, sha256Hex, store }: AccountApiRoutesDeps): void {
  // iOS app summary: account and network info only. The iPhone hosts only over Bluetooth and does
  // not earn or pay out, so neither route returns contribution, earnings or wallet figures. Both stay
  // (no 404) for older app builds; no shipped build decodes the removed fields (DashboardView was
  // unreachable from the app's UI before the first TestFlight build).
  app.get("/ios/dashboard", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const [nodes, networkSummary] = await Promise.all([
      store.listNodesByOwner(user.userId),
      loadIosNetworkSummary()
    ]);
    return reply.send({
      user: { userId: user.userId, email: user.email, emailVerified: user.emailVerified },
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId,
        nodeKind: n.nodeKind,
        active: n.active,
        nodeApproved: n.nodeApproved,
        lastSeenMs: n.lastSeenMs
      })),
      networkSummary
    });
  });

  app.get("/ios/agents/:agentId/contribution", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const params = z.object({ agentId: z.string().min(3) }).parse(req.params);
    if (!NODE_ID_PATTERN.test(params.agentId) || isReservedNodeId(params.agentId)) {
      return reply.code(404).send({ error: "agent_not_found" });
    }
    const node = await store.getNodeEnrollment(params.agentId);
    if (!node || node.nodeKind !== "agent") {
      return reply.code(404).send({ error: "agent_not_found" });
    }
    if (node.ownerUserId !== user.userId) {
      return reply.code(403).send({ error: "agent_access_forbidden" });
    }

    const { runtime } = await loadIosAgentRuntime(params.agentId);
    return reply.send({
      agentId: params.agentId,
      node: {
        active: node.active,
        nodeApproved: node.nodeApproved,
        lastSeenMs: node.lastSeenMs
      },
      runtime
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

  // Opt-in to share chat context to improve EdgeCoder (GET/PUT /me/chat-sharing).
  registerChatSharingRoutes(app, { store, getCurrentUser });

  // /portal/api/admin/users* moved to routes/admin-users.ts (list, role, delete, cleanup).

  // Enrolment (and only enrolment) also takes a portal API key, so `edgecoder-install --enroll eck_...` needs no browser session token.
  const enrollingUser = async (req: { headers: Record<string, unknown> }) => {
    const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!key.startsWith(API_KEY_PREFIX)) return getCurrentUser(req as any);
    const userId = store ? await store.userForApiKeyHash(hashApiKey(key)) : null;
    return userId && store ? store.getUserById(userId) : null;
  };

  app.post("/nodes/enroll", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await enrollingUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });

    // Node ids are shown in admin and owner pages and used in DNS names: a safe charset only.
    const raw = (req.body ?? {}) as { nodeId?: unknown };
    if (typeof raw.nodeId === "string" && !NODE_ID_PATTERN.test(raw.nodeId)) {
      return reply.code(400).send({ error: "invalid_node_id", detail: "Use 3-128 letters, digits, '.', '_' or '-'." });
    }
    if (typeof raw.nodeId === "string" && isReservedNodeId(raw.nodeId)) {
      return reply.code(400).send({ error: "reserved_node_id", detail: "Node IDs may not start with 'acct-'." });
    }
    const body = z
      .object({
        nodeId: z.string().regex(NODE_ID_PATTERN),
        nodeKind: z.enum(["agent", "coordinator"]),
        deviceId: z.string().min(3).max(128).optional()
      })
      .parse(req.body);
    const enrollmentDeviceId =
      body.deviceId?.trim().toLowerCase() || (body.nodeKind === "agent" ? deriveIosDeviceIdFromNodeId(body.nodeId) : undefined);
    // A node ID or device ID enrolled by another user is theirs: it can't be enrolled, linked or
    // redirected to this account. The store enforces the same; checking here keeps the 409 explicit.
    const [byNodeId, byDeviceId] = await Promise.all([
      store.getNodeEnrollment(body.nodeId),
      enrollmentDeviceId ? store.getNodeEnrollmentByDeviceId(enrollmentDeviceId) : Promise.resolve(null)
    ]);
    if ((byNodeId && byNodeId.ownerUserId !== user.userId) || (byDeviceId && byDeviceId.ownerUserId !== user.userId)) {
      return reply.code(409).send({ error: "node_owned_by_another_user" });
    }
    // A coordinator's DNS name comes from its node ID; two IDs that map to the same name can't both have one.
    if (body.nodeKind === "coordinator" && dnsLabelConflicts(body.nodeId, await store.listCoordinatorNodeIds()).length > 0) {
      return reply.code(409).send({ error: "dns_name_taken", detail: "Another coordinator uses a node ID with the same DNS name. Pick a different node ID." });
    }
    // Sybil bound: every per-agent limit on the coordinator scales with the agents one account can
    // enrol. Re-enrolling a node already yours is never refused.
    if (body.nodeKind === "agent" && !byNodeId && !byDeviceId && typeof store.listNodesByOwner === "function") {
      const agents = (await store.listNodesByOwner(user.userId)).filter((n) => n.nodeKind === "agent").length;
      if (agents >= maxAgentsPerAccount()) {
        return reply.code(429).send({ error: "agent_limit_reached", detail: `An account may enrol at most ${maxAgentsPerAccount()} agents.` });
      }
    }
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
    if (!record || record.ownerUserId !== user.userId) return reply.code(409).send({ error: "node_owned_by_another_user" });
    if (body.nodeKind === "agent" && user.emailVerified && !record.nodeApproved) {
      const approved = await store.setNodeApproval(record.nodeId, true);
      if (approved) {
        record = approved;
      }
    }
    // Link agent ownership so credits earned by this node flow to the user's account. Only the
    // enrollment the caller owns (record.nodeId, which a device redirect may have changed) is linked.
    if (CONTROL_PLANE_URL && CONTROL_PLANE_ADMIN_TOKEN) {
      const accountId = `acct-${user.userId}`;
      await ensureCreditAccountForUser(user);
      request(`${CONTROL_PLANE_URL}/credits/accounts/${encodeURIComponent(accountId)}/agents/link`, {
        method: "POST",
        headers: controlPlaneHeaders(true),
        headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
        bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
        body: JSON.stringify({
          agentId: record.nodeId,
          ownerUserId: user.userId
        })
      }).catch(() => undefined);
    }
    // Assign DNS hostname for coordinator nodes
    let dnsHostname: string | undefined;
    if (body.nodeKind === "coordinator" && store) {
      dnsHostname = getCoordinatorHostname(record.nodeId);
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
    // Only when no other coordinator's node ID maps to the same DNS name (an older enrollment may).
    if (existing.nodeKind === "coordinator" && existing.dnsHostname) {
      const shared = dnsLabelConflicts(existing.nodeId, await store.listCoordinatorNodeIds());
      if (shared.length === 0) {
        deleteDnsRecord(existing.nodeId).catch((err) =>
          logger.error({ nodeId: existing.nodeId, err }, "failed to delete DNS record")
        );
      } else {
        logger.warn({ nodeId: existing.nodeId, sharedWith: shared }, "DNS record kept: shared with other nodes");
      }
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

    // The token must belong to an enrollment (stored hashed), like /internal/nodes/validate checks.
    const enrollment = await store.getNodeEnrollmentByRegistrationTokenHash(sha256Hex(token));
    if (!enrollment) {
      return reply.code(401).send({ error: "registration_token_invalid" });
    }
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

  // The node id a registration token was issued for, for the token's holder (edgecoder-install
  // apply --token names the agent after it, so the agent id always matches its enrolment).
  app.get("/nodes/token-node", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) return reply.code(401).send({ error: "registration_token_required" });
    const enrollment = await store.getNodeEnrollmentByRegistrationTokenHash(sha256Hex(token));
    if (!enrollment) return reply.code(401).send({ error: "registration_token_invalid" });
    return reply.send({ nodeId: enrollment.nodeId, nodeKind: enrollment.nodeKind });
  });

  // Machines that presented one of this account's registration tokens under a node id that isn't
  // enrolled (rejected-attempts.ts): shown on Settings > Nodes with how to fix the name.
  app.get("/nodes/rejected-attempts", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    if (!user.email) return reply.send({ attempts: [] });
    try {
      const federated = await fetchCoordinatorFederatedSummary({ ownerEmail: user.email });
      const attempts = await rejectedAttemptsForOwner({
        ownerEmail: user.email,
        nodes: federated.nodes,
        isEnrolled: async (nodeId) => Boolean(await store.getNodeEnrollment(nodeId)),
        nowMs: Date.now()
      });
      return reply.send({ attempts });
    } catch {
      return reply.send({ attempts: [] });
    }
  });

  app.get("/nodes/me", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const nodes = await store.listNodesByOwner(user.userId);
    return reply.send({ nodes });
  });

  // Network status for the dashboard's status cards: any signed-in user (the coordinator's public
  // /health/runtime), not the operator-only /coordinator/ops/summary.
  app.get("/dashboard/network-status", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    // Every coordinator (each counts only the machines linked to it): online when any answers; counts add up.
    const answers = await askEveryCoordinator(await everyCoordinatorUrl(), (base, signal) => getCoordinatorJson(base, "/health/runtime", { signal, timeoutMs: EXTERNAL_HTTP_TIMEOUT_MS }), { timeoutMs: EXTERNAL_HTTP_TIMEOUT_MS });
    const up = answers.flatMap((a) => (a.ok ? [(a.value as { coordinator?: { agents?: number; queued?: number } }).coordinator ?? {}] : []));
    return reply.send({ coordinatorOnline: up.length > 0, agents: up.reduce((n, c) => n + (Number(c.agents) || 0), 0), queued: up.reduce((n, c) => n + (Number(c.queued) || 0), 0) });
  });

  app.get("/dashboard/summary", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const [nodes, walletSnapshot] = await Promise.all([store.listNodesByOwner(user.userId), loadWalletSnapshotForUser(user.userId)]);
    // Self-heal: ensure agent ownership is linked for every node this user owns (and only those).
    if (CONTROL_PLANE_URL && CONTROL_PLANE_ADMIN_TOKEN && nodes.length > 0) {
      const accountId = `acct-${user.userId}`;
      for (const node of nodes.filter((n) => n.ownerUserId === user.userId)) {
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
