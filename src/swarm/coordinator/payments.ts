// Copyright (c) 2025 EdgeCoder, LLC
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
import { createPaymentSettler, reconcilePaymentIntent } from "../../economy/payment-settlement.js";
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
import { payoutStore, lightningProvider } from "./payouts.js";

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
const PAYMENT_INTENT_EXPIRY_GRACE_MS = CC.PAYMENT_INTENT_EXPIRY_GRACE_MS;

/** #42 review: always ask the node first; expire only an unpaid intent past TTL + grace. */
export function reconcileIntent(intent: PaymentIntent): Promise<"settled" | "expired" | "pending"> {
  return reconcilePaymentIntent(intent, settleIfPaid, expireIntentIfStale);
}

async function expireIntentIfStale(intent: PaymentIntent): Promise<boolean> {
  if (Date.now() - intent.createdAtMs <= PAYMENT_INTENT_TTL_MS + PAYMENT_INTENT_EXPIRY_GRACE_MS) return false;
  const expired: PaymentIntent = { ...intent, status: "expired" };
  paymentIntents.set(expired.intentId, expired);
  await pgStore?.upsertPaymentIntent(expired);
  return true;
}

/** Unpaid, unexpired invoices one account may hold (an invoice flood starves the reconcile loop). */
export const MAX_OPEN_INTENTS_PER_ACCOUNT = 5;
export function openIntentCount(accountId: string, nowMs = Date.now()): number {
  let n = 0;
  for (const intent of paymentIntents.values()) {
    if (intent.accountId === accountId && intent.status === "created" && nowMs - intent.createdAtMs <= PAYMENT_INTENT_TTL_MS) n += 1;
  }
  return n;
}

/** A Lightning invoice that buys cSats for an account: 1 cSat per sat, after the coordinator fee. */
export async function createPaymentIntent(accountId: string, amountSats: number, walletType: WalletType = "lightning"): Promise<PaymentIntent> {
  const { feeSats, netSats } = computeIntentFee(amountSats, COORDINATOR_FEE_BPS);
  const invoice = await lightningProvider.createInvoice({
    amountSats,
    memo: `edgecoder_credits:${accountId}`,
    expiresInSeconds: Math.floor(PAYMENT_INTENT_TTL_MS / 1000)
  });
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
