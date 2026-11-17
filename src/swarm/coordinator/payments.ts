// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Payment intents: creation, settlement, expiry and payout allocation.
 */
import { randomUUID } from "node:crypto";
import { computeIntentFee } from "../coordinator-utils.js";
import type {
  CoordinatorFeeEvent,
  IssuancePayoutEvent,
  PaymentIntent,
  WalletType,
  CreditTransaction
} from "../../common/types.js";
import { NETWORK_FEE_POOL_ACCOUNT, grantCredits } from "../../credits/store.js";
import { pgStore } from "../../db/store.js";
import { createPaymentSettler, mayExpireIntent, reconcilePaymentIntent } from "../../economy/payment-settlement.js";
import type { SettlementResult } from "../../economy/lightning.js";
import { app } from "./app.js";
import {
  ISSUANCE_RECALC_MS,
  ISSUANCE_COORDINATOR_SHARE,
  ISSUANCE_RESERVE_SHARE,
  COORDINATOR_FEE_ACCOUNT,
  identity,
  CC,
  PAYMENT_INTENT_TTL_MS,
  COORDINATOR_FEE_BPS,
  BITCOIN_NETWORK
} from "./context.js";
import { paymentIntents } from "./economy.js";
import { payoutStore, lightningProvider, launchConfig } from "./payouts.js";
import { checkLaunchBuy, launchBuyUsage, LAUNCH_WINDOW_MS, type LaunchBuyViolation } from "../../economy/launch-gate.js";
import { creditEngine } from "../../credits/store.js";
import { PurchaseSignals } from "../../alerting/monitors.js";

async function allocateIntentPayouts(intent: PaymentIntent): Promise<IssuancePayoutEvent[]> {
  if (!pgStore) return [];
  const store = pgStore;
  const epoch = await store.latestIssuanceEpoch(true, ISSUANCE_RECALC_MS);
  if (!epoch) return [];
  const allocations = await store.listIssuanceAllocations(epoch.issuanceEpochId);
  if (allocations.length === 0) return [];
  const coordinatorShare = Math.max(0, Math.min(0.5, ISSUANCE_COORDINATOR_SHARE));
  const reserveShare = Math.max(0, Math.min(0.5, ISSUANCE_RESERVE_SHARE));
  const contributorShare = Math.max(0, 1 - coordinatorShare - reserveShare);
  const contributorPool = intent.netSats * contributorShare;
  const payoutEvents: IssuancePayoutEvent[] = [];
  for (const allocation of allocations) {
    payoutEvents.push({
      payoutEventId: randomUUID(),
      issuanceEpochId: epoch.issuanceEpochId,
      accountId: allocation.accountId,
      payoutType: "contributor",
      tokens: Number((contributorPool * allocation.allocationShare).toFixed(6)),
      sourceIntentId: intent.intentId,
      createdAtMs: Date.now()
    });
  }
  payoutEvents.push({
    payoutEventId: randomUUID(),
    issuanceEpochId: epoch.issuanceEpochId,
    accountId: COORDINATOR_FEE_ACCOUNT,
    payoutType: "coordinator_service",
    tokens: Number((intent.netSats * coordinatorShare).toFixed(6)),
    sourceIntentId: intent.intentId,
    createdAtMs: Date.now()
  });
  payoutEvents.push({
    payoutEventId: randomUUID(),
    issuanceEpochId: epoch.issuanceEpochId,
    accountId: `reserve:${identity.peerId}`,
    payoutType: "reserve",
    tokens: Number((intent.netSats * reserveShare).toFixed(6)),
    sourceIntentId: intent.intentId,
    createdAtMs: Date.now()
  });
  await Promise.all(payoutEvents.map((event) => store.persistIssuancePayoutEvent(event)));
  return payoutEvents;
}

async function recordIntentSettlementSideEffects(settled: PaymentIntent): Promise<CoordinatorFeeEvent> {
  const feeEvent: CoordinatorFeeEvent = {
    eventId: randomUUID(),
    coordinatorId: identity.peerId,
    intentId: settled.intentId,
    feeWalletAccountId: COORDINATOR_FEE_ACCOUNT,
    feeSats: settled.coordinatorFeeSats,
    createdAtMs: Date.now()
  };
  await pgStore?.persistCoordinatorFeeEvent(feeEvent);
  // The coordinator fee on a purchase is network revenue: it goes to the fee pool as sats (no
  // compute credits attached) and reaches infrastructure hosts at the next distribution.
  if (settled.coordinatorFeeSats > 0) {
    const row: CreditTransaction = {
      txId: `purchase-fee:${settled.intentId}`,
      accountId: NETWORK_FEE_POOL_ACCOUNT,
      type: "earn",
      credits: 0,
      reason: `purchase_fee:${settled.intentId}`,
      timestampMs: Date.now(),
      msat: Math.round(settled.coordinatorFeeSats * 1000)
    };
    await payoutStore.recordCreditTransactions([row]);
  }
  await allocateIntentPayouts(settled);
  return feeEvent;
}

// #42: the only settlement path. Always asks the Lightning node; never trusts caller-supplied
// txRef/settled flags. Postgres mode uses an atomic CAS + credit insert; in-memory mode uses a
// per-intent mutex and a status check.
export const settleIfPaid = createPaymentSettler({
  provider: lightningProvider,
  store: pgStore,
  getIntent: (intentId) => paymentIntents.get(intentId),
  saveIntent: (intent) => {
    paymentIntents.set(intent.intentId, intent);
  },
  grantCredits: (accountId, credits, reason) => grantCredits(accountId, credits, reason),
  onSettled: async (intent) => {
    await recordIntentSettlementSideEffects(intent);
  }
});

// Grace on top of the TTL so a payment made just before expiry is still picked up.
export const PAYMENT_INTENT_EXPIRY_GRACE_MS = CC.PAYMENT_INTENT_EXPIRY_GRACE_MS;
/** An invoice the node still calls "open" this long after TTL + grace is expired too (the node refuses payment past expiry). */
const OPEN_INVOICE_EXPIRY_MARGIN_MS = 10 * 60_000;

/** #42 review: always ask the node first; expire only on the node's definitive unpaid state, past TTL + grace. */
export function reconcileIntent(intent: PaymentIntent): Promise<"settled" | "expired" | "pending"> {
  return reconcilePaymentIntent(intent, settleIfPaid, expireIntentIfStale);
}

async function expireIntentIfStale(intent: PaymentIntent, invoiceState: SettlementResult["invoiceState"]): Promise<boolean> {
  if (!mayExpireIntent(invoiceState, Date.now() - intent.createdAtMs, PAYMENT_INTENT_TTL_MS, PAYMENT_INTENT_EXPIRY_GRACE_MS, OPEN_INVOICE_EXPIRY_MARGIN_MS)) return false;
  const expired: PaymentIntent = { ...intent, status: "expired" };
  paymentIntents.set(expired.intentId, expired);
  await pgStore?.upsertPaymentIntent(expired);
  return true;
}

/** How far back late-settlement recovery re-checks intents marked expired. */
export const LATE_SETTLEMENT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** Late-settlement recovery cadence. */
export const LATE_SETTLEMENT_RECOVERY_INTERVAL_MS = 10 * 60_000;
const LATE_SETTLEMENT_PAGE = 200;
const LATE_SETTLEMENT_MAX_PER_RUN = 5_000;

/**
 * Late-settlement recovery (M4): intents marked expired in the last LATE_SETTLEMENT_LOOKBACK_MS are
 * asked about again; any the node reports paid are credited (expired -> settled, once per intent
 * and payment hash: the same atomic settle as every other path). Stops at the first failed lookup
 * (the node is down; the next run retries).
 */
export async function recoverLateSettlements(nowMs = Date.now()): Promise<{ scanned: number; recovered: number; stoppedOnError?: string }> {
  const sinceMs = nowMs - LATE_SETTLEMENT_LOOKBACK_MS;
  let scanned = 0;
  let recovered = 0;
  let after: { createdAtMs: number; intentId: string } | undefined;
  for (;;) {
    const page = pgStore
      ? await pgStore.listExpiredPaymentIntentsSince(sinceMs, LATE_SETTLEMENT_PAGE, after)
      : after ? [] : [...paymentIntents.values()].filter((i) => i.status === "expired" && i.createdAtMs >= sinceMs);
    if (page.length === 0) break;
    for (const intent of page) {
      scanned += 1;
      const outcome = await settleIfPaid(intent, { allowExpired: true });
      if (outcome.status === "unknown") return { scanned, recovered, stoppedOnError: outcome.error };
      if (outcome.status === "settled") {
        recovered += 1;
        app.log.warn({ intentId: intent.intentId, accountId: intent.accountId, amountSats: intent.amountSats, createdAtMs: intent.createdAtMs }, "payment_intent_late_settlement_recovered");
      }
      if (scanned >= LATE_SETTLEMENT_MAX_PER_RUN) return { scanned, recovered };
    }
    if (!pgStore || page.length < LATE_SETTLEMENT_PAGE) break;
    const last = page[page.length - 1]!;
    after = { createdAtMs: last.createdAtMs, intentId: last.intentId };
  }
  return { scanned, recovered };
}

/** Unpaid, unexpired invoices one account may hold (an invoice flood starves the reconcile loop). */
export const MAX_OPEN_INTENTS_PER_ACCOUNT = 5;
/** In-memory count (memory mode); openIntentCountFor reads the shared database when there is one. */
export function openIntentCount(accountId: string, nowMs = Date.now()): number {
  let n = 0;
  for (const intent of paymentIntents.values()) {
    if (intent.accountId === accountId && intent.status === "created" && nowMs - intent.createdAtMs <= PAYMENT_INTENT_TTL_MS + PAYMENT_INTENT_EXPIRY_GRACE_MS) n += 1;
  }
  return n;
}
/** Open invoices of one account across every coordinator sharing the database (both seeds). */
export async function openIntentCountFor(accountId: string, nowMs = Date.now()): Promise<number> {
  if (!pgStore) return openIntentCount(accountId, nowMs);
  const rows = await pgStore.listPaymentIntentsForAccountSince(accountId, nowMs - PAYMENT_INTENT_TTL_MS - PAYMENT_INTENT_EXPIRY_GRACE_MS);
  return rows.filter((i) => i.status === "created").length;
}

/** Invoice creation outcomes for production alerting (src/swarm/coordinator/alerts.ts, purchase failure rate). */
export const purchaseSignals = new PurchaseSignals();

/** A Lightning invoice that buys cSats for an account: 1 cSat per sat, after the coordinator fee. */
export async function createPaymentIntent(accountId: string, amountSats: number, walletType: WalletType = "lightning"): Promise<PaymentIntent> {
  const { feeSats, netSats } = computeIntentFee(amountSats, COORDINATOR_FEE_BPS);
  let invoice: Awaited<ReturnType<typeof lightningProvider.createInvoice>>;
  try {
    invoice = await lightningProvider.createInvoice({
      amountSats,
      memo: `edgecoder_credits:${accountId}`,
      expiresInSeconds: Math.floor(PAYMENT_INTENT_TTL_MS / 1000)
    });
  } catch (error) {
    purchaseSignals.note(false, Date.now(), error instanceof Error ? error.message : String(error));
    throw error;
  }
  purchaseSignals.note(true);
  const intent: PaymentIntent = {
    intentId: randomUUID(),
    accountId,
    coordinatorId: identity.peerId,
    walletType,
    network: BITCOIN_NETWORK,
    invoiceRef: invoice.invoiceRef,
    paymentHash: invoice.paymentHash,
    amountSats,
    coordinatorFeeBps: COORDINATOR_FEE_BPS,
    coordinatorFeeSats: feeSats,
    netSats,
    // 1 cSat = 1 sat of prepaid compute: the net sats, after the coordinator fee.
    quotedCredits: netSats,
    status: "created",
    createdAtMs: Date.now()
  };
  paymentIntents.set(intent.intentId, intent);
  await pgStore?.upsertPaymentIntent(intent);
  return intent;
}

/** Paid and payable purchases of one account in the soft-launch window (Postgres when shared, else memory). */
export async function launchUsageFor(accountId: string, nowMs = Date.now()): Promise<{ boughtWindowSats: number; openCreditsSats: number }> {
  const rows = pgStore ? await pgStore.listPaymentIntentsForAccountSince(accountId, nowMs - LAUNCH_WINDOW_MS) : paymentIntents.values();
  // An invoice can still be paid (and credited) until TTL + grace: it counts against the cap until then.
  return launchBuyUsage(rows, accountId, nowMs, PAYMENT_INTENT_TTL_MS + PAYMENT_INTENT_EXPIRY_GRACE_MS);
}

// One purchase check-and-create at a time per account: across every coordinator on the shared
// database (a Postgres advisory lock), and in this process when there is none.
const launchBuyLocks = new Map<string, Promise<unknown>>();

/**
 * A purchase under the soft-launch caps (LAUNCH_MODE=invite; src/economy/launch-gate.ts): the
 * invoice, or the cap it would break. Open mode creates the invoice directly.
 */
export async function createPaymentIntentWithinLaunchCaps(accountId: string, amountSats: number): Promise<{ intent: PaymentIntent } | { violation: LaunchBuyViolation }> {
  if (launchConfig.mode !== "invite") return { intent: await createPaymentIntent(accountId, amountSats) };
  const checkAndCreate = async (): Promise<{ intent: PaymentIntent } | { violation: LaunchBuyViolation }> => {
    const usage = await launchUsageFor(accountId);
    const balanceSats = pgStore ? await pgStore.creditBalance(accountId) : creditEngine.balance(accountId);
    const { netSats } = computeIntentFee(amountSats, COORDINATOR_FEE_BPS);
    const violation = checkLaunchBuy({ amountSats, newCreditsSats: netSats, balanceSats, ...usage }, launchConfig);
    if (violation) return { violation };
    return { intent: await createPaymentIntent(accountId, amountSats) };
  };
  const previous = launchBuyLocks.get(accountId) ?? Promise.resolve();
  const store = pgStore;
  const run = previous.catch(() => undefined).then(() => (store ? store.withAccountPurchaseLock(accountId, checkAndCreate) : checkAndCreate()));
  launchBuyLocks.set(accountId, run);
  try {
    return await run;
  } finally {
    if (launchBuyLocks.get(accountId) === run) launchBuyLocks.delete(accountId);
  }
}
