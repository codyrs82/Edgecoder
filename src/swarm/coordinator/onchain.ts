// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * On-chain Bitcoin for this coordinator (ONCHAIN_ENABLED): the LND on-chain wallet, the deposit
 * watcher and the batched payout runner. Off unless ONCHAIN_ENABLED is set; LND only (Core
 * Lightning's REST has no equivalent wired here).
 */
import type { CreditTransaction } from "../../common/types.js";
import type { SecurityEventType } from "../../audit/security-events.js";
import { NETWORK_FEE_POOL_ACCOUNT, grantCredits } from "../../credits/store.js";
import { pgStore } from "../../db/store.js";
import { PostgresOnchainDepositStore, PostgresOnchainPayoutStore } from "../../db/onchain-store.js";
import { lndDispatcher } from "../../economy/lightning.js";
import { LndOnchainWallet, MockOnchainWallet, onchainConfigFromEnv, type OnchainConfig, type OnchainWallet } from "../../economy/onchain.js";
import { DepositWatcher, MemoryOnchainDepositStore, type OnchainDepositStore } from "../../economy/onchain-deposits.js";
import { MemoryOnchainPayoutStore, OnchainPayoutService, type OnchainPayoutStore } from "../../economy/onchain-payouts.js";
import type { OnchainReconcileLedger } from "../../economy/payout-reconcile.js";
import { app } from "./app.js";
import { BITCOIN_NETWORK, CC, COORDINATOR_FEE_BPS, identity, securityLog } from "./context.js";
import { ordering } from "./agent-state.js";
import { paymentIntents } from "./economy.js";
import { launchUsageFor } from "./payments.js";
import { checkLaunchBuy } from "../../economy/launch-gate.js";
import { creditEngine } from "../../credits/store.js";
import { ECONOMY_PAYMENTS_ENABLED, launchConfig, memoryPayoutStore, payoutLimits, payoutPause, payoutPolicy, payoutReconciler, payoutService, payoutStore } from "./payouts.js";

function resolveConfig(): { config: OnchainConfig; wallet: OnchainWallet | null; disabledReason?: string } {
  const config = onchainConfigFromEnv(BITCOIN_NETWORK);
  if (!config.enabled) return { config, wallet: null };
  const provider = (CC.LIGHTNING_PROVIDER ?? (process.env.NODE_ENV === "production" ? "" : "mock")).toLowerCase();
  const off = (reason: string) => {
    app.log.warn({ reason }, "onchain_disabled");
    return { config: { ...config, enabled: false }, wallet: null, disabledReason: reason };
  };
  if (!ECONOMY_PAYMENTS_ENABLED) return off("economy_payments_disabled");
  if (provider === "lnd") {
    if (!CC.LND_REST_URL || !CC.LND_MACAROON_HEX) return off("lnd_provider_missing_env");
    return { config, wallet: new LndOnchainWallet(CC.LND_REST_URL, CC.LND_MACAROON_HEX, lndDispatcher(CC.LND_TLS_CERT_BASE64)) };
  }
  if (provider === "mock") return { config, wallet: new MockOnchainWallet(BITCOIN_NETWORK) };
  return off(`unsupported_provider:${provider || "none"}`);
}

const resolved = resolveConfig();
export const onchainConfig: OnchainConfig = resolved.config;
export const ONCHAIN_ENABLED = onchainConfig.enabled;
const baseWallet = resolved.wallet;
/** The simulated wallet when LIGHTNING_PROVIDER=mock (dev and tests drive deposits and blocks through it). */
export const onchainMockWallet: MockOnchainWallet | null = baseWallet instanceof MockOnchainWallet ? baseWallet : null;

// Defense in depth: nothing is broadcast while payouts are paused, whatever the caller checked.
export const onchainWallet: OnchainWallet | null = baseWallet
  ? {
      newAddress: (t) => baseWallet.newAddress(t),
      listTransactions: (i) => baseWallet.listTransactions(i),
      estimateFeeRate: (c) => baseWallet.estimateFeeRate(c),
      async sendMany(input) {
        if (await payoutPause.isPaused()) throw new Error("onchain_paused");
        return baseWallet.sendMany(input);
      }
    }
  : null;

export const onchainDepositStore: OnchainDepositStore = pgStore
  ? pgStore.withPool((pool) => new PostgresOnchainDepositStore(pool))
  : new MemoryOnchainDepositStore(async (accountId, credit, amountSats) => {
      // In memory: the settled intent and the credit, as the Postgres store writes them in one transaction.
      paymentIntents.set(credit.intentId, {
        intentId: credit.intentId,
        accountId,
        coordinatorId: credit.coordinatorId,
        walletType: "onchain",
        network: credit.network,
        invoiceRef: credit.intentId,
        amountSats,
        coordinatorFeeBps: credit.feeBps,
        coordinatorFeeSats: credit.feeSats,
        netSats: credit.netSats,
        quotedCredits: credit.netSats,
        status: "settled",
        createdAtMs: credit.nowMs,
        settledAtMs: credit.nowMs,
        txRef: credit.intentId
      });
      if (memoryPayoutStore) memoryPayoutStore.received += amountSats * 1000;
      await grantCredits(accountId, credit.netSats, `credit_purchase:${credit.intentId}`);
    });

export const onchainPayoutStore: OnchainPayoutStore = pgStore
  ? pgStore.withPool((pool) => new PostgresOnchainPayoutStore(pool))
  : new MemoryOnchainPayoutStore(memoryPayoutStore!);

const securityEvent = (event: SecurityEventType, details: Record<string, unknown>, action: string) =>
  securityLog.log({
    level: securityLog.severity(event),
    event,
    source: { type: "system", id: String(details.accountId ?? "onchain") },
    details,
    action,
    coordinatorId: identity.peerId
  });

export const depositWatcher: DepositWatcher | null = onchainWallet
  ? new DepositWatcher({
      store: onchainDepositStore,
      wallet: onchainWallet,
      config: onchainConfig,
      coordinatorId: identity.peerId,
      purchaseFeeBps: COORDINATOR_FEE_BPS,
      log: app.log,
      onSecurityEvent: (event, details) => securityEvent(event, details, event === "onchain_deposit_reversed" ? "review_reversed_deposit" : "hold_deposit_for_review"),
      // Soft launch (LAUNCH_MODE=invite): a deposit counts like a purchase toward the daily buy cap
      // and the balance cap; one that would break either is held for an operator.
      launchHold: async (deposit, netSats) => {
        if (launchConfig.mode !== "invite") return null;
        const usage = await launchUsageFor(deposit.accountId);
        const balanceSats = pgStore ? await pgStore.creditBalance(deposit.accountId) : creditEngine.balance(deposit.accountId);
        const v = checkLaunchBuy({ amountSats: deposit.amountSats, newCreditsSats: netSats, balanceSats, ...usage }, launchConfig);
        return v ? `early access: ${v.error === "launch_buy_daily_cap" ? `above the ${v.limitSats} sat daily purchase limit` : `above the ${v.limitSats} cSat balance limit`}` : null;
      },
      onCredited: async (deposit, credit) => {
        // A purchase fee (COORDINATOR_FEE_BPS, 0 by default) is network revenue, as for Lightning.
        if (credit.feeSats <= 0) return;
        const row: CreditTransaction = {
          txId: `purchase-fee:${credit.intentId}`,
          accountId: NETWORK_FEE_POOL_ACCOUNT,
          type: "earn",
          credits: 0,
          reason: `purchase_fee:${credit.intentId}`,
          timestampMs: credit.nowMs,
          msat: credit.feeSats * 1000
        };
        await payoutStore.recordCreditTransactions([row]);
        app.log.info({ accountId: deposit.accountId, feeSats: credit.feeSats }, "onchain_deposit_purchase_fee");
      }
    })
  : null;

export const onchainPayouts: OnchainPayoutService | null = onchainWallet
  ? new OnchainPayoutService({
      store: onchainPayoutStore,
      payouts: payoutStore,
      payoutService,
      wallet: onchainWallet,
      config: onchainConfig,
      policy: payoutPolicy,
      limits: payoutLimits,
      pause: payoutPause,
      coordinatorId: identity.peerId,
      feePoolAccountId: NETWORK_FEE_POOL_ACCOUNT,
      heightHint: () => onchainDepositStore.getScanHeight(),
      log: app.log,
      pausePayouts: async (reason) => {
        await payoutPause.pause(reason, "reconciliation", identity.peerId);
      },
      onSecurityEvent: (event, details) => securityEvent(event, details, event === "onchain_batch_resurfaced" ? "pause_payouts" : event === "payout_limit_exceeded" ? "reject_payout" : "alert"),
      onPaid: async (p) => {
        ordering.append({
          eventType: "payout_settled",
          taskId: p.payoutId,
          subtaskId: p.txid ?? p.paymentHash,
          actorId: p.accountId,
          coordinatorId: identity.peerId,
          payloadJson: JSON.stringify({ payoutId: p.payoutId, accountId: p.accountId, kind: p.kind, amountMsat: p.amountMsat, feeMsat: p.feeMsat, txid: p.txid, batchId: p.batchId, destination: p.destination, settledAtMs: p.settledAtMs })
        });
      }
    })
  : null;

/** Reconciliation inputs; undefined when on-chain is off (the Lightning-only checks are unchanged). */
export const onchainReconcileLedger: OnchainReconcileLedger | undefined =
  depositWatcher && onchainPayouts
    ? {
        uncreditedDepositMsat: async () => (await onchainDepositStore.uncreditedDepositSats()) * 1000,
        feeOutflowMsat: () => onchainPayoutStore.edgecoderFeeOutflowMsat(),
        inFlight: () => onchainPayouts.inFlight(),
        beforeRun: () => depositWatcher.tick()
      }
    : undefined;
if (onchainReconcileLedger) payoutReconciler.attachOnchain(onchainReconcileLedger);

/** Timers: the watcher every ONCHAIN_POLL_MS, the batch runner on the same tick (it builds a batch only when due). */
export function startOnchainTimers(): void {
  if (!depositWatcher || !onchainPayouts) return;
  app.log.info({ network: onchainConfig.network, confirmations: onchainConfig.depositConfirmations, payoutIntervalMs: onchainConfig.payoutIntervalMs, feePayer: onchainConfig.payoutFeePayer }, "onchain_enabled");
  const tick = () => {
    void depositWatcher.tick().catch((error) => app.log.warn({ error: String(error) }, "onchain_deposit_watch_failed"));
    if (payoutPolicy.enabled) void onchainPayouts.tick().catch((error) => app.log.warn({ error: String(error) }, "onchain_batch_failed"));
  };
  tick();
  setInterval(tick, onchainConfig.pollMs).unref?.();
}
