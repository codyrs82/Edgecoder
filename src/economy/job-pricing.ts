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

/**
 * Model calls are priced per token, tied to the market (2026-11-03): a reference price per
 * million tokens by model size, set below typical hosted prices for open models of that size,
 * with a floor of the electricity the seconds cost so the machine's owner never loses money.
 * Code jobs and reservations stay per second.
 */

/** USD per million tokens (input, output) by model size; below hosted list prices for open models. */
export const TOKEN_PRICE_USD_PER_M: Array<{ maxB: number; input: number; output: number }> = [
  { maxB: 2, input: 0.01, output: 0.03 },
  { maxB: 4, input: 0.02, output: 0.05 },
  { maxB: 9, input: 0.04, output: 0.1 },
  { maxB: 16, input: 0.07, output: 0.2 },
  { maxB: 35, input: 0.12, output: 0.35 },
  { maxB: 80, input: 0.3, output: 0.8 },
  { maxB: Infinity, input: 0.6, output: 1.5 },
];

/** Electricity floor per class (USD per hour of the base tier; tiers scale by weight). */
export const POWER_FLOOR_USD_PER_HOUR: Record<string, number> = { cpu: 0.005, apple: 0.01, gpu: 0.05, "gpu.dc": 0.15 };

export function tokenPriceUsdPerM(paramsB: number): { input: number; output: number } {
  const row = TOKEN_PRICE_USD_PER_M.find((r) => paramsB <= r.maxB) ?? TOKEN_PRICE_USD_PER_M[TOKEN_PRICE_USD_PER_M.length - 1];
  return { input: row.input, output: row.output };
}

/** USD to msat at a BTC/USD price. */
export const usdToMsat = (usd: number, btcUsd: number) => (btcUsd > 0 ? (usd / btcUsd) * 1e8 * 1000 : 0);

/**
 * What a model call costs (msat): its tokens at the reference price, never below the power floor
 * for the seconds it ran. Without token counts (an agent that doesn't report them) it is the
 * per-second cost, as before.
 */
export function inferenceCostMsat(input: {
  promptTokens?: number;
  outputTokens?: number;
  paramsB: number;
  btcUsd: number;
  durationMs: number;
  computeClass: string;
  tierWeight: number;
  /** The per-second cost, used when there are no token counts. */
  perSecondCostMsat: number;
}): { costMsat: number; basis: "tokens" | "power_floor" | "per_second" } {
  if (input.promptTokens === undefined && input.outputTokens === undefined) return { costMsat: input.perSecondCostMsat, basis: "per_second" };
  const price = tokenPriceUsdPerM(input.paramsB);
  const tokenUsd = ((input.promptTokens ?? 0) * price.input + (input.outputTokens ?? 0) * price.output) / 1_000_000;
  const floorUsd = ((POWER_FLOOR_USD_PER_HOUR[input.computeClass] ?? POWER_FLOOR_USD_PER_HOUR.cpu) * Math.max(1, input.tierWeight) * Math.max(0, input.durationMs)) / 3_600_000;
  const tokenMsat = usdToMsat(tokenUsd, input.btcUsd);
  const floorMsat = usdToMsat(floorUsd, input.btcUsd);
  return tokenMsat >= floorMsat ? { costMsat: Math.round(tokenMsat), basis: "tokens" } : { costMsat: Math.round(floorMsat), basis: "power_floor" };
}

/** cSats per million tokens (input, output) for a model size at a BTC price: what the UI shows. */
export function cSatsPerMTokens(paramsB: number, btcUsd: number): { input: number; output: number } {
  const p = tokenPriceUsdPerM(paramsB);
  return { input: Number((usdToMsat(p.input, btcUsd) / 1000).toFixed(1)), output: Number((usdToMsat(p.output, btcUsd) / 1000).toFixed(1)) };
}
