// Copyright (c) 2025 EdgeCoder, LLC
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
import { mesh, peerScore, identity, coordinatorKeys, protocol } from "../context.js";
import { mutable } from "../mutable-state.js";
import {
  blacklistByAgent,
  activeBlacklistRecord,
  blacklistAuditLog,
  directWorkById,
  appendBlacklistRecord,
  issueCoordinatorBlacklistRecord,
  behaviorTracker,
  autoBlacklister
} from "../agent-state.js";
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
  });
}
