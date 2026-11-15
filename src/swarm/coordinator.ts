// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coordinator entry point and composition root.
 *
 * The coordinator's state and helpers live in src/swarm/coordinator/*.ts and its routes in
 * src/swarm/coordinator/routes/*.ts. This file loads those modules in a fixed order, registers
 * the global hooks and then each route group, in the order the routes have always been
 * registered. Two rules keep that order meaningful:
 *
 *  - a coordinator module imports only modules listed above it here, never one below it, so
 *    module state is created top to bottom in this order;
 *  - routes and hooks are registered here and inside `registerXRoutes(app)` functions, never as
 *    a side effect of importing a module.
 *
 * The global request hooks stay in this file so the order they run in is visible in one place.
 */
import "./coordinator/load-order.js";
import { registerCoordinatorMetrics } from "./coordinator-metrics.js";
import { registerRobotRoutes } from "./robot-routes.js";
import { registerDiscoveryRoutes } from "../discovery/announce.js";
import { signPayload } from "../mesh/peer.js";
import { IDENTITY_CHALLENGE_PATH } from "../trust/identity-challenge.js";
import { LOCAL_ATTEST_PATH } from "../trust/local-attest.js";
import { registerResponseSigning } from "../trust/response-signing.js";
import { LISTEN_HOST } from "../common/env-guard.js";
// ── Work receipts + replication (architecture step 2; src/receipts) ──
import { registerReceiptRoutes, startReceiptReplication } from "../receipts/replication.js";
import { anchorEpoch, closeEpoch } from "../receipts/epochs.js";
import { app, metrics } from "./coordinator/app.js";
import { queue, identity, coordinatorKeys, CC, mesh, MESH_AUTH_TOKEN } from "./coordinator/context.js";
import "./coordinator/mutable-state.js";
import { agentCapabilities, connectedAgentCount } from "./coordinator/agent-state.js";
import { hasMeshToken, hasPortalServiceToken, requireMeshToken } from "./coordinator/auth.js";
import { isPaymentGatedRequest } from "./coordinator/economy.js";
import { ECONOMY_PAYMENTS_ENABLED, lightningProvider, payoutReconciler } from "./coordinator/payouts.js";
import { robotQueue, receiptStore, discoveryAnnouncer } from "./coordinator/services.js";
import { coordinatorPublicKeyById, isApprovedCoordinator } from "./coordinator/peers.js";
import { anchorDeps } from "./coordinator/stats-ledger.js";
import "./coordinator/enrollment.js";
import "./coordinator/infra-hosts.js";
import "./coordinator/attested-keys.js";
import "./coordinator/issuance.js";
import "./coordinator/payments.js";
import "./coordinator/schemas.js";
import { finalizeFailedSubtask } from "./coordinator/results.js";
import { registerInferenceRoutes } from "./coordinator/routes/inference.js";
import { registerAccountRoutes } from "./coordinator/routes/account.js";
import "./coordinator/ledger-verify.js";
import { registerMeshRoutes } from "./coordinator/routes/mesh.js";
import { registerOrchestrationRoutes } from "./coordinator/routes/orchestration.js";
import { registerEscalationRoutes } from "./coordinator/routes/escalation.js";
import { registerBleSyncRoutes } from "./coordinator/routes/ble-sync.js";
import { registerDebugRoutes } from "./coordinator/routes/debug.js";
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
import { registerPortalRoutes } from "./coordinator/routes/portal.js";
import { registerAdminRoutes } from "./coordinator/routes/admin.js";
import { initCoordinator } from "./coordinator/init.js";
import { onClaimable, pickupStats } from "./coordinator/dispatch.js";

// Read at scrape time.
registerCoordinatorMetrics(metrics, {
  queue: () => queue.status(),
  connectedAgents: () => connectedAgentCount(),
  knownAgents: () => agentCapabilities.size,
  payoutReconcile: () => payoutReconciler.last(),
  dispatch: () => pickupStats()
});

// Fast dispatch: a subtask that becomes claimable is announced to idle eligible agents (dispatch.ts).
queue.onClaimable(onClaimable);

// #51: subtasks failed at the retry cap go through finalizeFailedSubtask (coordinator/results.ts).
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
registerOrchestrationRoutes(app);
registerPortalRoutes(app);
registerEscalationRoutes(app);
registerBleSyncRoutes(app);
registerDebugRoutes(app);
registerAdminRoutes(app);

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
export { initCoordinator } from "./coordinator/init.js";
export { runResultVerificationTick } from "./coordinator/results.js";
export type { CreditQuote } from "./coordinator/economy.js";
