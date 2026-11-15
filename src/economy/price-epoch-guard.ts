// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { ResourceClass } from "../common/types.js";
import { signPayload, verifyPayload } from "../mesh/peer.js";
import { DynamicPriceInputs, LEGACY_BASE_SATS_PER_UNIT } from "./pricing.js";

/*
 * #53: guard rails for the legacy mesh price epoch (sats per compute unit).
 *
 * The epoch is only consulted when the rate oracle has no epoch (quote fallback, receipt price
 * fallback), but it must still not be settable by one peer. Every epoch is held to a configured
 * [min, max] band and a maximum change from the previous epoch, and peer quotes only count when
 * signed by an allowlisted coordinator key over the exact inputs we asked about. A consensus round
 * needs a quorum of such signers and takes the median with one vote per coordinator, so a single
 * peer neither forms a quorum nor moves the median.
 */

export interface PriceEpochBounds {
  minSats: number;
  maxSats: number;
  /** Largest allowed move from the previous epoch, in basis points of the previous price. */
  maxChangeBps: number;
}

export const DEFAULT_PRICE_EPOCH_MAX_CHANGE_BPS = 2500;

function envNumber(env: Record<string, string | undefined>, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number`);
  return n;
}

/**
 * Defaults follow the dynamic multiplier's own range (0.35x .. 4x the legacy base), so any price
 * the local formula can produce is in band. PRICE_EPOCH_{CPU,GPU}_{MIN,MAX}_SATS and
 * PRICE_EPOCH_MAX_CHANGE_BPS override them.
 */
export function priceEpochBoundsFromEnv(
  resourceClass: ResourceClass,
  env: Record<string, string | undefined> = process.env
): PriceEpochBounds {
  const base = LEGACY_BASE_SATS_PER_UNIT[resourceClass];
  const prefix = resourceClass === "gpu" ? "PRICE_EPOCH_GPU" : "PRICE_EPOCH_CPU";
  const minSats = envNumber(env, `${prefix}_MIN_SATS`) ?? Math.max(1, Math.floor(base * 0.35));
  const maxSats = envNumber(env, `${prefix}_MAX_SATS`) ?? base * 4;
  const maxChangeBps = envNumber(env, "PRICE_EPOCH_MAX_CHANGE_BPS") ?? DEFAULT_PRICE_EPOCH_MAX_CHANGE_BPS;
  if (minSats > maxSats) throw new Error(`${prefix}_MIN_SATS must not exceed ${prefix}_MAX_SATS`);
  return { minSats, maxSats, maxChangeBps };
}

export type PriceBoundsCheck =
  | { ok: true }
  | { ok: false; reason: "not_finite" | "below_min" | "above_max" | "change_too_large" };

/** Is `price` inside the band and within maxChangeBps of `previous` (when there is one)? */
export function checkPriceEpoch(price: number, previous: number | undefined, bounds: PriceEpochBounds): PriceBoundsCheck {
  if (!Number.isFinite(price)) return { ok: false, reason: "not_finite" };
  if (price < bounds.minSats) return { ok: false, reason: "below_min" };
  if (price > bounds.maxSats) return { ok: false, reason: "above_max" };
  if (previous !== undefined && previous > 0) {
    const maxDelta = (previous * bounds.maxChangeBps) / 10_000;
    if (Math.abs(price - previous) > maxDelta + 1e-9) return { ok: false, reason: "change_too_large" };
  }
  return { ok: true };
}

/** Pull `price` into the band and to at most maxChangeBps away from `previous`. */
export function clampPriceEpoch(price: number, previous: number | undefined, bounds: PriceEpochBounds): number {
  let lo = bounds.minSats;
  let hi = bounds.maxSats;
  if (previous !== undefined && previous > 0) {
    const maxDelta = (previous * bounds.maxChangeBps) / 10_000;
    lo = Math.max(lo, previous - maxDelta);
    hi = Math.min(hi, previous + maxDelta);
    // previous itself far out of band (old row, tightened config): step toward the band.
    if (lo > hi) return previous < bounds.minSats ? Math.min(bounds.maxSats, previous + maxDelta) : Math.max(bounds.minSats, previous - maxDelta);
  }
  return Math.min(hi, Math.max(lo, price));
}

// ---- signed peer quotes ----

export interface PriceQuoteFields {
  coordinatorId: string;
  resourceClass: ResourceClass;
  pricePerComputeUnitSats: number;
  inputs: DynamicPriceInputs;
  issuedAtMs: number;
}

/** Canonical bytes a coordinator signs for a price quote: binds price, inputs, signer and time. */
export function priceQuotePayload(q: PriceQuoteFields): string {
  return JSON.stringify([
    "edgecoder.price-quote.v1",
    q.coordinatorId,
    q.resourceClass,
    q.pricePerComputeUnitSats,
    q.inputs.cpuCapacity,
    q.inputs.gpuCapacity,
    q.inputs.queuedTasks,
    q.inputs.activeAgents,
    q.issuedAtMs
  ]);
}

export function signPriceQuote(q: PriceQuoteFields, privateKeyPem: string): string {
  return signPayload(priceQuotePayload(q), privateKeyPem);
}

export type QuoteCheck = { ok: true } | { ok: false; reason: string };

/** A peer's quote counts only if that peer signed exactly these inputs, recently. */
export function verifyPriceQuote(input: {
  quote: Partial<Omit<PriceQuoteFields, "inputs">> & { signature?: string };
  expectedCoordinatorId: string;
  resourceClass: ResourceClass;
  inputs: DynamicPriceInputs;
  publicKeyPem: string | null | undefined;
  nowMs: number;
  maxSkewMs: number;
}): QuoteCheck {
  const { quote } = input;
  if (quote.coordinatorId !== input.expectedCoordinatorId) return { ok: false, reason: "coordinator_mismatch" };
  if (quote.resourceClass !== input.resourceClass) return { ok: false, reason: "resource_mismatch" };
  if (typeof quote.pricePerComputeUnitSats !== "number" || !Number.isFinite(quote.pricePerComputeUnitSats)) {
    return { ok: false, reason: "bad_price" };
  }
  if (typeof quote.issuedAtMs !== "number" || Math.abs(input.nowMs - quote.issuedAtMs) > input.maxSkewMs) {
    return { ok: false, reason: "stale_quote" };
  }
  if (!quote.signature || !input.publicKeyPem) return { ok: false, reason: "unsigned" };
  const payload = priceQuotePayload({
    coordinatorId: quote.coordinatorId,
    resourceClass: quote.resourceClass,
    pricePerComputeUnitSats: quote.pricePerComputeUnitSats,
    inputs: input.inputs,
    issuedAtMs: quote.issuedAtMs
  });
  if (!verifyPayload(payload, quote.signature, input.publicKeyPem)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

/** Majority of the allowlisted coordinators (self included); an override can only raise it. */
export function priceConsensusQuorum(allowlistedPeerIds: Iterable<string>, selfId: string, override?: number): number {
  const members = new Set(allowlistedPeerIds);
  members.add(selfId);
  const majority = Math.floor(members.size / 2) + 1;
  if (override !== undefined && Number.isFinite(override) && override >= 1) return Math.max(majority, Math.floor(override));
  return majority;
}

export type ConsensusOutcome =
  | { ok: true; price: number; medianPrice: number; clamped: boolean; signers: string[] }
  | { ok: false; error: "quorum_not_met"; signers: string[]; quorum: number };

/**
 * One vote per distinct coordinator; out-of-band quotes dropped; median of the rest (for an even
 * count, the middle value nearer the previous price, so one dissenting peer can hold the price
 * but not move it); then clamped to the max change from `previous`.
 */
export function resolvePriceConsensus(input: {
  quotes: Array<{ coordinatorId: string; value: number }>;
  quorum: number;
  previous: number | undefined;
  bounds: PriceEpochBounds;
}): ConsensusOutcome {
  const byCoordinator = new Map<string, number>();
  for (const q of input.quotes) {
    if (byCoordinator.has(q.coordinatorId)) continue;
    if (!checkPriceEpoch(q.value, undefined, input.bounds).ok) continue;
    byCoordinator.set(q.coordinatorId, q.value);
  }
  const signers = [...byCoordinator.keys()];
  if (signers.length === 0 || signers.length < input.quorum) {
    return { ok: false, error: "quorum_not_met", signers, quorum: input.quorum };
  }
  const values = [...byCoordinator.values()].sort((a, b) => a - b);
  let medianPrice: number;
  if (values.length % 2 === 1) {
    medianPrice = values[(values.length - 1) / 2];
  } else {
    const a = values[values.length / 2 - 1];
    const b = values[values.length / 2];
    const anchor = input.previous ?? (a + b) / 2;
    medianPrice = Math.abs(a - anchor) <= Math.abs(b - anchor) ? a : b;
  }
  const price = Math.round(clampPriceEpoch(medianPrice, input.previous, input.bounds) * 1e6) / 1e6;
  return { ok: true, price, medianPrice, clamped: price !== medianPrice, signers };
}
