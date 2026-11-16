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

/**
 * How the network fee is rounded to whole msat. `nearest` (half up) since 2026-11-15: model calls
 * cost a few msat, and flooring kept EdgeCoder well under its 5 % (a 16 msat call paid no fee).
 * `floor` is what accruals recorded before then used; ledger verification recomputes those with it.
 */
export type FeeRounding = "floor" | "nearest";
export const FEE_ROUNDING: FeeRounding = "nearest";

/** The network fee taken out of a job's cost (basis points); the agent gets the rest. */
export function splitJobCost(costMsat: number, feeBps: number, rounding: FeeRounding = FEE_ROUNDING): { agentMsat: number; feeMsat: number } {
  const bps = Math.max(0, Math.min(10_000, Math.floor(feeBps)));
  const exact = (costMsat * bps) / 10_000;
  const feeMsat = Math.min(costMsat, rounding === "nearest" ? Math.floor(exact + 0.5) : Math.floor(exact));
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
 * million tokens by model size (set 2026-11-16 so every host class profits at 50 % utilization,
 * HOST_PROFIT_MARGIN), with a floor of the electricity the seconds cost so the machine's owner never loses money.
 * Code jobs and reservations stay per second.
 */

/**
 * Profit a host makes over its cost at 50 % utilization (the share of the hour its slots serve
 * calls), after the network fee: the owner's pricing target (2026-11-16, "make everything
 * profitable"). TOKEN_PRICE_USD_PER_M's 30B-and-up bands and the cpu / apple power floors are
 * derived from it by scripts/pricing/break-even.mjs (PROFIT_MARGIN there) on measured Ollama
 * throughput; change both and re-run the script to retune.
 */
export const HOST_PROFIT_MARGIN = 0.2;

/**
 * USD per million tokens (input, output) by model size. Up to 16B: unchanged since 2026-11-03 (a
 * Mac's tokens already clear HOST_PROFIT_MARGIN at 50 % on them). 30B and up: 8.64× the 2026-11-03
 * prices, rounded up to 0.05 (2026-11-16): what a Vultr 2×A16 running qwen3-coder:30b under Ollama
 * (1.00 USD/h, measured) needs for HOST_PROFIT_MARGIN at 50 % utilization; larger bands scale alike.
 */
export const TOKEN_PRICE_USD_PER_M: Array<{ maxB: number; input: number; output: number }> = [
  { maxB: 2, input: 0.01, output: 0.03 },
  { maxB: 4, input: 0.02, output: 0.05 },
  { maxB: 9, input: 0.04, output: 0.1 },
  { maxB: 16, input: 0.07, output: 0.2 },
  { maxB: 35, input: 1.05, output: 3.05 },
  { maxB: 80, input: 2.6, output: 6.95 },
  { maxB: Infinity, input: 5.2, output: 13.0 },
];

/**
 * Electricity floor per class (USD per hour of the base tier; tiers scale by weight; split across
 * the agent's slots). `cpu` 0.025 (was 0.005) and `apple` 0.014 (was 0.01) since 2026-11-16: from
 * the floor alone a 65 W home CPU (~0.01 USD/h) and a Mac Studio (tier weight 2.5, ~90 W, ~0.0135
 * USD/h) clear HOST_PROFIT_MARGIN over their electricity at 50 % utilization.
 */
export const POWER_FLOOR_USD_PER_HOUR: Record<string, number> = { cpu: 0.025, apple: 0.014, gpu: 0.05, "gpu.dc": 0.15 };

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
 *
 * The floor's seconds leave out `floorExcludeMs`, the agent's model-load time for the call (Ollama
 * load_duration): a host that unloaded its model (keep_alive) should not bill the buyer for loading
 * it again, so a cold call costs what the same call costs warm. Only the agent is paid by the floor,
 * so it gains nothing by over-reporting load time.
 *
 * The floor is the machine's electricity per second, so it is split across the agent's parallel
 * model slots (`floorSlots`, its reported inferenceSlots; 2026-11-16): an agent running N calls at
 * once draws one machine's power, not N. Without the split a 4-slot Mac or a 12-slot vLLM GPU
 * collected the floor up to N times over. Reporting fewer slots than it runs doesn't help an
 * agent: the coordinator never gives it more calls at once than the slots it reports.
 */
export function inferenceCostMsat(input: {
  promptTokens?: number;
  outputTokens?: number;
  paramsB: number;
  btcUsd: number;
  durationMs: number;
  /** Model-load time inside durationMs, left out of the power floor. */
  floorExcludeMs?: number;
  /** The agent's parallel model slots; the power floor is divided by them (default 1). */
  floorSlots?: number;
  computeClass: string;
  tierWeight: number;
  /** The per-second cost, used when there are no token counts. */
  perSecondCostMsat: number;
}): { costMsat: number; basis: "tokens" | "power_floor" | "per_second" } {
  if (input.promptTokens === undefined && input.outputTokens === undefined) return { costMsat: input.perSecondCostMsat, basis: "per_second" };
  const price = tokenPriceUsdPerM(input.paramsB);
  const tokenUsd = ((input.promptTokens ?? 0) * price.input + (input.outputTokens ?? 0) * price.output) / 1_000_000;
  const exclude = typeof input.floorExcludeMs === "number" && Number.isFinite(input.floorExcludeMs) ? Math.max(0, input.floorExcludeMs) : 0;
  const floorMs = Math.max(0, input.durationMs - exclude);
  const slots = typeof input.floorSlots === "number" && Number.isFinite(input.floorSlots) ? Math.max(1, Math.floor(input.floorSlots)) : 1;
  const floorUsd = ((POWER_FLOOR_USD_PER_HOUR[input.computeClass] ?? POWER_FLOOR_USD_PER_HOUR.cpu) * Math.max(1, input.tierWeight) * floorMs) / 3_600_000 / slots;
  const tokenMsat = usdToMsat(tokenUsd, input.btcUsd);
  const floorMsat = usdToMsat(floorUsd, input.btcUsd);
  return tokenMsat >= floorMsat ? { costMsat: Math.round(tokenMsat), basis: "tokens" } : { costMsat: Math.round(floorMsat), basis: "power_floor" };
}

/** cSats per million tokens (input, output) for a model size at a BTC price: what the UI shows. */
export function cSatsPerMTokens(paramsB: number, btcUsd: number): { input: number; output: number } {
  const p = tokenPriceUsdPerM(paramsB);
  return { input: Number((usdToMsat(p.input, btcUsd) / 1000).toFixed(1)), output: Number((usdToMsat(p.output, btcUsd) / 1000).toFixed(1)) };
}
