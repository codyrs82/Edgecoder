// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Mesh routes: identity, peer registration, gossip ingest and relay, and the mesh WebSocket.
 */
import { z } from "zod";
import { safeTokenEqual, readHeaderValue, mayRelayOverWs } from "../../coordinator-utils.js";
import { createRegistryMirror } from "../../../discovery/registry-mirror.js";
import type {
  MeshPeerIdentity,
  CapabilitySummaryPayload,
  PeerExchangePayload,
  CapabilityAnnouncePayload,
  SandboxMode
} from "../../../common/types.js";
import { checkPeerRegistration, isAllowlistedKey } from "../../../mesh/peer-trust.js";
import { setNudgeTransport } from "../dispatch.js";
import { setModelControlTransport } from "../model-control.js";
import { RttTracker, startRttPings, type PingableSocket } from "../../agent-rtt.js";
import { MESH_WS_BIND_MAX_SKEW_MS, decideMeshWsBind, meshWsSenderMatches } from "../../../mesh/ws-auth.js";
import { legacyPemFingerprints, publicKeyFingerprint } from "../../../security/key-fingerprint.js";
import { IDENTITY_CHALLENGE_PATH, answerIdentityChallenge } from "../../../trust/identity-challenge.js";
import { LOCAL_ATTEST_PATH, NonceLog, answerLocalAttest } from "../../../trust/local-attest.js";
import { RESPONSE_SIGNING_VERSION } from "../../../trust/response-signing.js";
import { pgStore } from "../../../db/store.js";
import type { ComputeClassId } from "../../../economy/compute-classes.js";
import { isProduction } from "../../../common/env-guard.js";
import { validateIncomingBlacklistRecord } from "../../../security/blacklist.js";
import { verifyNonce } from "../../../security/nonce-verifier.js";
import { app, type CoordinatorApp } from "../app.js";
import {
  identity,
  coordinatorKeys,
  COORDINATOR_PUBLIC_URL,
  requestOrigin,
  mesh,
  PORTAL_SERVICE_URL,
  CC,
  MESH_AUTH_TOKEN,
  MESH_PEER_ALLOWLIST,
  peerScore,
  PEER_ALLOWLIST_ENFORCED,
  peerMessageWindow,
  MESH_RATE_LIMIT_PER_10S,
  protocol,
  queue,
  peerOfferBudgetMsat,
  peerGrants,
  SUBTASK_RESERVE_TIMEOUT_MS,
  taskOriginMap,
  nonceStore,
  SECURITY_NONCE_TTL_MS,
  securityLog
} from "../context.js";
import {
  ordering,
  activeBlacklistRecord,
  appendBlacklistRecord,
  federatedCapabilities,
  agentCapabilities
} from "../agent-state.js";
import { ADMIN_API_TOKEN, requireMeshToken, hasMeshToken } from "../auth.js";
import { subtaskReserveMsat, rateOracleConfig } from "../economy.js";
import { persistStatsLedgerRecord } from "../stats-ledger.js";
import { validatePortalNode } from "../enrollment.js";
import { grantSubtaskToPeer, hasLiveAgentFor, requestOfferGrant } from "../grants.js";
import { recordMeshMessage } from "../world-activity.js";

// `fingerprint` (sha256 of the SPKI DER) is what operators list in TRUSTED_COORDINATOR_KEYS and
// MESH_PEER_ALLOWLIST; `legacyFingerprints` are the PEM-text forms older agent builds compare.
const IDENTITY_FINGERPRINT = publicKeyFingerprint(identity.publicKeyPem);

// #147: the desktop app proves an agent already on :4301 is the one it started (src/trust/local-attest.ts).
const localAttestNonces = new NonceLog();

// The portal's signed coordinator registry, mirrored so the one platform URL serves it too
// (src/discovery/registry-mirror.ts). REGISTRY_UPSTREAM_URL overrides the source.
const REGISTRY_PORTAL_URL = PORTAL_SERVICE_URL || CC.PORTAL_PUBLIC_URL;
const registryMirror = createRegistryMirror({
  upstreamUrl: CC.REGISTRY_UPSTREAM_URL || `${REGISTRY_PORTAL_URL.replace(/\/+$/, "")}/network/registry`
});

const peerSchema = z.object({
  peerId: z.string(),
  publicKeyPem: z.string(),
  coordinatorUrl: z.string().url(),
  networkMode: z.enum(["public_mesh", "enterprise_overlay"]),
  role: z.enum(["coordinator", "agent", "phone"]).optional(),
  registrationToken: z.string().optional(),
  issuedAtMs: z.number().optional(),
  signature: z.string().optional()
});

const meshIngestSchema = z.object({
  id: z.string(),
  type: z.enum([
    "peer_announce",
    "queue_summary",
    "task_offer",
    "task_claim",
    "result_announce",
    "ordering_snapshot",
    "blacklist_update",
    "issuance_proposal",
    "issuance_vote",
    "issuance_commit",
    "issuance_checkpoint",
    "capability_summary",
    "peer_exchange",
    "capability_announce"
  ]),
  fromPeerId: z.string(),
  issuedAtMs: z.number(),
  ttlMs: z.number(),
  payload: z.record(z.string(), z.unknown()),
  signature: z.string()
});

async function handleMeshIngest(
  message: z.infer<typeof meshIngestSchema>
): Promise<{ ok: boolean; statusCode?: number; error?: string; [key: string]: unknown }> {
  const peer = mesh.listPeers().find((p) => p.peerId === message.fromPeerId);
  // #118 review: with the allowlist enforced, only registered allowlisted peers may send gossip.
  if (PEER_ALLOWLIST_ENFORCED) {
    if (!MESH_PEER_ALLOWLIST.has(message.fromPeerId)) return { ok: false, statusCode: 403, error: "peer_not_allowlisted" };
    if (!peer || !isAllowlistedKey(MESH_PEER_ALLOWLIST, peer.peerId, peer.publicKeyPem)) {
      return { ok: false, statusCode: 404, error: "peer_unknown" };
    }
  }
  // Allow peer_exchange and capability_announce from unknown peers — this is how
  // new peers introduce themselves to the mesh after registering.
  if (!peer && message.type !== "peer_exchange" && message.type !== "capability_announce") {
    return { ok: false, statusCode: 404, error: "peer_unknown" };
  }

  // Rate limiting and signature validation (only when peer is known)
  if (peer) {
    const now = Date.now();
    const windowStart = now - (now % 10_000);
    const window = peerMessageWindow.get(peer.peerId);
    if (!window || window.windowMs !== windowStart) {
      peerMessageWindow.set(peer.peerId, { windowMs: windowStart, count: 1 });
    } else {
      window.count += 1;
      if (window.count > MESH_RATE_LIMIT_PER_10S) {
        peerScore.set(peer.peerId, Math.max(0, (peerScore.get(peer.peerId) ?? 100) - 10));
        return { ok: false, statusCode: 429, error: "peer_rate_limited" };
      }
    }

    const validation = protocol.validateMessage(message, peer.publicKeyPem);
    if (!validation.ok) {
      peerScore.set(peer.peerId, Math.max(0, (peerScore.get(peer.peerId) ?? 100) - 5));
      return { ok: false, statusCode: 400, error: validation.reason };
    }
    // Counted for the Network page's mesh-link pulses (work or gossip per minute).
    recordMeshMessage(peer.peerId, message.type);
  }
  if (message.type === "blacklist_update" && peer) {
    const payload = z
      .object({
        eventId: z.string(),
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
        reason: z.string(),
        evidenceHashSha256: z.string(),
        reporterId: z.string(),
        reporterPublicKeyPem: z.string().optional(),
        reporterSignature: z.string().optional(),
        evidenceSignatureVerified: z.boolean(),
        evidenceRef: z.string().optional(),
        sourceCoordinatorId: z.string(),
        reportedBy: z.string(),
        timestampMs: z.number(),
        expiresAtMs: z.number().optional(),
        prevEventHash: z.string(),
        eventHash: z.string(),
        coordinatorSignature: z.string()
      })
      .safeParse(message.payload);
    if (!payload.success) {
      peerScore.set(peer.peerId, Math.max(0, (peerScore.get(peer.peerId) ?? 100) - 5));
      return { ok: false, statusCode: 400, error: "invalid_blacklist_payload" };
    }
    const data = payload.data;
    // The record is checked against the sender's key, so it must be the sender's own record.
    if (data.sourceCoordinatorId !== peer.peerId) {
      peerScore.set(peer.peerId, Math.max(0, (peerScore.get(peer.peerId) ?? 100) - 10));
      return { ok: false, statusCode: 403, error: "blacklist_source_mismatch" };
    }
    const incomingValidation = validateIncomingBlacklistRecord({
      record: data,
      peerPublicKeyPem: peer.publicKeyPem
    });
    if (!incomingValidation.ok) {
      peerScore.set(peer.peerId, Math.max(0, (peerScore.get(peer.peerId) ?? 100) - 10));
      return { ok: false, statusCode: 400, error: incomingValidation.reason };
    }
    const current = activeBlacklistRecord(data.agentId);
    if (!current || data.timestampMs >= current.timestampMs) {
      appendBlacklistRecord(data);
    }
  }
  if (message.type === "capability_summary") {
    const payload = message.payload as unknown as CapabilitySummaryPayload;
    // A coordinator speaks for itself only.
    if (payload.coordinatorId && payload.timestamp && payload.coordinatorId === message.fromPeerId) {
      federatedCapabilities.set(payload.coordinatorId, payload);
      app.log.info({ from: payload.coordinatorId, agents: payload.agentCount }, "capability_summary_received");
    }
    return { ok: true };
  }

  // ── Peer Exchange (BitTorrent-style peer table merge) ──
  if (message.type === "peer_exchange") {
    const payload = message.payload as unknown as PeerExchangePayload;
    let added = 0;
    for (const p of payload.peers ?? []) {
      if (p.peerId === identity.peerId) continue;
      // #118 review: admission (allowlist + squatter replacement) is enforced inside addPeer.
      const admitted = mesh.addPeer({
        peerId: p.peerId,
        publicKeyPem: p.publicKeyPem,
        coordinatorUrl: p.peerUrl,
        networkMode: p.networkMode,
      }, { source: "gossip" });
      if (admitted) {
        peerScore.set(p.peerId, peerScore.get(p.peerId) ?? 100);
        added++;
      } else {
        app.log.debug?.({ from: message.fromPeerId, peerId: p.peerId }, "peer_exchange_entry_dropped");
      }
    }
    if (added > 0) {
      app.log.info({ from: message.fromPeerId, added, total: mesh.listPeers().length }, "peer_exchange_merged");
    }
    return { ok: true, added };
  }

  // ── Capability Announce (individual peer capabilities) ──
  if (message.type === "capability_announce") {
    const payload = message.payload as unknown as CapabilityAnnouncePayload;
    if (payload.peerId && payload.role) {
      // Store mesh peer capabilities for agent/phone peers so the coordinator
      // knows they can accept task_offers via gossip (without full /register).
      if (payload.role === "agent" || payload.role === "phone") {
        const existing = agentCapabilities.get(payload.peerId);
        // #54: gossip never rewrites the models of an agent that registered here (signed report).
        if (existing && existing.version !== "mesh-peer") {
          existing.lastSeenMs = Date.now();
        } else if (existing) {
          existing.activeModel = payload.models[0];
          existing.localModelCatalog = payload.models;
          existing.maxConcurrentTasks = payload.maxConcurrentTasks;
          existing.lastSeenMs = Date.now();
        } else {
          agentCapabilities.set(payload.peerId, {
            os: payload.deviceType === "phone" ? "ios" : "macos",
            version: "mesh-peer",
            mode: "swarm-only",
            localModelEnabled: true,
            localModelProvider: "ollama-local",
            localModelCatalog: payload.models,
            clientType: `mesh-${payload.deviceType}`,
            swarmEnabled: true,
            ideEnabled: false,
            maxConcurrentTasks: payload.maxConcurrentTasks,
            connectedPeers: new Set<string>(),
            activeModel: payload.models[0],
            activeModelParamSize: 0,
            computeClass: "cpu" as ComputeClassId,
            sandboxMode: "none" as SandboxMode,
            lastSeenMs: Date.now(),
          });
        }
      }
      app.log.info({ peerId: payload.peerId, role: payload.role, models: payload.models.length }, "capability_announce_received");
    }
    return { ok: true };
  }

  // ── P2P mesh task distribution ──
  if (message.type === "task_offer") {
    const payload = z.object({
      subtaskId: z.string(),
      taskId: z.string(),
      kind: z.enum(["micro_loop", "single_step"]),
      language: z.enum(["python", "javascript"]),
      input: z.string(),
      timeoutMs: z.number(),
      snapshotRef: z.string(),
      projectMeta: z.object({
        projectId: z.string(),
        tenantId: z.string().optional(),
        resourceClass: z.enum(["cpu", "gpu"]),
        priority: z.number(),
        // Capability constraints travel with the task so a peer cannot hand it to an under-spec agent.
        minVramGb: z.number().positive().max(4096).optional(),
        minMemoryGb: z.number().positive().max(4096).optional(),
        // The requester's bid: class and price ceiling (msat per credit), enforced here too.
        computeClass: z.string().max(64).optional(),
        maxBidMsatPerCredit: z.number().positive().finite().optional(),
      }),
      originCoordinatorId: z.string(),
      originCoordinatorUrl: z.string(),
      bidPremiumBps: z.number().int().min(0).max(100_000).optional(),
    }).safeParse(message.payload);

    if (!payload.success) {
      return { ok: false, statusCode: 400, error: "invalid_task_offer_payload" };
    }

    const d = payload.data;
    // Don't re-enqueue our own tasks
    if (d.originCoordinatorId === identity.peerId) {
      return { ok: true, skipped: "own_task" };
    }
    // An offer comes from its origin, a known peer: results go back to that peer's pinned URL,
    // never to a URL named in the payload.
    if (!peer || d.originCoordinatorId !== message.fromPeerId) {
      return { ok: false, statusCode: 403, error: "offer_origin_mismatch" };
    }
    // Only ask for it if a live agent here could run it.
    if (!hasLiveAgentFor(d)) {
      return { ok: true, skipped: "no_agents" };
    }
    // The requester's bid (stress finding 4): its class must be one we know; its ceiling is posted
    // in our book for the task when granted, so only agents whose ask is within it can claim.
    const bidClass = d.projectMeta.computeClass ?? "any";
    if (bidClass !== "any" && !(bidClass in rateOracleConfig.computeClasses)) {
      return { ok: true, skipped: "unknown_compute_class" };
    }
    const ceiling = d.bidPremiumBps === undefined ? d.projectMeta.maxBidMsatPerCredit : undefined;
    // The origin charges its requester at most its worst case for one subtask, lowered to the bid's
    // ceiling: that is all an agent here may earn for running it, and only what the origin actually
    // charges for the forwarded result is paid (results.ts).
    const budgetMsat = subtaskReserveMsat(d.projectMeta.resourceClass, bidClass as ComputeClassId | "any", SUBTASK_RESERVE_TIMEOUT_MS, ceiling);
    const bid = { computeClass: bidClass as ComputeClassId | "any", maxMsatPerCredit: ceiling, premiumBps: d.bidPremiumBps };
    // Queued here only once the origin grants it to us (task_claim answered granted), so it never runs
    // on two coordinators (src/swarm/remote-grants.ts).
    const { bidPremiumBps: _premium, ...offered } = d;
    void requestOfferGrant(peer, { ...offered, id: d.subtaskId }, budgetMsat, bid).catch((error) =>
      app.log.warn({ subtaskId: d.subtaskId, error: String(error) }, "task_offer_grant_request_failed")
    );
    if (peer) peerScore.set(peer.peerId, Math.min(200, (peerScore.get(peer.peerId) ?? 100) + 2));
    return { ok: true, claimRequested: true };
  }

  if (message.type === "task_claim") {
    const payload = z.object({
      subtaskId: z.string(),
      taskId: z.string().optional(),
      claimedByCoordinator: z.string(),
    }).safeParse(message.payload);
    if (!payload.success) return { ok: false, statusCode: 400, error: "invalid_task_claim_payload" };
    // A coordinator claims for itself only.
    if (!peer || payload.data.claimedByCoordinator !== message.fromPeerId) {
      return { ok: false, statusCode: 403, error: "claim_sender_mismatch" };
    }
    // Only the origin answers: it grants the subtask to this peer or refuses (already granted to
    // another peer, already claimed by a local agent, done, or not ours).
    const decision = grantSubtaskToPeer(payload.data.subtaskId, peer.peerId);
    if (decision.granted) return { ok: true, granted: true, grantTtlMs: decision.ttlMs };
    return { ok: true, granted: false, reason: decision.reason };
  }

  // ── Result Announce from mesh peers (agent/phone executed a task) ──
  if (message.type === "result_announce") {
    const payload = z.object({
      taskId: z.string(),
      subtaskId: z.string(),
      ok: z.boolean(),
      output: z.string().optional(),
      error: z.string().optional(),
      durationMs: z.number().optional(),
    }).safeParse(message.payload);

    if (payload.success) {
      // Only the subtask's origin may take back an unclaimed copy it granted us (it ran it itself
      // after the grant lapsed); anyone else's announcement changes nothing here.
      if (taskOriginMap.get(payload.data.subtaskId)?.coordinatorId === message.fromPeerId && queue.markRemoteClaimed(payload.data.subtaskId)) {
        taskOriginMap.delete(payload.data.subtaskId);
        peerOfferBudgetMsat.delete(payload.data.subtaskId);
        peerGrants.delete(payload.data.subtaskId);
      }
      app.log.info(
        { subtaskId: payload.data.subtaskId, from: message.fromPeerId, ok: payload.data.ok },
        "result_announce_from_mesh"
      );
    }
    return { ok: true };
  }

  if (peer) {
    peerScore.set(peer.peerId, Math.min(200, (peerScore.get(peer.peerId) ?? 100) + 1));
  }
  return { ok: true };
}

/**
 * Relay a gossip message to all WS-connected peers except the sender.
 * This is the key mechanism for NAT traversal: when a coordinator receives
 * gossip, it pushes it to all WS-connected agents/peers, ensuring NATed
 * nodes stay in sync even when they can't be reached via HTTP.
 */
function relayToWsPeers(message: z.infer<typeof meshIngestSchema>): void {
  const serialized = JSON.stringify(message);
  const wsConnected = mesh.getWsConnectedPeerIds();
  for (const peerId of wsConnected) {
    if (peerId === message.fromPeerId) continue; // don't echo back to sender
    if (peerId === identity.peerId) continue;     // don't send to self
    if (!mayRelayOverWs(message.type, meshWsBindings.get(peerId)?.authenticated === true)) continue;
    try {
      const ws = (mesh as any).wsPeers?.get(peerId);
      if (ws && ws.readyState === 1) {
        ws.send(serialized);
      }
    } catch {
      // Non-fatal — peer may have disconnected
    }
  }
}

// ── WebSocket endpoint for NAT traversal ──
// Agents behind NAT open an outbound WebSocket to this endpoint.
// The coordinator pushes gossip messages down the persistent connection.
// Each connection is bound to one peerId (src/mesh/ws-auth.ts): signed binds prove the peer's
// key, unsigned (older agents) binds are allowed until MESH_WS_REQUIRE_SIGNED=true and never
// displace an authenticated one, and every message must come from the bound peer.
const MESH_WS_REQUIRE_SIGNED = CC.MESH_WS_REQUIRE_SIGNED;
const meshWsBindings = new Map<string, { socket: unknown; authenticated: boolean }>();
/**
 * Round trip from this coordinator to each peer on an authenticated mesh socket (agents and peer
 * coordinators), from WebSocket pings (src/swarm/agent-rtt.ts). Read by GET /network/world.
 */
export const meshRtt = new RttTracker();

// Fast dispatch (../dispatch.ts): work_available nudges go only down a socket whose bind proved the
// agent's registered key, and only to registered agents (never to a peer coordinator's socket).
setNudgeTransport({
  connected: (agentId) => {
    const b = meshWsBindings.get(agentId);
    return !!b && b.authenticated && agentCapabilities.has(agentId) && (b.socket as { readyState?: number }).readyState === 1;
  },
  send: (agentId, frame) => {
    const b = meshWsBindings.get(agentId);
    if (!b || !b.authenticated || !agentCapabilities.has(agentId)) return false;
    const ws = b.socket as { readyState?: number; send: (data: string) => void };
    if (ws.readyState !== 1) return false;
    try {
      ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }
});

// Remote model control (../model-control.ts): owner commands go only down a socket whose bind proved
// the agent's registered key, and only to a registered agent (never a peer coordinator's socket).
setModelControlTransport({
  connected: (agentId) => {
    const b = meshWsBindings.get(agentId);
    return !!b && b.authenticated && agentCapabilities.has(agentId) && (b.socket as { readyState?: number }).readyState === 1;
  },
  send: (agentId, frame) => {
    const b = meshWsBindings.get(agentId);
    if (!b || !b.authenticated || !agentCapabilities.has(agentId)) return false;
    if (mesh.listPeers().some((p) => p.peerId === agentId)) return false;
    const ws = b.socket as { readyState?: number; send: (data: string) => void };
    if (ws.readyState !== 1) return false;
    try {
      ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }
});

export function registerMeshRoutes(app: CoordinatorApp): void {
  app.get("/identity", async () => ({
    ...identity,
    fingerprint: IDENTITY_FINGERPRINT,
    trustEntry: `${identity.peerId}:${IDENTITY_FINGERPRINT}`,
    legacyFingerprints: legacyPemFingerprints(identity.publicKeyPem),
    responseSigning: RESPONSE_SIGNING_VERSION
  }));
  // Agents send a fresh nonce; the answer is signed with this coordinator's identity key, so a
  // replayed /identity does not pass their pinned-key check.
  app.post(IDENTITY_CHALLENGE_PATH, async (req, reply) => {
    const answer = answerIdentityChallenge(req.body, {
      peerId: identity.peerId,
      publicKeyPem: identity.publicKeyPem,
      privateKeyPem: coordinatorKeys.privateKeyPem,
      publicUrl: COORDINATOR_PUBLIC_URL
    });
    if (!answer) return reply.code(400).send({ error: "invalid_challenge" });
    return { ...answer, responseSigning: RESPONSE_SIGNING_VERSION };
  });

  app.post(LOCAL_ATTEST_PATH, async (req, reply) => {
    const r = answerLocalAttest(req.body, { adminToken: ADMIN_API_TOKEN, loopback: requestOrigin(req).loopback, nonces: localAttestNonces });
    return reply.code(r.status).send(r.body);
  });
  app.get("/mesh/peers", async () => ({ peers: mesh.listPeers() }));

  app.get("/network/registry", async (_req, reply) => {
    const doc = await registryMirror.get();
    if (!doc) return reply.code(503).send({ error: "registry_unavailable" });
    return reply.header("cache-control", "public, max-age=30").send(doc);
  });

  app.post("/mesh/register-peer", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const body = peerSchema.parse(req.body);
    const origin = requestOrigin(req);
    const sourceIp = origin.clientIp;

    // Coordinators that authenticate with a valid mesh token are trusted peers —
    // skip portal validation (same pattern as loopback self-registration for agents).
    // The mesh token IS the shared secret that proves membership in this coordinator mesh.
    const meshTokenProvided = MESH_AUTH_TOKEN !== "" && hasMeshToken((req.headers ?? {}) as Record<string, unknown>);
    let activationReason = "mesh_token_peer";

    if (meshTokenProvided) {
      // #52: the shared token alone is not enough; the peer's key must be allowlisted.
      const trust = checkPeerRegistration({ body, allowlist: MESH_PEER_ALLOWLIST, production: isProduction() });
      if (!trust.ok) {
        app.log.warn({ peerId: body.peerId, error: trust.error }, "peer_registration_rejected");
        return reply.code(trust.code).send({ error: trust.error });
      }
      activationReason = trust.mode === "allowlist" ? "mesh_peer_allowlisted" : "mesh_token_peer_legacy";
    }

    if (!meshTokenProvided) {
      const activation = await validatePortalNode({
        nodeId: body.peerId,
        nodeKind: "coordinator",
        registrationToken: body.registrationToken,
        sourceIp,
        loopback: origin.loopback
      });
      if (!activation.allowed) {
        return reply.code(403).send({ error: "coordinator_not_activated", reason: activation.reason });
      }
      if (PORTAL_SERVICE_URL && !activation.ownerEmail) {
        return reply.code(403).send({ error: "coordinator_not_activated", reason: "owner_email_required" });
      }
      activationReason = activation.reason ?? "portal_validated";
    }

    const { issuedAtMs: _issuedAtMs, signature: _signature, ...peerIdentity } = body;
    // Proven key (or portal-validated): may replace a squatter or update its own URL.
    if (!mesh.addPeer(peerIdentity as MeshPeerIdentity, { authoritative: true, source: "register" })) {
      // #118 review: also refused when the URL disagrees with the pin or no endpoint is pinned/known.
      return reply.code(403).send({ error: "peer_not_allowlisted_or_url_unpinned" });
    }
    peerScore.set(body.peerId, 100);
    app.log.info({ peerId: body.peerId, reason: activationReason, url: body.coordinatorUrl }, "peer_registered");
    const approvalRecord = ordering.append({
      eventType: "node_approval",
      taskId: `coordinator:${body.peerId}`,
      actorId: body.peerId,
      coordinatorId: identity.peerId,
      payloadJson: JSON.stringify({
        approved: true,
        activationReason,
        sourceIp: sourceIp ?? null
      })
    });
    await pgStore?.persistLedgerRecord(approvalRecord);
    await persistStatsLedgerRecord(approvalRecord);
    return reply.send({ ok: true, peerCount: mesh.listPeers().length });
  });

  app.post("/mesh/ingest", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const message = meshIngestSchema.parse(req.body);
    const result = await handleMeshIngest(message);
    if (result.ok) {
      // Fan-out: relay the message to WS-connected peers that haven't seen it.
      // This ensures NATed peers receive gossip even when the sender can't
      // reach them directly.
      relayToWsPeers(message);
    }
    return reply.code(result.statusCode ?? (result.ok ? 200 : 400)).send(result);
  });

  // ── Gossip relay for NATed peers ──
  // When a peer can't reach another peer via HTTP (NAT/firewall), it asks a
  // coordinator that has a WS connection to that peer to forward the message.
  app.post("/mesh/relay-gossip", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const body = z.object({
      targetPeerId: z.string(),
      message: z.string(),
    }).parse(req.body);

    if (!mesh.hasWebSocket(body.targetPeerId)) {
      return reply.code(404).send({ ok: false, error: "no_ws_for_target" });
    }

    // Parse and validate the inner message before relaying
    try {
      const innerMsg = meshIngestSchema.parse(JSON.parse(body.message));
      // Validate it through normal ingest path first
      const result = await handleMeshIngest(innerMsg);
      if (!result.ok) {
        return reply.code(result.statusCode ?? 400).send(result);
      }
    } catch {
      return reply.code(400).send({ ok: false, error: "invalid_relay_message" });
    }

    // Push to the target peer's WS connection
    try {
      const ws = (mesh as any).wsPeers?.get(body.targetPeerId);
      if (ws && ws.readyState === 1) {
        ws.send(body.message);
        return reply.send({ ok: true, relayed: true });
      }
      return reply.code(404).send({ ok: false, error: "ws_not_open" });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: (err as Error).message });
    }
  });

  app.get("/mesh/ws", { websocket: true }, async (socket, req) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    // Header first; the query parameter is kept for agents that predate it (it can end up in logs).
    const token = readHeaderValue(req.headers as Record<string, unknown>, "x-mesh-token") || url.searchParams.get("token");
    const peerId = url.searchParams.get("peerId");
    const tokenValid = !MESH_AUTH_TOKEN || (Boolean(token) && safeTokenEqual(String(token), MESH_AUTH_TOKEN));
    // Agents hold no mesh token: a registered agent connects with a signed bind by its own key.
    // A coordinator peer's id binds with that peer's key only, never with an agent key registered
    // under the same id (an agent named like a coordinator would otherwise take its gossip).
    const meshPeerKey = peerId ? mesh.listPeers().find((p) => p.peerId === peerId)?.publicKeyPem : undefined;
    const registeredAgentKey = peerId && !meshPeerKey ? agentCapabilities.get(peerId)?.publicKeyPem : undefined;
    if (!peerId || (!tokenValid && !registeredAgentKey)) {
      socket.close(4001, "mesh_unauthorized");
      return;
    }
    const signature = readHeaderValue(req.headers as Record<string, unknown>, "x-mesh-ws-signature") || null;
    const issuedAtMs = readHeaderValue(req.headers as Record<string, unknown>, "x-mesh-ws-ts") || null;
    const bind = decideMeshWsBind({
      peerId,
      signature,
      issuedAtMs,
      knownPublicKeyPem: meshPeerKey ?? registeredAgentKey,
      existingAuthenticated: meshWsBindings.get(peerId)?.authenticated === true,
      // Without the token, only a signed bind (proof of the registered agent key) is admitted.
      requireSigned: MESH_WS_REQUIRE_SIGNED || !tokenValid
    });
    // A signed bind is single-use: the same headers cannot bind a second connection.
    const replayed =
      bind.ok && bind.authenticated &&
      !(await verifyNonce(nonceStore, { nonce: `mesh-ws:${signature}`, sourceId: peerId, timestampMs: Number(issuedAtMs), maxSkewMs: MESH_WS_BIND_MAX_SKEW_MS, ttlMs: SECURITY_NONCE_TTL_MS })).valid;
    if (!bind.ok || replayed) {
      const reason = bind.ok ? "replayed_bind" : bind.reason;
      securityLog.log({
        level: securityLog.severity("agent_trust_violation"),
        event: "agent_trust_violation",
        source: { type: "agent", id: peerId, ip: req.ip },
        details: { route: "/mesh/ws", reason },
        action: "reject_connection",
        coordinatorId: identity.peerId
      });
      socket.close(4003, reason);
      return;
    }
    // Gossip to a peer coordinator (task offers included) goes down its socket: an unsigned bind may
    // not take a coordinator's id.
    if (!bind.authenticated && mesh.listPeers().some((p) => p.peerId === peerId)) {
      securityLog.log({
        level: securityLog.severity("agent_trust_violation"),
        event: "agent_trust_violation",
        source: { type: "agent", id: peerId, ip: req.ip },
        details: { route: "/mesh/ws", reason: "unsigned_bind_for_coordinator_peer" },
        action: "reject_connection",
        coordinatorId: identity.peerId
      });
      socket.close(4003, "signature_required");
      return;
    }
    const previous = meshWsBindings.get(peerId);
    meshWsBindings.set(peerId, { socket, authenticated: bind.authenticated });
    if (previous && previous.socket !== socket) {
      try {
        (previous.socket as { close: (code: number, reason: string) => void }).close(4004, "replaced_by_new_connection");
      } catch {
        /* already closed */
      }
    }

    app.log.info({ peerId, signedBind: bind.authenticated }, "mesh_ws_peer_connected");
    mesh.setWebSocketForPeer(peerId, socket);
    // Only a bind that proved its key is measured, so an unsigned socket cannot set another peer's figure.
    if (bind.authenticated) startRttPings(socket as unknown as PingableSocket, peerId, meshRtt, CC.MESH_WS_PING_INTERVAL_MS);

    socket.on("message", async (data) => {
      try {
        const message = meshIngestSchema.parse(JSON.parse(data.toString()));
        // The socket speaks for its bound peer only.
        if (!meshWsSenderMatches(peerId, message)) {
          securityLog.log({
            level: securityLog.severity("agent_trust_violation"),
            event: "agent_trust_violation",
            source: { type: "agent", id: peerId },
            details: { route: "/mesh/ws", reason: "from_peer_mismatch", claimedFromPeerId: message.fromPeerId },
            action: "drop_message",
            coordinatorId: identity.peerId
          });
          return;
        }
        const result = await handleMeshIngest(message);
        // Fan-out WS-received gossip to other WS-connected peers.
        // This lets NATed agents gossip to each other through the coordinator.
        if (result.ok) relayToWsPeers(message);
      } catch (err) {
        app.log.warn({ peerId, error: (err as Error).message }, "mesh_ws_ingest_error");
      }
    });

    // Only the connection that currently holds the binding may release it.
    const release = () => {
      if (meshWsBindings.get(peerId)?.socket !== socket) return;
      meshWsBindings.delete(peerId);
      mesh.removeWebSocketForPeer(peerId);
    };
    socket.on("close", () => {
      app.log.info({ peerId }, "mesh_ws_peer_disconnected");
      release();
    });

    socket.on("error", (err) => {
      app.log.warn({ peerId, error: err.message }, "mesh_ws_error");
      release();
    });
  });

  app.get("/mesh/capabilities", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const model = (req.query as Record<string, string>).model;
    const entries = [...federatedCapabilities.values()];
    if (model) {
      const filtered = entries.filter(
        (c) => c.modelAvailability[model]?.agentCount > 0
      );
      return reply.send({ coordinators: filtered });
    }
    return reply.send({ coordinators: entries });
  });
}
