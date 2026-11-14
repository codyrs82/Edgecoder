// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Lightning provider, payout store and service, infrastructure host settings and the
 * payout reconciler.
 */
import { randomUUID } from "node:crypto";
import { request } from "undici";
import { NETWORK_FEE_POOL_ACCOUNT, creditEngine } from "../../credits/store.js";
import {
  MemoryPayoutStore,
  PayoutService,
  type FeePoolDistribution,
  type PayoutStore
} from "../../economy/payout-service.js";
import { PayoutPauseControl, payoutLimitsFromEnv, payoutsPausedByEnv } from "../../economy/payout-safeguards.js";
import { PayoutReconciler, payoutReconcileConfigFromEnv } from "../../economy/payout-reconcile.js";
import { earningsHoldFromEnv, payoutPolicyFromEnv } from "../../economy/payouts.js";
import { MemoryCallbackPinStore, type CallbackPinStore } from "../../economy/lnurl-callback-pin.js";
import { fetchPublicJson } from "../../security/public-fetch.js";
import { pgStore } from "../../db/store.js";
import { HostServiceAttestor, networkServiceProbes } from "../../economy/host-attestation.js";
import {
  createLightningProviderFromEnv,
  economyPaymentsEnabled,
  type LightningProvider
} from "../../economy/lightning.js";
import { app } from "./app.js";
import {
  BITCOIN_NETWORK,
  securityLog,
  identity,
  PORTAL_SERVICE_URL,
  PORTAL_OUTBOUND_TOKEN,
  CC,
  COORDINATOR_FEE_ACCOUNT
} from "./context.js";
import { mutable } from "./mutable-state.js";
import { ordering } from "./agent-state.js";

// ECONOMY_PAYMENTS_ENABLED=false lets a coordinator boot (including in production)
// without a Lightning node: payment routes return 503 and no provider is created.
export const ECONOMY_PAYMENTS_ENABLED = economyPaymentsEnabled();
const disabledLightningProvider: LightningProvider = {
  async createInvoice() {
    throw new Error("economy_payments_disabled");
  },
  async checkSettlement() {
    return { settled: false };
  },
  async payInvoice() {
    return { status: "failed" as const, error: "economy_payments_disabled" };
  },
  async getBalances() {
    return { supported: false as const, reason: "economy_payments_disabled" };
  },
  async listPayments() {
    return { supported: false as const, reason: "economy_payments_disabled" };
  }
};
export const lightningProvider: LightningProvider = ECONOMY_PAYMENTS_ENABLED
  ? createLightningProviderFromEnv()
  : disabledLightningProvider;

// ── Payouts and the network fee pool (docs/economy-math.md "Payouts") ──
// Earned sats leave the ledger only through PayoutService: a withdrawal pays a BOLT11 invoice from
// the coordinator's Lightning node, auto payouts pay Lightning addresses, and the fee pool (network
// fee on every accrual + the coordinator fee on every purchase) is distributed to infrastructure
// hosts by uptime. In-memory mode (no Postgres) keeps the same semantics without durability.
export const payoutPolicy = payoutPolicyFromEnv(BITCOIN_NETWORK);
{
  // Earnings become withdrawable only after this hold (24 h on mainnet by default, 0 elsewhere).
  const earningsHold = earningsHoldFromEnv(BITCOIN_NETWORK);
  if (earningsHold.warning) app.log.warn({ holdMs: earningsHold.holdMs, warning: earningsHold.warning }, "payout_earnings_hold");
}
class EnginePayoutStore extends MemoryPayoutStore {
  constructor() {
    super((accountId, cutoff) => creditEngine.earnedMsat(accountId, cutoff));
  }
  override async creditBalance(accountId: string): Promise<number> {
    return creditEngine.balance(accountId) + (await super.creditBalance(accountId));
  }
  /** Engine-held earnings can't be totalled across accounts, so the liability check is skipped in memory mode. */
  override async liabilitiesMsat(): Promise<number | undefined> {
    return undefined;
  }
}
export const memoryPayoutStore = pgStore ? null : new EnginePayoutStore();
export const payoutStore: PayoutStore = pgStore ?? (memoryPayoutStore as PayoutStore);

// Hot-wallet safeguards (docs/going-to-mainnet.md): caps, the kill switch and reconciliation.
export const payoutLimits = payoutLimitsFromEnv(BITCOIN_NETWORK);
export const payoutPause = new PayoutPauseControl({
  store: payoutStore,
  envPaused: payoutsPausedByEnv(),
  onChange: (state, previous) => {
    securityLog.log({
      level: securityLog.severity(state.paused ? "payouts_paused" : "payouts_resumed"),
      event: state.paused ? "payouts_paused" : "payouts_resumed",
      source: { type: state.source === "reconciliation" ? "system" : "coordinator", id: state.changedBy ?? identity.peerId },
      details: { reason: state.reason, source: state.source, wasPaused: previous.paused },
      action: state.paused ? "halt_outbound_payments" : "resume_outbound_payments",
      coordinatorId: identity.peerId
    });
    ordering.append({
      eventType: "payouts_pause_changed",
      taskId: `payouts_pause:${state.changedAtMs ?? Date.now()}`,
      actorId: state.changedBy ?? identity.peerId,
      coordinatorId: identity.peerId,
      payloadJson: JSON.stringify({ paused: state.paused, reason: state.reason, source: state.source, changedAtMs: state.changedAtMs })
    });
  }
});
// Defense in depth: even a caller that skipped PayoutService's checks cannot pay while paused.
const payoutProvider: LightningProvider = {
  createInvoice: (input) => lightningProvider.createInvoice(input),
  checkSettlement: (ref, hash) => lightningProvider.checkSettlement(ref, hash),
  async payInvoice(input) {
    if (await payoutPause.isPaused()) return { status: "failed", error: "payouts_paused" };
    return lightningProvider.payInvoice(input);
  },
  getBalances: lightningProvider.getBalances ? () => lightningProvider.getBalances!() : undefined,
  listPayments: lightningProvider.listPayments ? (input) => lightningProvider.listPayments!(input) : undefined
};
// LNURL callback pins (src/economy/lnurl-callback-pin.ts). A changed callback host holds the
// account's auto payouts and tells the portal once, which emails the owner (/internal/payouts/callback-changed).
export const callbackPins: CallbackPinStore = pgStore ? pgStore.callbackPinStore() : new MemoryCallbackPinStore();
async function notifyPortalCallbackChanged(info: { accountId: string; destination: string; previousOrigin: string; newOrigin: string }): Promise<boolean> {
  if (!PORTAL_SERVICE_URL) return false;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (PORTAL_OUTBOUND_TOKEN) headers["x-portal-service-token"] = PORTAL_OUTBOUND_TOKEN;
  const res = await request(`${PORTAL_SERVICE_URL.replace(/\/+$/, "")}/internal/payouts/callback-changed`, {
    method: "POST",
    headers,
    headersTimeout: 5_000,
    bodyTimeout: 5_000,
    body: JSON.stringify(info)
  });
  await res.body.dump();
  return res.statusCode >= 200 && res.statusCode < 300;
}
export const payoutService = new PayoutService({
  store: payoutStore,
  pins: callbackPins,
  onCallbackChanged: notifyPortalCallbackChanged,
  provider: payoutProvider,
  policy: payoutPolicy,
  limits: payoutLimits,
  pause: payoutPause,
  onSecurityEvent: (event, details) => {
    securityLog.log({
      level: securityLog.severity(event),
      event,
      source: { type: "system", id: String(details.accountId ?? "payouts") },
      details,
      action: "reject_payout",
      coordinatorId: identity.peerId
    });
  },
  coordinatorId: identity.peerId,
  feePoolAccountId: NETWORK_FEE_POOL_ACCOUNT,
  // LNURL hosts are user-chosen: public https only, checked again at connect, no redirects.
  fetcher: (url: string) => fetchPublicJson(url, { timeoutMs: 10_000 }),
  log: app.log,
  onPaid: async (p) => {
    ordering.append({
      eventType: "payout_settled",
      taskId: p.payoutId,
      subtaskId: p.paymentHash,
      actorId: p.accountId,
      coordinatorId: identity.peerId,
      payloadJson: JSON.stringify({ payoutId: p.payoutId, accountId: p.accountId, kind: p.kind, amountMsat: p.amountMsat, feeMsat: p.feeMsat, paymentHash: p.paymentHash, destination: p.destination, settledAtMs: p.settledAtMs })
    });
  },
  onDistributed: async (rows, hosts) => {
    mutable.lastFeePoolDistribution = { atMs: Date.now(), distributedMsat: hosts.reduce((a, h) => a + h.msat, 0), hosts: hosts.length };
    ordering.append({
      eventType: "fee_pool_distribution",
      taskId: rows[0]?.txId ?? randomUUID(),
      subtaskId: "",
      actorId: NETWORK_FEE_POOL_ACCOUNT,
      coordinatorId: identity.peerId,
      payloadJson: JSON.stringify({ hosts, totalMsat: hosts.reduce((a, h) => a + h.msat, 0) })
    });
  }
});

export const INFRA_HOST_ENABLED = CC.INFRA_HOST_ENABLED;
export const INFRA_HOST_SERVICES: string[] = (CC.INFRA_HOST_SERVICES ?? "")
  .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
if (INFRA_HOST_SERVICES.length === 0) {
  INFRA_HOST_SERVICES.push("coordinator");
  if (process.env.BITCOIN_ANCHOR_PROVIDER === "bitcoind") INFRA_HOST_SERVICES.push("bitcoind");
  if (["lnd", "cln"].includes((CC.LIGHTNING_PROVIDER ?? "").toLowerCase())) INFRA_HOST_SERVICES.push("lightning");
}
/** Systems accounts a host record may never name as its payee. */
export const RESERVED_HOST_ACCOUNTS = [NETWORK_FEE_POOL_ACCOUNT, COORDINATOR_FEE_ACCOUNT];
// Remote hosts: probes run against the host of the URL the mesh admitted (service-probes.ts).
// HOST_ATTEST_ALLOW_PRIVATE=1 lets local test networks probe private addresses.
export const hostAttestor = new HostServiceAttestor({
  network: BITCOIN_NETWORK,
  probes: networkServiceProbes({ allowPrivate: CC.HOST_ATTEST_ALLOW_PRIVATE })
});

/** Other coordinators whose fee pool this host also reports to (signed POST /economy/hosts/heartbeat). */
export const INFRA_HOST_REPORT_URLS = (CC.INFRA_HOST_REPORT_URLS ?? "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);

let feePoolDistributing: Promise<FeePoolDistribution> | null = null;
export async function runFeePoolDistribution(opts: { manual?: boolean } = {}): Promise<FeePoolDistribution> {
  // Single-flight: concurrent callers (a flooded endpoint, overlapping timers) share one run so
  // the pool is not distributed twice for the same window (audit econ#3). Across instances sharing
  // one database, distributeFeePool holds a Postgres advisory lock (a second coordinator skips with
  // "locked"), and the timer skips a window another instance already distributed ("recent", at
  // 90% of FEE_POOL_DISTRIBUTION_MS). The admin route is a manual override of the latter only.
  if (feePoolDistributing) return feePoolDistributing;
  const expectedHeartbeats = Math.max(1, Math.floor(CC.FEE_POOL_DISTRIBUTION_MS / CC.HOST_HEARTBEAT_MS));
  const minIntervalMs = opts.manual ? 0 : Math.floor(CC.FEE_POOL_DISTRIBUTION_MS * 0.9);
  feePoolDistributing = payoutService.distributeFeePool(expectedHeartbeats, { minIntervalMs }).finally(() => { feePoolDistributing = null; });
  return feePoolDistributing;
}
export const payoutReconcileConfig = payoutReconcileConfigFromEnv();
export const payoutReconciler = new PayoutReconciler({
  provider: lightningProvider,
  ledger: payoutStore,
  config: payoutReconcileConfig,
  coordinatorId: identity.peerId,
  webhookUrl: CC.PAYOUT_ALERT_WEBHOOK_URL,
  log: app.log,
  pause: async (reason) => {
    await payoutPause.pause(reason, "reconciliation", identity.peerId);
  },
  onAlert: (r) => {
    const event = r.status === "error" ? "payout_reconciliation_error" : "payout_reconciliation_mismatch";
    securityLog.log({
      level: securityLog.severity(event),
      event,
      source: { type: "system", id: "payout_reconciler" },
      details: { status: r.status, failed: r.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail, msat: c.msat })), error: r.error },
      action: r.status === "tripped" ? "pause_payouts" : "alert",
      coordinatorId: identity.peerId
    });
  }
});
