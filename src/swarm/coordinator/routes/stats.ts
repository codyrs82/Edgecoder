// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Ledger snapshot and stats routes: ledger head, range and ingest, anchors and summaries.
 */
import { request } from "undici";
import { z } from "zod";
import type { QueueEventRecord } from "../../../common/types.js";
import { pgStore } from "../../../db/store.js";
import { checkpointAnchorFinality, describeAnchor } from "../../../economy/anchor-status.js";
import type { CoordinatorApp } from "../app.js";
import {
  identity,
  ANCHOR_REQUIRED_CONFIRMATIONS,
  STATS_ANCHOR_MIN_CONFIRMATIONS,
  PORTAL_SERVICE_URL,
  PORTAL_OUTBOUND_TOKEN
} from "../context.js";
import { ordering, agentCapabilities, directWorkById, activeTunnels } from "../agent-state.js";
import { requireMeshToken, authorizeAdmin, hasMeshToken, hasPortalServiceToken } from "../auth.js";
import {
  statsQuorumThreshold,
  ingestStatsLedgerRecords,
  maybeAnchorLatestStatsCheckpoint,
  latestStatsFinality,
  currentAnchoringStatus
} from "../stats-ledger.js";

export function registerStatsRoutes(app: CoordinatorApp): void {
  app.get("/ledger/snapshot", async () => ({ records: ordering.snapshot(), proof: ordering.latestProof() }));
  app.get("/stats/ledger/head", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const [head, checkpoint] = await Promise.all([
      pgStore?.latestStatsLedgerHead(),
      pgStore?.latestStatsCheckpoint(),
    ]);
    return {
      coordinatorId: identity.peerId,
      head: head ?? { issuedAtMs: 0, hash: "GENESIS", count: 0 },
      checkpoint: checkpoint
        ? {
            hash: checkpoint.hash,
            height: checkpoint.height,
            issuedAtMs: checkpoint.issuedAtMs
          }
        : null,
      quorumThreshold: statsQuorumThreshold()
    };
  });
  app.get("/stats/ledger/range", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const query = z
      .object({
        sinceIssuedAtMs: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().positive().max(5000).default(1000)
      })
      .parse(req.query);
    const records = await pgStore?.listStatsLedgerSince(query.sinceIssuedAtMs, query.limit);
    return { records: records ?? [] };
  });
  app.post("/stats/ledger/ingest", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const body = z
      .object({
        records: z.array(
          z.object({
            id: z.string(),
            eventType: z.string(),
            taskId: z.string(),
            subtaskId: z.string().optional(),
            actorId: z.string(),
            sequence: z.number().int().positive(),
            issuedAtMs: z.number().int().positive(),
            prevHash: z.string(),
            coordinatorId: z.string().optional(),
            checkpointHeight: z.number().int().optional(),
            checkpointHash: z.string().optional(),
            payloadJson: z.string().optional(),
            hash: z.string(),
            signature: z.string()
          })
        )
      })
      .parse(req.body);
    const { ingested, skipped } = await ingestStatsLedgerRecords(body.records as QueueEventRecord[]);
    return { ok: true, ingested, skipped };
  });
  app.post("/stats/anchors/anchor-latest", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return; // #100

    const anchor = await maybeAnchorLatestStatsCheckpoint();
    const finality = await latestStatsFinality();
    return {
      ok: true,
      anchor: anchor ? describeAnchor(anchor, ANCHOR_REQUIRED_CONFIRMATIONS) : null,
      finality
    };
  });
  app.get("/stats/anchors/verify", async (req, reply) => {
    const meshAuthorized = hasMeshToken((req as any).headers ?? {});
    const portalAuthorized = hasPortalServiceToken((req as any).headers ?? {});
    if (!meshAuthorized && !portalAuthorized) {
      return reply.code(401).send({ error: "stats_access_unauthorized" });
    }
    const query = z
      .object({
        checkpointHash: z.string().min(8)
      })
      .parse(req.query);
    const finality = checkpointAnchorFinality({
      anchor: await pgStore?.latestAnchorByCheckpoint(query.checkpointHash),
      requiredConfirmations: ANCHOR_REQUIRED_CONFIRMATIONS,
      minConfirmations: STATS_ANCHOR_MIN_CONFIRMATIONS
    });
    return {
      ok: true,
      checkpointHash: query.checkpointHash,
      verified: finality.hardFinalized,
      requiredConfirmations: finality.requiredConfirmations,
      anchoring: currentAnchoringStatus(),
      anchor: finality.anchor ?? null
    };
  });
  app.get("/stats/projections/summary", async (req, reply) => {
    const meshAuthorized = hasMeshToken((req as any).headers ?? {});
    const portalAuthorized = hasPortalServiceToken((req as any).headers ?? {});
    if (!meshAuthorized && !portalAuthorized) {
      return reply.code(401).send({ error: "stats_access_unauthorized" });
    }
    const query = z
      .object({
        ownerEmail: z.string().email().optional()
      })
      .parse(req.query);
    // Owner email and network location are for the portal: a mesh-token caller gets the nodes without them.
    if (!portalAuthorized) query.ownerEmail = undefined;
    const projectionQueryTimeoutMs = 3_000;
    const timeoutReject = (label: string) =>
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label}_timeout`)), projectionQueryTimeoutMs)
      );
    let nodes: Array<Record<string, unknown>> | undefined;
    let earnings: unknown[] | undefined;
    let head: { issuedAtMs: number; hash: string; count: number } | null | undefined;
    let latestCommit: { hash: string; height: number | null; issuedAtMs: number } | null | undefined;
    if (pgStore) {
      try {
        [nodes, earnings, head, latestCommit] = await Promise.race([
          Promise.all([
            pgStore.listNodeStatusProjection(query.ownerEmail),
            pgStore.listCoordinatorEarningsProjection(query.ownerEmail),
            pgStore.latestStatsLedgerHead(),
            pgStore.latestStatsCheckpoint()
          ]),
          timeoutReject("stats_projection_query")
        ]);
      } catch (error) {
        app.log.warn({ error }, "stats_projection_query_skipped");
      }
    }
    let finality: Awaited<ReturnType<typeof latestStatsFinality>> = {
      softFinalized: false,
      hardFinalized: false,
      finalityState: "no_checkpoint",
      anchoring: currentAnchoringStatus()
    };
    try {
      finality = await Promise.race([latestStatsFinality(), timeoutReject("stats_projection_finality")]);
    } catch (error) {
      app.log.warn({ error }, "stats_projection_finality_skipped");
    }
    const mergedByNodeId = new Map<string, Record<string, unknown>>();
    for (const node of nodes ?? []) {
      const nodeId = String(node.nodeId ?? "").trim();
      if (!nodeId) continue;
      mergedByNodeId.set(nodeId, node as Record<string, unknown>);
    }
    const now = Date.now();
    for (const [agentId, cap] of agentCapabilities.entries()) {
      if (query.ownerEmail && cap.ownerEmail !== query.ownerEmail) continue;
      const existing = mergedByNodeId.get(agentId) ?? {};
      const existingLastSeenMs = Number(existing.lastSeenMs ?? 0);
      const mergedLastSeenMs = Math.max(existingLastSeenMs, cap.lastSeenMs ?? 0);
      mergedByNodeId.set(agentId, {
        nodeId: agentId,
        nodeKind: "agent",
        ownerEmail: cap.ownerEmail ?? existing.ownerEmail,
        emailVerified: (existing.emailVerified as boolean | undefined) ?? true,
        nodeApproved: (existing.nodeApproved as boolean | undefined) ?? true,
        active: now - mergedLastSeenMs <= 120_000,
        sourceIp: cap.sourceIp ?? existing.sourceIp,
        countryCode: cap.countryCode ?? existing.countryCode,
        vpnDetected: cap.vpnDetected ?? existing.vpnDetected,
        lastSeenMs: mergedLastSeenMs > 0 ? mergedLastSeenMs : undefined,
        updatedAtMs: Math.max(Number(existing.updatedAtMs ?? 0), mergedLastSeenMs)
      });
    }
    return {
      coordinatorId: identity.peerId,
      generatedAt: Date.now(),
      head: head ?? { issuedAtMs: 0, hash: "GENESIS", count: 0 },
      quorumThreshold: statsQuorumThreshold(),
      latestCheckpoint: latestCommit
        ? {
            hash: latestCommit.hash,
            height: latestCommit.height ?? null,
            issuedAtMs: latestCommit.issuedAtMs
          }
        : null,
      finality,
      nodes: portalAuthorized
        ? [...mergedByNodeId.values()]
        : [...mergedByNodeId.values()].map(({ ownerEmail: _email, sourceIp: _ip, countryCode: _cc, vpnDetected: _vpn, ...node }) => node),
      earnings: earnings ?? []
    };
  });
  app.get("/stats/network/summary", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    let portalCounts: { users: { total: number; verified: number }; nodes: { total: number; approved: number; active: number; agents: number; coordinators: number } } | null = null;
    if (PORTAL_SERVICE_URL) {
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (PORTAL_OUTBOUND_TOKEN) headers["x-portal-service-token"] = PORTAL_OUTBOUND_TOKEN;
        const res = await request(`${PORTAL_SERVICE_URL}/internal/stats/counts`, {
          method: "GET",
          headers,
          headersTimeout: 5_000,
          bodyTimeout: 5_000
        });
        if (res.statusCode === 200) {
          portalCounts = (await res.body.json()) as { users: { total: number; verified: number }; nodes: { total: number; approved: number; active: number; agents: number; coordinators: number } };
        }
      } catch (err) {
        app.log.warn({ err }, "stats_network_summary_portal_unreachable");
      }
    }
    const allModels = new Set<string>();
    for (const cap of agentCapabilities.values()) {
      for (const m of cap.localModelCatalog) allModels.add(m);
    }
    return {
      timestamp: Date.now(),
      users: portalCounts?.users ?? null,
      nodes: portalCounts
        ? {
            enrolled: portalCounts.nodes.total,
            approved: portalCounts.nodes.approved,
            active: portalCounts.nodes.active,
            agents: portalCounts.nodes.agents,
            coordinators: portalCounts.nodes.coordinators
          }
        : null,
      live: {
        agentsConnected: agentCapabilities.size,
        queueDepth: [...directWorkById.values()].filter((w) => w.status === "offered").length,
        activeTunnels: activeTunnels.size,
        modelsAvailable: allModels.size
      }
    };
  });
}
