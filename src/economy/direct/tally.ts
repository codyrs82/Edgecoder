// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Optional "pay from your own wallet" spot path (PAYMENTS_NWC): a tally per (buyer, payee) in msat,
 * settled by the buyer's wallet over NWC straight to the payee's Lightning address.
 *
 * It is a tally, not a balance: the coordinator records what the buyer owes each host for calls
 * already served (priced by job-pricing.ts, split by splitJobCost) and what it owes EdgeCoder's
 * 5 % fee, and asks the buyer's wallet to pay. Nothing is held. Hosts carry the risk of an unpaid
 * tally, bounded by the exposure cap.
 *
 * - settle a pair when it reaches settleMinSats, or when it has owed anything for settleIntervalMs;
 * - only whole sats move; the msat remainder stays in the tally (carry-over);
 * - a buyer's unsettled total never exceeds maxUnsettledSats: admit() refuses work whose worst
 *   case would cross it (settle_first) and starts settling;
 * - a failed payment backs off (30 s, 2 min, 8 min); after maxFailures in a row the buyer is
 *   paused (no new network work) with the reason, until a wallet is reconnected or a settle succeeds.
 */

import { randomUUID } from "node:crypto";
import type { TallyLimits } from "./flags.js";
import type { ReceiptSigner, SettlementReceipt } from "./receipts.js";
import { preimageProves } from "./lnurl-pay.js";

export const FEE_PAYEE = "edgecoder";
export const RETRY_BACKOFF_MS = [30_000, 120_000, 480_000];

export interface PayerWallet {
  payInvoice(bolt11: string): Promise<{ preimage: string; feesPaidMsat?: number }>;
  /** NWC lookup_invoice by payment hash: the preimage when an earlier attempt did pay after all. */
  lookupPaid?(paymentHash: string): Promise<string | null>;
}

export interface TallyDeps {
  limits: TallyLimits;
  /** The buyer's connected wallet (NWC), or null when none is connected. */
  walletFor(buyerAccountId: string): PayerWallet | null;
  /** A host's payout Lightning address, or null. */
  hostAddress(hostAccountId: string): string | null;
  /** EdgeCoder's own Lightning address for the 5 % fee. */
  feeAddress: string;
  /** Resolve an address to an invoice for exactly amountMsat (lnurl-pay.ts). */
  resolveInvoice(destination: string, amountMsat: number): Promise<{ bolt11: string; paymentHash: string }>;
  signer: ReceiptSigner;
  now?: () => number;
  onReceipt?: (r: SettlementReceipt) => void;
}

interface PairState {
  buyer: string;
  payee: string; // host account id, or FEE_PAYEE
  msat: number;
  firstOwedAtMs: number | null;
  inFlight: boolean;
  /** An attempt whose outcome is unknown (timeout): checked before paying a new invoice. */
  unresolved?: { paymentHash: string; bolt11: string; amountMsat: number; destination: string };
}

interface BuyerState {
  failures: number;
  nextAttemptAtMs: number;
  paused: { reason: string; atMs: number } | null;
  lastError?: string;
}

export type AdmitResult = { ok: true } | { ok: false; error: "no_wallet" | "paused" | "settle_first"; reason?: string; unsettledSats?: number; capSats?: number };

export type SettleOutcome =
  | { ok: true; receipt: SettlementReceipt }
  | { ok: false; error: string; skipped?: boolean };

export class TallyEngine {
  private readonly pairs = new Map<string, PairState>();
  private readonly buyers = new Map<string, BuyerState>();
  readonly receipts: SettlementReceipt[] = [];
  private readonly now: () => number;

  constructor(private readonly d: TallyDeps) {
    this.now = d.now ?? Date.now;
  }

  private key(buyer: string, payee: string) {
    return `${buyer}\u0000${payee}`;
  }

  private pair(buyer: string, payee: string): PairState {
    const k = this.key(buyer, payee);
    let p = this.pairs.get(k);
    if (!p) this.pairs.set(k, (p = { buyer, payee, msat: 0, firstOwedAtMs: null, inFlight: false }));
    return p;
  }

  private buyer(buyer: string): BuyerState {
    let b = this.buyers.get(buyer);
    if (!b) this.buyers.set(buyer, (b = { failures: 0, nextAttemptAtMs: 0, paused: null }));
    return b;
  }

  /** One served call: the host's share and the fee, from splitJobCost. */
  record(buyer: string, host: string, agentMsat: number, feeMsat: number): void {
    const add = (payee: string, msat: number) => {
      const m = Math.max(0, Math.round(msat));
      if (m === 0) return;
      const p = this.pair(buyer, payee);
      p.msat += m;
      if (p.firstOwedAtMs === null) p.firstOwedAtMs = this.now();
    };
    add(host, agentMsat);
    add(FEE_PAYEE, feeMsat);
  }

  tallyMsat(buyer: string, payee: string): number {
    return this.pairs.get(this.key(buyer, payee))?.msat ?? 0;
  }

  unsettledMsat(buyer: string): number {
    let total = 0;
    for (const p of this.pairs.values()) if (p.buyer === buyer) total += p.msat;
    return total;
  }

  status(buyer: string) {
    const b = this.buyers.get(buyer);
    return {
      unsettledMsat: this.unsettledMsat(buyer),
      capMsat: this.d.limits.maxUnsettledSats * 1000,
      paused: b?.paused ?? null,
      failures: b?.failures ?? 0,
      lastError: b?.lastError,
      pairs: [...this.pairs.values()].filter((p) => p.buyer === buyer && p.msat > 0).map((p) => ({ payee: p.payee, msat: p.msat })),
    };
  }

  /** May this buyer start network work whose cost is at most worstCaseMsat? */
  admit(buyer: string, worstCaseMsat: number): AdmitResult {
    if (!this.d.walletFor(buyer)) return { ok: false, error: "no_wallet" };
    const b = this.buyer(buyer);
    if (b.paused) return { ok: false, error: "paused", reason: b.paused.reason };
    const cap = this.d.limits.maxUnsettledSats * 1000;
    const unsettled = this.unsettledMsat(buyer);
    if (unsettled + Math.max(0, worstCaseMsat) > cap) {
      void this.settleBuyer(buyer, true);
      return { ok: false, error: "settle_first", unsettledSats: Math.floor(unsettled / 1000), capSats: this.d.limits.maxUnsettledSats };
    }
    return { ok: true };
  }

  /** The buyer reconnected a wallet: clear the pause and the backoff. */
  resume(buyer: string): void {
    this.buyers.set(buyer, { failures: 0, nextAttemptAtMs: 0, paused: null });
  }

  /** Pairs due now: at the threshold, or owing a whole sat for longer than the interval. */
  due(now = this.now()): PairState[] {
    const { settleMinSats, settleIntervalMs } = this.d.limits;
    return [...this.pairs.values()].filter(
      (p) => !p.inFlight && p.msat >= 1000 && (p.msat >= settleMinSats * 1000 || (p.firstOwedAtMs !== null && now - p.firstOwedAtMs >= settleIntervalMs))
    );
  }

  /** Settle everything due (threshold / hourly), honouring each buyer's backoff and pause. */
  async tick(): Promise<SettleOutcome[]> {
    const out: SettleOutcome[] = [];
    for (const p of this.due()) out.push(await this.settlePair(p.buyer, p.payee));
    return out;
  }

  /** Settle all of a buyer's pairs owing a whole sat (exposure cap, or a manual "settle now"). */
  async settleBuyer(buyer: string, force = false): Promise<SettleOutcome[]> {
    const out: SettleOutcome[] = [];
    for (const p of [...this.pairs.values()]) if (p.buyer === buyer && p.msat >= 1000) out.push(await this.settlePair(buyer, p.payee, force));
    return out;
  }

  async settlePair(buyer: string, payee: string, force = false): Promise<SettleOutcome> {
    const p = this.pair(buyer, payee);
    const b = this.buyer(buyer);
    const now = this.now();
    if (p.inFlight) return { ok: false, error: "in_flight", skipped: true };
    if (!force && now < b.nextAttemptAtMs) return { ok: false, error: "backoff", skipped: true };
    if (b.paused && !force) return { ok: false, error: "paused", skipped: true };
    const amountMsat = Math.floor(p.msat / 1000) * 1000;
    if (amountMsat <= 0) return { ok: false, error: "nothing_due", skipped: true };
    const wallet = this.d.walletFor(buyer);
    if (!wallet) return this.fail(b, "no_wallet");
    const destination = payee === FEE_PAYEE ? this.d.feeAddress : this.d.hostAddress(payee);
    // A host with no payout address keeps its tally (it is owed, not lost); the buyer isn't penalised.
    if (!destination) return { ok: false, error: "payee_has_no_address", skipped: true };
    p.inFlight = true;
    let attempt: PairState["unresolved"];
    try {
      // A timed-out attempt may still have paid: never pay twice for the same sats.
      if (p.unresolved && wallet.lookupPaid) {
        const pre = await wallet.lookupPaid(p.unresolved.paymentHash).catch(() => null);
        if (pre && preimageProves(p.unresolved.paymentHash, pre)) {
          const u = p.unresolved;
          p.unresolved = undefined;
          return this.succeed(p, b, u.destination, u.amountMsat, { bolt11: u.bolt11, paymentHash: u.paymentHash }, pre);
        }
      }
      if (p.unresolved && !wallet.lookupPaid) return this.fail(b, "unresolved_payment");
      p.unresolved = undefined;
      const inv = await this.d.resolveInvoice(destination, amountMsat);
      attempt = { paymentHash: inv.paymentHash, bolt11: inv.bolt11, amountMsat, destination };
      const paid = await wallet.payInvoice(inv.bolt11);
      if (!preimageProves(inv.paymentHash, paid.preimage)) return this.fail(b, "preimage_mismatch");
      return this.succeed(p, b, destination, amountMsat, inv, paid.preimage);
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err));
      if (code === "TIMEOUT" && attempt) p.unresolved = attempt;
      return this.fail(b, code);
    } finally {
      p.inFlight = false;
    }
  }

  private succeed(p: PairState, b: BuyerState, destination: string, amountMsat: number, inv: { bolt11: string; paymentHash: string }, preimage: string): SettleOutcome {
    const now = this.now();
    const buyer = p.buyer;
    const payee = p.payee;
    const before = p.msat;
      p.msat -= amountMsat; // the sub-sat remainder (and anything recorded meanwhile) carries over
      p.firstOwedAtMs = p.msat >= 1000 ? now : p.msat > 0 ? p.firstOwedAtMs ?? now : null;
      b.failures = 0;
      b.nextAttemptAtMs = 0;
      b.paused = null;
      b.lastError = undefined;
      const receipt = this.d.signer.sign({
        id: `stl-${randomUUID()}`, rail: "lightning", purpose: "tally", buyerAccountId: buyer,
        payeeKind: payee === FEE_PAYEE ? "edgecoder_fee" : "host", payeeAccountId: payee, destination,
        amountMsat, paymentHash: inv.paymentHash, preimage, bolt11: inv.bolt11,
        tallyBeforeMsat: before, tallyAfterMsat: p.msat, settledAtMs: now,
      });
      this.receipts.push(receipt);
      this.d.onReceipt?.(receipt);
      return { ok: true, receipt };
  }

  private fail(b: BuyerState, error: string): SettleOutcome {
    b.failures += 1;
    b.lastError = error;
    b.nextAttemptAtMs = this.now() + RETRY_BACKOFF_MS[Math.min(b.failures - 1, RETRY_BACKOFF_MS.length - 1)];
    if (b.failures >= this.d.limits.maxFailures && !b.paused) b.paused = { reason: `payment_failed:${error}`, atMs: this.now() };
    return { ok: false, error };
  }

  /** Plain snapshot for persistence (no secrets in it). */
  snapshot() {
    return { pairs: [...this.pairs.values()].map((p) => ({ ...p, inFlight: false })), buyers: [...this.buyers.entries()] };
  }
}
