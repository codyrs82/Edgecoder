// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { z } from "zod";
import type { CoordinatorOpsRoutesDeps } from "../server.js";

/** #16: Coordinator operations API (/coordinator/ops/*). Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerCoordinatorOpsRoutes(app: FastifyInstance, { CONTROL_PLANE_ADMIN_TOKEN, CONTROL_PLANE_URL, EXTERNAL_HTTP_TIMEOUT_MS, PORTAL_SERVICE_TOKEN, controlPlaneHeaders, discoverCoordinatorUrlsForPortal, fetchCoordinatorFederatedSummary, requireCoordinatorOperationsUser, store }: CoordinatorOpsRoutesDeps): void {
  app.get("/coordinator/ops/summary", async (req, reply) => {
    const principal = await requireCoordinatorOperationsUser(req as any, reply);
    if (!principal) return;
    const { user, access } = principal;
    try {
      let status: Record<string, unknown> = {
        agents: 0,
        queued: 0,
        results: 0
      };
      if (access.isSystemAdmin && CONTROL_PLANE_URL && CONTROL_PLANE_ADMIN_TOKEN) {
        const res = await request(`${CONTROL_PLANE_URL}/ops/summary`, {
          method: "GET",
          headers: controlPlaneHeaders(),
          headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
          bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
        });
        const payload = (await res.body.json()) as { status?: Record<string, unknown> };
        if (res.statusCode >= 200 && res.statusCode < 300 && payload.status) {
          status = payload.status;
        }
      } else {
        const ownedNodes = (await store?.listNodesByOwner(user.userId)) ?? [];
        status = {
          agents: ownedNodes.filter((n) => n.nodeKind === "agent" && n.active).length,
          queued: 0,
          results: 0
        };
      }
      const ownerUserId = access.isSystemAdmin ? undefined : user.userId;
      const ownerEmail = access.isSystemAdmin ? undefined : user.email;
      const ownedNodeIds = new Set<string>();
      if (!access.isSystemAdmin) {
        const ownedNodes = (await store?.listNodesByOwner(user.userId)) ?? [];
        for (const n of ownedNodes) ownedNodeIds.add(n.nodeId);
      }
      const federated = await fetchCoordinatorFederatedSummary({ ownerEmail });
      const pendingFromStore = (await store?.listPendingNodes({ limit: 250, ownerUserId })) ?? [];
      const pendingFromFederated = federated.nodes.filter(
        (n) => n.nodeApproved !== true && (access.isSystemAdmin || ownedNodeIds.has(n.nodeId))
      );
      const pendingByNodeId = new Map<string, (typeof pendingFromFederated)[number]>();
      for (const n of pendingFromFederated) pendingByNodeId.set(n.nodeId, n);
      for (const n of pendingFromStore) {
        // Store can momentarily retain historical enrollment rows that were
        // already approved; never show those in pending requests.
        if (n.nodeApproved === true) continue;
        pendingByNodeId.set(n.nodeId, {
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
        });
      }
      const approvedFromFederated = federated.nodes.filter(
        (n) => n.nodeApproved === true && (access.isSystemAdmin || ownedNodeIds.has(n.nodeId))
      );
      const approvedFromStore =
        (await store?.listApprovedNodes({ ownerUserId, limit: 500 }))?.map((n) => ({
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
        })) ?? [];
      // Always include store-approved nodes so approved devices do not disappear
      // when federated summaries are temporarily incomplete.
      const approvedByNodeId = new Map<string, (typeof approvedFromStore)[number]>();
      for (const n of approvedFromStore) approvedByNodeId.set(n.nodeId, n);
      for (const n of approvedFromFederated) {
        const existing = approvedByNodeId.get(n.nodeId) ?? {};
        approvedByNodeId.set(n.nodeId, {
          ...existing,
          ...n,
          ownerEmail: n.ownerEmail ?? (existing as { ownerEmail?: string }).ownerEmail ?? "unknown",
          emailVerified: n.emailVerified ?? (existing as { emailVerified?: boolean }).emailVerified ?? false,
          nodeApproved: n.nodeApproved ?? (existing as { nodeApproved?: boolean }).nodeApproved ?? false,
          active: n.active ?? (existing as { active?: boolean }).active ?? false,
          sourceIp: n.sourceIp ?? (existing as { sourceIp?: string }).sourceIp,
          countryCode: n.countryCode ?? (existing as { countryCode?: string }).countryCode,
          vpnDetected: n.vpnDetected ?? (existing as { vpnDetected?: boolean }).vpnDetected ?? false,
          lastSeenMs: n.lastSeenMs ?? (existing as { lastSeenMs?: number }).lastSeenMs,
          updatedAtMs: n.updatedAtMs ?? (existing as { updatedAtMs?: number }).updatedAtMs ?? Date.now()
        });
      }
      let approvedNodes = [...approvedByNodeId.values()];
      const agentProviderByNodeId: Record<string, string> = {};
      const agentOrchestrationStatusByNodeId: Record<string, { phase: string; message: string; progressPct?: number; updatedAtMs: number }> = {};
      const agentModelRolloutByNodeId: Record<
        string,
        { rolloutId?: string; status: string; error?: string; updatedAtMs: number }
      > = {};
      if (access.isSystemAdmin && CONTROL_PLANE_URL && CONTROL_PLANE_ADMIN_TOKEN) {
        try {
          const catalogRes = await request(`${CONTROL_PLANE_URL}/agents/catalog`, {
            method: "GET",
            headers: controlPlaneHeaders(),
            headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
            bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
          });
          if (catalogRes.statusCode >= 200 && catalogRes.statusCode < 300) {
            const catalog = (await catalogRes.body.json()) as {
              agents?: Array<{
                agentId?: string;
                localModelProvider?: string;
                orchestrationStatus?: { phase: string; message: string; progressPct?: number; updatedAtMs: number };
              }>;
            };
            for (const a of catalog.agents ?? []) {
              const id = a.agentId ?? "";
              if (id && typeof a.localModelProvider === "string") agentProviderByNodeId[id] = a.localModelProvider;
              if (id && a.orchestrationStatus) agentOrchestrationStatusByNodeId[id] = a.orchestrationStatus;
            }
          }
        } catch {
          // best-effort; leave maps empty
        }
        try {
          const rolloutsRes = await request(`${CONTROL_PLANE_URL}/orchestration/rollouts`, {
            method: "GET",
            headers: controlPlaneHeaders(),
            headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
            bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
          });
          if (rolloutsRes.statusCode >= 200 && rolloutsRes.statusCode < 300) {
            const payload = (await rolloutsRes.body.json()) as {
              rollouts?: Array<{
                rolloutId?: string;
                targetType?: string;
                targetId?: string;
                status?: string;
                error?: string;
                updatedAtMs?: number;
                requestedAtMs?: number;
              }>;
            };
            for (const rollout of payload.rollouts ?? []) {
              if (rollout.targetType !== "agent") continue;
              const targetId = rollout.targetId ?? "";
              const status = rollout.status ?? "";
              if (!targetId || !status) continue;
              const updatedAtMs = Number(rollout.updatedAtMs ?? rollout.requestedAtMs ?? 0);
              const existing = agentModelRolloutByNodeId[targetId];
              if (!existing || updatedAtMs >= existing.updatedAtMs) {
                agentModelRolloutByNodeId[targetId] = {
                  rolloutId: rollout.rolloutId,
                  status,
                  error: rollout.error,
                  updatedAtMs
                };
              }
            }
          }
        } catch {
          // best-effort; leave rollout map empty
        }
      }
      const canonicalNodeSuffix = (nodeId: string): string => {
        return String(nodeId)
          .toLowerCase()
          .replace(/^iphone-/, "")
          .replace(/^ios-/, "")
          .replace(/[^a-z0-9]/g, "");
      };
      const looksLikeIosAlias = (
        pendingNode: { nodeId: string; nodeKind: "agent" | "coordinator" },
        approvedNode: { nodeId: string; nodeKind: "agent" | "coordinator" }
      ): boolean => {
        if (pendingNode.nodeKind !== approvedNode.nodeKind) return false;
        const p = canonicalNodeSuffix(pendingNode.nodeId);
        const a = canonicalNodeSuffix(approvedNode.nodeId);
        if (!p || !a) return false;
        const pendingIsIosStyle = /^ios-|^iphone-/i.test(pendingNode.nodeId);
        const approvedIsIosStyle = /^ios-|^iphone-/i.test(approvedNode.nodeId);
        if (!pendingIsIosStyle || !approvedIsIosStyle) return false;
        return p.startsWith(a) || a.startsWith(p);
      };
      approvedNodes = approvedNodes.map((n) => {
        const aliasRollout = Object.entries(agentModelRolloutByNodeId)
          .filter(([nodeId]) =>
            looksLikeIosAlias(
              { nodeId, nodeKind: "agent" },
              { nodeId: n.nodeId, nodeKind: n.nodeKind }
            )
          )
          .sort((a, b) => Number(b[1].updatedAtMs ?? 0) - Number(a[1].updatedAtMs ?? 0))[0]?.[1];
        const alias = federated.nodes
          .filter((candidate) =>
            looksLikeIosAlias(
              { nodeId: candidate.nodeId, nodeKind: candidate.nodeKind },
              { nodeId: n.nodeId, nodeKind: n.nodeKind }
            )
          )
          .sort((a, b) => Number(b.lastSeenMs ?? b.updatedAtMs ?? 0) - Number(a.lastSeenMs ?? a.updatedAtMs ?? 0))[0];
        const mergedLastSeenMs = n.lastSeenMs ?? alias?.lastSeenMs;
        const mergedUpdatedAtMs = n.updatedAtMs ?? alias?.updatedAtMs;
        return {
          ...n,
          lastSeenMs: mergedLastSeenMs,
          updatedAtMs: mergedUpdatedAtMs,
          sourceIp: n.sourceIp ?? alias?.sourceIp,
          countryCode: n.countryCode ?? alias?.countryCode,
          vpnDetected: n.vpnDetected ?? alias?.vpnDetected,
          localModelProvider: agentProviderByNodeId[n.nodeId] ?? (n as { localModelProvider?: string }).localModelProvider,
          orchestrationStatus: agentOrchestrationStatusByNodeId[n.nodeId],
          modelRollout: agentModelRolloutByNodeId[n.nodeId] ?? aliasRollout
        };
      });
      const approvedNodeIds = new Set(approvedNodes.map((n) => n.nodeId));
      const pendingNodes = [...pendingByNodeId.values()].filter((pendingNode) => {
        if (approvedNodeIds.has(pendingNode.nodeId)) return false;
        return !approvedNodes.some((approvedNode) =>
          looksLikeIosAlias(
            { nodeId: pendingNode.nodeId, nodeKind: pendingNode.nodeKind },
            { nodeId: approvedNode.nodeId, nodeKind: approvedNode.nodeKind }
          )
        );
      });
      const finalityState =
        federated.finalityStates.length === 1 ? federated.finalityStates[0] : federated.stale ? "stale_federation" : "unknown";
      const anchorTxRef = federated.anchorTxRefs.length === 1 ? federated.anchorTxRefs[0] : undefined;
      return reply.send({
        status,
        pendingNodes,
        approvedNodes: approvedNodes.map((n) => ({
          nodeId: n.nodeId,
          nodeKind: n.nodeKind,
          ownerEmail: n.ownerEmail,
          emailVerified: n.emailVerified,
          nodeApproved: n.nodeApproved,
          active: n.active,
          sourceIp: n.sourceIp,
          countryCode: n.countryCode,
          vpnDetected: n.vpnDetected ?? false,
          lastSeenMs: n.lastSeenMs,
          updatedAtMs: n.updatedAtMs,
          localModelProvider: (n as { localModelProvider?: string }).localModelProvider,
          orchestrationStatus: (n as { orchestrationStatus?: { phase: string; message: string; progressPct?: number; updatedAtMs: number } }).orchestrationStatus,
          modelRollout: (n as { modelRollout?: { rolloutId?: string; status: string; error?: string; updatedAtMs: number } }).modelRollout
        })),
        access: {
          isSystemAdmin: access.isSystemAdmin,
          isCoordinatorAdmin: access.isCoordinatorAdmin,
          canManageApprovals: access.canManageCoordinatorOps
        },
        federation: {
          reachedCoordinators: federated.reachedCoordinators,
          checkpointHashes: federated.checkpointHashes,
          finalityStates: federated.finalityStates,
          finalityState,
          anchorTxRefs: federated.anchorTxRefs,
          anchorTxRef,
          stale: federated.stale
        }
      });
    } catch {
      // Never blank coordinator ops UI; return safe fallback payload.
      return reply.send({
        status: { agents: 0, queued: 0, results: 0 },
        pendingNodes: [],
        approvedNodes: [],
        access: {
          isSystemAdmin: access.isSystemAdmin,
          isCoordinatorAdmin: access.isCoordinatorAdmin,
          canManageApprovals: access.canManageCoordinatorOps
        },
        federation: {
          reachedCoordinators: 0,
          checkpointHashes: [],
          finalityStates: [],
          finalityState: "unknown",
          anchorTxRefs: [],
          anchorTxRef: undefined,
          stale: true
        },
        degraded: true
      });
    }
  });

  app.get("/coordinator/ops/agent-diagnostics", async (req, reply) => {
    const principal = await requireCoordinatorOperationsUser(req as any, reply);
    if (!principal) return;
    const { user, access } = principal;
    const query = z.object({ agentId: z.string().min(1) }).parse(req.query);
    const agentId = query.agentId.trim();
    if (!agentId) return reply.code(400).send({ error: "agent_id_required" });

    if (!access.isSystemAdmin) {
      const enrollment = await store?.getNodeEnrollment(agentId);
      if (!enrollment || enrollment.ownerUserId !== user.userId) {
        return reply.code(403).send({ error: "agent_diagnostics_forbidden" });
      }
    }

    const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
    if (coordinatorUrls.length === 0) {
      return reply.send({ ok: true, agentId, events: [], reachedCoordinators: 0 });
    }

    const headers: Record<string, string> = {};
    if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;
    const responses = await Promise.all(
      coordinatorUrls.map(async (baseUrl) => {
        try {
          const res = await request(`${baseUrl.replace(/\/$/, "")}/agent/diagnostics/${encodeURIComponent(agentId)}`, {
            method: "GET",
            headers
          });
          if (res.statusCode < 200 || res.statusCode >= 300) return null;
          return (await res.body.json()) as {
            events?: Array<{ eventAtMs?: number; message?: string }>;
          };
        } catch {
          return null;
        }
      })
    );

    const reached = responses.filter((r) => Boolean(r));
    const seen = new Set<string>();
    const merged = reached
      .flatMap((payload) => payload?.events ?? [])
      .map((event) => ({
        eventAtMs: Number(event?.eventAtMs ?? 0),
        message: String(event?.message ?? "").trim()
      }))
      .filter((event) => event.eventAtMs > 0 && event.message.length > 0)
      .filter((event) => {
        const key = `${event.eventAtMs}:${event.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.eventAtMs - a.eventAtMs)
      .slice(0, 250);

    return reply.send({
      ok: true,
      agentId,
      events: merged,
      reachedCoordinators: reached.length
    });
  });

  app.post("/coordinator/ops/node-approval", async (req, reply) => {
    const principal = await requireCoordinatorOperationsUser(req as any, reply);
    if (!principal) return;
    const { access } = principal;
    if (!access.canManageCoordinatorOps) {
      return reply.code(403).send({ error: "coordinator_operations_forbidden" });
    }
    if (!CONTROL_PLANE_URL || !CONTROL_PLANE_ADMIN_TOKEN) {
      return reply.code(503).send({ error: "control_plane_not_configured" });
    }
    const body = z
      .object({
        nodeId: z.string().min(3),
        nodeKind: z.enum(["agent", "coordinator"]),
        approved: z.boolean()
      })
      .parse(req.body);
    const pathSegment = body.nodeKind === "agent" ? "agents" : "coordinators";
    try {
      const res = await request(`${CONTROL_PLANE_URL}/${pathSegment}/${body.nodeId}/approval`, {
        method: "POST",
        headers: controlPlaneHeaders(true),
        body: JSON.stringify({ approved: body.approved })
      });
      const payload = await res.body.json();
      if (res.statusCode >= 200 && res.statusCode < 300 && !body.approved && store) {
        const existing = await store.getNodeEnrollment(body.nodeId);
        // "Reject" on a pending request should remove it from enrollment queue.
        if (existing && existing.nodeApproved !== true) {
          await store.deleteNodeEnrollment(body.nodeId);
        }
      }
      return reply.code(res.statusCode).send(payload);
    } catch {
      return reply.code(502).send({ error: "control_plane_unreachable" });
    }
  });

  app.post("/coordinator/ops/coordinator-ollama", async (req, reply) => {
    const principal = await requireCoordinatorOperationsUser(req as any, reply);
    if (!principal) return;
    const { access } = principal;
    if (!access.canManageCoordinatorOps) {
      return reply.code(403).send({ error: "coordinator_operations_forbidden" });
    }
    if (!CONTROL_PLANE_URL || !CONTROL_PLANE_ADMIN_TOKEN) {
      return reply.code(503).send({ error: "control_plane_not_configured" });
    }
    const body = z
      .object({
        provider: z.enum(["edgecoder-local", "ollama-local"]).default("ollama-local"),
        model: z.string().default("qwen3.5:9b"),
        autoInstall: z.boolean().default(true)
      })
      .parse(req.body);
    try {
      const res = await request(`${CONTROL_PLANE_URL}/ops/coordinator-ollama`, {
        method: "POST",
        headers: controlPlaneHeaders(true),
        body: JSON.stringify(body)
      });
      return reply.code(res.statusCode).send(await res.body.json());
    } catch {
      return reply.code(502).send({ error: "control_plane_unreachable" });
    }
  });

  app.post("/coordinator/ops/agents-model", async (req, reply) => {
    const principal = await requireCoordinatorOperationsUser(req as any, reply);
    if (!principal) return;
    const { user, access } = principal;
    if (!access.canManageCoordinatorOps) {
      return reply.code(403).send({ error: "coordinator_operations_forbidden" });
    }
    if (!CONTROL_PLANE_URL || !CONTROL_PLANE_ADMIN_TOKEN) {
      return reply.code(503).send({ error: "control_plane_not_configured" });
    }
    const body = z
      .object({
        agentIds: z.array(z.string().min(3)).min(1).max(250),
        provider: z.enum(["edgecoder-local", "ollama-local"]).default("ollama-local"),
        model: z.string().default("qwen3.5:9b"),
        autoInstall: z.boolean().default(true)
      })
      .parse(req.body);
    const uniqueAgentIds = Array.from(new Set(body.agentIds.map((id) => id.trim()).filter(Boolean)));
    if (uniqueAgentIds.length === 0) {
      return reply.code(400).send({ error: "agent_ids_required" });
    }
    if (!access.isSystemAdmin) {
      if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
      for (const agentId of uniqueAgentIds) {
        const enrollment = await store.getNodeEnrollment(agentId);
        if (!enrollment || enrollment.nodeKind !== "agent" || enrollment.ownerUserId !== user.userId) {
          return reply.code(403).send({ error: "agent_model_switch_forbidden_for_owner_scope" });
        }
      }
    }
    const results: Array<{ agentId: string; ok: boolean; statusCode?: number; error?: string; rolloutId?: string }> = [];
    for (const agentId of uniqueAgentIds) {
      try {
        const res = await request(`${CONTROL_PLANE_URL}/orchestration/install-model`, {
          method: "POST",
          headers: controlPlaneHeaders(true),
          body: JSON.stringify({
            target: "agent",
            agentId,
            provider: body.provider,
            model: body.model,
            autoInstall: body.autoInstall,
            requestedBy: user.email
          })
        });
        const payload = (await res.body.json()) as { error?: string; rolloutId?: string };
        results.push({
          agentId,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode,
          error: payload?.error,
          rolloutId: payload?.rolloutId
        });
      } catch (error) {
        results.push({ agentId, ok: false, error: String(error) });
      }
    }
    const success = results.filter((r) => r.ok).length;
    return reply.send({
      ok: success > 0,
      provider: body.provider,
      model: body.model,
      autoInstall: body.autoInstall,
      requested: uniqueAgentIds.length,
      success,
      failed: uniqueAgentIds.length - success,
      results
    });
  });
}
