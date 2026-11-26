// Copyright (c) 2025 EdgeCoder
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
 * When a code job is submitted the worst case is set aside (its time limit at the top of its class's
 * band on the class's fastest tier) and settled to the actual cost once it ran. A model call sets
 * aside an upper bound on its token-priced cost instead (inferenceReserveMsat).
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
 * Profit a host makes over its cost at its target utilization (the share of the hour its slots
 * serve calls; 50 %, datacenter GPUs 40 %), after the network fee: the owner's pricing target
 * (2026-11-16, "make everything profitable"). TOKEN_PRICE_USD_PER_M's 30B-and-up bands and the
 * cpu / apple power floors are derived from it by scripts/pricing/break-even.mjs (PROFIT_MARGIN,
 * TARGET_UTILIZATION, TARGET_UTILIZATION_GPU there) on measured throughput; change both and
 * re-run the script to retune.
 */
export const HOST_PROFIT_MARGIN = 0.2;

/**
 * USD per million tokens (input, output) by model size. Up to 16B: unchanged since 2026-11-03 (a
 * Mac's tokens already clear HOST_PROFIT_MARGIN at 50 % on them). 30B and up: 4.74× the 2026-11-03
 * prices, rounded up to the cent: what a Vultr 2×A16 (1.00 USD/h) running qwen3-coder:30b under
 * vLLM with 2 slots (measured 2026-11-16: 640 calls/h of 8,287 tokens in, 134 out) needs for
 * HOST_PROFIT_MARGIN at 40 % utilization; larger bands scale alike. (8.64× under Ollama before.)
 */
export const TOKEN_PRICE_USD_PER_M: Array<{ maxB: number; input: number; output: number }> = [
  { maxB: 2, input: 0.01, output: 0.03 },
  { maxB: 4, input: 0.02, output: 0.05 },
  { maxB: 9, input: 0.04, output: 0.1 },
  { maxB: 16, input: 0.07, output: 0.2 },
  { maxB: 35, input: 0.57, output: 1.66 },
  { maxB: 80, input: 1.43, output: 3.8 },
  { maxB: Infinity, input: 2.85, output: 7.11 },
];

/**
 * Electricity floor per class (USD per hour of the base tier; tiers scale by weight; split across
 * the agent's slots). `cpu` 0.025 (was 0.005) and `apple` 0.014 (was 0.01) since 2026-11-16: from
 * the floor alone a 65 W home CPU (~0.01 USD/h) and a Mac Studio (tier weight 2.5, ~90 W, ~0.0135
 * USD/h) clear HOST_PROFIT_MARGIN over their electricity at 50 % utilization.
 */
export const POWER_FLOOR_USD_PER_HOUR: Record<string, number> = { cpu: 0.025, apple: 0.014, gpu: 0.05, "gpu.dc": 0.15 };

/**
 * How long a model call's own work can take on a slow host of a class (C8/C10, network test
 * 2026-11-24): decode tok/s of a 7B model there (scaled by 7 / paramsB for other sizes) and how many
 * times faster it reads the prompt. These are a slow machine's rates, a third or less of what
 * best-fit.ts expects of a typical one, so an honest host stays inside the estimate.
 */
export const SLOW_HOST_DECODE_TPS_7B: Record<string, number> = { cpu: 3, apple: 8, gpu: 15, "gpu.dc": 30 };
export const SLOW_HOST_PREFILL_FACTOR: Record<string, number> = { cpu: 6, apple: 8, gpu: 15, "gpu.dc": 25 };
/**
 * Prompt tokens a call's work is estimated on: at most its request's bytes plus this (the chat
 * template). Not PROMPT_TOKEN_ALLOWANCE (inference-streams.ts, 2048), which bounds the counts the call
 * is priced on and would make every short call look like a 2,000-token one. The hold and the billed
 * floor both use this bound, so the floor still never exceeds the hold.
 */
export const WORK_PROMPT_TOKEN_ALLOWANCE = 256;

/**
 * Bytes of a cloud model call's queued input per prompt token, for its hold (economy.ts
 * inferenceCallReserve). A cloud model is priced per token, so its hold is its real worst case:
 * prompt tokens × input price + (max_tokens + allowance) × output price; the reasoning a cloud host
 * asks the provider for past max_tokens is never billed (#554: output stays bounded by max_tokens).
 * Bytes overstate tokens (code and prose run ~3.5–4 bytes per token, and the JSON escaping of the
 * messages adds more); with INFERENCE_RESERVE_MARGIN the hold covers 2 bytes per token. Bounding the
 * prompt at one token per byte + 2048 held glm-5.3 at ~66 cSats per call (run 6) and 402'd buyers
 * with ~100 cSats. A count past the hold is settled in full from the buyer's balance at settle time
 * (results.ts accrueResultCredits), within the bound on reported counts (inference-streams.ts
 * boundTokenCounts: request bytes + PROMPT_TOKEN_ALLOWANCE).
 */
export const CLOUD_PROMPT_BYTES_PER_TOKEN = 3;

/**
 * A local model call's (GPU, CPU, Apple) prompt bound for its hold: the larger of the digit-aware
 * token estimate of its queued input (start-eta.ts promptTokenEstimate) × LOCAL_PROMPT_ESTIMATE_FACTOR
 * and its bytes / LOCAL_PROMPT_BYTES_PER_TOKEN, plus the chat-template allowance, and never above
 * what /inference/chunks accepts (bytes + PROMPT_TOKEN_ALLOWANCE). It was one token per byte: run 18's
 * 62,015-byte prompt (~18k tokens) on qwen3-coder:30b held 127.1 cSats, of which ~85 was its prompt
 * counted at ~3.4 times its size. A call whose real count is past the hold (a dense prompt: minified
 * JSON, short keys) is still paid in full: the rest comes from the buyer's balance at settle time.
 */
export const LOCAL_PROMPT_ESTIMATE_FACTOR = 1.25;
export const LOCAL_PROMPT_BYTES_PER_TOKEN = 2;

/**
 * The prompt tokens a local model call is held for (see LOCAL_PROMPT_ESTIMATE_FACTOR): `estimate` is
 * the digit-aware token estimate of the queued input; without one, bytes / 4.
 */
export function localPromptTokensMax(inputBytes: number, estimate: number | undefined, allowance: number): number {
  const bytes = Math.max(0, inputBytes);
  const est = estimate !== undefined && Number.isFinite(estimate) && estimate > 0 ? estimate : Math.ceil(bytes / 4);
  const bound = Math.max(Math.ceil(est * LOCAL_PROMPT_ESTIMATE_FACTOR), Math.ceil(bytes / LOCAL_PROMPT_BYTES_PER_TOKEN));
  return Math.min(bound, bytes) + allowance;
}
/** Safety factor on the slow-host estimate, and a fixed allowance per call (first token, scheduling). */
export const WORK_TIME_SAFETY = 2;
export const WORK_TIME_OVERHEAD_MS = 5_000;

/**
 * The most seconds of model work a call with these token counts takes on a slow host of
 * `computeClass` (on a tier of weight `tierWeight`, default the base tier): WORK_TIME_OVERHEAD_MS +
 * WORK_TIME_SAFETY x (prompt / prefill rate + output / decode rate) / tierWeight. It only grows with
 * the counts and only shrinks with the weight, so the floor it allows (weight × seconds) is largest on
 * the class's top tier for the call's caps, and that bounds what any tier can bill for any counts it
 * can report. Used two ways:
 * - the power-floor part of a model call's hold (inferenceReserveMsat) is sized on it for the call's
 *   caps (capped by the timeout), not on the timeout alone;
 * - the power floor a call is billed (inferenceCostMsat `floorMaxMs`) counts at most this for the
 *   counts it reported, so a short call that shared a busy host is not billed the other call's time.
 */
export function expectedWorkMs(input: { paramsB: number; computeClass: string; promptTokens: number; outputTokens: number; tierWeight?: number }): number {
  const b = Math.max(0.3, Number.isFinite(input.paramsB) ? input.paramsB : 7);
  const decode = Math.max(0.05, (SLOW_HOST_DECODE_TPS_7B[input.computeClass] ?? SLOW_HOST_DECODE_TPS_7B.cpu) * (7 / b));
  const prefill = decode * (SLOW_HOST_PREFILL_FACTOR[input.computeClass] ?? SLOW_HOST_PREFILL_FACTOR.cpu);
  const seconds = Math.max(0, input.promptTokens || 0) / prefill + Math.max(0, input.outputTokens || 0) / decode;
  // A tier's weight is its speed over the class's base tier (credits per second): it does the same
  // tokens in 1 / weight of the time, and is paid weight × the base rate per second for them.
  const weight = typeof input.tierWeight === "number" && Number.isFinite(input.tierWeight) ? Math.max(1, input.tierWeight) : 1;
  return Math.ceil(WORK_TIME_OVERHEAD_MS + (WORK_TIME_SAFETY * seconds * 1000) / weight);
}

export function tokenPriceUsdPerM(paramsB: number): { input: number; output: number } {
  const row = TOKEN_PRICE_USD_PER_M.find((r) => paramsB <= r.maxB) ?? TOKEN_PRICE_USD_PER_M[TOKEN_PRICE_USD_PER_M.length - 1];
  return { input: row.input, output: row.output };
}

/**
 * A model's own token price (USD per million tokens), in place of the size band: a cloud model's
 * provider price plus margin (src/economy/cloud-pricing.ts). `cachedInput` prices prompt tokens the
 * provider served from its cache; without it they cost `input`.
 */
export interface TokenPrice {
  input: number;
  output: number;
  cachedInput?: number;
}

/** USD for a call's tokens at a price; cached tokens are part of promptTokens. */
function tokensUsd(price: TokenPrice, promptTokens: number, outputTokens: number, cachedPromptTokens = 0): number {
  const prompt = Math.max(0, promptTokens);
  const cached = Math.min(prompt, Math.max(0, cachedPromptTokens));
  return ((prompt - cached) * price.input + cached * (price.cachedInput ?? price.input) + Math.max(0, outputTokens) * price.output) / 1_000_000;
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
 * The floor's seconds are also at most `floorWorkMs`, the call's own model time as the agent reports
 * it (Ollama prompt_eval_duration + eval_duration): wall time since the claim includes time the call
 * waited on the host while a neighbour ran (a busy Ollama queues a request it has no free slot for),
 * and a short call billed for that paid for the other call's seconds (B6, 2026-11-24: a 12-token call
 * sharing a host with a long one cost 0.483 cSats, ~160x normal). It only ever lowers the floor
 * (the wall time stays the ceiling), so an agent gains nothing by over-reporting it.
 *
 * Both are reports from the agent, and under contention they are not enough: a host that runs two
 * calls at once in one engine interleaves them, so a short call's own prompt + generation time spans
 * most of the long call (C10, 2026-11-24: a 1.5b probe sharing a CPU host with a long call billed
 * 0.427 cSats over 83 s). `floorMaxMs` (expectedWorkMs for the counts the call reported) caps the
 * floor's seconds at what that many tokens take on a slow host of the class. The settle path
 * (results.ts) always passes it: it is also what keeps the cost within the hold (inferenceReserveMsat).
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
  /** Prompt tokens the provider served from its cache (priced at `price.cachedInput`); part of promptTokens. */
  cachedPromptTokens?: number;
  paramsB: number;
  /**
   * The model's own token price (a cloud model, src/economy/cloud-pricing.ts) instead of the size
   * band. That cost is rounded up, never down: it is the provider's cost plus margin.
   */
  price?: TokenPrice;
  btcUsd: number;
  durationMs: number;
  /** Model-load time inside durationMs, left out of the power floor. */
  floorExcludeMs?: number;
  /** The call's own model time (prompt + generation) inside durationMs; the power floor counts at most this. */
  floorWorkMs?: number;
  /** At most this many seconds of floor (expectedWorkMs for the reported counts); unset: no cap. */
  floorMaxMs?: number;
  /** The agent's parallel model slots; the power floor is divided by them (default 1). */
  floorSlots?: number;
  computeClass: string;
  tierWeight: number;
  /** The per-second cost, used when there are no token counts. */
  perSecondCostMsat: number;
}): { costMsat: number; basis: "tokens" | "power_floor" | "per_second" } {
  if (input.promptTokens === undefined && input.outputTokens === undefined) return { costMsat: input.perSecondCostMsat, basis: "per_second" };
  const price = input.price ?? tokenPriceUsdPerM(input.paramsB);
  const tokenUsd = tokensUsd(price, input.promptTokens ?? 0, input.outputTokens ?? 0, input.price ? input.cachedPromptTokens : 0);
  const exclude = typeof input.floorExcludeMs === "number" && Number.isFinite(input.floorExcludeMs) ? Math.max(0, input.floorExcludeMs) : 0;
  const work = typeof input.floorWorkMs === "number" && Number.isFinite(input.floorWorkMs) ? Math.max(0, input.floorWorkMs) : Number.POSITIVE_INFINITY;
  const most = typeof input.floorMaxMs === "number" && Number.isFinite(input.floorMaxMs) ? Math.max(0, input.floorMaxMs) : Number.POSITIVE_INFINITY;
  const floorMs = Math.max(0, Math.min(input.durationMs - exclude, work, most));
  const slots = typeof input.floorSlots === "number" && Number.isFinite(input.floorSlots) ? Math.max(1, Math.floor(input.floorSlots)) : 1;
  // A model with its own price (a cloud model) has no power floor: it draws no power on the host,
  // and its price already covers what it costs.
  const floorUsd = input.price ? 0 : ((POWER_FLOOR_USD_PER_HOUR[input.computeClass] ?? POWER_FLOOR_USD_PER_HOUR.cpu) * Math.max(1, input.tierWeight) * floorMs) / 3_600_000 / slots;
  const tokenMsat = usdToMsat(tokenUsd, input.btcUsd);
  const floorMsat = usdToMsat(floorUsd, input.btcUsd);
  if (tokenMsat < floorMsat) return { costMsat: Math.round(floorMsat), basis: "power_floor" };
  return { costMsat: input.price ? Math.ceil(tokenMsat) : Math.round(tokenMsat), basis: "tokens" };
}

/**
 * Safety margin on a model call's reserve (2026-11-16): covers the BTC price moving between submit
 * and settlement (the cost is converted at the settle-time price) by up to a third.
 */
export const INFERENCE_RESERVE_MARGIN = 1.5;

/**
 * What to set aside at submit for one model call: an upper bound on what inferenceCostMsat can
 * settle it at, so a buyer's balance is held only for what the call can really cost (it was 180 s
 * at the top of the dearest class band, ~750 cSats, for calls that settle under 1 to ~6 cSats).
 *
 *   reserve = margin × max(token bound, power-floor bound), capped by the buyer's maxCSats
 *
 * - token bound: the model's price for `promptTokensMax` in and `outputTokensMax` out. The caller
 *   passes the same bounds /inference/chunks puts on reported counts (request bytes + allowance,
 *   max_tokens + allowance), so no accepted count can exceed them;
 * - power-floor bound: the dearest of `floorClasses`' floor (USD/h × its top tier weight) for the
 *   seconds the call's own work can take there: expectedWorkMs for its token caps on a slow host of
 *   the class, at most `maxDurationMs` (the call's timeout, which also caps the duration it is billed
 *   on); one slot. It was the timeout alone until 2026-11-24 (C8): every 1.5b call held 54.47 cSats
 *   for a cost of 0.002 to 0.5, and a buyer with ~200 cSats got 402s with 3 or 4 calls in flight.
 *   Settlement bills the floor on at most expectedWorkMs of the counts the call reported
 *   (inferenceCostMsat floorMaxMs), never more than this bound.
 *
 * A model call's cost above its reserve (a prompt denser than its bound, the BTC price fell by over a
 * third, a capped maxCSats) is settled from the buyer's balance at settle time, up to what it holds,
 * in the same database transaction as the host's earning (results.ts accrueResultCredits): the host
 * is paid in full, and only what the buyer cannot cover goes unpaid (logged as
 * job_cost_over_reserve_unpaid and recorded on the billing entry, the usage record and the accrual's
 * ledger record). The counts it is priced on stay bounded by what the request and reply can hold
 * (inference-streams.ts boundTokenCounts), whatever the reserve.
 */
export function inferenceReserveMsat(input: {
  paramsB: number;
  /** The model's own token price (a cloud model) instead of the size band; prompt tokens are bounded at the uncached price. */
  price?: TokenPrice;
  btcUsd: number;
  promptTokensMax: number;
  outputTokensMax: number;
  /** Prompt tokens the work time is estimated on (request bytes + WORK_PROMPT_TOKEN_ALLOWANCE); default promptTokensMax. */
  workPromptTokensMax?: number;
  maxDurationMs: number;
  floorClasses: Array<{ computeClass: string; maxTierWeight: number }>;
  margin?: number;
  /** The buyer's ceiling for the call (maxCSats), msat. */
  capMsat?: number;
}): { reserveMsat: number; tokenMsat: number; floorMsat: number; capped: boolean } {
  const price = input.price ?? tokenPriceUsdPerM(input.paramsB);
  const tokenUsd = (Math.max(0, input.promptTokensMax) * price.input + Math.max(0, input.outputTokensMax) * price.output) / 1_000_000;
  const hoursIn = (c: { computeClass: string; maxTierWeight: number }) =>
    Math.min(Math.max(0, input.maxDurationMs), expectedWorkMs({ paramsB: input.paramsB, computeClass: c.computeClass, promptTokens: Math.min(input.promptTokensMax, input.workPromptTokensMax ?? input.promptTokensMax), outputTokens: input.outputTokensMax, tierWeight: c.maxTierWeight })) / 3_600_000;
  const floorUsd = input.price ? 0 : Math.max(0, ...input.floorClasses.map((c) => (POWER_FLOOR_USD_PER_HOUR[c.computeClass] ?? POWER_FLOOR_USD_PER_HOUR.cpu) * Math.max(1, c.maxTierWeight) * hoursIn(c)));
  const tokenMsat = usdToMsat(tokenUsd, input.btcUsd);
  const floorMsat = usdToMsat(floorUsd, input.btcUsd);
  const bound = Math.max(1, Math.ceil(Math.max(tokenMsat, floorMsat) * (input.margin ?? INFERENCE_RESERVE_MARGIN)));
  const cap = input.capMsat !== undefined && Number.isFinite(input.capMsat) && input.capMsat > 0 ? Math.max(1, Math.floor(input.capMsat)) : undefined;
  const reserveMsat = cap !== undefined ? Math.min(bound, cap) : bound;
  return { reserveMsat, tokenMsat: Math.ceil(tokenMsat), floorMsat: Math.ceil(floorMsat), capped: reserveMsat < bound };
}

/**
 * cSats per million tokens (input, output) for a model size at a BTC price: what the UI shows. With
 * a model's own price (a cloud model) that price instead, and `cachedInput` when it has one.
 */
export function cSatsPerMTokens(paramsB: number, btcUsd: number, own?: TokenPrice): { input: number; output: number; cachedInput?: number } {
  const p = own ?? tokenPriceUsdPerM(paramsB);
  const c = (usd: number) => Number((usdToMsat(usd, btcUsd) / 1000).toFixed(1));
  return { input: c(p.input), output: c(p.output), ...(own?.cachedInput !== undefined ? { cachedInput: c(own.cachedInput) } : {}) };
}
