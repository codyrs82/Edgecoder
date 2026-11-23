// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Production alerting on a coordinator (src/alerting). It watches what only it can see:
 *
 *  - its mesh peers' GET /health/runtime and the portal's GET /health (a coordinator that is down
 *    cannot report itself, so the coordinators and the portal watch each other);
 *  - its Lightning node (reachable, synced to chain and graph, liquidity, inactive channels), and
 *    inbound capacity as a shared incident per node (both seeds use one LND: one notification);
 *  - payouts (failures, stuck pending, the kill switch) and purchase invoices;
 *  - the ledger (the periodic reconciliation and its own ordering chain);
 *  - its Postgres pool (the #328 error counter and a probe);
 *  - the security-event stream (integrity events, repeated auth failures, auto-blacklists).
 *
 * Payout and ledger incidents are "shared": both seeds read the same database, so they share one
 * incident and one notification (src/alerting/store.ts claimNotify). Admin routes are in
 * routes/alerts.ts; the portal's Settings > Network shows them (src/portal/alerts.ts).
 */
import { alertConfigFromEnv } from "../../alerting/config.js";
import { AlertRunner, SHARED_SOURCE, createAlertManager } from "../../alerting/index.js";
import {
  SecurityEventMonitor,
  databaseMonitor,
  healthWatchMonitor,
  ledgerMonitor,
  lightningInboundMonitor,
  lightningMonitor,
  orderingChainMonitor,
  payoutMonitor,
  purchaseMonitor,
  type LedgerVerification,
  type Monitor,
  type PayoutAlertQueries
} from "../../alerting/monitors.js";
import { pgStore } from "../../db/store.js";
import { pgPoolErrorCount } from "../../db/pool.js";
import { verifyOrderingChain } from "../../ledger/verify.js";
import { app } from "./app.js";
import { CC, COORDINATOR_BOOTSTRAP_URLS, COORDINATOR_PUBLIC_URL, coordinatorKeys, identity, mesh, securityLog } from "./context.js";
import { agentCapabilities, ordering } from "./agent-state.js";
import { hardwareVerifier } from "./economy.js";
import { ECONOMY_PAYMENTS_ENABLED, lightningProvider, memoryPayoutStore, payoutPause } from "./payouts.js";
import { isApprovedCoordinator } from "./peers.js";
import { purchaseSignals } from "./payments.js";
import { coordinatorRegion } from "./routes/admin-network.js";

export const alertConfig = alertConfigFromEnv();

const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
const label = host(COORDINATOR_PUBLIC_URL) + (coordinatorRegion() ? ` · ${coordinatorRegion()}` : "");
const log = { warn: (o: unknown, m: string) => app.log.warn(o as object, m), info: (o: unknown, m: string) => app.log.info(o as object, m) };
const pool = pgStore ? pgStore.withPool((p) => p) : null;

export const coordinatorAlerts = createAlertManager(alertConfig, {
  pool,
  sourceId: identity.peerId,
  reporter: `coordinator ${label}`,
  portalUrl: CC.PORTAL_PUBLIC_URL,
  log
});

/** An agent with a known owner (enrolled to an account) or verified hardware: its auto-blacklist is unusual. */
export function isOwnedHost(agentId: string): boolean {
  if (agentCapabilities.get(agentId)?.ownerEmail) return true;
  return hardwareVerifier.get(agentId)?.status === "verified";
}

export const securityMonitor = new SecurityEventMonitor({ authFailuresPer10Min: alertConfig.authFailuresPer10Min, isOwnedHost, label });
securityLog.addListener((event) => securityMonitor.ingest(event));

const payoutQueries: PayoutAlertQueries = pool
  ? {
      async failedSince(sinceMs) {
        const r = await pool.query(
          `SELECT payout_id, kind, amount_msat, error, settled_at_ms, count(*) OVER () AS total FROM payouts
           WHERE status = 'failed' AND settled_at_ms >= $1 AND COALESCE(error, '') <> 'payouts_paused'
           ORDER BY settled_at_ms DESC LIMIT 5`,
          [sinceMs]
        );
        return {
          count: Number(r.rows[0]?.total ?? 0),
          recent: r.rows.map((x) => ({ payoutId: String(x.payout_id), kind: String(x.kind), amountMsat: Number(x.amount_msat), error: x.error ?? null, settledAtMs: Number(x.settled_at_ms) }))
        };
      },
      async pendingBefore(beforeMs) {
        const r = await pool.query(`SELECT count(*)::int AS n, min(created_at_ms) AS oldest FROM payouts WHERE status = 'pending' AND kind <> 'onchain' AND created_at_ms < $1`, [beforeMs]);
        return { count: Number(r.rows[0]?.n ?? 0), oldestMs: r.rows[0]?.oldest === null || r.rows[0]?.oldest === undefined ? null : Number(r.rows[0].oldest) };
      },
      paused: async () => {
        const s = await payoutPause.state();
        return { paused: s.paused, reason: s.reason ?? null, sinceMs: s.changedAtMs ?? null };
      }
    }
  : {
      async failedSince(sinceMs) {
        const rows = [...(memoryPayoutStore?.payouts.values() ?? [])].filter((p) => p.status === "failed" && (p.settledAtMs ?? 0) >= sinceMs && p.error !== "payouts_paused").sort((a, b) => (b.settledAtMs ?? 0) - (a.settledAtMs ?? 0));
        return { count: rows.length, recent: rows.slice(0, 5).map((p) => ({ payoutId: p.payoutId, kind: p.kind, amountMsat: p.amountMsat, error: p.error ?? null, settledAtMs: p.settledAtMs ?? 0 })) };
      },
      async pendingBefore(beforeMs) {
        const rows = [...(memoryPayoutStore?.payouts.values() ?? [])].filter((p) => p.status === "pending" && p.kind !== "onchain" && p.createdAtMs < beforeMs);
        return { count: rows.length, oldestMs: rows.length ? Math.min(...rows.map((p) => p.createdAtMs)) : null };
      },
      paused: async () => {
        const s = await payoutPause.state();
        return { paused: s.paused, reason: s.reason ?? null, sinceMs: s.changedAtMs ?? null };
      }
    };

async function latestLedgerVerifications(): Promise<LedgerVerification[]> {
  if (!pool) return [];
  const r = await pool.query(`SELECT window_start_ms, started_at_ms, finished_at_ms, ok, mismatches FROM ledger_verifications ORDER BY window_start_ms DESC LIMIT 3`);
  return r.rows.map((x) => ({
    windowStartMs: Number(x.window_start_ms),
    startedAtMs: Number(x.started_at_ms),
    finishedAtMs: x.finished_at_ms === null ? null : Number(x.finished_at_ms),
    ok: x.ok === null ? null : Boolean(x.ok),
    mismatches: x.mismatches === null ? null : Number(x.mismatches)
  }));
}

/** Peers to watch: approved mesh peers with a URL, and the bootstrap list; never this coordinator. */
async function peerTargets() {
  const self = host(COORDINATOR_PUBLIC_URL);
  const urls = new Map<string, string>();
  for (const p of mesh.listPeers()) {
    if (p.peerId === identity.peerId || !p.coordinatorUrl || !isApprovedCoordinator(p.peerId)) continue;
    urls.set(host(p.coordinatorUrl), p.coordinatorUrl.replace(/\/+$/, ""));
  }
  for (const u of COORDINATOR_BOOTSTRAP_URLS) urls.set(host(u), u.replace(/\/+$/, ""));
  urls.delete(self);
  return [...urls.entries()].map(([h, url]) => ({ url: `${url}/health/runtime`, label: h }));
}

export function coordinatorMonitors(): Monitor[] {
  const c = alertConfig;
  const portalHealth = c.portalHealthUrl ?? `${CC.PORTAL_PUBLIC_URL.replace(/\/+$/, "")}/health`;
  const monitors: Monitor[] = [
    healthWatchMonitor({ name: "peer_health", what: "coordinator", targets: peerTargets, failures: c.healthFailures, minDownMs: c.healthMinDownMs, observer: `coordinator ${label}` }),
    healthWatchMonitor({ name: "portal_health", what: "portal", targets: async () => [{ url: portalHealth, label: host(CC.PORTAL_PUBLIC_URL) }], failures: c.healthFailures, minDownMs: c.healthMinDownMs, observer: `coordinator ${label}` }),
    payoutMonitor({ queries: payoutQueries, failuresPerHour: c.payoutFailuresPerHour, pendingMaxMs: c.payoutPendingMs }),
    purchaseMonitor({ signals: purchaseSignals, failureRate: c.purchaseFailureRate, minAttempts: c.purchaseMinAttempts, label }),
    orderingChainMonitor({ verify: () => verifyOrderingChain(ordering.snapshot(), coordinatorKeys.publicKeyPem), label }),
    securityMonitor
  ];
  if (ECONOMY_PAYMENTS_ENABLED && lightningProvider.getNodeHealth) {
    monitors.push(lightningMonitor({ getHealth: () => lightningProvider.getNodeHealth!(), failures: c.healthFailures, minOutboundSats: c.lnMinOutboundSats, label }));
    monitors.push(
      lightningInboundMonitor({
        getHealth: () => lightningProvider.getNodeHealth!(),
        thresholdSats: c.lnMinInboundSats,
        hysteresisSats: c.lnInboundHysteresisSats,
        intervalMs: c.lnInboundCheckMs,
        renotifyMs: c.lnInboundRenotifyMs,
        isActive: async (key) => (await coordinatorAlerts.store.get(SHARED_SOURCE, key))?.status === "active",
        label
      })
    );
  }
  if (pool) {
    monitors.push(ledgerMonitor({ latest: latestLedgerVerifications }));
    monitors.push(databaseMonitor({ errorCount: pgPoolErrorCount, probe: async () => void (await pool.query("SELECT 1")), errorsPer10Min: c.dbErrorsPer10Min, failures: c.healthFailures, label }));
  }
  return monitors;
}

let runner: AlertRunner | null = null;

/** Called once the coordinator is up (coordinator.ts, src/index.ts). ALERT_ENABLED=false keeps it off. */
export function startCoordinatorAlerting(): void {
  if (!alertConfig.enabled || runner) return;
  runner = new AlertRunner(coordinatorAlerts, coordinatorMonitors(), { intervalMs: alertConfig.checkIntervalMs, log });
  runner.start();
  app.log.info({ channels: coordinatorAlerts.channels, intervalMs: alertConfig.checkIntervalMs }, "alerting_started");
  if (!coordinatorAlerts.channels.length) app.log.warn({}, "alerting_no_channels: set ALERT_EMAILS (with RESEND_API_KEY, RESEND_FROM_EMAIL) or ALERT_WEBHOOK_URL");
}

export function stopCoordinatorAlerting(): void {
  runner?.stop();
  runner = null;
}
