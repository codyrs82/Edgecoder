// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Reservations, blocks of time and server commitments paid buyer → host directly
 * (PAYMENTS_DIRECT_RESERVATIONS). EdgeCoder quotes, verifies and activates; it never receives the
 * host's money. The buyer makes two payments:
 *
 *   host:      price − fee  to the host's Lightning address / BTC address / Zcash address
 *   EdgeCoder: fee (5 %, splitJobCost) to EdgeCoder's own address on the same rail
 *
 * Rails: `lightning` (small to medium blocks; proof = preimages), `onchain` (large commitments;
 * proof = txid + output, xpub-derived address per quote when the host registered an xpub), `zcash`
 * (shielded; proof = memo'd notes seen through the host's incoming viewing key).
 *
 * A quote holds the agent until it expires. Paid in time → the lease starts in the shared
 * ReservationBook with `direct` set, so ending it moves no cSats. Late or short payments do not
 * activate anything; refunds are between buyer and host (docs/design/noncustodial-payments.md).
 */

import { randomUUID } from "node:crypto";
import { splitJobCost } from "../job-pricing.js";
import type { Reservation, ReservationBook } from "../reservations.js";
import { preimageProves } from "./lnurl-pay.js";
import { checkOnchainPayment, receiveAddressFromXpub, type BtcNet, type ChainSource, type OnchainCheck } from "./onchain-direct.js";
import type { ReceiptSigner, SettlementReceipt } from "./receipts.js";
import { quoteZec, validIncomingViewingKey, validShieldedAddress, type ZcashCheck, type ZcashViewingKeyVerifier, type ZecQuote } from "./zcash.js";

export type DirectRail = "lightning" | "onchain" | "zcash";

/** Where a host is paid. The viewing key is read-only; keep it sealed at rest (secret-box.ts). */
export interface HostPayoutProfile {
  accountId: string;
  lightningAddress?: string;
  btcAddress?: string;
  btcXpub?: string;
  zcashAddress?: string;
  zcashViewingKey?: string;
  updatedAtMs: number;
}

export interface PayoutProfileStore {
  get(accountId: string): Promise<HostPayoutProfile | null>;
  put(profile: HostPayoutProfile): Promise<void>;
  /** Next unused xpub receive index for an account (one address per on-chain quote). */
  nextXpubIndex(accountId: string): Promise<number>;
}

export class MemoryPayoutProfileStore implements PayoutProfileStore {
  private readonly rows = new Map<string, HostPayoutProfile>();
  private readonly idx = new Map<string, number>();
  async get(accountId: string) {
    const p = this.rows.get(accountId);
    return p ? { ...p } : null;
  }
  async put(profile: HostPayoutProfile) {
    this.rows.set(profile.accountId, { ...profile });
  }
  async nextXpubIndex(accountId: string) {
    const n = this.idx.get(accountId) ?? 0;
    this.idx.set(accountId, n + 1);
    return n;
  }
}

/** What a profile may show: never the viewing key itself. */
export function publicPayoutProfile(p: HostPayoutProfile | null) {
  if (!p) return null;
  return { lightningAddress: p.lightningAddress ?? null, btcAddress: p.btcAddress ?? null, btcXpubSet: !!p.btcXpub, zcashAddress: p.zcashAddress ?? null, zcashViewingKeySet: !!p.zcashViewingKey, updatedAtMs: p.updatedAtMs };
}

export interface DirectQuote {
  reservationId: string;
  rail: DirectRail;
  buyerAccountId: string;
  hostAccountId: string;
  agentId: string;
  computeClass: string;
  tier?: string;
  creditsPerSecond: number;
  model?: string;
  minutes: number;
  ratePerSecondMsat: number;
  priceMsat: number;
  hostSats: number;
  feeSats: number;
  quotedAtMs: number;
  expiresAtMs: number;
  /** Rail-specific payment instructions. */
  lightning?: { hostAddress: string; host: { bolt11: string; paymentHash: string }; fee: { bolt11: string; paymentHash: string } };
  onchain?: { hostAddress: string; feeAddress: string; minConfirmations: number };
  zcash?: ZecQuote & { minConfirmations: number };
  status: "quoted" | "active" | "expired";
  receipts: SettlementReceipt[];
}

export interface DirectDeps {
  network: BtcNet;
  feeBps: number;
  /** EdgeCoder's own receiving addresses for the fee, per rail. */
  edgecoder: { lightningAddress?: string; btcAddress?: string; zcashAddress?: string; zcashViewingKey?: string };
  profiles: PayoutProfileStore;
  resolveInvoice(destination: string, amountMsat: number): Promise<{ bolt11: string; paymentHash: string }>;
  chain?: ChainSource;
  zcash?: ZcashViewingKeyVerifier;
  rates(): { btcUsd: number; zecUsd?: number };
  signer: ReceiptSigner;
  book: ReservationBook;
  /** Lease persistence (pgStore.upsertReservation), when there is a shared store. */
  persist?: (r: Reservation) => Promise<void>;
  onchainMinConfirmations?: number;
  zcashMinConfirmations?: number;
  now?: () => number;
}

const TTL_MS: Record<DirectRail, number> = { lightning: 10 * 60_000, onchain: 60 * 60_000, zcash: 30 * 60_000 };

export type ActivationResult =
  | { status: "active"; quote: DirectQuote; reservation: Reservation }
  | { status: "pending" | "unconfirmed" | "underpaid" | "expired" | "invalid_proof" | "late"; quote: DirectQuote; detail?: unknown };

export class DirectReservationService {
  private readonly quotes = new Map<string, DirectQuote>();
  /** "txid:vout" / note refs already credited (one payment pays for one thing). */
  private readonly usedOutputs = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly d: DirectDeps) {
    this.now = d.now ?? Date.now;
  }

  get(id: string): DirectQuote | undefined {
    return this.quotes.get(id);
  }

  /** Agents held by an unexpired, unpaid quote: not offered to anyone else meanwhile. */
  heldAgentIds(): Set<string> {
    const now = this.now();
    return new Set([...this.quotes.values()].filter((q) => q.status === "quoted" && now < q.expiresAtMs).map((q) => q.agentId));
  }

  listForBuyer(accountId: string): DirectQuote[] {
    return [...this.quotes.values()].filter((q) => q.buyerAccountId === accountId).sort((a, b) => b.quotedAtMs - a.quotedAtMs);
  }

  async quote(input: {
    rail: DirectRail; buyerAccountId: string; hostAccountId: string; agentId: string; computeClass: string; tier?: string; creditsPerSecond: number; model?: string;
    minutes: number; ratePerSecondMsat: number;
  }): Promise<DirectQuote> {
    if (input.buyerAccountId === input.hostAccountId) throw new Error("direct_self_reservation");
    if (this.heldAgentIds().has(input.agentId)) throw new Error("direct_agent_held_by_quote");
    const profile = await this.d.profiles.get(input.hostAccountId);
    const priceMsat = Math.ceil(input.minutes * 60 * input.ratePerSecondMsat);
    // Whole sats on every rail; rounded up so the host is never short.
    const priceSats = Math.max(1, Math.ceil(priceMsat / 1000));
    const { feeMsat } = splitJobCost(priceSats * 1000, this.d.feeBps);
    const feeSats = Math.max(1, Math.round(feeMsat / 1000));
    const hostSats = priceSats - feeSats;
    const now = this.now();
    const id = `res-${randomUUID()}`;
    const base: DirectQuote = {
      reservationId: id, rail: input.rail, buyerAccountId: input.buyerAccountId, hostAccountId: input.hostAccountId, agentId: input.agentId,
      computeClass: input.computeClass, ...(input.tier ? { tier: input.tier } : {}), creditsPerSecond: input.creditsPerSecond, ...(input.model ? { model: input.model } : {}),
      minutes: input.minutes, ratePerSecondMsat: input.ratePerSecondMsat, priceMsat: priceSats * 1000, hostSats, feeSats,
      quotedAtMs: now, expiresAtMs: now + TTL_MS[input.rail], status: "quoted", receipts: [],
    };
    if (input.rail === "lightning") {
      if (!profile?.lightningAddress) throw new Error("host_has_no_lightning_address");
      if (!this.d.edgecoder.lightningAddress) throw new Error("edgecoder_fee_address_missing");
      const [host, fee] = await Promise.all([this.d.resolveInvoice(profile.lightningAddress, hostSats * 1000), this.d.resolveInvoice(this.d.edgecoder.lightningAddress, feeSats * 1000)]);
      base.lightning = { hostAddress: profile.lightningAddress, host, fee };
    } else if (input.rail === "onchain") {
      if (!this.d.chain) throw new Error("onchain_verifier_unavailable");
      if (!this.d.edgecoder.btcAddress) throw new Error("edgecoder_fee_address_missing");
      const hostAddress = profile?.btcXpub
        ? receiveAddressFromXpub(profile.btcXpub, await this.d.profiles.nextXpubIndex(input.hostAccountId), this.d.network)
        : profile?.btcAddress;
      if (!hostAddress) throw new Error("host_has_no_btc_address");
      base.onchain = { hostAddress, feeAddress: this.d.edgecoder.btcAddress, minConfirmations: this.d.onchainMinConfirmations ?? 1 };
    } else {
      if (!this.d.zcash) throw new Error("zcash_verifier_unavailable");
      if (!profile?.zcashAddress || !profile.zcashViewingKey) throw new Error("host_has_no_zcash_address");
      if (!this.d.edgecoder.zcashAddress || !this.d.edgecoder.zcashViewingKey) throw new Error("edgecoder_fee_address_missing");
      const r = this.d.rates();
      if (!r.zecUsd) throw new Error("zcash_no_rate");
      base.zcash = {
        ...quoteZec({ reservationId: id, priceSats: hostSats, feeSats, btcUsd: r.btcUsd, zecUsd: r.zecUsd, nowMs: now, ttlMs: TTL_MS.zcash, hostAddress: profile.zcashAddress, feeAddress: this.d.edgecoder.zcashAddress }),
        minConfirmations: this.d.zcashMinConfirmations ?? 3,
      };
    }
    this.quotes.set(id, base);
    return base;
  }

  /** Lightning: the buyer (or its NWC wallet) paid both invoices; the preimages prove it. */
  async submitLightning(id: string, proof: { hostPreimage: string; feePreimage: string }): Promise<ActivationResult> {
    const q = this.mustGet(id, "lightning");
    if (q.status === "active") return this.activeResult(q);
    const ln = q.lightning!;
    if (!preimageProves(ln.host.paymentHash, proof.hostPreimage) || !preimageProves(ln.fee.paymentHash, proof.feePreimage)) return { status: "invalid_proof", quote: q };
    // A paid invoice can't be paid late (it was ours only until expiry); the preimage is final.
    const receipts = [
      this.receipt(q, "host", { paymentHash: ln.host.paymentHash, preimage: proof.hostPreimage.toLowerCase(), bolt11: ln.host.bolt11 }, q.hostSats),
      this.receipt(q, "edgecoder_fee", { paymentHash: ln.fee.paymentHash, preimage: proof.feePreimage.toLowerCase(), bolt11: ln.fee.bolt11 }, q.feeSats),
    ];
    return this.activate(q, receipts);
  }

  /** On-chain: check the host and fee transactions (txid + output to the quoted addresses). */
  async checkOnchain(id: string, txids: { hostTxid: string; feeTxid: string }): Promise<ActivationResult> {
    const q = this.mustGet(id, "onchain");
    if (q.status === "active") return this.activeResult(q);
    const oc = q.onchain!;
    const [host, fee] = await Promise.all([
      checkOnchainPayment(this.d.chain!, { txid: txids.hostTxid, address: oc.hostAddress, minSats: q.hostSats, minConfirmations: oc.minConfirmations, used: this.usedOutputs }),
      checkOnchainPayment(this.d.chain!, { txid: txids.feeTxid, address: oc.feeAddress, minSats: q.feeSats, minConfirmations: oc.minConfirmations, used: this.usedOutputs }),
    ]);
    const bad = [host, fee].find((c) => c.status !== "paid" && c.status !== "unconfirmed");
    if (bad) return this.pendingOrExpired(q, bad.status === "underpaid" ? "underpaid" : "pending", { host, fee });
    if (host.status !== "paid" || fee.status !== "paid") return this.pendingOrExpired(q, "unconfirmed", { host, fee });
    const h = host as Extract<OnchainCheck, { status: "paid" }>;
    const f = fee as Extract<OnchainCheck, { status: "paid" }>;
    for (const c of [h, f]) this.usedOutputs.add(`${c.txid}:${c.vout}`);
    return this.activate(q, [
      this.receipt(q, "host", { txid: h.txid, vout: h.vout, confirmations: h.confirmations }, h.sats),
      this.receipt(q, "edgecoder_fee", { txid: f.txid, vout: f.vout, confirmations: f.confirmations }, f.sats),
    ]);
  }

  /** Zcash: notes carrying the reservation's memos, seen through the host's and EdgeCoder's viewing keys. */
  async checkZcash(id: string): Promise<ActivationResult> {
    const q = this.mustGet(id, "zcash");
    if (q.status === "active") return this.activeResult(q);
    const z = q.zcash!;
    const profile = await this.d.profiles.get(q.hostAccountId);
    if (!profile?.zcashViewingKey) return { status: "pending", quote: q, detail: "host_viewing_key_missing" };
    const [host, fee] = await Promise.all([
      this.d.zcash!.check({ address: z.hostAddress, viewingKey: profile.zcashViewingKey, memo: z.hostMemo, minZatoshi: z.zatoshi, minConfirmations: z.minConfirmations, expiresAtMs: z.expiresAtMs, used: this.usedOutputs }),
      this.d.zcash!.check({ address: z.feeAddress, viewingKey: this.d.edgecoder.zcashViewingKey!, memo: z.feeMemo, minZatoshi: z.feeZatoshi, minConfirmations: z.minConfirmations, expiresAtMs: z.expiresAtMs, used: this.usedOutputs }),
    ]);
    if (host.status === "late" || fee.status === "late") return { status: "late", quote: this.expireIfDue(q, true), detail: { host, fee } };
    if (host.status === "paid" && fee.status === "paid") {
      for (const c of [host, fee]) for (const n of c.notes) this.usedOutputs.add(`${n.txid}:${n.outindex ?? 0}`);
      return this.activate(q, [
        this.receipt(q, "host", { txid: host.notes[0].txid, confirmations: host.confirmations }, q.hostSats, host),
        this.receipt(q, "edgecoder_fee", { txid: fee.notes[0].txid, confirmations: fee.confirmations }, q.feeSats, fee),
      ]);
    }
    const s = [host, fee].some((c) => c.status === "underpaid") ? "underpaid" : [host, fee].every((c) => c.status === "paid" || c.status === "unconfirmed") ? "unconfirmed" : "pending";
    return this.pendingOrExpired(q, s, { host, fee });
  }

  private mustGet(id: string, rail: DirectRail): DirectQuote {
    const q = this.quotes.get(id);
    if (!q) throw new Error("unknown_quote");
    if (q.rail !== rail) throw new Error("wrong_rail");
    return q;
  }

  private expireIfDue(q: DirectQuote, force = false): DirectQuote {
    if (q.status === "quoted" && (force || this.now() >= q.expiresAtMs)) q.status = "expired";
    return q;
  }

  /**
   * Not (yet) paid in full. On-chain and Zcash payments broadcast before expiry may confirm after
   * it: an `unconfirmed` payment keeps the quote open; anything else past expiry expires it.
   */
  private pendingOrExpired(q: DirectQuote, status: "pending" | "unconfirmed" | "underpaid", detail: unknown): ActivationResult {
    if (status !== "unconfirmed" && this.now() >= q.expiresAtMs) return { status: "expired", quote: this.expireIfDue(q), detail };
    return { status, quote: q, detail };
  }

  private activeResult(q: DirectQuote): ActivationResult {
    const r = this.d.book.get(q.reservationId);
    return r ? { status: "active", quote: q, reservation: r } : { status: "pending", quote: q };
  }

  private receipt(q: DirectQuote, payee: "host" | "edgecoder_fee", proof: Partial<SettlementReceipt>, sats: number, _detail?: ZcashCheck): SettlementReceipt {
    void _detail;
    const destination =
      q.rail === "lightning" ? (payee === "host" ? q.lightning!.hostAddress : this.d.edgecoder.lightningAddress ?? "") :
      q.rail === "onchain" ? (payee === "host" ? q.onchain!.hostAddress : q.onchain!.feeAddress) :
      payee === "host" ? q.zcash!.hostAddress : q.zcash!.feeAddress;
    return this.d.signer.sign({
      id: `stl-${randomUUID()}`, rail: q.rail, purpose: payee === "host" ? "reservation" : "reservation_fee", buyerAccountId: q.buyerAccountId,
      payeeKind: payee, payeeAccountId: payee === "host" ? q.hostAccountId : "edgecoder", destination, amountMsat: sats * 1000,
      reservationId: q.reservationId, settledAtMs: this.now(), ...proof,
    });
  }

  private async activate(q: DirectQuote, receipts: SettlementReceipt[]): Promise<ActivationResult> {
    const now = this.now();
    // Paid in time, but someone else's lease took the agent meanwhile (a quote holds it only here).
    if (this.d.book.isHeld(q.agentId, now)) return { status: "pending", quote: q, detail: "agent_taken_contact_host_for_refund" };
    const r: Reservation = {
      id: q.reservationId, accountId: q.buyerAccountId, agentId: q.agentId, agentAccountId: q.hostAccountId, computeClass: q.computeClass,
      ...(q.tier ? { tier: q.tier } : {}), creditsPerSecond: q.creditsPerSecond, ...(q.model ? { model: q.model } : {}),
      startMs: now, endMs: now + q.minutes * 60_000, ratePerSecondMsat: q.ratePerSecondMsat, prepaidMsat: q.priceMsat, status: "active",
      direct: { rail: q.rail, receiptIds: receipts.map((x) => x.id) },
    };
    this.d.book.add(r);
    await this.d.persist?.(r);
    q.status = "active";
    q.receipts = receipts;
    return { status: "active", quote: q, reservation: r };
  }
}

/** Validate what a host registers (shape only; networks must match the coordinator's). */
export function validatePayoutProfileInput(
  input: { lightningAddress?: string; btcAddress?: string; btcXpub?: string; zcashAddress?: string; zcashViewingKey?: string },
  nets: { btc: BtcNet; zcash: "main" | "test" }
): string | null {
  if (input.lightningAddress && !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(input.lightningAddress)) return "invalid_lightning_address";
  if (input.btcXpub) {
    try {
      receiveAddressFromXpub(input.btcXpub, 0, nets.btc);
    } catch (e) {
      return e instanceof Error ? e.message : "invalid_xpub";
    }
  }
  if (input.btcAddress) {
    const hrp = nets.btc === "bitcoin" ? "bc1" : nets.btc === "regtest" ? "bcrt1" : "tb1";
    if (!input.btcAddress.toLowerCase().startsWith(hrp)) return "invalid_btc_address";
  }
  if (input.zcashAddress && !validShieldedAddress(input.zcashAddress, nets.zcash)) return "invalid_zcash_address";
  if (input.zcashViewingKey && !validIncomingViewingKey(input.zcashViewingKey, nets.zcash)) return "invalid_zcash_viewing_key";
  if ((input.zcashAddress && !input.zcashViewingKey) || (!input.zcashAddress && input.zcashViewingKey)) return "zcash_needs_address_and_viewing_key";
  return null;
}
