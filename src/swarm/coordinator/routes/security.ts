// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Reputation, blacklist and direct-work audit routes.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { safeTokenEqual, readHeaderValue } from "../../coordinator-utils.js";
import type { BlacklistRecord, BlacklistReasonCode } from "../../../common/types.js";
import { signPayload } from "../../../mesh/peer.js";
import {
  type BlacklistEvidenceInput,
  buildBlacklistEventHash,
  verifyReporterEvidenceSignature
} from "../../../security/blacklist.js";
import type { CoordinatorApp } from "../app.js";
import { mesh, peerScore, identity, coordinatorKeys, protocol, queue, reservations } from "../context.js";
import { pgStore } from "../../../db/store.js";
import { mutable } from "../mutable-state.js";
import {
  blacklistByAgent,
  activeBlacklistRecord,
  blacklistAuditLog,
  directWorkById,
  appendBlacklistRecord,
  issueCoordinatorBlacklistRecord,
  behaviorTracker,
  autoBlacklister,
  agentCapabilities
} from "../agent-state.js";
import { nodeRemovalBlocker } from "../node-removal.js";
import { requireMeshToken, ADMIN_API_TOKEN, authorizeAdmin } from "../auth.js";

export function registerSecurityRoutes(app: CoordinatorApp): void {
  app.get("/mesh/reputation", async () => ({
    peers: mesh.listPeers().map((p) => ({ peerId: p.peerId, score: peerScore.get(p.peerId) ?? 100 }))
  }));
  app.get("/security/blacklist", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const records = [...blacklistByAgent.values()].filter((record) => Boolean(activeBlacklistRecord(record.agentId)));
    return { version: mutable.blacklistVersion, records, lastEventHash: mutable.lastBlacklistEventHash };
  });

  app.get("/security/blacklist/audit", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    return { version: mutable.blacklistVersion, chainHead: mutable.lastBlacklistEventHash, events: blacklistAuditLog };
  });

  app.get("/agent-mesh/direct-work/audit", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const limit = z
      .object({ limit: z.coerce.number().int().positive().max(500).default(100) })
      .parse(req.query);
    // The work's input and result belong to the two agents; other mesh members see the record only.
    const headerToken = readHeaderValue((req as any).headers ?? {}, "x-admin-token");
    const admin = Boolean(ADMIN_API_TOKEN && headerToken && safeTokenEqual(headerToken, ADMIN_API_TOKEN));
    const events = [...directWorkById.values()]
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, limit.limit)
      .map((w) => (admin ? w : { ...w, input: undefined, result: undefined }));
    return { events };
  });

  app.post("/security/blacklist", async (req, reply) => {
    // #40: admin only (previously any mesh peer)
    if (!authorizeAdmin(req, reply)) return;
    const body = z
      .object({
        agentId: z.string(),
        reasonCode: z.enum([
          "abuse_spam",
          "abuse_malware",
          "policy_violation",
          "credential_abuse",
          "dos_behavior",
          "forged_results",
          "manual_review"
        ]),
        reason: z.string().min(3),
        reportedBy: z.string().default("policy-engine"),
        reporterId: z.string().default("policy-engine"),
        reporterPublicKeyPem: z.string().optional(),
        reporterSignature: z.string().optional(),
        evidenceHashSha256: z.string().length(64),
        evidenceRef: z.string().optional(),
        expiresInMs: z.number().positive().optional()
      })
      .parse(req.body);
    const timestampMs = Date.now();
    const evidenceInput: BlacklistEvidenceInput = {
      agentId: body.agentId,
      reasonCode: body.reasonCode as BlacklistReasonCode,
      reason: body.reason,
      evidenceHashSha256: body.evidenceHashSha256,
      reporterId: body.reporterId,
      timestampMs
    };
    const evidenceSignatureVerified = verifyReporterEvidenceSignature({
      evidence: evidenceInput,
      reporterPublicKeyPem: body.reporterPublicKeyPem,
      reporterSignature: body.reporterSignature
    });
    if (!evidenceSignatureVerified && body.reasonCode !== "manual_review") {
      return reply.code(400).send({ error: "reporter_signature_invalid_for_reason_code" });
    }
    const eventId = randomUUID();
    const prevEventHash = mutable.lastBlacklistEventHash;
    const eventHash = buildBlacklistEventHash({
      eventId,
      agentId: body.agentId,
      reasonCode: body.reasonCode as BlacklistReasonCode,
      reason: body.reason,
      evidenceHashSha256: body.evidenceHashSha256,
      reporterId: body.reporterId,
      sourceCoordinatorId: identity.peerId,
      timestampMs,
      expiresAtMs: body.expiresInMs ? timestampMs + body.expiresInMs : undefined,
      prevEventHash,
      evidenceSignatureVerified
    });
    const coordinatorSignature = signPayload(eventHash, coordinatorKeys.privateKeyPem);
    const record: BlacklistRecord = {
      eventId,
      agentId: body.agentId,
      reasonCode: body.reasonCode as BlacklistReasonCode,
      reason: body.reason,
      evidenceHashSha256: body.evidenceHashSha256,
      reporterId: body.reporterId,
      reporterPublicKeyPem: body.reporterPublicKeyPem,
      reporterSignature: body.reporterSignature,
      evidenceSignatureVerified,
      evidenceRef: body.evidenceRef,
      sourceCoordinatorId: identity.peerId,
      reportedBy: body.reportedBy,
      timestampMs,
      expiresAtMs: body.expiresInMs ? timestampMs + body.expiresInMs : undefined,
      prevEventHash,
      eventHash,
      coordinatorSignature
    };
    appendBlacklistRecord(record);
    const gossipMessage = protocol.createMessage(
      "blacklist_update",
      identity.peerId,
      record as unknown as Record<string, unknown>,
      coordinatorKeys.privateKeyPem
    );
    void mesh.broadcast(gossipMessage);
    return { ok: true, record, version: mutable.blacklistVersion, chainHead: mutable.lastBlacklistEventHash };
  });
  /** Lift an agent's blacklist (admin). Appends an already-expired record, which supersedes the
   *  earlier one here, on reload and on peers that receive the gossip. */
  app.post("/security/blacklist/:agentId/lift", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    return liftBlacklist(req, reply);
  });

  // The portal's admin page (Settings > Network): list and lift with the admin token alone. Its own
  // plugin with the admin gate, like routes/admin.ts (coordinator.ts lets /admin/* past the mesh check).
  app.register(async (admin) => {
    admin.addHook("onRequest", async (req, reply) => {
      if (!authorizeAdmin(req, reply)) return reply;
    });
    /** Active records, newest first, with whether behavioural monitoring issued each and when it lifts by itself. */
    admin.get("/admin/security/blacklist", async (req, reply) => {
      if (!authorizeAdmin(req, reply)) return;
      const now = Date.now();
      const records = [...blacklistByAgent.values()]
        .filter((record) => Boolean(activeBlacklistRecord(record.agentId)))
        .sort((a, b) => b.timestampMs - a.timestampMs)
        .map((r) => ({
          agentId: r.agentId,
          reasonCode: r.reasonCode,
          reason: r.reason,
          reportedBy: r.reportedBy,
          automatic: r.reportedBy === "behavioral_monitoring",
          sourceCoordinatorId: r.sourceCoordinatorId,
          timestampMs: r.timestampMs,
          expiresAtMs: r.expiresAtMs ?? null,
          expiresInMs: r.expiresAtMs ? Math.max(0, r.expiresAtMs - now) : null,
        }));
      reply.header("cache-control", "no-store");
      return { coordinatorId: identity.peerId, version: mutable.blacklistVersion, records };
    });
    admin.post("/admin/security/blacklist/:agentId/lift", async (req, reply) => {
      if (!authorizeAdmin(req, reply)) return;
      return liftBlacklist(req, reply);
    });
    /**
     * Dismiss a pending enrollment request from a node with no portal enrollment (an agent that tried
     * /register and got node_not_enrolled). Removes it from this coordinator's pending list and,
     * with blockDays, blacklists the agent id for that long (gossiped like any blacklist record).
     * Never approves anything: an ownerless node has to enroll with a token from a signed-in account.
     */
    admin.post("/admin/nodes/:nodeId/dismiss", async (req, reply) => {
      if (!authorizeAdmin(req, reply)) return;
      const params = z.object({ nodeId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:@-]+$/) }).parse(req.params);
      const body = z
        .object({
          nodeKind: z.enum(["agent", "coordinator"]).default("agent"),
          blockDays: z.number().int().min(0).max(365).default(0),
          reason: z.string().min(3).max(500).default("enrollment request dismissed by admin")
        })
        .parse(req.body ?? {});
      const removed = pgStore ? await pgStore.deleteUnapprovedNodeStatusProjection(params.nodeId) : 0;
      let blacklisted = false;
      if (body.blockDays > 0 && body.nodeKind === "agent") {
        issueCoordinatorBlacklistRecord({
          agentId: params.nodeId,
          reasonCode: "manual_review",
          reason: `enrollment request rejected: ${body.reason}`,
          evidenceHashSha256: createHash("sha256").update(`dismiss:${params.nodeId}`).digest("hex"),
          reportedBy: "admin",
          expiresAtMs: Date.now() + body.blockDays * 86_400_000
        });
        blacklisted = true;
      }
      req.log.info({ nodeId: params.nodeId, nodeKind: body.nodeKind, removed, blockDays: body.blockDays, reason: body.reason }, "admin_node_request_dismissed");
      return { ok: true, nodeId: params.nodeId, removed, blacklisted, coordinatorId: identity.peerId };
    });

    /**
     * Remove an approved machine (its host deleted it, or an admin is cleaning up). Refuses while it
     * holds an active reservation lease or is running a task, unless force. dryRun only checks.
     * Drops it from the agent registry and the status projection; ledger and earnings rows are untouched.
     * The portal revokes the enrollment token, so the agent cannot register again.
     */
    admin.post("/admin/nodes/:nodeId/remove", async (req, reply) => {
      if (!authorizeAdmin(req, reply)) return;
      const params = z.object({ nodeId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:@-]+$/) }).parse(req.params);
      const body = z.object({ force: z.boolean().default(false), dryRun: z.boolean().default(false) }).parse(req.body ?? {});
      const lease = reservations.activeForAgent(params.nodeId);
      const blocker = nodeRemovalBlocker({ lease: lease ? { id: lease.id, endMs: lease.endMs } : undefined, runningClaims: queue.activeClaims().get(params.nodeId)?.all ?? 0 });
      if (blocker && !body.force) return reply.code(409).send({ ...blocker, nodeId: params.nodeId, coordinatorId: identity.peerId });
      if (body.dryRun) return { ok: true, dryRun: true, nodeId: params.nodeId, coordinatorId: identity.peerId };
      const registered = agentCapabilities.delete(params.nodeId);
      const projected = pgStore ? await pgStore.deleteNodeStatusProjection(params.nodeId) : 0;
      req.log.info({ nodeId: params.nodeId, registered, projected, force: body.force, blocker: blocker?.error }, "admin_node_removed");
      return { ok: true, nodeId: params.nodeId, registered, projected, forced: Boolean(blocker), coordinatorId: identity.peerId };
    });
  });
}

async function liftBlacklist(req: { params: unknown; body: unknown }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  const params = z.object({ agentId: z.string().min(1) }).parse(req.params);
  const body = z.object({ reason: z.string().min(3).default("lifted by admin") }).parse(req.body ?? {});
  if (!activeBlacklistRecord(params.agentId)) return reply.code(404).send({ error: "not_blacklisted" });
  const record = issueCoordinatorBlacklistRecord({
    agentId: params.agentId,
    reasonCode: "manual_review",
    reason: `lifted: ${body.reason}`,
    evidenceHashSha256: createHash("sha256").update(`lift:${params.agentId}`).digest("hex"),
    reportedBy: "admin",
    expiresAtMs: Date.now(),
  });
  behaviorTracker.reset(params.agentId);
  autoBlacklister.clearStrikes(params.agentId);
  return { ok: true, record, version: mutable.blacklistVersion };
}
