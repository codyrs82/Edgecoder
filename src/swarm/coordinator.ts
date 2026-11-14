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
import { randomBytes, randomUUID } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import { registerRobotRoutes } from "./robot-routes.js";
import { registerDiscoveryRoutes } from "../discovery/announce.js";
import { extractCode } from "../model/extract.js";
import type { PeerExchangePayload, MeshPeerRole } from "../common/types.js";
import { signPayload } from "../mesh/peer.js";
import { IDENTITY_CHALLENGE_PATH } from "../trust/identity-challenge.js";
import { LOCAL_ATTEST_PATH } from "../trust/local-attest.js";
import { registerResponseSigning } from "../trust/response-signing.js";
import { creditEngine, rewardAccountForAgent } from "../credits/store.js";
import { payoutsPausedByEnv } from "../economy/payout-safeguards.js";
import { ensureOllamaModelInstalled } from "../model/ollama-installer.js";
import { pgStore } from "../db/store.js";
import { checkPriceEpoch } from "../economy/price-epoch-guard.js";
import { isRateEpochStale, normalizeRateEpoch } from "../economy/rate-oracle.js";
import { debugRoutesEnabled, LISTEN_HOST } from "../common/env-guard.js";
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
import type { EscalationRequest, EscalationResult } from "../escalation/types.js";
import { createEscalationResolverFromEnv } from "../escalation/server.js";
import { buildCapabilitySummary, type AgentCapabilityInfo } from "../mesh/capability-gossip.js";
import { rawBodyOf } from "../security/request-signing.js";
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
  OLLAMA_MODEL,
  OLLAMA_HOST,
  OLLAMA_AUTO_INSTALL,
  COORDINATOR_BOOTSTRAP_URLS,
  COORDINATOR_PUBLIC_URL,
  coordinatorPullTracker,
  INFERENCE_AUTH_TOKEN,
  protocol,
  reservations,
  ISSUANCE_RECALC_MS,
  ANCHOR_INTERVAL_MS,
  STATS_LEDGER_SYNC_INTERVAL_MS,
  STATS_ANCHOR_INTERVAL_MS,
  ANCHOR_RECONCILE_MS,
  nonceStore,
  PROVIDER
} from "./coordinator/context.js";
import { mutable } from "./coordinator/mutable-state.js";
import {
  upsertRollout,
  agentCapabilities,
  agentOrchestration,
  ollamaRollouts,
  federatedCapabilities,
  blacklistAuditLog,
  blacklistByAgent,
  cleanupStaleTunnels,
  behaviorTracker,
  anomalyDetector,
  autoBlacklister
} from "./coordinator/agent-state.js";
import {
  hasMeshToken,
  hasPortalServiceToken,
  requireMeshToken,
  authorizeAdmin,
  requireAgentSelf,
  verifyAgentRequest
} from "./coordinator/auth.js";
import {
  isPaymentGatedRequest,
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
  syncStatsLedgerFromPeer,
  maybeFinalizeStatsCheckpoint,
  maybeAnchorLatestStatsCheckpoint,
  anchorTracker,
  reconcileAnchorRows
} from "./coordinator/stats-ledger.js";
import "./coordinator/enrollment.js";
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
import { registerMeshRoutes } from "./coordinator/routes/mesh.js";
import { registerAgentRoutes } from "./coordinator/routes/agents.js";
import { registerTaskRoutes } from "./coordinator/routes/tasks.js";
import { registerStatusRoutes } from "./coordinator/routes/status.js";
import { registerEconomyRoutes } from "./coordinator/routes/economy.js";
import { registerMarketRoutes } from "./coordinator/routes/market.js";
import { registerPricingRoutes } from "./coordinator/routes/pricing.js";
import { registerPaymentRoutes } from "./coordinator/routes/payments.js";
import { registerIssuanceRoutes } from "./coordinator/routes/issuance.js";
import { registerStatsRoutes } from "./coordinator/routes/stats.js";
import { registerSecurityRoutes } from "./coordinator/routes/security.js";
import { registerAgentMeshRoutes } from "./coordinator/routes/agent-mesh.js";

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
registerMeshRoutes(app);
registerStatsRoutes(app);
registerSecurityRoutes(app);
registerAgentMeshRoutes(app);

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
