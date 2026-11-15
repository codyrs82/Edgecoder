// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coordinator startup: restores persisted state and starts the periodic jobs.
 */
import { HOST_APPROVAL_REFRESH_MS, refreshHostApprovals } from "./enrollment.js";
import type { PeerExchangePayload, MeshPeerRole } from "../../common/types.js";
import { ensureOllamaModelInstalled } from "../../model/ollama-installer.js";
import { pgStore } from "../../db/store.js";
import { checkPriceEpoch } from "../../economy/price-epoch-guard.js";
import { isRateEpochStale, normalizeRateEpoch } from "../../economy/rate-oracle.js";
import { buildCapabilitySummary, type AgentCapabilityInfo } from "../../mesh/capability-gossip.js";
import { startPruneScheduler, type PrunableStore } from "../../audit/prune-scheduler.js";
import { app } from "./app.js";
import { LedgerNetworkMismatchError } from "../../db/ledger-network.js";
import {
  reservations,
  ISSUANCE_RECALC_MS,
  CC,
  ANCHOR_INTERVAL_MS,
  mesh,
  protocol,
  identity,
  BITCOIN_NETWORK,
  coordinatorKeys,
  STATS_LEDGER_SYNC_INTERVAL_MS,
  STATS_ANCHOR_INTERVAL_MS,
  ANCHOR_RECONCILE_MS,
  nonceStore,
  PROVIDER,
  OLLAMA_AUTO_INSTALL,
  OLLAMA_MODEL,
  OLLAMA_HOST,
  queue
} from "./context.js";
import { mutable } from "./mutable-state.js";
import { blacklistAuditLog, blacklistByAgent, cleanupStaleTunnels, agentCapabilities, pruneStaleAgentCapabilities } from "./agent-state.js";
import {
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
  RATE_RECALIBRATION_MS,
  orderBook
} from "./economy.js";
import {
  ECONOMY_PAYMENTS_ENABLED,
  payoutPolicy,
  runFeePoolDistribution,
  payoutReconcileConfig,
  payoutReconciler,
  resolvePendingPayouts,
  startAutoPayoutSchedule
} from "./payouts.js";
import { bootstrapPeerMesh } from "./peers.js";
import {
  syncStatsLedgerFromPeer,
  maybeFinalizeStatsCheckpoint,
  maybeAnchorLatestStatsCheckpoint,
  anchorTracker,
  reconcileAnchorRows
} from "./stats-ledger.js";
import { selfInfraHeartbeat } from "./infra-hosts.js";
import { runIssuanceTick, maybeAnchorLatestFinalizedEpoch } from "./issuance.js";
import { reconcileIntent } from "./payments.js";
import { startOnchainTimers } from "./onchain.js";
import { restorePendingVerifications, runResultVerificationTick } from "./results.js";
import { LEDGER_VERIFY_INTERVAL_MS, runLedgerVerifyTick } from "./ledger-verify.js";
import { sweepGrants } from "./grants.js";
import { restoreTaskBilling, sweepTaskBilling } from "./billing-restore.js";
import { TASK_BILLING_SWEEP_INTERVAL_MS } from "../billing-sweep.js";

/** Initialize coordinator background tasks, intervals, and peer mesh.
 *  Call after the Fastify server is listening (either standalone or unified mode). */
export async function initCoordinator(): Promise<void> {
  // Do not block coordinator readiness indefinitely on database recovery.
  if (pgStore) {
    const storeRef = pgStore;
    const initDbState = async () => {
      await storeRef.migrate();
      // A database recorded for another Bitcoin network (e.g. regtest balances on a coordinator now
      // set to mainnet) must never be served: stop instead of logging and carrying on like the
      // other startup steps (docs/going-to-mainnet.md, "Switching the database to mainnet").
      try {
        const ledger = await storeRef.assertLedgerNetwork(BITCOIN_NETWORK, identity.peerId);
        app.log.info({ network: BITCOIN_NETWORK, ledger }, "ledger_network_checked");
      } catch (error) {
        if (error instanceof LedgerNetworkMismatchError) {
          app.log.fatal({ error: error.message }, "ledger_network_mismatch");
          process.exit(1);
        }
        throw error;
      }
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
      // Stress finding 2: tasks billed here and not settled before the restart are resumed or refunded
      // (after the verifications, which own the subtasks they hold).
      await restoreTaskBilling(storeRef).catch((error) => app.log.warn({ error: String(error) }, "task_billing_restore_failed"));
      // ...and rows an outgoing instance left open after that (deploy overlap): swept periodically.
      setInterval(() => {
        void sweepTaskBilling(storeRef).catch((error) => app.log.warn({ error: String(error) }, "task_billing_sweep_failed"));
      }, TASK_BILLING_SWEEP_INTERVAL_MS).unref?.();
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
        // Stress finding 5: agents not seen for AGENT_CAPABILITY_TTL_MS leave the registry (and the
        // order book); one holding a reservation stays.
        const now = Date.now();
        for (const agentId of pruneStaleAgentCapabilities(now, CC.AGENT_CAPABILITY_TTL_MS, (id) => reservations.isHeld(id, now) || reservations.activeForAgent(id, now) !== undefined)) {
          orderBook.removeAsk(agentId);
          queue.forgetAgent(agentId);
        }
        // #51 leases also expire without agent traffic (they were only checked on heartbeats and
        // pulls), so a vanished holder's subtask is requeued, or failed at the cap, on time.
        const leases = queue.expireLeases(now);
        if (leases.failed.length > 0) app.log.warn({ subtaskIds: leases.failed }, "subtask_failed_max_attempts");
        // Execution grants between coordinators: lapsed grants go back on the queue (remote-grants.ts).
        try {
          sweepGrants();
        } catch (error) {
          app.log.warn({ error: String(error) }, "grant_sweep_failed");
        }
      }, 15_000);
      // Host approval (src/portal/host-requests.ts): an admin's approve or revoke reaches agents already registered.
      setInterval(() => {
        void refreshHostApprovals().catch((error) => app.log.warn({ error: String(error) }, "host_approval_refresh_failed"));
      }, HOST_APPROVAL_REFRESH_MS).unref?.();
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
      if (ECONOMY_PAYMENTS_ENABLED && payoutPolicy.enabled) startAutoPayoutSchedule(CC.PAYOUT_AUTO_INTERVAL_MS);
      // On-chain deposits and batched payouts (ONCHAIN_ENABLED; no-op otherwise).
      startOnchainTimers();
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
        // Then settle payouts stuck in pending from the node's payment record (nothing is sent).
        const reconcileAndResolve = () =>
          void payoutReconciler
            .run()
            .catch((error) => app.log.warn({ error: String(error) }, "payout_reconcile_failed"))
            .then(() => resolvePendingPayouts())
            .catch((error) => app.log.warn({ error: String(error) }, "payout_resolve_pending_failed"));
        reconcileAndResolve();
        setInterval(reconcileAndResolve, payoutReconcileConfig.intervalMs);
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
