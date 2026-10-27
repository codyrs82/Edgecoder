// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentIntent } from "../common/types.js";
import type { LightningProvider } from "./lightning.js";

/**
 * Single settlement path for payment intents (#42).
 *
 * Credits are only ever granted after the Lightning node itself reports the
 * invoice as settled. Callers (webhook, reconcile, background poller, admin
 * confirm) never supply proof of payment: they only hint that an intent should
 * be re-checked.
 */
export type SettleOutcome =
  | { status: "unpaid" }
  | { status: "settled"; intent: PaymentIntent }
  | { status: "already"; intent?: PaymentIntent };

export interface AtomicSettleStore {
  /**
   * Status CAS (created -> settled) plus the `credit_purchase:<intentId>` credit
   * insert, in one transaction. Returns "already" if the intent was not in
   * status "created" (already settled, expired, ...).
   */
  settlePaymentIntentAtomic(
    intentId: string,
    txRef: string,
    accountId: string,
    credits: number,
    paymentHash?: string
  ): Promise<{ status: "settled" | "already"; intent?: PaymentIntent }>;
}

export interface PaymentSettlerOptions {
  provider: LightningProvider;
  /** Durable atomic store (Postgres). When absent, in-memory settlement is used. */
  store?: AtomicSettleStore | null;
  /** Current in-memory view of an intent (used for the in-memory CAS). */
  getIntent: (intentId: string) => PaymentIntent | undefined;
  /** Persist the in-memory intent after a state change. */
  saveIntent: (intent: PaymentIntent) => void | Promise<void>;
  /** Grant credits (in-memory mode only; the atomic store inserts its own credit row). */
  grantCredits: (accountId: string, credits: number, reason: string) => Promise<unknown>;
  /** Side effects that must run exactly once per settled intent (fee events, payouts). */
  onSettled?: (intent: PaymentIntent) => Promise<void>;
}

export function createPaymentSettler(opts: PaymentSettlerOptions) {
  // Per-intent mutex: concurrent callers for the same intent share one in-flight settle.
  const inflight = new Map<string, Promise<SettleOutcome>>();

  async function settleInMemory(intent: PaymentIntent, txRef: string, paymentHash?: string): Promise<SettleOutcome> {
    const current = opts.getIntent(intent.intentId) ?? intent;
    if (current.status !== "created") return { status: "already", intent: current };
    const settled: PaymentIntent = {
      ...current,
      status: "settled",
      settledAtMs: Date.now(),
      txRef,
      paymentHash: current.paymentHash ?? paymentHash
    };
    // Mark settled before granting so a re-entrant call can never double credit.
    await opts.saveIntent(settled);
    await opts.grantCredits(settled.accountId, settled.quotedCredits, `credit_purchase:${settled.intentId}`);
    return { status: "settled", intent: settled };
  }

  async function run(intent: PaymentIntent): Promise<SettleOutcome> {
    const known = opts.getIntent(intent.intentId);
    if (!opts.store && known && known.status !== "created") return { status: "already", intent: known };
    if (intent.status !== "created" && !opts.store) return { status: "already", intent };

    const s = await opts.provider
      .checkSettlement(intent.invoiceRef, intent.paymentHash ?? opts.getIntent(intent.intentId)?.paymentHash)
      .catch(() => ({ settled: false }) as const);
    if (!s.settled) return { status: "unpaid" };
    const txRef = ("txRef" in s && s.txRef) || intent.invoiceRef;
    const paymentHash = "paymentHash" in s ? s.paymentHash : undefined;

    let outcome: SettleOutcome;
    if (opts.store) {
      const res = await opts.store.settlePaymentIntentAtomic(
        intent.intentId,
        txRef,
        intent.accountId,
        intent.quotedCredits,
        paymentHash
      );
      if (res.status === "already") {
        // refresh the in-memory copy so later hints don't keep asking the node
        if (res.intent) await opts.saveIntent(res.intent);
        return { status: "already", intent: res.intent };
      }
      const settled: PaymentIntent = res.intent ?? {
        ...intent,
        status: "settled",
        settledAtMs: Date.now(),
        txRef,
        paymentHash: intent.paymentHash ?? paymentHash
      };
      await opts.saveIntent(settled);
      outcome = { status: "settled", intent: settled };
    } else {
      outcome = await settleInMemory(intent, txRef, paymentHash);
    }
    if (outcome.status === "settled" && opts.onSettled) await opts.onSettled(outcome.intent);
    return outcome;
  }

  return async function settleIfPaid(intent: PaymentIntent): Promise<SettleOutcome> {
    const existing = inflight.get(intent.intentId);
    if (existing) {
      const out = await existing;
      // Only the first caller observes "settled"; joiners see "already".
      return out.status === "settled" ? { status: "already", intent: out.intent } : out;
    }
    const p = run(intent).finally(() => inflight.delete(intent.intentId));
    inflight.set(intent.intentId, p);
    return p;
  };
}

/**
 * #42 review: reconcile = ask the node first; only an intent that is still unpaid
 * (and past TTL + grace, decided by `expireIfStale`) is expired.
 */
export async function reconcilePaymentIntent(
  intent: PaymentIntent,
  settleIfPaid: (intent: PaymentIntent) => Promise<SettleOutcome>,
  expireIfStale: (intent: PaymentIntent) => Promise<boolean>
): Promise<"settled" | "expired" | "pending"> {
  const outcome = await settleIfPaid(intent);
  if (outcome.status === "settled") return "settled";
  if (outcome.status === "already") return "pending";
  return (await expireIfStale(intent)) ? "expired" : "pending";
}

/** `sha256=<hex>` HMAC of the raw webhook body. */
export function signPaymentWebhookBody(rawBody: string | Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** Constant-time check of the `x-payment-signature: sha256=...` header. */
export function verifyPaymentWebhookSignature(
  rawBody: string | Buffer | undefined,
  header: unknown,
  secret: string
): boolean {
  if (!secret || rawBody === undefined || typeof header !== "string") return false;
  const expected = Buffer.from(signPaymentWebhookBody(rawBody, secret));
  const provided = Buffer.from(header.trim());
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Startup guard: production coordinators must have a webhook HMAC secret. */
export function assertPaymentWebhookSecret(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production" && !(env.PAYMENT_WEBHOOK_SECRET ?? "").trim()) {
    throw new Error("PAYMENT_WEBHOOK_SECRET required");
  }
}
