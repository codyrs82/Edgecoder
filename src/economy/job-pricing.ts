// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Job pricing in cSats (1 cSat = 1 sat of prepaid compute; amounts carried as msat).
 *
 * A job costs the measured seconds of work times the per-second rate of the hardware tier that
 * ran it. The rate is the price matched in the order book (msat per credit, a credit being one
 * second on a class's base tier), kept within the class's band, times the tier's weight. The
 * requester pays that; the agent earns it minus the network fee, which goes to the fee pool. So
 * what requesters pay and what agents earn are the same number.
 *
 * When a job is submitted the worst case is set aside (its time limit at the top of its class's
 * band on the class's fastest tier) and settled to the actual cost once it ran.
 */

/** Price band around the class reference that a matched price is kept within (audit econ#2). */
export const PRICE_BAND = { min: 0.25, max: 4 } as const;

export function clampToBand(msatPerCredit: number | undefined, classRefMsatPerCredit: number): number {
  if (msatPerCredit === undefined || !Number.isFinite(msatPerCredit) || msatPerCredit <= 0) return classRefMsatPerCredit;
  return Math.min(classRefMsatPerCredit * PRICE_BAND.max, Math.max(classRefMsatPerCredit * PRICE_BAND.min, msatPerCredit));
}

/** msat per second for a tier: the per-credit price times the tier's credits per second. */
export function ratePerSecondMsat(msatPerCredit: number, tierWeight: number): number {
  return msatPerCredit * Math.max(0, tierWeight);
}

/** Cost of a run: measured seconds × rate, whole msat. */
export function jobCostMsat(durationMs: number, ratePerSecondMsat: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.round((durationMs / 1000) * ratePerSecondMsat);
}

/** The network fee taken out of a job's cost (basis points); the agent gets the rest. */
export function splitJobCost(costMsat: number, feeBps: number): { agentMsat: number; feeMsat: number } {
  const bps = Math.max(0, Math.min(10_000, Math.floor(feeBps)));
  const feeMsat = Math.floor((costMsat * bps) / 10_000);
  return { agentMsat: costMsat - feeMsat, feeMsat };
}

/**
 * What to set aside at submit for one subtask: its time limit at the top of the price band on the
 * class's fastest tier, lowered to the requester's own price ceiling when they set one.
 */
export function reserveMsat(input: {
  timeoutMs: number;
  classRefMsatPerCredit: number;
  maxTierWeight: number;
  bidCeilingMsatPerCredit?: number;
}): number {
  const top = input.classRefMsatPerCredit * PRICE_BAND.max;
  const perCredit = input.bidCeilingMsatPerCredit !== undefined && input.bidCeilingMsatPerCredit > 0 ? Math.min(top, input.bidCeilingMsatPerCredit) : top;
  return Math.ceil((Math.max(0, input.timeoutMs) / 1000) * perCredit * Math.max(1, input.maxTierWeight));
}

/** msat to cSats (the ledger's unit), at the ledger's 6-decimal precision. */
export function msatToCSats(msat: number): number {
  return Math.round(msat) / 1000;
}

export function cSatsToMsat(cSats: number): number {
  return Math.round(cSats * 1000);
}
