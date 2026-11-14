// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coordinator entry point. Being split into src/swarm/coordinator/* (issue #16): modules listed
 * in the imports below are loaded in that order, and a coordinator module imports only modules
 * listed above it.
 */
import "./coordinator/load-order.js";
import type { FastifyReply } from "fastify";
import { registerCoordinatorMetrics } from "./coordinator-metrics.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import { safeTokenEqual, readHeaderValue, pairKey, mayRelayOverWs } from "./coordinator-utils.js";
import { registerRobotRoutes } from "./robot-routes.js";
import { registerDiscoveryRoutes } from "../discovery/announce.js";
import { createRegistryMirror } from "../discovery/registry-mirror.js";
import { extractCode } from "../model/extract.js";
import type {
  BlacklistRecord,
  BlacklistReasonCode,
  QueueEventRecord,
  MeshPeerIdentity,
  CapabilitySummaryPayload,
  PeerExchangePayload,
  CapabilityAnnouncePayload,
  MeshPeerRole,
  SandboxMode
} from "../common/types.js";
import { signPayload } from "../mesh/peer.js";
import { checkPeerRegistration, isAllowlistedKey } from "../mesh/peer-trust.js";
import { MESH_WS_BIND_MAX_SKEW_MS, decideMeshWsBind, meshWsSenderMatches } from "../mesh/ws-auth.js";
import { legacyPemFingerprints, publicKeyFingerprint } from "../security/key-fingerprint.js";
import { IDENTITY_CHALLENGE_PATH, answerIdentityChallenge } from "../trust/identity-challenge.js";
import { LOCAL_ATTEST_PATH, NonceLog, answerLocalAttest } from "../trust/local-attest.js";
import { RESPONSE_SIGNING_VERSION, registerResponseSigning } from "../trust/response-signing.js";
import { creditEngine, rewardAccountForAgent } from "../credits/store.js";
import { payoutsPausedByEnv } from "../economy/payout-safeguards.js";
import { ensureOllamaModelInstalled } from "../model/ollama-installer.js";
import { pgStore } from "../db/store.js";
import { checkPriceEpoch } from "../economy/price-epoch-guard.js";
import { isRateEpochStale, normalizeRateEpoch } from "../economy/rate-oracle.js";
import type { ComputeClassId } from "../economy/compute-classes.js";
import { debugRoutesEnabled, isProduction, LISTEN_HOST } from "../common/env-guard.js";
import { checkpointAnchorFinality, describeAnchor } from "../economy/anchor-status.js";
// ── Work receipts + replication (architecture step 2; src/receipts) ──
import { registerReceiptRoutes, startReceiptReplication } from "../receipts/replication.js";
import { anchorEpoch, closeEpoch } from "../receipts/epochs.js";
import {
  applyBleSyncBatch,
  bleSyncAllowV1,
  createBleSyncSchema,
  createInMemoryBleTransfer,
  isBleSyncAuthorized
} from "../credits/ble-sync.js";
import {
  type BlacklistEvidenceInput,
  validateIncomingBlacklistRecord,
  buildBlacklistEventHash,
  verifyReporterEvidenceSignature
} from "../security/blacklist.js";
import type { EscalationRequest, EscalationResult } from "../escalation/types.js";
import { createEscalationResolverFromEnv } from "../escalation/server.js";
import { buildCapabilitySummary, type AgentCapabilityInfo } from "../mesh/capability-gossip.js";
import { rawBodyOf } from "../security/request-signing.js";
import { verifyNonce } from "../security/nonce-verifier.js";
import { startPruneScheduler, type PrunableStore } from "../audit/prune-scheduler.js";
import { buildChatSystemPrompt, type SystemPromptContext } from "../model/system-prompt.js";
import { app, metrics } from "./coordinator/app.js";
import {
  queue,
  identity,
  coordinatorKeys,
  CC,
  mesh,
  MESH_AUTH_TOKEN,
  COORDINATOR_PUBLIC_URL,
  requestOrigin,
  PORTAL_SERVICE_URL,
  MESH_PEER_ALLOWLIST,
  peerScore,
  PEER_ALLOWLIST_ENFORCED,
  peerMessageWindow,
  MESH_RATE_LIMIT_PER_10S,
  protocol,
  peerOfferBudgetMsat,
  PEER_OFFER_BUDGET_MAX_ENTRIES,
  SUBTASK_RESERVE_TIMEOUT_MS,
  taskOriginMap,
  nonceStore,
  SECURITY_NONCE_TTL_MS,
  securityLog,
  ANCHOR_REQUIRED_CONFIRMATIONS,
  STATS_ANCHOR_MIN_CONFIRMATIONS,
  PORTAL_OUTBOUND_TOKEN,
  OLLAMA_MODEL,
  OLLAMA_HOST,
  OLLAMA_AUTO_INSTALL,
  COORDINATOR_BOOTSTRAP_URLS,
  coordinatorPullTracker,
  INFERENCE_AUTH_TOKEN,
  reservations,
  ISSUANCE_RECALC_MS,
  ANCHOR_INTERVAL_MS,
  STATS_LEDGER_SYNC_INTERVAL_MS,
  STATS_ANCHOR_INTERVAL_MS,
  ANCHOR_RECONCILE_MS,
  PROVIDER
} from "./coordinator/context.js";
import { mutable } from "./coordinator/mutable-state.js";
import {
  ordering,
  activeBlacklistRecord,
  appendBlacklistRecord,
  federatedCapabilities,
  agentCapabilities,
  directWorkById,
  activeTunnels,
  blacklistByAgent,
  blacklistAuditLog,
  issueCoordinatorBlacklistRecord,
  behaviorTracker,
  autoBlacklister,
  tunnelByPairKey,
  pendingTunnelInvites,
  relayWindowByAgent,
  RELAY_RATE_LIMIT_PER_10S,
  TUNNEL_MAX_RELAYS_PER_MIN,
  pendingTunnelCloseNotices,
  offerWindowByAgent,
  DIRECT_WORK_OFFERS_PER_10S,
  type DirectWorkOffer,
  directWorkInbox,
  upsertRollout,
  agentOrchestration,
  ollamaRollouts,
  cleanupStaleTunnels,
  anomalyDetector
} from "./coordinator/agent-state.js";
import {
  hasMeshToken,
  hasPortalServiceToken,
  requireMeshToken,
  ADMIN_API_TOKEN,
  authorizeAdmin,
  requireAgentSelf,
  verifyAgentRequest
} from "./coordinator/auth.js";
import {
  isPaymentGatedRequest,
  subtaskReserveMsat,
  PRICE_EPOCH_BOUNDS,
  latestPriceEpochByResource,
  rateOracleConfig,
  syncOrderBookReference,
  marketHistory,
  marketOrders,
  hardwareVerifier,
  paymentIntents,
  repostAsk,
  recordMarketTicks,
  MARKET_TICK_MS,
  RATE_ORACLE_ENABLED,
  recalibrateRateEpoch,
  RATE_RECALIBRATION_MS
} from "./coordinator/economy.js";
import {
  ECONOMY_PAYMENTS_ENABLED,
  lightningProvider,
  payoutPolicy,
  payoutService,
  runFeePoolDistribution,
  payoutReconcileConfig,
  payoutReconciler,
  payoutPause,
  payoutLimits
} from "./coordinator/payouts.js";
import { robotQueue, receiptStore, discoveryAnnouncer, appendAgentDiagnostic } from "./coordinator/services.js";
import { coordinatorPublicKeyById, isApprovedCoordinator, bootstrapPeerMesh } from "./coordinator/peers.js";
import {
  anchorDeps,
  persistStatsLedgerRecord,
  statsQuorumThreshold,
  ingestStatsLedgerRecords,
  maybeAnchorLatestStatsCheckpoint,
  latestStatsFinality,
  currentAnchoringStatus,
  syncStatsLedgerFromPeer,
  maybeFinalizeStatsCheckpoint,
  anchorTracker,
  reconcileAnchorRows
} from "./coordinator/stats-ledger.js";
import { validatePortalNode } from "./coordinator/enrollment.js";
import { selfInfraHeartbeat } from "./coordinator/infra-hosts.js";
import "./coordinator/attested-keys.js";
import { runIssuanceTick, maybeAnchorLatestFinalizedEpoch } from "./coordinator/issuance.js";
import { reconcileIntent } from "./coordinator/payments.js";
import "./coordinator/schemas.js";
import {
  finalizeFailedSubtask,
  restorePendingVerifications,
  runResultVerificationTick
} from "./coordinator/results.js";
import { registerInferenceRoutes } from "./coordinator/routes/inference.js";
import { registerAccountRoutes } from "./coordinator/routes/account.js";
import { LEDGER_VERIFY_INTERVAL_MS, runLedgerVerifyTick } from "./coordinator/ledger-verify.js";
import { registerAgentRoutes } from "./coordinator/routes/agents.js";
import { registerTaskRoutes } from "./coordinator/routes/tasks.js";
import { registerStatusRoutes } from "./coordinator/routes/status.js";
import { registerEconomyRoutes } from "./coordinator/routes/economy.js";
import { registerMarketRoutes } from "./coordinator/routes/market.js";
import { registerPricingRoutes } from "./coordinator/routes/pricing.js";
import { registerPaymentRoutes } from "./coordinator/routes/payments.js";
import { registerIssuanceRoutes } from "./coordinator/routes/issuance.js";

// Read at scrape time, so the sources may be declared further down this module.
registerCoordinatorMetrics(metrics, {
  queue: () => queue.status(),
  connectedAgents: () => agentCapabilities.size,
  payoutReconcile: () => payoutReconciler.last()
});

// #51: subtasks failed at the retry cap go through finalizeFailedSubtask (declared below).
queue.onLeaseFailure((result) => {
  void finalizeFailedSubtask(result).catch((err) =>
    app.log.error({ err, subtaskId: result.subtaskId }, "subtask_failure_finalize_failed")
  );
});

// Every response to an agent request (one carrying x-agent-nonce: register, heartbeat, pull, result,
// agent-mesh, inference, orchestration, errors included) is signed with the identity key, in headers
// or, for a streamed body, in a trailer (src/trust/response-signing.ts). Advertised as responseSigning.
registerResponseSigning(app, { peerId: identity.peerId, privateKeyPem: coordinatorKeys.privateKeyPem });

app.addHook("onRequest", async (req, reply) => {
  if (!ECONOMY_PAYMENTS_ENABLED && isPaymentGatedRequest(req.method, req.url)) {
    return reply.code(503).send({ error: "economy_payments_disabled" });
  }
});

if (robotQueue) {
  registerRobotRoutes(app, robotQueue, {
    hasMeshToken: (headers) => hasMeshToken(headers),
    hasPortalServiceToken: (headers) => hasPortalServiceToken(headers),
    lightningProvider
  });
}

registerReceiptRoutes(app, {
  store: receiptStore,
  coordinatorId: identity.peerId,
  requireMeshToken: (req, reply) => requireMeshToken(req, reply),
  sign: (payload) => signPayload(payload, coordinatorKeys.privateKeyPem),
  coordinatorPublicKeyFor: (id) => coordinatorPublicKeyById(id),
  log: app.log
});

app.addHook("onReady", async () => {
  const epochTimer = setInterval(() => {
    void (async () => {
      const closed = await closeEpoch(receiptStore, { coordinatorId: identity.peerId, coordinatorPrivateKeyPem: coordinatorKeys.privateKeyPem });
      if (!closed) return;
      app.log.info({ epochId: closed.epoch.epochId, count: closed.epoch.count, merkleRoot: closed.epoch.merkleRoot }, "receipt_epoch_closed");
      const deps = anchorDeps();
      if (!deps) return;
      const anchored = await anchorEpoch(closed.epoch, deps, receiptStore);
      app.log.info({ epochId: anchored.epoch.epochId, txRef: anchored.txRef }, "receipt_epoch_anchored");
    })().catch((error) => app.log.warn({ error }, "receipt_epoch_tick_failed"));
  }, CC.RECEIPT_EPOCH_MS);
  epochTimer.unref?.();
  startReceiptReplication({
    peers: () =>
      mesh
        .listPeers()
        .filter((p) => isApprovedCoordinator(p.peerId))
        .map((p) => ({ peerId: p.peerId, coordinatorUrl: p.coordinatorUrl, publicKeyPem: p.publicKeyPem })),
    store: receiptStore,
    intervalMs: CC.RECEIPT_REPLICATION_MS,
    fetch: (url, init) => fetch(url, init),
    selfId: identity.peerId,
    meshToken: MESH_AUTH_TOKEN || undefined,
    coordinatorPublicKeyFor: (id) => coordinatorPublicKeyById(id),
    log: app.log
  });
});

registerDiscoveryRoutes(app, discoveryAnnouncer);

app.addHook("onRequest", async (req, reply) => {
  // Allow initial agent registration without mesh token; coordinator validates
  // portal enrollment token and returns mesh auth material in the response.
  const reqPath = (req as any).url as string | undefined;
  if (reqPath === "/register") return;
  // Health check must be unauthenticated for Fly health probes
  if (reqPath === "/health/runtime") return;
  // #14: /metrics is deliberately outside the mesh/admin token check so a scraper needs only its
  // own credential. It is not public: the route itself requires a loopback caller or the
  // METRICS_TOKEN bearer, and answers 404 when that token is unset (src/common/metrics.ts).
  if (reqPath === "/metrics") return;
  // Public read-only endpoints (peer identity & model pull status)
  if (reqPath === "/identity" || reqPath === "/model/pull/progress") return;
  // Proof of key possession for agents verifying this coordinator (src/trust/identity-challenge.ts).
  if (reqPath === IDENTITY_CHALLENGE_PATH && (req as any).method === "POST") return;
  // #147: the desktop shell checks a leftover :4301 agent holds its admin token (loopback only, see route).
  if (reqPath === LOCAL_ATTEST_PATH && (req as any).method === "POST") return;
  if (reqPath === "/discovery/announcement" || reqPath === "/discovery/peers") return;
  // Mirror of the signed coordinator registry (clients verify the signature; no auth needed).
  if (reqPath === "/network/registry") return;
  // #40: all /admin/* routes are behind authorizeAdmin (admin plugin), not the mesh token.
  // WARNING: register /admin/* routes ONLY inside the admin plugin below — a route added with
  // app.get("/admin/...") outside it would get no auth at all because of this skip.
  if (reqPath?.startsWith("/admin/")) return;
  // #40: blacklist writes are admin-only (route checks authorizeAdmin)
  if (reqPath === "/security/blacklist" && (req as any).method === "POST") return;
  // WebSocket upgrade: auth handled inside the WS handler via query params
  if (reqPath?.startsWith("/mesh/ws")) return;
  if (
    hasPortalServiceToken(((req as any).headers ?? {}) as Record<string, unknown>) &&
    (reqPath?.startsWith("/stats/projections/summary") || reqPath?.startsWith("/agent/diagnostics/") || reqPath === "/portal/chat" || reqPath?.startsWith("/account/") || reqPath === "/inference/submit" || reqPath === "/inference/stream" || reqPath === "/inference/models" || reqPath?.startsWith("/economy/market/") || reqPath === "/economy/rates/current" || reqPath?.startsWith("/economy/payouts") || reqPath?.startsWith("/economy/hosts") || reqPath?.startsWith("/economy/fee-pool") || reqPath?.startsWith("/escalate/"))
  ) {
    return;
  }
  if (!requireMeshToken(req as any, reply)) {
    return reply.send({ error: "mesh_unauthorized" });
  }
});

registerAgentRoutes(app);
registerTaskRoutes(app);
registerAccountRoutes(app);
registerInferenceRoutes(app);
registerStatusRoutes(app);
registerEconomyRoutes(app);
registerMarketRoutes(app);
registerPricingRoutes(app);
registerPaymentRoutes(app);
registerIssuanceRoutes(app);

// `fingerprint` (sha256 of the SPKI DER) is what operators list in TRUSTED_COORDINATOR_KEYS and
// MESH_PEER_ALLOWLIST; `legacyFingerprints` are the PEM-text forms older agent builds compare.
const IDENTITY_FINGERPRINT = publicKeyFingerprint(identity.publicKeyPem);
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
// #147: the desktop app proves an agent already on :4301 is the one it started (src/trust/local-attest.ts).
const localAttestNonces = new NonceLog();
app.post(LOCAL_ATTEST_PATH, async (req, reply) => {
  const r = answerLocalAttest(req.body, { adminToken: ADMIN_API_TOKEN, loopback: requestOrigin(req).loopback, nonces: localAttestNonces });
  return reply.code(r.status).send(r.body);
});
app.get("/mesh/peers", async () => ({ peers: mesh.listPeers() }));

// The portal's signed coordinator registry, mirrored so the one platform URL serves it too
// (src/discovery/registry-mirror.ts). REGISTRY_UPSTREAM_URL overrides the source.
const REGISTRY_PORTAL_URL = PORTAL_SERVICE_URL || CC.PORTAL_PUBLIC_URL;
const registryMirror = createRegistryMirror({
  upstreamUrl: CC.REGISTRY_UPSTREAM_URL || `${REGISTRY_PORTAL_URL.replace(/\/+$/, "")}/network/registry`
});
app.get("/network/registry", async (_req, reply) => {
  const doc = await registryMirror.get();
  if (!doc) return reply.code(503).send({ error: "registry_unavailable" });
  return reply.header("cache-control", "public, max-age=30").send(doc);
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
      }),
      originCoordinatorId: z.string(),
      originCoordinatorUrl: z.string(),
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
    // Only accept if we have alive agents (heartbeat in last 30s)
    const aliveAgents = [...agentCapabilities.values()].filter(
      a => a.lastSeenMs > Date.now() - 30_000
    );
    if (aliveAgents.length === 0) {
      return { ok: true, skipped: "no_agents" };
    }
    // Enqueue locally (dedup by subtaskId handled in queue)
    queue.enqueueSubtask({ ...d, id: d.subtaskId });
    // The origin charges its requester at most its worst case for one subtask (perSubtaskReserveMsat):
    // that is all an agent here may earn for running it.
    if (!peerOfferBudgetMsat.has(d.subtaskId)) {
      if (peerOfferBudgetMsat.size >= PEER_OFFER_BUDGET_MAX_ENTRIES) peerOfferBudgetMsat.delete(peerOfferBudgetMsat.keys().next().value as string);
      peerOfferBudgetMsat.set(d.subtaskId, subtaskReserveMsat(d.projectMeta.resourceClass, "any", SUBTASK_RESERVE_TIMEOUT_MS));
    }
    // Track origin for result forwarding: the origin peer's URL from the peer table.
    taskOriginMap.set(d.subtaskId, {
      coordinatorId: d.originCoordinatorId,
      coordinatorUrl: peer.coordinatorUrl,
    });
    // Broadcast task_claim so origin coordinator knows we're handling it
    const claimMsg = protocol.createMessage(
      "task_claim",
      identity.peerId,
      { subtaskId: d.subtaskId, claimedByCoordinator: identity.peerId },
      coordinatorKeys.privateKeyPem,
    );
    void mesh.broadcast(claimMsg);
    app.log.info({ subtaskId: d.subtaskId, from: d.originCoordinatorId }, "task_offer_accepted");
    if (peer) peerScore.set(peer.peerId, Math.min(200, (peerScore.get(peer.peerId) ?? 100) + 2));
    return { ok: true, enqueued: true };
  }

  if (message.type === "task_claim") {
    const payload = z.object({
      subtaskId: z.string(),
      claimedByCoordinator: z.string(),
    }).safeParse(message.payload);

    if (payload.success && payload.data.claimedByCoordinator !== identity.peerId) {
      // Only remove from our queue if we don't have alive local agents who
      // could claim it.  When we *do* have agents (e.g. iPhone connected via
      // WS), keep the task so local agents can still race for it via /pull.
      const aliveLocalAgents = [...agentCapabilities.values()].filter(
        a => a.lastSeenMs > Date.now() - 30_000
      );
      if (aliveLocalAgents.length === 0) {
        const removed = queue.markRemoteClaimed(payload.data.subtaskId);
        if (removed) {
          app.log.info({ subtaskId: payload.data.subtaskId, by: payload.data.claimedByCoordinator }, "task_claim_remote");
        }
      } else {
        app.log.info(
          { subtaskId: payload.data.subtaskId, by: payload.data.claimedByCoordinator, localAgents: aliveLocalAgents.length },
          "task_claim_remote_kept_for_local"
        );
      }
    }
    return { ok: true };
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
      // Remove from our queue if still pending
      queue.markRemoteClaimed(payload.data.subtaskId);
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
app.get("/mesh/ws", { websocket: true }, async (socket, req) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  // Header first; the query parameter is kept for agents that predate it (it can end up in logs).
  const token = readHeaderValue(req.headers as Record<string, unknown>, "x-mesh-token") || url.searchParams.get("token");
  const peerId = url.searchParams.get("peerId");
  if (!peerId || (MESH_AUTH_TOKEN && (!token || !safeTokenEqual(token, MESH_AUTH_TOKEN)))) {
    socket.close(4001, "mesh_unauthorized");
    return;
  }
  const signature = readHeaderValue(req.headers as Record<string, unknown>, "x-mesh-ws-signature") || null;
  const issuedAtMs = readHeaderValue(req.headers as Record<string, unknown>, "x-mesh-ws-ts") || null;
  const bind = decideMeshWsBind({
    peerId,
    signature,
    issuedAtMs,
    knownPublicKeyPem: agentCapabilities.get(peerId)?.publicKeyPem ?? mesh.listPeers().find((p) => p.peerId === peerId)?.publicKeyPem,
    existingAuthenticated: meshWsBindings.get(peerId)?.authenticated === true,
    requireSigned: MESH_WS_REQUIRE_SIGNED
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
app.get("/agent-mesh/peers/:agentId", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ agentId: z.string() }).parse(req.params);
  if (activeBlacklistRecord(params.agentId)) return reply.code(403).send({ error: "agent_blacklisted" });
  const peers = [...agentCapabilities.keys()].filter(
    (id) => id !== params.agentId && !activeBlacklistRecord(id)
  );
  return { peers };
});

app.get("/agent-mesh/models/available", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const query = z
    .object({
      provider: z.enum(["edgecoder-local", "ollama-local"]).optional(),
      includeBlacklisted: z.coerce.boolean().optional().default(false)
    })
    .parse(req.query);
  const models = [...agentCapabilities.entries()]
    .filter(([agentId, info]) => {
      if (!query.includeBlacklisted && activeBlacklistRecord(agentId)) return false;
      if (!info.localModelEnabled) return false;
      if (query.provider && info.localModelProvider !== query.provider) return false;
      return true;
    })
    .map(([agentId, info]) => ({
      agentId,
      provider: info.localModelProvider,
      modelCatalog: info.localModelCatalog,
      maxConcurrentTasks: info.maxConcurrentTasks,
      connectedPeers: info.connectedPeers.size
    }));
  return { models, generatedAtMs: Date.now() };
});

app.post("/agent-mesh/connect", async (req, reply) => {
  const body = z.object({ fromAgentId: z.string(), toAgentId: z.string() }).parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
  if (activeBlacklistRecord(body.fromAgentId) || activeBlacklistRecord(body.toAgentId)) {
    return reply.code(403).send({ error: "agent_blacklisted" });
  }
  if (!agentCapabilities.has(body.fromAgentId) || !agentCapabilities.has(body.toAgentId)) {
    return reply.code(404).send({ error: "agent_not_found" });
  }
  const existing = tunnelByPairKey.get(pairKey(body.fromAgentId, body.toAgentId));
  if (existing) {
    const tunnel = activeTunnels.get(existing);
    if (tunnel) {
      tunnel.lastRelayMs = Date.now();
      activeTunnels.set(existing, tunnel);
      return { ok: true, token: existing, reused: true };
    }
    tunnelByPairKey.delete(pairKey(body.fromAgentId, body.toAgentId));
  }
  const token = randomUUID();
  activeTunnels.set(token, {
    fromAgentId: body.fromAgentId,
    toAgentId: body.toAgentId,
    createdAtMs: Date.now(),
    lastRelayMs: Date.now(),
    relayCount: 0,
    relayWindowStartMs: Date.now() - (Date.now() % 60_000),
    relayWindowCount: 0
  });
  tunnelByPairKey.set(pairKey(body.fromAgentId, body.toAgentId), token);
  const pending = pendingTunnelInvites.get(body.toAgentId) ?? [];
  pending.push({ fromAgentId: body.fromAgentId, token });
  pendingTunnelInvites.set(body.toAgentId, pending);
  return { ok: true, token };
});

app.post("/agent-mesh/accept", async (req, reply) => {
  const body = z.object({ agentId: z.string(), token: z.string() }).parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.agentId))) return;
  if (activeBlacklistRecord(body.agentId)) return reply.code(403).send({ error: "agent_blacklisted" });
  const tunnel = activeTunnels.get(body.token);
  if (!tunnel) return reply.code(404).send({ error: "tunnel_not_found" });
  if (tunnel.toAgentId !== body.agentId) return reply.code(403).send({ error: "tunnel_target_mismatch" });
  agentCapabilities.get(tunnel.fromAgentId)?.connectedPeers.add(tunnel.toAgentId);
  agentCapabilities.get(tunnel.toAgentId)?.connectedPeers.add(tunnel.fromAgentId);
  return { ok: true };
});

app.post("/agent-mesh/relay", async (req, reply) => {
  const body = z.object({ token: z.string(), fromAgentId: z.string(), payload: z.string() }).parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
  if (activeBlacklistRecord(body.fromAgentId)) return reply.code(403).send({ error: "agent_blacklisted" });
  const tunnel = activeTunnels.get(body.token);
  if (!tunnel) return reply.code(404).send({ error: "tunnel_not_found" });
  if (tunnel.fromAgentId !== body.fromAgentId && tunnel.toAgentId !== body.fromAgentId) {
    return reply.code(403).send({ error: "tunnel_peer_mismatch" });
  }
  if (body.payload.length > 16_384) {
    return reply.code(413).send({ error: "relay_payload_too_large" });
  }
  const now = Date.now();
  const relayWindowStart = now - (now % 10_000);
  const relayWindow = relayWindowByAgent.get(body.fromAgentId);
  if (!relayWindow || relayWindow.windowMs !== relayWindowStart) {
    relayWindowByAgent.set(body.fromAgentId, { windowMs: relayWindowStart, count: 1 });
  } else {
    relayWindow.count += 1;
    if (relayWindow.count > RELAY_RATE_LIMIT_PER_10S) {
      return reply.code(429).send({ error: "relay_rate_limited" });
    }
  }
  const relayMinuteWindowStart = now - (now % 60_000);
  if (tunnel.relayWindowStartMs !== relayMinuteWindowStart) {
    tunnel.relayWindowStartMs = relayMinuteWindowStart;
    tunnel.relayWindowCount = 0;
  }
  if (tunnel.relayWindowCount >= TUNNEL_MAX_RELAYS_PER_MIN) {
    return reply.code(429).send({ error: "tunnel_relay_cap_reached" });
  }
  tunnel.lastRelayMs = Date.now();
  tunnel.relayCount += 1;
  tunnel.relayWindowCount += 1;
  activeTunnels.set(body.token, tunnel);
  return { ok: true, relayCount: tunnel.relayCount };
});

app.post("/agent-mesh/close", async (req, reply) => {
  const body = z.object({ fromAgentId: z.string(), token: z.string(), reason: z.string() }).parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
  const tunnel = activeTunnels.get(body.token);
  if (!tunnel) return reply.code(404).send({ error: "tunnel_not_found" });
  if (tunnel.fromAgentId !== body.fromAgentId && tunnel.toAgentId !== body.fromAgentId) {
    return reply.code(403).send({ error: "tunnel_peer_mismatch" });
  }
  const peerAgentId = tunnel.fromAgentId === body.fromAgentId ? tunnel.toAgentId : tunnel.fromAgentId;
  activeTunnels.delete(body.token);
  tunnelByPairKey.delete(pairKey(tunnel.fromAgentId, tunnel.toAgentId));
  agentCapabilities.get(tunnel.fromAgentId)?.connectedPeers.delete(tunnel.toAgentId);
  agentCapabilities.get(tunnel.toAgentId)?.connectedPeers.delete(tunnel.fromAgentId);
  const notices = pendingTunnelCloseNotices.get(peerAgentId) ?? [];
  notices.push({ peerAgentId: body.fromAgentId, token: body.token, reason: body.reason });
  pendingTunnelCloseNotices.set(peerAgentId, notices);
  return { ok: true };
});

app.post("/agent-mesh/close-ack", async (req, reply) => {
  const body = z.object({ agentId: z.string(), token: z.string() }).parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.agentId))) return;
  const notices = (pendingTunnelCloseNotices.get(body.agentId) ?? []).filter((n) => n.token !== body.token);
  pendingTunnelCloseNotices.set(body.agentId, notices);
  return { ok: true };
});

app.post("/agent-mesh/direct-work/offer", async (req, reply) => {
  const body = z
    .object({
      fromAgentId: z.string(),
      toAgentId: z.string(),
      workType: z.enum(["code_task", "model_inference"]).default("code_task"),
      language: z.enum(["python", "javascript"]).optional(),
      input: z.string().min(1)
    })
    .parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
  if (activeBlacklistRecord(body.fromAgentId) || activeBlacklistRecord(body.toAgentId)) {
    return reply.code(403).send({ error: "agent_blacklisted" });
  }
  if (!agentCapabilities.has(body.fromAgentId) || !agentCapabilities.has(body.toAgentId)) {
    return reply.code(404).send({ error: "agent_not_found" });
  }
  const now = Date.now();
  const offerWindowStart = now - (now % 10_000);
  const offerWindow = offerWindowByAgent.get(body.fromAgentId);
  if (!offerWindow || offerWindow.windowMs !== offerWindowStart) {
    offerWindowByAgent.set(body.fromAgentId, { windowMs: offerWindowStart, count: 1 });
  } else {
    offerWindow.count += 1;
    if (offerWindow.count > DIRECT_WORK_OFFERS_PER_10S) {
      return reply.code(429).send({ error: "direct_work_offer_rate_limited" });
    }
  }
  const offer: DirectWorkOffer = {
    offerId: randomUUID(),
    fromAgentId: body.fromAgentId,
    toAgentId: body.toAgentId,
    workType: body.workType,
    language: body.workType === "code_task" ? (body.language ?? "python") : undefined,
    input: body.input,
    createdAtMs: Date.now(),
    status: "offered"
  };
  directWorkById.set(offer.offerId, offer);
  const inbox = directWorkInbox.get(body.toAgentId) ?? [];
  inbox.push(offer.offerId);
  directWorkInbox.set(body.toAgentId, inbox);
  return { ok: true, offerId: offer.offerId };
});

app.post("/agent-mesh/models/request", async (req, reply) => {
  const body = z
    .object({
      fromAgentId: z.string(),
      toAgentId: z.string(),
      prompt: z.string().min(1).max(16_384)
    })
    .parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
  if (activeBlacklistRecord(body.fromAgentId) || activeBlacklistRecord(body.toAgentId)) {
    return reply.code(403).send({ error: "agent_blacklisted" });
  }
  const fromInfo = agentCapabilities.get(body.fromAgentId);
  const toInfo = agentCapabilities.get(body.toAgentId);
  if (!fromInfo || !toInfo) {
    return reply.code(404).send({ error: "agent_not_found" });
  }
  if (!toInfo.localModelEnabled) {
    return reply.code(409).send({ error: "target_has_no_local_model" });
  }
  const now = Date.now();
  const offerWindowStart = now - (now % 10_000);
  const offerWindow = offerWindowByAgent.get(body.fromAgentId);
  if (!offerWindow || offerWindow.windowMs !== offerWindowStart) {
    offerWindowByAgent.set(body.fromAgentId, { windowMs: offerWindowStart, count: 1 });
  } else {
    offerWindow.count += 1;
    if (offerWindow.count > DIRECT_WORK_OFFERS_PER_10S) {
      return reply.code(429).send({ error: "direct_work_offer_rate_limited" });
    }
  }
  const offer: DirectWorkOffer = {
    offerId: randomUUID(),
    fromAgentId: body.fromAgentId,
    toAgentId: body.toAgentId,
    workType: "model_inference",
    input: body.prompt,
    createdAtMs: now,
    status: "offered"
  };
  directWorkById.set(offer.offerId, offer);
  const inbox = directWorkInbox.get(body.toAgentId) ?? [];
  inbox.push(offer.offerId);
  directWorkInbox.set(body.toAgentId, inbox);
  return { ok: true, offerId: offer.offerId, targetProvider: toInfo.localModelProvider };
});

app.get("/agent-mesh/models/request/:offerId", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ offerId: z.string() }).parse(req.params);
  const offer = directWorkById.get(params.offerId);
  if (!offer) return reply.code(404).send({ error: "offer_not_found" });
  if (offer.workType !== "model_inference") {
    return reply.code(409).send({ error: "offer_not_model_request" });
  }
  return {
    offerId: offer.offerId,
    fromAgentId: offer.fromAgentId,
    toAgentId: offer.toAgentId,
    status: offer.status,
    acceptedAtMs: offer.acceptedAtMs,
    result: offer.result ?? null
  };
});

app.post("/agent-mesh/direct-work/accept", async (req, reply) => {
  const body = z.object({ offerId: z.string(), byAgentId: z.string() }).parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.byAgentId))) return;
  if (activeBlacklistRecord(body.byAgentId)) return reply.code(403).send({ error: "agent_blacklisted" });
  const offer = directWorkById.get(body.offerId);
  if (!offer) return reply.code(404).send({ error: "offer_not_found" });
  if (offer.toAgentId !== body.byAgentId) return reply.code(403).send({ error: "offer_target_mismatch" });
  if (offer.status !== "offered") return reply.code(409).send({ error: "offer_not_available" });
  offer.status = "accepted";
  offer.acceptedBy = body.byAgentId;
  offer.acceptedAtMs = Date.now();
  directWorkById.set(body.offerId, offer);
  const inbox = (directWorkInbox.get(body.byAgentId) ?? []).filter((id) => id !== body.offerId);
  directWorkInbox.set(body.byAgentId, inbox);
  return { ok: true, accepted: true, offer };
});

app.post("/agent-mesh/direct-work/result", async (req, reply) => {
  const body = z
    .object({
      offerId: z.string(),
      byAgentId: z.string(),
      ok: z.boolean(),
      output: z.string(),
      error: z.string().optional(),
      durationMs: z.number()
    })
    .parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.byAgentId))) return;
  if (activeBlacklistRecord(body.byAgentId)) return reply.code(403).send({ error: "agent_blacklisted" });
  const offer = directWorkById.get(body.offerId);
  if (!offer) return reply.code(404).send({ error: "offer_not_found" });
  if (offer.toAgentId !== body.byAgentId) return reply.code(403).send({ error: "offer_target_mismatch" });
  if (offer.status !== "accepted") return reply.code(409).send({ error: "offer_not_accepted" });
  offer.status = "completed";
  offer.result = {
    ok: body.ok,
    output: body.output,
    error: body.error,
    durationMs: body.durationMs,
    completedAtMs: Date.now()
  };
  directWorkById.set(body.offerId, offer);
  return { ok: true };
});

app.post("/orchestration/coordinator/ollama-install", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return; // operator: pulls a model onto this coordinator's volume
  const body = z
    .object({
      provider: z.enum(["edgecoder-local", "ollama-local"]).default("ollama-local"),
      model: z.string().default(OLLAMA_MODEL),
      autoInstall: z.boolean().default(true),
      requestedBy: z.string().default("control-plane")
    })
    .parse(req.body);
  const rolloutId = randomUUID();
  const requestedAtMs = Date.now();
  await upsertRollout({
    rolloutId,
    targetType: "coordinator",
    targetId: "coordinator-local",
    provider: body.provider,
    model: body.model,
    autoInstall: body.autoInstall,
    status: "in_progress",
    requestedBy: body.requestedBy,
    requestedAtMs,
    updatedAtMs: requestedAtMs
  });
  try {
    await ensureOllamaModelInstalled({
      enabled: body.provider === "ollama-local",
      autoInstall: body.autoInstall,
      model: body.model,
      role: "coordinator",
      host: OLLAMA_HOST
    });
    mutable.coordinatorProvider = body.provider;
    await upsertRollout({
      rolloutId,
      targetType: "coordinator",
      targetId: "coordinator-local",
      provider: body.provider,
      model: body.model,
      autoInstall: body.autoInstall,
      status: "applied",
      requestedBy: body.requestedBy,
      requestedAtMs,
      updatedAtMs: Date.now()
    });
    return reply.send({ ok: true, rolloutId, coordinatorProvider: mutable.coordinatorProvider, model: body.model });
  } catch (error) {
    await upsertRollout({
      rolloutId,
      targetType: "coordinator",
      targetId: "coordinator-local",
      provider: body.provider,
      model: body.model,
      autoInstall: body.autoInstall,
      status: "failed",
      requestedBy: body.requestedBy,
      requestedAtMs,
      updatedAtMs: Date.now(),
      error: String(error)
    });
    return reply.code(500).send({ error: String(error), rolloutId });
  }
});

app.get("/orchestration/coordinator/status", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  return {
    provider: mutable.coordinatorProvider,
    ollamaAutoInstall: OLLAMA_AUTO_INSTALL
  };
});

const AGENT_ORCHESTRATION_ONLINE_WINDOW_MS = CC.AGENT_ORCHESTRATION_ONLINE_WINDOW_MS;

function canonicalNodeSuffix(nodeId: string): string {
  return String(nodeId)
    .toLowerCase()
    .replace(/^iphone-/, "")
    .replace(/^ios-/, "")
    .replace(/[^a-z0-9]/g, "");
}

function looksLikeIosAlias(agentIdA: string, agentIdB: string): boolean {
  const a = canonicalNodeSuffix(agentIdA);
  const b = canonicalNodeSuffix(agentIdB);
  if (!a || !b) return false;
  const aIosStyle = /^ios-|^iphone-/i.test(agentIdA);
  const bIosStyle = /^ios-|^iphone-/i.test(agentIdB);
  if (!aIosStyle || !bIosStyle) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function resolveRecentOrchestrationAgentId(
  requestedAgentId: string
): { agentId: string | null; reason?: "agent_not_connected" | "agent_not_recently_seen" } {
  const now = Date.now();
  const exact = agentCapabilities.get(requestedAgentId);
  if (exact) {
    if (now - Number(exact.lastSeenMs ?? 0) <= AGENT_ORCHESTRATION_ONLINE_WINDOW_MS) {
      return { agentId: requestedAgentId };
    }
    return { agentId: null, reason: "agent_not_recently_seen" };
  }
  const aliasMatch = [...agentCapabilities.entries()]
    .filter(([agentId, cap]) =>
      looksLikeIosAlias(agentId, requestedAgentId) &&
      now - Number(cap.lastSeenMs ?? 0) <= AGENT_ORCHESTRATION_ONLINE_WINDOW_MS
    )
    .sort((a, b) => Number(b[1].lastSeenMs ?? 0) - Number(a[1].lastSeenMs ?? 0))[0];
  if (aliasMatch?.[0]) return { agentId: aliasMatch[0] };
  return { agentId: null, reason: "agent_not_connected" };
}

app.post("/orchestration/agents/:agentId/ollama-install", async (req, reply) => {
  // Operator: a forced model rollout makes the target agent pull (and maybe install Ollama).
  if (!authorizeAdmin(req, reply)) return;
  const params = z.object({ agentId: z.string() }).parse(req.params);
  const body = z
    .object({
      provider: z.enum(["edgecoder-local", "ollama-local"]).default("ollama-local"),
      model: z.string().default(OLLAMA_MODEL),
      autoInstall: z.boolean().default(true),
      requestedBy: z.string().default("control-plane")
    })
    .parse(req.body);
  const requestedAgentId = params.agentId;
  const resolvedTarget = resolveRecentOrchestrationAgentId(requestedAgentId);
  if (!resolvedTarget.agentId) {
    appendAgentDiagnostic(
      requestedAgentId,
      `Model switch request rejected: ${resolvedTarget.reason ?? "agent_not_connected"}`
    );
    return reply.code(409).send({
      error: "agent_not_connected",
      reason: resolvedTarget.reason ?? "agent_not_connected",
      agentId: requestedAgentId
    });
  }
  const targetAgentId = resolvedTarget.agentId;
  if (targetAgentId !== requestedAgentId) {
    appendAgentDiagnostic(requestedAgentId, `Routing model switch request to active id ${targetAgentId}`);
  }
  const rolloutId = randomUUID();
  appendAgentDiagnostic(
    targetAgentId,
    `Model switch requested: ${body.provider} (${body.model}) autoInstall=${body.autoInstall ? "true" : "false"}`
  );
  agentOrchestration.set(targetAgentId, {
    rolloutId,
    provider: body.provider,
    model: body.model,
    autoInstall: body.autoInstall,
    pending: true,
    requestedAtMs: Date.now()
  });
  await upsertRollout({
    rolloutId,
    targetType: "agent",
    targetId: targetAgentId,
    provider: body.provider,
    model: body.model,
    autoInstall: body.autoInstall,
    status: "requested",
    requestedBy: body.requestedBy,
    requestedAtMs: Date.now(),
    updatedAtMs: Date.now()
  });
  return reply.send({ ok: true, agentId: targetAgentId, requestedAgentId, rolloutId });
});

app.post("/orchestration/agents/:agentId/status", async (req, reply) => {
  const params = z.object({ agentId: z.string() }).parse(req.params);
  if (!(await requireAgentSelf(req, reply, params.agentId))) return;
  const body = z
    .object({
      phase: z.string().max(64),
      message: z.string().max(512),
      progressPct: z.number().min(0).max(100).optional()
    })
    .parse(req.body);
  const current = agentOrchestration.get(params.agentId);
  if (!current) return reply.code(404).send({ error: "orchestration_not_found" });
  current.status = {
    phase: body.phase,
    message: body.message,
    progressPct: body.progressPct,
    updatedAtMs: Date.now()
  };
  appendAgentDiagnostic(
    params.agentId,
    `${body.phase}: ${body.message}${body.progressPct != null ? ` (${body.progressPct}%)` : ""}`,
    current.status.updatedAtMs
  );
  agentOrchestration.set(params.agentId, current);
  await upsertRollout({
    rolloutId: current.rolloutId,
    targetType: "agent",
    targetId: params.agentId,
    provider: current.provider,
    model: current.model ?? OLLAMA_MODEL,
    autoInstall: current.autoInstall,
    status: "in_progress",
    requestedBy: "control-plane",
    requestedAtMs: current.requestedAtMs,
    updatedAtMs: Date.now()
  });
  return reply.send({ ok: true });
});

app.post("/orchestration/agents/:agentId/ack", async (req, reply) => {
  const params = z.object({ agentId: z.string() }).parse(req.params);
  if (!(await requireAgentSelf(req, reply, params.agentId))) return;
  const body = z.object({ ok: z.boolean(), error: z.string().optional() }).parse(req.body);
  const current = agentOrchestration.get(params.agentId);
  if (!current) return reply.code(404).send({ error: "orchestration_not_found" });
  current.pending = false;
  agentOrchestration.set(params.agentId, current);
  appendAgentDiagnostic(
    params.agentId,
    body.ok ? "Model switch applied successfully." : `Model switch failed: ${body.error ?? "unknown error"}`
  );
  if (body.ok) {
    const cap = agentCapabilities.get(params.agentId);
    if (cap) {
      cap.localModelProvider = current.provider;
      // #54: a reported catalog is refreshed by the agent's own next report, not assumed here.
      if (!cap.modelsReported) cap.localModelCatalog = current.provider === "ollama-local" ? [current.model ?? OLLAMA_MODEL] : ["edgecoder-default"];
      agentCapabilities.set(params.agentId, cap);
    }
  }
  await upsertRollout({
    rolloutId: current.rolloutId,
    targetType: "agent",
    targetId: params.agentId,
    provider: current.provider,
    model: current.model ?? OLLAMA_MODEL,
    autoInstall: current.autoInstall,
    status: body.ok ? "applied" : "failed",
    requestedBy: "control-plane",
    requestedAtMs: current.requestedAtMs,
    updatedAtMs: Date.now(),
    error: body.error
  });
  return reply.send({ ok: body.ok, pending: current.pending, error: body.error });
});

app.get("/orchestration/rollouts", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  if (pgStore) {
    try {
      const rolloutsQueryTimeoutMs = 3_000;
      const rollouts = await Promise.race([
        pgStore.listOllamaRollouts(200),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("rollouts_query_timeout")), rolloutsQueryTimeoutMs)
        )
      ]);
      return { rollouts };
    } catch (error) {
      app.log.warn({ error }, "rollouts_query_fallback_in_memory");
    }
  }
  return { rollouts: [...ollamaRollouts.values()] };
});

// --- Escalation: mesh-based hard task routing ---

const escalationStore = new Map<string, EscalationResult & { request: EscalationRequest }>();
const escalationResolver = createEscalationResolverFromEnv();

const escalationRequestSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  task: z.string().min(1),
  failedCode: z.string(),
  errorHistory: z.array(z.string()),
  language: z.enum(["python", "javascript"]),
  iterationsAttempted: z.number().int().min(1)
});

// Portal model discovery — returns local Ollama models + swarm models
app.get("/portal/models", async (_req, reply) => {
  const ollamaHost = OLLAMA_HOST ?? "http://127.0.0.1:11434";
  let local: Array<{ name: string; parameterSize: string; quantization: string; running: boolean }> = [];
  let runningNames: Set<string> = new Set();

  // Get running models
  try {
    const psRes = await request(`${ollamaHost}/api/ps`, { method: "GET", headersTimeout: 3_000 });
    if (psRes.statusCode >= 200 && psRes.statusCode < 300) {
      const ps = (await psRes.body.json()) as { models?: Array<{ name: string }> };
      for (const m of ps.models ?? []) runningNames.add(m.name);
    } else {
      await psRes.body.text().catch(() => "");
    }
  } catch { /* ignore */ }

  // Get installed models
  try {
    const tagsRes = await request(`${ollamaHost}/api/tags`, { method: "GET", headersTimeout: 3_000 });
    if (tagsRes.statusCode >= 200 && tagsRes.statusCode < 300) {
      const tags = (await tagsRes.body.json()) as { models?: Array<{ name: string; details: { parameter_size: string; quantization_level: string } }> };
      local = (tags.models ?? []).map((m) => ({
        name: m.name,
        parameterSize: m.details.parameter_size ?? "",
        quantization: m.details.quantization_level ?? "",
        running: runningNames.has(m.name),
      }));
    } else {
      await tagsRes.body.text().catch(() => "");
    }
  } catch { /* Ollama not reachable */ }

  // Build swarm model list from agent capabilities
  const swarmModelMap: Record<string, number> = {};
  for (const [, cap] of agentCapabilities) {
    if (cap.activeModel) {
      swarmModelMap[cap.activeModel] = (swarmModelMap[cap.activeModel] ?? 0) + 1;
    }
  }
  const swarm = Object.entries(swarmModelMap).map(([model, agentCount]) => ({
    model,
    paramSize: 0,
    agentCount,
  }));

  return reply.send({ local, swarm });
});

// ── Mesh-peer chat failover helper ──
// Tries chat-capable mesh peers (from federatedCapabilities + bootstrap URLs).
// Streams the first successful response through `reply` and returns true.
// Returns false if all peers fail so the caller can send its own error.
async function tryMeshPeerChat(
  chatBody: { messages: Array<{ role: string; content: string }>; model?: string; temperature?: number; max_tokens?: number },
  reply: FastifyReply,
): Promise<boolean> {
  const chatPeerUrls: string[] = [];
  const meshPeers = mesh.listPeers();
  for (const cap of federatedCapabilities.values()) {
    if (!cap.chatEnabled) continue;
    if (cap.coordinatorId === identity.peerId) continue;
    const peer = meshPeers.find(p => p.peerId === cap.coordinatorId);
    if (peer?.coordinatorUrl) chatPeerUrls.push(peer.coordinatorUrl);
  }
  // Fallback: include bootstrap URLs in case mesh hasn't converged yet
  for (const url of COORDINATOR_BOOTSTRAP_URLS) {
    if (url !== COORDINATOR_PUBLIC_URL && !chatPeerUrls.includes(url)) {
      chatPeerUrls.push(url);
    }
  }

  for (const peerUrl of chatPeerUrls) {
    try {
      // The mesh token only: peers already hold it, and it is what /portal/chat accepts from them. The
      // portal service token names any account and must never leave this coordinator.
      const fwdHeaders: Record<string, string> = { "content-type": "application/json" };
      if (MESH_AUTH_TOKEN) fwdHeaders["x-mesh-token"] = MESH_AUTH_TOKEN;
      const peerRes = await request(`${peerUrl.replace(/\/$/, "")}/portal/chat`, {
        method: "POST",
        headers: fwdHeaders,
        body: JSON.stringify(chatBody),
        headersTimeout: 120_000,
        bodyTimeout: 0,
      });
      if (peerRes.statusCode >= 200 && peerRes.statusCode < 300) {
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        for await (const chunk of peerRes.body) {
          reply.raw.write(chunk);
        }
        reply.raw.end();
        return true;
      }
      await peerRes.body.text().catch(() => "");
    } catch {
      // peer unreachable, try next
    }
  }

  return false;
}

// Portal chat completion — streams Ollama response for portal web chat
app.post("/portal/chat", async (req, reply) => {
  const body = z.object({
    messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
    model: z.string().optional(),
    temperature: z.number().optional(),
    max_tokens: z.number().optional()
  }).parse(req.body);

  const ollamaHost = OLLAMA_HOST ?? "http://127.0.0.1:11434";
  let chatModel = body.model ?? process.env.OLLAMA_MODEL ?? "qwen3.5:9b";

  // Auto-detect available model if configured one isn't available
  let ollamaHealthy = true;
  let installedModels: Array<{ name: string; paramSize: number }> = [];
  let activeModelQuantization: string | undefined;
  let activeModelParamSize = 0;
  try {
    const tagsRes = await request(`${ollamaHost}/api/tags`, { method: "GET", headersTimeout: 3_000 });
    if (tagsRes.statusCode >= 200 && tagsRes.statusCode < 300) {
      const tags = (await tagsRes.body.json()) as { models?: Array<{ name: string; size: number; details: { parameter_size: string; quantization_level: string } }> };
      const available = tags.models ?? [];
      installedModels = available.map((m) => ({
        name: m.name,
        paramSize: parseFloat(m.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0"),
      }));
      const activeEntry = available.find((m) => m.name === chatModel);
      if (activeEntry) {
        activeModelParamSize = parseFloat(activeEntry.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0");
        activeModelQuantization = activeEntry.details.quantization_level;
      }
      if (available.length > 0 && !available.some((m) => m.name === chatModel || m.name.startsWith(chatModel + ":"))) {
        chatModel = available[0].name;
        const fallback = available[0];
        activeModelParamSize = parseFloat(fallback.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0");
        activeModelQuantization = fallback.details.quantization_level;
      }
    }
  } catch {
    ollamaHealthy = false;
  }

  // ── Forward to mesh peer when local Ollama is down ──
  if (!ollamaHealthy) {
    app.log.warn("Local Ollama unavailable — failing over to mesh network");
    const handled = await tryMeshPeerChat(body, reply);
    if (handled) return;
    return reply.code(502).send({
      error: "no_models_available",
      detail: "No local Ollama running and no mesh peers with available models. Start Ollama locally or ensure at least one peer in the network has a model loaded."
    });
  }

  // Build swarm model list from agent capabilities
  const swarmModelMap: Record<string, number> = {};
  for (const [, cap] of agentCapabilities) {
    if (cap.activeModel) {
      swarmModelMap[cap.activeModel] = (swarmModelMap[cap.activeModel] ?? 0) + 1;
    }
  }
  const swarmModels = Object.entries(swarmModelMap).map(([model, agentCount]) => ({ model, agentCount }));

  const queueStatus = queue.status();
  const pullProgress = coordinatorPullTracker.getProgress();

  const systemPromptCtx: SystemPromptContext = {
    activeModel: chatModel,
    activeModelParamSize,
    activeModelQuantization,
    installedModels,
    swarmModels,
    ollamaHealthy,
    queueDepth: queueStatus.queued,
    connectedAgents: agentCapabilities.size,
    pullInProgress: pullProgress ? { model: pullProgress.model, progressPct: pullProgress.progressPct } : undefined,
  };

  const systemPrompt = buildChatSystemPrompt(systemPromptCtx);
  const messagesWithSystem = [
    { role: "system", content: systemPrompt },
    ...body.messages.filter((m) => m.role !== "system"),
  ];

  // Local Ollama is available — try calling it directly
  let ollamaRes;
  try {
    ollamaRes = await request(`${ollamaHost}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: chatModel,
        messages: messagesWithSystem,
        stream: true,
        options: {
          temperature: body.temperature ?? 0.7,
          num_predict: body.max_tokens ?? 4096
        }
      }),
      headersTimeout: 120_000,
      bodyTimeout: 0
    });
  } catch (localErr) {
    app.log.warn({ err: localErr }, "Local Ollama chat failed — falling over to mesh");
    ollamaRes = null;
  }

  if (!ollamaRes || ollamaRes.statusCode < 200 || ollamaRes.statusCode >= 300) {
    // Consume error body if present
    if (ollamaRes) await ollamaRes.body.text().catch(() => "");
    const handled = await tryMeshPeerChat(body, reply);
    if (handled) return;
    return reply.code(502).send({ error: "no_models_available", model: chatModel });
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  for await (const chunk of ollamaRes.body) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        if (parsed.message?.content) {
          reply.raw.write(`data: ${JSON.stringify({ content: parsed.message.content })}\n\n`);
        }
        if (parsed.done) {
          reply.raw.write("data: [DONE]\n\n");
        }
      } catch {
        // skip unparseable lines
      }
    }
  }

  reply.raw.end();
});

// Pull progress endpoint on the coordinator
app.get("/model/pull/progress", async (_req, reply) => {
  const progress = coordinatorPullTracker.getProgress();
  return reply.send(progress ?? { status: "idle" });
});

app.post("/escalate", async (req, reply) => {
  const body = escalationRequestSchema.parse(req.body);
  const taskId = body.taskId;

  escalationStore.set(taskId, {
    taskId,
    status: "processing",
    request: body
  });

  const ollamaHost = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const coordinatorModel = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
  const useLocalOllama = process.env.LOCAL_MODEL_PROVIDER === "ollama-local";

  const errorContext = body.errorHistory.length > 0
    ? `\n\nPrevious errors:\n${body.errorHistory.join("\n")}`
    : "";

  const escalationPrompt = `You are a senior coding assistant. A smaller model failed to solve this task after multiple attempts.

Task: ${body.task}

Failed code:
${body.failedCode}
${errorContext}

Write correct, working ${body.language} code that solves the task. Output ONLY executable code, no markdown fences, no explanation.`;

  // Try local Ollama first (coordinator has Ollama co-located on Fly)
  if (useLocalOllama) {
    try {
      const ollamaRes = await request(`${ollamaHost}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: coordinatorModel, prompt: escalationPrompt, stream: false })
      });
      const payload = (await ollamaRes.body.json()) as { response?: string };
      const raw = payload.response ?? "";
      const improvedCode = raw ? extractCode(raw, body.language) : "";

      if (improvedCode) {
        const result: EscalationResult & { request: EscalationRequest } = {
          taskId,
          status: "completed",
          improvedCode,
          explanation: "Escalated to coordinator-local Ollama model.",
          resolvedByModel: coordinatorModel,
          request: body
        };
        escalationStore.set(taskId, result);
        return reply.send({
          taskId,
          status: "completed",
          improvedCode,
          explanation: result.explanation,
          resolvedByModel: coordinatorModel
        });
      }
    } catch {
      // Local Ollama failed, fall through to inference service
    }
  }

  // Fallback: forward to inference service
  const inferenceUrl = process.env.INFERENCE_URL ?? "http://127.0.0.1:4302";
  try {
    const escalateHeaders: Record<string, string> = { "content-type": "application/json" };
    if (INFERENCE_AUTH_TOKEN) {
      escalateHeaders["x-inference-token"] = INFERENCE_AUTH_TOKEN;
    }
    const inferRes = await request(`${inferenceUrl}/escalate`, {
      method: "POST",
      headers: escalateHeaders,
      body: JSON.stringify({
        task: body.task,
        failedCode: body.failedCode,
        errorHistory: body.errorHistory,
        language: body.language
      })
    });

    if (inferRes.statusCode >= 200 && inferRes.statusCode < 300) {
      const inferResult = (await inferRes.body.json()) as {
        improvedCode?: string;
        explanation?: string;
      };
      const result: EscalationResult & { request: EscalationRequest } = {
        taskId,
        status: "completed",
        improvedCode: inferResult.improvedCode,
        explanation: inferResult.explanation,
        resolvedByModel: "coordinator-inference",
        request: body
      };
      escalationStore.set(taskId, result);
      return reply.send({
        taskId,
        status: "completed",
        improvedCode: inferResult.improvedCode,
        explanation: inferResult.explanation
      });
    }

    // Inference service returned a non-2xx status — fall through to escalation resolver
  } catch {
    // Inference service unreachable — fall through to escalation resolver
  }

  // Fallback: escalation resolver (parent coordinator → cloud inference)
  try {
    const resolved = await escalationResolver.resolve(body);
    const storeEntry: EscalationResult & { request: EscalationRequest } = {
      ...resolved,
      request: body
    };
    escalationStore.set(taskId, storeEntry);
    return reply.send(resolved);
  } catch (resolveError) {
    escalationStore.set(taskId, { taskId, status: "failed", request: body });
    return reply.code(502).send({ taskId, status: "failed", error: String(resolveError) });
  }
});

app.get("/escalate/:taskId", async (req, reply) => {
  const params = z.object({ taskId: z.string() }).parse(req.params);
  const result = escalationStore.get(params.taskId);
  if (!result) return reply.code(404).send({ error: "escalation_not_found" });
  const { request: _req, ...rest } = result;
  return reply.send(rest);
});

/** Callback endpoint — the EscalationResolver posts resolved results here. */
app.post("/escalate/:taskId/result", async (req, reply) => {
  const params = z.object({ taskId: z.string() }).parse(req.params);
  const resultBody = z.object({
    taskId: z.string(),
    status: z.enum(["pending", "processing", "completed", "failed"]),
    improvedCode: z.string().optional(),
    explanation: z.string().optional(),
    resolvedByAgentId: z.string().optional(),
    resolvedByModel: z.string().optional()
  }).parse(req.body);

  const existing = escalationStore.get(params.taskId);
  if (!existing) return reply.code(404).send({ error: "escalation_not_found" });
  if (resultBody.taskId !== params.taskId) return reply.code(400).send({ error: "task_id_mismatch" });
  // The resolver reports once; a settled result is changed only by the portal (a reviewer's decision).
  const settled = existing.status === "completed" || existing.status === "failed";
  if (settled && !hasPortalServiceToken(((req as any).headers ?? {}) as Record<string, unknown>)) {
    return reply.code(409).send({ error: "escalation_already_settled", status: existing.status });
  }

  escalationStore.set(params.taskId, {
    ...resultBody,
    request: existing.request
  });
  return reply.send({ ok: true });
});

// #41: authenticated, double-signed, balance-checked, persistently deduped BLE settlement.
const bleSyncSchema = createBleSyncSchema();
const syncedBLETxIds = new Set<string>(); // non-PG mode only
const inMemoryBleTransfer = createInMemoryBleTransfer(creditEngine, syncedBLETxIds);

app.post("/credits/ble-sync", async (req, reply) => {
  // Unsigned callers fall through to the (configured) mesh-token check below.
  const verified = await verifyAgentRequest(req.headers as any, "/credits/ble-sync", req.ip, { allowUnsigned: true, rawBody: rawBodyOf(req) });
  if (!isBleSyncAuthorized(verified, MESH_AUTH_TOKEN !== "", hasMeshToken(req.headers as any))) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const parsed = bleSyncSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_ble_sync_body", detail: parsed.error.message });
  }
  const body = parsed.data;
  const { applied, skipped } = await applyBleSyncBatch(body.transactions, {
    getPublicKeyPem: (agentId) => agentCapabilities.get(agentId)?.publicKeyPem,
    rewardAccountForAgent,
    allowV1: bleSyncAllowV1(),
    transfer: (tx, requesterAccountId, providerAccountId) =>
      pgStore
        ? pgStore.applyBleTransfer({ txId: tx.txId, requesterAccountId, providerAccountId, credits: tx.credits })
        : inMemoryBleTransfer(tx, requesterAccountId, providerAccountId)
  });
  return reply.send({ applied, skipped, total: body.transactions.length });
});

// ── Debug: direct enqueue for E2E testing (no inference decomposition) ──
const debugEnqueueSchema = z.object({
  input: z.string().min(1).max(10_000),
  language: z.string().optional(),
  taskId: z.string().uuid().optional(),
});

// #40: debug routes are registered only outside production with ENABLE_DEBUG_ROUTES=1.
if (debugRoutesEnabled()) {
  app.post("/debug/enqueue", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    const parsed = debugEnqueueSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", detail: parsed.error.message });
    const body = parsed.data;
    const taskId = body.taskId ?? randomUUID();
    const hasPeers = mesh.listPeers().length > 0;
    const subtask = queue.enqueueSubtask({
      taskId,
      kind: "single_step",
      language: (body.language as "python" | "javascript") ?? "python",
      input: body.input,
      timeoutMs: 30_000,
      snapshotRef: "debug",
      projectMeta: { projectId: "debug", resourceClass: "cpu" as any, priority: 50 }
    }, hasPeers ? { claimDelayMs: 3_000 } : undefined);
    // Gossip task_offer to peer coordinators
    const offerMsg = protocol.createMessage(
      "task_offer",
      identity.peerId,
      {
        subtaskId: subtask.id,
        taskId,
        kind: subtask.kind,
        language: subtask.language,
        input: subtask.input,
        timeoutMs: subtask.timeoutMs,
        snapshotRef: subtask.snapshotRef,
        projectMeta: subtask.projectMeta,
        originCoordinatorId: identity.peerId,
        originCoordinatorUrl: COORDINATOR_PUBLIC_URL,
      },
      coordinatorKeys.privateKeyPem,
      60_000
    );
    void mesh.broadcast(offerMsg);
    return reply.send({ taskId, subtaskId: subtask.id, queued: true });
  });
}

/** Initialize coordinator background tasks, intervals, and peer mesh.
 *  Call after the Fastify server is listening (either standalone or unified mode). */
export async function initCoordinator(): Promise<void> {
  // Do not block coordinator readiness indefinitely on database recovery.
  if (pgStore) {
    const storeRef = pgStore;
    const initDbState = async () => {
      await storeRef.migrate();
      const persistedEvents = await storeRef.listBlacklistEvents();
      for (const event of persistedEvents) {
        blacklistAuditLog.push(event);
        blacklistByAgent.set(event.agentId, event);
        mutable.lastBlacklistEventHash = event.eventHash;
      }
      mutable.blacklistVersion = blacklistAuditLog.length;
      const latestCpu = await storeRef.latestPriceEpoch("cpu");
      const latestGpu = await storeRef.latestPriceEpoch("gpu");
      // #53: a stored epoch outside the configured band (older code had none) is not reloaded.
      if (latestCpu && checkPriceEpoch(latestCpu.pricePerComputeUnitSats, undefined, PRICE_EPOCH_BOUNDS.cpu).ok) latestPriceEpochByResource.set("cpu", latestCpu);
      if (latestGpu && checkPriceEpoch(latestGpu.pricePerComputeUnitSats, undefined, PRICE_EPOCH_BOUNDS.gpu).ok) latestPriceEpochByResource.set("gpu", latestGpu);
      const storedEpoch = await storeRef.latestRateEpoch();
      mutable.latestRateEpoch = storedEpoch ? normalizeRateEpoch(storedEpoch, rateOracleConfig.computeClasses) : null;
      syncOrderBookReference(mutable.latestRateEpoch);
      for (const t of await storeRef.listMarketTicks(7 * 24 * 60)) marketHistory.recordTick(t);
      for (const t of await storeRef.listMarketTrades(5_000)) marketHistory.recordTrade(t);
      for (const o of await storeRef.listMarketOrders()) marketOrders.set(`${o.accountId}:${o.side}`, o);
      hardwareVerifier.load(await storeRef.listHardwareVerifications());
      reservations.load(await storeRef.listReservations());
      mutable.treasuryPolicy = await storeRef.latestTreasuryPolicy();
      const pendingIntents = await storeRef.listPendingPaymentIntents(500);
      for (const intent of pendingIntents) {
        paymentIntents.set(intent.intentId, intent);
      }
      // #105: results held for verification before a restart are held again, not dropped.
      await restorePendingVerifications(storeRef).catch((error) => app.log.warn({ error: String(error) }, "result_verification_restore_failed"));
    };
    const startupDbInitTimeoutMs = 10_000;
    await Promise.race([
      initDbState(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("startup_db_init_timeout")), startupDbInitTimeoutMs)
      )
    ]).catch((error) => app.log.warn({ error }, "startup_db_init_skipped"));
  }

  {
      setInterval(() => {
        cleanupStaleTunnels();
      }, 15_000);
      // Hardware verification: expire unanswered challenges and missing witnesses, re-post changed asks.
      setInterval(() => {
        for (const agentId of hardwareVerifier.tick(Date.now())) repostAsk(agentId);
      }, 15_000);
      setInterval(async () => {
        try {
          const pending = pgStore ? await pgStore.listPendingPaymentIntents(500) : [...paymentIntents.values()];
          for (const intent of pending) {
            if (intent.status !== "created") continue;
            await reconcileIntent(intent);
          }
        } catch (error) {
          app.log.warn({ error }, "payment_reconcile_tick_failed");
        }
      }, 30_000);
      setInterval(() => {
        void runIssuanceTick().catch((error) => app.log.warn({ error }, "issuance_tick_failed"));
      }, ISSUANCE_RECALC_MS);
      // Rate oracle: recalibrate at startup when there is no fresh epoch, then on the daily timer.
      recordMarketTicks();
      setInterval(() => recordMarketTicks(), MARKET_TICK_MS);
      // Payouts: this host's uptime heartbeat, automatic Lightning-address payouts, fee-pool distribution.
      void selfInfraHeartbeat().catch((error) => app.log.warn({ error: String(error) }, "infra_heartbeat_failed"));
      setInterval(() => {
        void selfInfraHeartbeat().catch((error) => app.log.warn({ error: String(error) }, "infra_heartbeat_failed"));
      }, CC.HOST_HEARTBEAT_MS);
      if (ECONOMY_PAYMENTS_ENABLED && payoutPolicy.enabled) {
        setInterval(() => {
          void payoutService.runAutoPayouts().then((r) => { if (r.length) app.log.info({ results: r }, "auto_payouts"); }).catch((error) => app.log.warn({ error: String(error) }, "auto_payouts_failed"));
        }, CC.PAYOUT_AUTO_INTERVAL_MS);
      }
      setInterval(() => {
        void runFeePoolDistribution().catch((error) => app.log.warn({ error: String(error) }, "fee_pool_distribution_failed"));
      }, CC.FEE_POOL_DISTRIBUTION_MS);
      // #115: periodic ledger reconciliation; ticks often, runs once per window across the database.
      if (pgStore && LEDGER_VERIFY_INTERVAL_MS > 0) {
        setInterval(() => {
          void runLedgerVerifyTick().catch((error) => app.log.warn({ error: String(error) }, "ledger_verify_failed"));
        }, Math.min(LEDGER_VERIFY_INTERVAL_MS, 15 * 60_000)).unref?.();
      }
      // Ledger vs Lightning node; a mismatch pauses payouts (payout-reconcile.ts).
      if (ECONOMY_PAYMENTS_ENABLED && payoutReconcileConfig.intervalMs > 0) {
        void payoutReconciler.run().catch((error) => app.log.warn({ error: String(error) }, "payout_reconcile_failed"));
        setInterval(() => {
          void payoutReconciler.run().catch((error) => app.log.warn({ error: String(error) }, "payout_reconcile_failed"));
        }, payoutReconcileConfig.intervalMs);
      }
      if (RATE_ORACLE_ENABLED) {
        if (isRateEpochStale(mutable.latestRateEpoch, rateOracleConfig)) {
          void recalibrateRateEpoch().catch((error) => app.log.warn({ error: String(error) }, "rate_recalibration_failed"));
        }
        setInterval(() => {
          void recalibrateRateEpoch().catch((error) => app.log.warn({ error: String(error) }, "rate_recalibration_failed"));
        }, RATE_RECALIBRATION_MS);
      }
      setInterval(() => {
        void maybeAnchorLatestFinalizedEpoch().catch((error) => app.log.warn({ error }, "anchor_tick_failed"));
      }, ANCHOR_INTERVAL_MS);
      setInterval(() => {
        void bootstrapPeerMesh();
      }, 45_000);
      // ── Peer Exchange: broadcast known peer table to all peers (BitTorrent-style) ──
      setInterval(() => {
        void (async () => {
          const peers = mesh.listPeers();
          if (peers.length === 0) return;
          const peerExchangePayload: PeerExchangePayload = {
            peers: peers.slice(0, 50).map(p => ({
              peerId: p.peerId,
              publicKeyPem: p.publicKeyPem,
              peerUrl: p.coordinatorUrl,
              networkMode: p.networkMode,
              role: "coordinator" as MeshPeerRole,
              lastSeenMs: Date.now(),
            })),
          };
          const msg = protocol.createMessage(
            "peer_exchange",
            identity.peerId,
            peerExchangePayload as unknown as Record<string, unknown>,
            coordinatorKeys.privateKeyPem,
            60_000,
          );
          await mesh.broadcast(msg);
        })().catch((error) => app.log.warn({ error }, "peer_exchange_broadcast_failed"));
      }, 30_000);
      setInterval(() => {
        void (async () => {
          const agents: AgentCapabilityInfo[] = [...agentCapabilities.entries()].map(
            ([agentId, cap]) => ({
              agentId,
              activeModel: cap.activeModel ?? cap.localModelCatalog[0] ?? "",
              activeModelParamSize: cap.activeModelParamSize ?? 0,
              currentLoad: 0,
            })
          );
          const summary = buildCapabilitySummary(identity.peerId, agents);
          // All mesh peers advertise chat capability — when local Ollama is down
          // the coordinator will failover to other mesh peers with available models
          summary.chatEnabled = true;
          const msg = protocol.createMessage(
            "capability_summary",
            identity.peerId,
            summary as unknown as Record<string, unknown>,
            coordinatorKeys.privateKeyPem,
            60_000
          );
          await mesh.broadcast(msg);
        })().catch((error) => app.log.warn({ error }, "capability_gossip_failed"));
      }, 60_000);
      setInterval(() => {
        void (async () => {
          const peers = mesh.listPeers();
          for (const peer of peers) {
            await syncStatsLedgerFromPeer(peer);
          }
          await maybeFinalizeStatsCheckpoint();
        })().catch((error) => app.log.warn({ error }, "stats_ledger_sync_failed"));
      }, STATS_LEDGER_SYNC_INTERVAL_MS);
      setInterval(() => {
        void maybeAnchorLatestStatsCheckpoint().catch((error) => app.log.warn({ error }, "stats_anchor_tick_failed"));
      }, STATS_ANCHOR_INTERVAL_MS);
      // #50: reassign stalled replicas and release verifications whose replicas never reported.
      setInterval(() => {
        void runResultVerificationTick().catch((error) => app.log.warn({ error }, "result_verification_expire_failed"));
      }, 60_000);
      // #46: polls now (resumes rows left pending by the previous process), then every
      // ANCHOR_CONFIRM_POLL_MS, backing off while the provider is unreachable.
      anchorTracker.start();
      setInterval(() => {
        void reconcileAnchorRows().catch((error) => app.log.warn({ error }, "anchor_reconcile_tick_failed"));
      }, ANCHOR_RECONCILE_MS);
      // ── Security: nonce prune scheduler ──
      const pruneAdapter: PrunableStore = {
        async noncePrune() { await nonceStore.prune(); return 0; },
        async meshMessagePrune() { return 0; },
      };
    startPruneScheduler(pruneAdapter, 5 * 60_000);
    app.log.info("security: request signing verification, nonce replay detection, and rate limiting active");
  }
  // Do not block coordinator readiness on model pull/install.
  // Fly health checks and agent registration should stay available while
  // Ollama warms up in the background.
  void ensureOllamaModelInstalled({
    enabled: PROVIDER === "ollama-local",
    autoInstall: OLLAMA_AUTO_INSTALL,
    model: OLLAMA_MODEL,
    role: "coordinator",
    host: OLLAMA_HOST
  }).catch((error) => app.log.warn({ error }, "coordinator_ollama_bootstrap_failed"));
  await bootstrapPeerMesh();
  await (async () => {
    const peers = mesh.listPeers();
    for (const peer of peers) {
      await syncStatsLedgerFromPeer(peer);
    }
    await maybeFinalizeStatsCheckpoint();
  })().catch(() => undefined);
  await runIssuanceTick().catch(() => undefined);
  // #103: reconcile before anchoring so a crash-left "broadcasting" row is resolved first.
  await reconcileAnchorRows().catch((error) => app.log.warn({ error }, "anchor_reconcile_startup_failed"));
  await maybeAnchorLatestFinalizedEpoch().catch(() => undefined);
  await maybeAnchorLatestStatsCheckpoint().catch(() => undefined);
}

// #40: every /admin/* route lives in this plugin behind authorizeAdmin (in addition to the
// per-route checks), so new admin routes can't forget it.
app.register(async (admin) => {
admin.addHook("onRequest", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return reply;
});

admin.get("/admin/dashboard", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  const status = queue.status();
  const agentList = [...agentCapabilities.entries()].map(([agentId, info]) => ({
    agentId,
    os: info.os,
    provider: info.localModelProvider,
    maxConcurrentTasks: info.maxConcurrentTasks,
    modelCatalog: info.localModelCatalog
  }));
  // Agent fields are agent-supplied: the page renders them as text, and only its own script may run.
  const nonce = randomBytes(16).toString("base64");
  reply.header("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  return reply.type("text/html").send(adminDashboardHtml(status, agentList, nonce));
});

admin.get("/admin/dashboard/api/overview", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  const status = queue.status();
  const agentList = [...agentCapabilities.entries()].map(([agentId, info]) => ({
    agentId,
    os: info.os,
    provider: info.localModelProvider,
    maxConcurrentTasks: info.maxConcurrentTasks,
    modelCatalog: info.localModelCatalog
  }));
  return reply.send({
    coordinator: { queued: status.queued, agents: status.agents, results: status.results },
    agents: agentList,
    uptimeSeconds: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage.rss() / 1_048_576),
    meshPeers: mesh.listPeers().length
  });
});

// Payout kill switch: halts withdrawals, auto payouts and fee-pool distribution (purchases keep working).
admin.get("/admin/payouts/pause", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  return { ...(await payoutPause.state()), envForced: payoutsPausedByEnv(), limits: payoutLimits };
});
admin.post("/admin/payouts/pause", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  const parsed = z.object({ paused: z.boolean(), reason: z.string().max(500).optional(), actor: z.string().max(128).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
  const actor = `admin:${parsed.data.actor ?? "token"}@${req.ip}`;
  if (parsed.data.paused) return { ok: true, state: await payoutPause.pause(parsed.data.reason ?? "paused by operator", "admin", actor) };
  const resumed = await payoutPause.resume(actor, parsed.data.reason);
  if (!resumed.ok) return reply.code(409).send({ ok: false, code: resumed.code, state: resumed.state });
  return resumed;
});
admin.get("/admin/payouts/reconciliation", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  return { config: payoutReconcileConfig, webhookConfigured: Boolean(process.env.PAYOUT_ALERT_WEBHOOK_URL?.trim()), last: payoutReconciler.last() };
});
admin.post("/admin/payouts/reconciliation/run", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  return payoutReconciler.run();
});

admin.get("/admin/agents/:agentId/behavior", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  const params = z.object({ agentId: z.string() }).parse(req.params);
  const stats = behaviorTracker.getStats(params.agentId);
  if (!stats) {
    return reply.code(404).send({ error: "agent_not_found", agentId: params.agentId });
  }
  const anomalies = anomalyDetector.evaluate(stats);
  const strikeCount = autoBlacklister.getStrikeCount(params.agentId);
  return reply.send({ agentId: params.agentId, stats, anomalies, strikeCount });
});
});

function adminDashboardHtml(status: { queued: number; agents: number; results: number }, agentList: Array<{ agentId: string; os?: string; provider?: string; maxConcurrentTasks?: number; modelCatalog?: string[] }>, nonce: string): string {
  const agentRows = agentList.map((a) =>
    `<tr><td>${esc(a.agentId)}</td><td>${esc(a.os ?? "-")}</td><td>${esc(a.provider ?? "-")}</td><td>${esc((a.modelCatalog ?? []).join(", ") || "-")}</td><td>${a.maxConcurrentTasks ?? 0}</td></tr>`
  ).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EdgeCoder Coordinator Admin</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --green: #3fb950; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  .container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  header { margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
  header h1 { font-size: 20px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-bottom: 12px; }
  .stat { font-size: 28px; font-weight: 700; }
  .stat-label { font-size: 13px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  #refresh-timer { font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>EdgeCoder Coordinator Admin</h1>
    <span id="refresh-timer">Auto-refresh: 10s</span>
  </header>
  <div class="grid">
    <div class="card"><h2>Connected Agents</h2><div class="stat" id="v-agents">${status.agents}</div></div>
    <div class="card"><h2>Queue Depth</h2><div class="stat" id="v-queued">${status.queued}</div></div>
    <div class="card"><h2>Results</h2><div class="stat" id="v-results">${status.results}</div></div>
    <div class="card"><h2>Uptime</h2><div class="stat" id="v-uptime">${Math.floor(process.uptime())}s</div></div>
    <div class="card"><h2>Memory</h2><div class="stat" id="v-mem">${Math.round(process.memoryUsage.rss() / 1_048_576)} MB</div></div>
    <div class="card"><h2>Mesh Peers</h2><div class="stat" id="v-peers">${mesh.listPeers().length}</div></div>
  </div>
  <div class="card" style="margin-bottom:24px;">
    <h2>Connected Agents</h2>
    <table>
      <thead><tr><th>Agent</th><th>OS</th><th>Provider</th><th>Models</th><th>Capacity</th></tr></thead>
      <tbody id="agent-body">${agentRows || "<tr><td colspan='5'>No agents connected.</td></tr>"}</tbody>
    </table>
  </div>
</div>
<script nonce="${nonce}">
// #40 review: the admin token is sent only in the x-admin-token header, never in the URL.
const TOKEN_KEY = "edgecoder_admin_token";
let token = sessionStorage.getItem(TOKEN_KEY) || "";
if (!token) {
  token = window.prompt("Admin token") || "";
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
}
async function refresh() {
  try {
    const res = await fetch("/admin/dashboard/api/overview", { headers: { "x-admin-token": token } });
    if (res.status === 401) { sessionStorage.removeItem(TOKEN_KEY); return; }
    const d = await res.json();
    document.getElementById("v-agents").textContent = d.coordinator.agents;
    document.getElementById("v-queued").textContent = d.coordinator.queued;
    document.getElementById("v-results").textContent = d.coordinator.results;
    document.getElementById("v-uptime").textContent = d.uptimeSeconds + "s";
    document.getElementById("v-mem").textContent = d.memoryMB + " MB";
    document.getElementById("v-peers").textContent = d.meshPeers;
    // Agent fields are agent-supplied: set as text, never parsed as HTML.
    const body = document.getElementById("agent-body");
    const row = function(cells, colspan) {
      const tr = document.createElement("tr");
      cells.forEach(function(text) {
        const td = document.createElement("td");
        if (colspan) td.colSpan = colspan;
        td.textContent = String(text);
        tr.appendChild(td);
      });
      return tr;
    };
    const rows = d.agents.length === 0
      ? [row(["No agents connected."], 5)]
      : d.agents.map(function(a) {
          return row([a.agentId || "-", a.os || "-", a.provider || "-", (a.modelCatalog || []).join(", ") || "-", a.maxConcurrentTasks || 0]);
        });
    body.replaceChildren.apply(body, rows);
  } catch(e) { console.error("refresh failed", e); }
}
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    await app.listen({ port: 4301, host: LISTEN_HOST });
    await initCoordinator();
  })().catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

export { app as coordinatorServer };
export { runResultVerificationTick } from "./coordinator/results.js";
export type { CreditQuote } from "./coordinator/economy.js";
