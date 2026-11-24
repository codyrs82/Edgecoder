// Copyright (c) 2025 EdgeCoder
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
import { queue, identity, coordinatorKeys, CC, mesh, MESH_AUTH_TOKEN, COORDINATOR_PUBLIC_URL, taskBilling } from "./coordinator/context.js";
import { startAdminListener } from "./coordinator/admin-listener.js";
import "./coordinator/mutable-state.js";
import { agentCapabilities, connectedAgentCount, recordAbandonedClaim } from "./coordinator/agent-state.js";
import { hasMeshToken, hasPortalServiceToken, requireMeshToken, isAgentGateRoute, agentSignatureAtGate, agentGateRefusalReason } from "./coordinator/auth.js";
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
import { accrualsInFlight, finalizeFailedSubtask, settleTaskIfDone } from "./coordinator/results.js";
import { registerInferenceRoutes } from "./coordinator/routes/inference.js";
import { registerAccountRoutes } from "./coordinator/routes/account.js";
import { registerWebToolRoutes } from "./coordinator/routes/web-tools.js";
import "./coordinator/ledger-verify.js";
import { meshDrainSockets, registerMeshRoutes } from "./coordinator/routes/mesh.js";
import { coordinatorDrain, installDrainHooks, installDrainSignals, RECONNECT_DELAY_MS, RECONNECT_JITTER_MS } from "./coordinator/drain.js";
import { createCoordinatorReconnectFrame } from "../mesh/coordinator-reconnect.js";
import { registerOrchestrationRoutes } from "./coordinator/routes/orchestration.js";
import { registerModelControlRoutes } from "./coordinator/routes/model-control.js";
import { registerBotRelayRoutes } from "./coordinator/routes/bot-relay.js";
import { registerCodeRelayRoutes } from "./coordinator/routes/code-relay.js";
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
import { registerDirectPaymentRoutes } from "./coordinator/direct-payments.js";
import { registerOnchainRoutes } from "./coordinator/routes/onchain.js";
import { registerIssuanceRoutes } from "./coordinator/routes/issuance.js";
import { registerStatsRoutes } from "./coordinator/routes/stats.js";
import { registerReservesRoutes } from "./coordinator/routes/reserves.js";
import { registerSecurityRoutes } from "./coordinator/routes/security.js";
import { registerAgentMeshRoutes } from "./coordinator/routes/agent-mesh.js";
import { registerPortalRoutes } from "./coordinator/routes/portal.js";
import { registerAdminRoutes } from "./coordinator/routes/admin.js";
import { registerNetworkWorldRoutes } from "./coordinator/routes/network-world.js";
import { registerAdminNetworkRoutes } from "./coordinator/routes/admin-network.js";
import { startCoordinatorAlerting, stopCoordinatorAlerting } from "./coordinator/alerts.js";
import { registerAlertRoutes } from "./coordinator/routes/alerts.js";
import { initCoordinator } from "./coordinator/init.js";
import { onClaimable, pickupStats } from "./coordinator/dispatch.js";
import { noteAgentOutcome } from "./coordinator/memory-admission.js";
import { envelopeStats } from "./envelope-policy.js";
import { cancelUnclaimedForDrain, onInferenceClaimable } from "./coordinator/routes/inference.js";
import { startLostAgentSweep } from "./coordinator/lost-agent-claims.js";

// Read at scrape time.
registerCoordinatorMetrics(metrics, {
  queue: () => queue.status(),
  connectedAgents: () => connectedAgentCount(),
  knownAgents: () => agentCapabilities.size,
  payoutReconcile: () => payoutReconciler.last(),
  dispatch: () => pickupStats(),
  envelope: () => envelopeStats
});

// Fast dispatch: a subtask that becomes claimable is announced to idle eligible agents (dispatch.ts).
queue.onClaimable((subtask, claimableAtMs) => {
  onClaimable(subtask, claimableAtMs);
  // A model call requeued after a lease expiry gets its no-capacity bound again (routes/inference.ts).
  onInferenceClaimable(subtask);
});

// #524: model calls held by an agent whose socket closed (and that went quiet) run elsewhere once.
startLostAgentSweep();

// #51: subtasks failed at the retry cap go through finalizeFailedSubtask (coordinator/results.ts).
queue.onLeaseFailure((result) => {
  void finalizeFailedSubtask(result).catch((err) =>
    app.log.error({ err, subtaskId: result.subtaskId }, "subtask_failure_finalize_failed")
  );
});

// BHV006: a lapsed claim is requeued (above) and recorded as abandoned; only a pattern strikes.
// A lapsed claim is also a timeout for the agent's circuit breaker (coordinator/memory-admission.ts).
queue.onClaimAbandoned((claim) => {
  noteAgentOutcome(claim.agentId, false, claim.atMs);
  recordAbandonedClaim(claim);
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
  // Initial agent registration needs no token: the coordinator validates the portal enrollment
  // token (or proof of the stored key). The response carries no mesh token.
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
  // Proof of reserves: aggregate totals only, cached and rate limited per IP in the route (routes/reserves.ts).
  if (reqPath?.split("?")[0] === "/economy/reserves" && (req as any).method === "GET") return;
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
    (reqPath?.startsWith("/stats/projections/summary") || reqPath?.startsWith("/agent/diagnostics/") || reqPath === "/portal/chat" || reqPath?.startsWith("/account/") || reqPath?.startsWith("/v1/tools/web/") || reqPath === "/inference/submit" || reqPath === "/inference/stream" || reqPath === "/inference/models" || reqPath?.split("?")[0] === "/network/world" || reqPath?.startsWith("/economy/market/") || reqPath === "/economy/rates/current" || reqPath?.startsWith("/economy/payouts") || reqPath?.startsWith("/economy/hosts") || reqPath?.startsWith("/economy/fee-pool") || reqPath?.startsWith("/escalate/") || reqPath === "/agent-control/machines" || /^\/agent-control\/agents\/[^/?]+\/commands$/.test(reqPath ?? "") || reqPath === "/agent-control/bots" || /^\/agent-control\/agents\/[^/?]+\/bot-commands$/.test(reqPath ?? "") || /^\/agent-control\/bot-commands\/[^/?]+$/.test(reqPath ?? "") || reqPath === "/agent-control/code" || /^\/agent-control\/agents\/[^/?]+\/code-commands$/.test(reqPath ?? "") || /^\/agent-control\/code-commands\/[^/?]+$/.test(reqPath ?? ""))
  ) {
    return;
  }
  const headers = ((req as any).headers ?? {}) as Record<string, unknown>;
  if (hasMeshToken(headers)) return;
  // Agents never hold the coordinators' mesh token: a registered agent passes with its own key,
  // and only on the routes agents use (auth.ts isAgentGateRoute). Everything else (fleet-wide
  // reads, gossip ingest, receipts, escalation) stays coordinator/operator-only.
  const gatePath = String(reqPath ?? "").split("?")[0];
  if (isAgentGateRoute(req.method, gatePath) && agentSignatureAtGate(headers, req.method, gatePath)) return;
  if (!requireMeshToken(req as any, reply)) {
    const reason = isAgentGateRoute(req.method, gatePath) ? agentGateRefusalReason(headers) : null;
    return reply.send(reason ? { error: "mesh_unauthorized", reason } : { error: "mesh_unauthorized" });
  }
});

// Graceful stop (coordinator/drain.ts): while draining, new work is refused (retryable) and the
// requests still open are counted so the drain can wait for them.
installDrainHooks(app);
coordinatorDrain.peerUrl = () => {
  const self = COORDINATOR_PUBLIC_URL.replace(/\/+$/, "");
  const peer = mesh.listPeers().find((p) => isApprovedCoordinator(p.peerId) && p.coordinatorUrl && p.coordinatorUrl.replace(/\/+$/, "") !== self);
  return peer?.coordinatorUrl ?? null;
};

registerAgentRoutes(app);
registerTaskRoutes(app);
registerAccountRoutes(app);
// POST /v1/tools/web/{status,search,read} (signed agent or portal): web search and page reads, billed per call.
registerWebToolRoutes(app);
registerInferenceRoutes(app);
registerStatusRoutes(app);
registerEconomyRoutes(app);
registerMarketRoutes(app);
registerPricingRoutes(app);
registerDirectPaymentRoutes(app);
registerPaymentRoutes(app);
registerOnchainRoutes(app);
registerIssuanceRoutes(app);
registerMeshRoutes(app);
registerStatsRoutes(app);
// Public proof of reserves (aggregate liabilities vs node balances; docs/decentralization.md).
registerReservesRoutes(app);
registerSecurityRoutes(app);
registerAgentMeshRoutes(app);
registerOrchestrationRoutes(app);
// Owner-controlled models (portal service token for the owner's commands; signed agent reports).
registerModelControlRoutes(app);
// Bots on the web (portal service token for the owner's reads and commands; signed agent reports).
registerBotRelayRoutes(app);
// Code from your phone (portal service token for the owner's reads and commands; signed agent reports).
registerCodeRelayRoutes(app);
registerPortalRoutes(app);
registerEscalationRoutes(app);
registerBleSyncRoutes(app);
registerDebugRoutes(app);
registerAdminRoutes(app);
// GET /admin/network (admin token): the live network for the portal's admin page.
registerAdminNetworkRoutes(app);
// GET /admin/alerts, POST /admin/alerts/ack and /admin/alerts/test (admin token): production alerting.
registerAlertRoutes(app);
app.addHook("onClose", async () => stopCoordinatorAlerting());
// GET /network/world (signed agent or portal): the anonymized world view for the app's Network page.
registerNetworkWorldRoutes(app);

/** ADMIN_LISTEN_PORT: the internal-only operator listener (coordinator/admin-listener.ts); a no-op when unset. */
export async function startCoordinatorAdminListener(): Promise<void> {
  await startAdminListener(app, CC.ADMIN_LISTEN_PORT, CC.ADMIN_LISTEN_HOST);
}

/**
 * SIGTERM / SIGINT (a deploy or restart) drain the coordinator, then exit (coordinator/drain.ts):
 * running work finishes for up to COORDINATOR_DRAIN_MS, its billing settles, and every connected
 * agent is told to register again and reconnect.
 */
export function installCoordinatorShutdown(opts: { exit?: (code: number) => void; signals?: Pick<NodeJS.Process, "once"> } = {}): void {
  installDrainSignals(() => {
    void coordinatorDrain.run({
      drainMs: CC.COORDINATOR_DRAIN_MS,
      busy: () => {
        let claims = 0;
        for (const c of queue.activeClaims().values()) claims += c.all;
        return { claims, accruals: accrualsInFlight.size };
      },
      settle: async () => {
        // #524: calls nobody claimed cannot run here any more: refunded now, before exit.
        const cancelled = await cancelUnclaimedForDrain().catch(() => 0);
        if (cancelled > 0) app.log.warn({ cancelled }, "drain_unclaimed_inference_refunded");
        let settled = 0;
        for (const taskId of [...taskBilling.keys()]) {
          await settleTaskIfDone(taskId).catch((err) => app.log.warn({ err, taskId }, "drain_settle_failed"));
          if (!taskBilling.has(taskId)) settled++;
        }
        return settled;
      },
      sockets: meshDrainSockets,
      frameFor: (agentId) =>
        JSON.stringify(createCoordinatorReconnectFrame({ agentId, coordinatorId: identity.peerId, privateKeyPem: coordinatorKeys.privateKeyPem, delayMs: RECONNECT_DELAY_MS, jitterMs: RECONNECT_JITTER_MS })),
      close: () => app.close(),
      exit: opts.exit ?? ((code) => process.exit(code)),
      log: app.log
    });
  }, opts.signals);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    await app.listen({ port: 4301, host: LISTEN_HOST });
    installCoordinatorShutdown();
    await startCoordinatorAdminListener();
    await initCoordinator();
    startCoordinatorAlerting();
  })().catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

export { app as coordinatorServer };
export { initCoordinator } from "./coordinator/init.js";
export { startCoordinatorAlerting } from "./coordinator/alerts.js";
export { runResultVerificationTick } from "./coordinator/results.js";
export type { CreditQuote } from "./coordinator/economy.js";
