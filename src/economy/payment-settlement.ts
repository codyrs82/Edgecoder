// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentIntent } from "../common/types.js";
import type { LightningProvider, SettlementResult } from "./lightning.js";

/**
 * Single settlement path for payment intents (#42).
 *
 * Credits are only ever granted after the Lightning node itself reports the
 * invoice as settled. Callers (webhook, reconcile, background poller, admin
 * confirm) never supply proof of payment: they only hint that an intent should
 * be re-checked.
 */
export type SettleOutcome =
  /** The node answered: not paid. `invoiceState` is its definitive state, when it gave one. */
  | { status: "unpaid"; invoiceState?: SettlementResult["invoiceState"] }
  /** The node could not be asked (unreachable, non-2xx): says nothing about the invoice. */
  | { status: "unknown"; error: string }
  | { status: "settled"; intent: PaymentIntent }
  | { status: "already"; intent?: PaymentIntent };

export interface SettleOptions {
  /**
   * Late-settlement recovery: an intent already marked "expired" is checked with the node too, and
   * credited (expired -> settled, once) if the node reports it paid.
   */
  allowExpired?: boolean;
}

export interface AtomicSettleStore {
  /**
   * Status CAS (created -> settled; also expired -> settled with `fromExpired`) plus the
   * `credit_purchase:<intentId>` credit insert, in one transaction. Returns "already" if the
   * intent was not in such a status (already settled, expired without `fromExpired`, ...).
   * #155: the account and amount credited are the ones stored on the intent row,
   * never values supplied by the caller.
   */
  settlePaymentIntentAtomic(
    intentId: string,
    txRef: string,
    paymentHash?: string,
    opts?: { fromExpired?: boolean }
  ): Promise<{ status: "settled" | "already"; intent?: PaymentIntent }>;
  /** #155: the stored intent; its invoice is what the node is asked about. */
  getPaymentIntent(intentId: string): Promise<PaymentIntent | null>;
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

  async function settleInMemory(stored: PaymentIntent, txRef: string, paymentHash: string | undefined, allowExpired: boolean): Promise<SettleOutcome> {
    const current = opts.getIntent(stored.intentId) ?? stored;
    if (!(current.status === "created" || (allowExpired && current.status === "expired"))) return { status: "already", intent: current };
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

  async function run(hint: PaymentIntent, allowExpired: boolean): Promise<SettleOutcome> {
    // #155: the caller's object is only a hint naming the intent. Every field used below
    // (invoice, payment hash, account, amount) comes from the stored intent.
    const known = opts.getIntent(hint.intentId);
    const stored = opts.store ? ((await opts.store.getPaymentIntent(hint.intentId)) ?? undefined) : known;
    if (!stored) return { status: "unpaid" };
    if (!(stored.status === "created" || (allowExpired && stored.status === "expired"))) {
      if (opts.store) await opts.saveIntent(stored);
      return { status: "already", intent: stored };
    }
    const intent = stored;

    // M4: a failed lookup is "unknown", never "unpaid": an intent is only ever expired on the
    // node's own definitive answer (reconcilePaymentIntent).
    let s: SettlementResult;
    try {
      s = await opts.provider.checkSettlement(intent.invoiceRef, intent.paymentHash ?? known?.paymentHash);
    } catch (err) {
      return { status: "unknown", error: err instanceof Error ? err.message : String(err) };
    }
    if (!s.settled) return s.invoiceState ? { status: "unpaid", invoiceState: s.invoiceState } : { status: "unpaid" };
    const txRef = ("txRef" in s && s.txRef) || intent.invoiceRef;
    const paymentHash = "paymentHash" in s ? s.paymentHash : undefined;

    let outcome: SettleOutcome;
    if (opts.store) {
      const res = await opts.store.settlePaymentIntentAtomic(intent.intentId, txRef, paymentHash, allowExpired ? { fromExpired: true } : undefined);
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
      outcome = await settleInMemory(intent, txRef, paymentHash, allowExpired);
    }
    if (outcome.status === "settled" && opts.onSettled) await opts.onSettled(outcome.intent);
    return outcome;
  }

  return async function settleIfPaid(intent: PaymentIntent, settleOpts: SettleOptions = {}): Promise<SettleOutcome> {
    const existing = inflight.get(intent.intentId);
    if (existing) {
      const out = await existing;
      // Only the first caller observes "settled"; joiners see "already".
      return out.status === "settled" ? { status: "already", intent: out.intent } : out;
    }
    const p = run(intent, settleOpts.allowExpired === true).finally(() => inflight.delete(intent.intentId));
    inflight.set(intent.intentId, p);
    return p;
  };
}

/**
 * #42 review: reconcile = ask the node first; only an intent the node definitively reports as
 * unpaid for good (canceled / expired, or still open well past its expiry) and past TTL + grace
 * (decided by `expireIfStale`) is expired. A failed lookup ("unknown") or an answer without a
 * definitive state leaves it pending: the next tick asks again.
 */
export async function reconcilePaymentIntent(
  intent: PaymentIntent,
  settleIfPaid: (intent: PaymentIntent) => Promise<SettleOutcome>,
  expireIfStale: (intent: PaymentIntent, invoiceState: SettlementResult["invoiceState"]) => Promise<boolean>
): Promise<"settled" | "expired" | "pending"> {
  const outcome = await settleIfPaid(intent);
  if (outcome.status === "settled") return "settled";
  if (outcome.status !== "unpaid" || !outcome.invoiceState) return "pending";
  return (await expireIfStale(intent, outcome.invoiceState)) ? "expired" : "pending";
}

/**
 * Whether an unpaid intent may be marked expired, from the node's definitive invoice state:
 * canceled / expired past TTL + grace, or still "open" a further `openMarginMs` after that (the
 * node refuses payments to an invoice past its expiry and cancels it soon after). "accepted" (a
 * held HTLC) and an unknown state never expire it.
 */
export function mayExpireIntent(
  invoiceState: SettlementResult["invoiceState"],
  ageMs: number,
  ttlMs: number,
  graceMs: number,
  openMarginMs: number
): boolean {
  if (ageMs <= ttlMs + graceMs) return false;
  if (invoiceState === "canceled" || invoiceState === "expired") return true;
  if (invoiceState === "open") return ageMs > ttlMs + graceMs + openMarginMs;
  return false;
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
