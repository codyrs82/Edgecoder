// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";
import type { BitcoinNetwork, InfrastructureHost, PayoutRecord } from "../common/types.js";
import { bolt11IsExpired, decodeBolt11, type DecodedBolt11 } from "./bolt11.js";

/**
 * Sats payouts: the rules that turn an account's earned msat into a Lightning payment.
 *
 * Payable balance = Σ earn msat (locked at accrual) − Σ payouts that are paid or still pending.
 * A payout is either a `withdraw` (the account posts a BOLT11 invoice for its own wallet) or
 * `auto` (the account registered a Lightning address; the coordinator fetches an invoice over
 * LNURL-pay each tick and pays it). Both go through validatePayoutRequest and the coordinator's
 * solvency check: it can never promise more sats than its node received from settled purchases.
 */

export interface PayoutPolicy {
  enabled: boolean;
  /** Smallest payout the node will make (routing fees make tiny payouts uneconomic). */
  minPayoutSats: number;
  /** Routing fee cap in basis points of the amount, with an absolute floor so small payouts can route. */
  maxFeeBps: number;
  minFeeFloorSats: number;
  /** Auto payout: pay registered Lightning addresses when payable >= this. */
  autoMinPayoutSats: number;
  /** Share of received sats kept back as a routing/fee reserve, never paid out. */
  reserveBps: number;
  network: BitcoinNetwork;
}

export const DEFAULT_PAYOUT_POLICY: Omit<PayoutPolicy, "network"> = {
  enabled: true,
  minPayoutSats: 1_000,
  maxFeeBps: 100,
  minFeeFloorSats: 10,
  autoMinPayoutSats: 10_000,
  reserveBps: 200
};

export function payoutPolicyFromEnv(network: BitcoinNetwork, env: NodeJS.ProcessEnv = process.env): PayoutPolicy {
  const num = (k: string, d: number) => {
    const v = env[k];
    if (v === undefined || v.trim() === "") return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`[payouts] ${k} must be a number >= 0`);
    return n;
  };
  return {
    enabled: (env.PAYOUTS_ENABLED ?? "true").trim().toLowerCase() !== "false",
    minPayoutSats: num("PAYOUT_MIN_SATS", DEFAULT_PAYOUT_POLICY.minPayoutSats),
    maxFeeBps: num("PAYOUT_MAX_FEE_BPS", DEFAULT_PAYOUT_POLICY.maxFeeBps),
    minFeeFloorSats: num("PAYOUT_MIN_FEE_FLOOR_SATS", DEFAULT_PAYOUT_POLICY.minFeeFloorSats),
    autoMinPayoutSats: num("PAYOUT_AUTO_MIN_SATS", DEFAULT_PAYOUT_POLICY.autoMinPayoutSats),
    reserveBps: num("PAYOUT_RESERVE_BPS", DEFAULT_PAYOUT_POLICY.reserveBps),
    network
  };
}

export function payableMsat(earnedMsat: number, paidOrPendingMsat: number): number {
  return Math.max(0, Math.floor(earnedMsat) - Math.floor(paidOrPendingMsat));
}

export function maxFeeMsatFor(amountMsat: number, policy: PayoutPolicy): number {
  return Math.max(policy.minFeeFloorSats * 1000, Math.ceil((amountMsat * policy.maxFeeBps) / 10_000));
}

/**
 * Sats the coordinator may still pay out: received from settled purchases, minus what it has
 * already paid or promised, minus the reserve. Payouts beyond this would spend sats the node
 * never received (or needs for routing).
 */
export function payoutCapacityMsat(input: { receivedMsat: number; paidOrPendingMsat: number }, policy: PayoutPolicy): number {
  const reserve = Math.ceil((input.receivedMsat * policy.reserveBps) / 10_000);
  return Math.max(0, Math.floor(input.receivedMsat) - reserve - Math.floor(input.paidOrPendingMsat));
}

export type PayoutValidation =
  | { ok: true; decoded: DecodedBolt11; amountMsat: number; maxFeeMsat: number }
  | { ok: false; code: string; detail?: string };

/** Everything that must hold before a payout row is reserved. Pure. */
export function validatePayoutRequest(
  input: { bolt11: string; payableMsat: number; capacityMsat: number; nowMs?: number },
  policy: PayoutPolicy
): PayoutValidation {
  if (!policy.enabled) return { ok: false, code: "payouts_disabled" };
  let decoded: DecodedBolt11;
  try {
    decoded = decodeBolt11(input.bolt11);
  } catch (err) {
    return { ok: false, code: "invalid_invoice", detail: err instanceof Error ? err.message : String(err) };
  }
  const expectedNetwork: DecodedBolt11["network"] = policy.network;
  if (decoded.network !== expectedNetwork) return { ok: false, code: "wrong_network", detail: `${decoded.network} != ${expectedNetwork}` };
  if (bolt11IsExpired(decoded, input.nowMs)) return { ok: false, code: "invoice_expired" };
  if (decoded.amountMsat === undefined) return { ok: false, code: "amountless_invoice" };
  const amountMsat = decoded.amountMsat;
  if (amountMsat < policy.minPayoutSats * 1000) return { ok: false, code: "below_minimum", detail: `${amountMsat} msat < ${policy.minPayoutSats} sats` };
  if (amountMsat > input.payableMsat) return { ok: false, code: "insufficient_payable", detail: `${amountMsat} msat > payable ${input.payableMsat}` };
  const maxFeeMsat = maxFeeMsatFor(amountMsat, policy);
  if (amountMsat + maxFeeMsat > input.capacityMsat) return { ok: false, code: "coordinator_capacity", detail: `node can pay out at most ${input.capacityMsat} msat right now` };
  return { ok: true, decoded, amountMsat, maxFeeMsat };
}

/** A paid payout must come back with the preimage of the invoice's payment hash (unless the provider can't return one, dev mock). */
export function preimageMatches(paymentHashHex: string, preimageHex: string | undefined): boolean {
  if (!preimageHex || !/^[0-9a-f]{64}$/i.test(preimageHex)) return false;
  return createHash("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex") === paymentHashHex.toLowerCase();
}

/* ------------------------------------------------------------------ */
/*  LNURL-pay / Lightning address (auto payouts)                        */
/* ------------------------------------------------------------------ */

export type JsonFetcher = (url: string) => Promise<unknown>;

/** user@domain -> https://domain/.well-known/lnurlp/user ; a raw https LNURL-pay URL is used as-is. */
export function lnurlPayEndpoint(destination: string): string {
  const d = destination.trim();
  if (/^https:\/\//i.test(d)) return d;
  const m = /^([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(d);
  if (!m) throw new Error("invalid_lightning_address");
  return `https://${m[2].toLowerCase()}/.well-known/lnurlp/${m[1]}`;
}

/**
 * Fetch an invoice for `amountMsat` from a Lightning address / LNURL-pay endpoint and check the
 * invoice is for that amount on the right network. The invoice's payment hash is what we pay.
 */
export async function requestLnurlInvoice(
  destination: string,
  amountMsat: number,
  fetcher: JsonFetcher,
  network: BitcoinNetwork
): Promise<{ bolt11: string; decoded: DecodedBolt11 }> {
  const meta = (await fetcher(lnurlPayEndpoint(destination))) as {
    tag?: string;
    callback?: string;
    minSendable?: number;
    maxSendable?: number;
    status?: string;
    reason?: string;
  };
  if (meta?.status === "ERROR") throw new Error(`lnurl_error:${meta.reason ?? "unknown"}`);
  if (meta?.tag !== "payRequest" || typeof meta.callback !== "string" || !/^https:\/\//i.test(meta.callback)) throw new Error("lnurl_not_pay_request");
  if (typeof meta.minSendable === "number" && amountMsat < meta.minSendable) throw new Error(`lnurl_below_min:${meta.minSendable}`);
  if (typeof meta.maxSendable === "number" && amountMsat > meta.maxSendable) throw new Error(`lnurl_above_max:${meta.maxSendable}`);
  const cb = new URL(meta.callback);
  cb.searchParams.set("amount", String(amountMsat));
  const inv = (await fetcher(cb.toString())) as { pr?: string; status?: string; reason?: string };
  if (inv?.status === "ERROR" || typeof inv?.pr !== "string") throw new Error(`lnurl_invoice_error:${inv?.reason ?? "no pr"}`);
  const decoded = decodeBolt11(inv.pr);
  if (decoded.network !== network) throw new Error(`lnurl_wrong_network:${decoded.network}`);
  if (decoded.amountMsat !== amountMsat) throw new Error(`lnurl_amount_mismatch:${decoded.amountMsat}`);
  return { bolt11: inv.pr, decoded };
}

/* ------------------------------------------------------------------ */
/*  Infrastructure fee pool                                            */
/* ------------------------------------------------------------------ */

/**
 * Weight of a host in a fee-pool distribution window. Uptime is the fraction of expected
 * heartbeats seen; services add weight so a host also running Bitcoin / Lightning
 * infrastructure earns more than a bare coordinator.
 *   coordinator 1.0 (base), bitcoind +1.0, lightning +1.0, electrs +0.5
 */
export function hostWeight(host: Pick<InfrastructureHost, "heartbeatsInWindow" | "services">, expectedHeartbeats: number): number {
  const uptime = expectedHeartbeats > 0 ? Math.min(1, host.heartbeatsInWindow / expectedHeartbeats) : 0;
  if (uptime < 0.5) return 0; // under half the window online: nothing this round
  const services = new Set(host.services.map((s) => s.toLowerCase()));
  let w = 1.0;
  if (services.has("bitcoind")) w += 1.0;
  if (services.has("lightning")) w += 1.0;
  if (services.has("electrs")) w += 0.5;
  return Number((w * uptime).toFixed(6));
}

/** Split the pool across hosts by weight; sums to <= pool (floors), remainder stays in the pool. */
export function distributeFeePool(
  poolMsat: number,
  hosts: Array<Pick<InfrastructureHost, "hostId" | "accountId" | "heartbeatsInWindow" | "services">>,
  expectedHeartbeats: number
): Array<{ hostId: string; accountId: string; weight: number; msat: number }> {
  const weighted = hosts.map((h) => ({ hostId: h.hostId, accountId: h.accountId, weight: hostWeight(h, expectedHeartbeats) })).filter((h) => h.weight > 0);
  const total = weighted.reduce((s, h) => s + h.weight, 0);
  if (total <= 0 || poolMsat <= 0) return [];
  return weighted.map((h) => ({ ...h, msat: Math.floor((poolMsat * h.weight) / total) })).filter((h) => h.msat > 0);
}

export function describePayout(p: PayoutRecord): string {
  return `${p.kind} ${p.amountMsat} msat to ${p.accountId} (${p.status})`;
}
