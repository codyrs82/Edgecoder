// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Cost-plus pricing for cloud models (src/cloud-host/catalog.ts): a call on a model a cloud host
 * forwards to a hosted API is priced per token at the provider's USD price plus a margin, instead
 * of the size bands every other model call uses (job-pricing.ts TOKEN_PRICE_USD_PER_M).
 *
 *   price per token (USD) = provider price × (1 + margin)            input, cached input, output
 *   cost (msat)           = ceil(Σ tokens × price  / btcUsd × 1e11)  at the BTC/USD of the rate epoch
 *
 * It plugs into the existing formula as the token price (job-pricing.ts inferenceCostMsat `price`):
 * reserve, settlement and the 95/5 split (splitJobCost, NETWORK_FEE_BPS) are unchanged. A call
 * with its own price has no power floor (a cloud host draws no power per call), so the token price
 * is the whole cost. USD is converted at settlement with the latest rate epoch's BTC/USD, so a BTC move
 * reprices the next call on its own: nothing is cached in sats.
 *
 * Never below cost: the margin is at least what keeps the host's share (after the network fee)
 * at or above the provider's cost, (1 + margin) × (1 − fee) ≥ 1, and token costs are rounded up.
 * The margin is CLOUD_MARGIN_PCT on the coordinator (default 30 %).
 */
import type { TokenPrice } from "./job-pricing.js";
import { cloudModelSpec, type CloudModelSpec } from "../cloud-host/catalog.js";

export const DEFAULT_CLOUD_MARGIN_PCT = 30;

/** The smallest margin (fraction) at which the host's share after a `feeBps` fee still covers the provider's cost. */
export function minCloudMargin(feeBps: number): number {
  const fee = Math.max(0, Math.min(9_999, feeBps)) / 10_000;
  return fee / (1 - fee);
}

/** The margin used (fraction): the configured percentage, never below minCloudMargin. */
export function effectiveCloudMargin(marginPct: number, feeBps: number): number {
  const m = Number.isFinite(marginPct) && marginPct > 0 ? marginPct / 100 : 0;
  return Math.max(m, minCloudMargin(feeBps));
}

/** A cloud model's price to the buyer, USD per million tokens. */
export function costPlusPrice(spec: Pick<CloudModelSpec, "usdPerM">, margin: number): Required<TokenPrice> {
  const k = 1 + Math.max(0, margin);
  // Rounded up at 1e-9 USD/M so a float error can never land a hair under cost.
  const up = (usd: number) => Math.ceil(usd * k * 1e9) / 1e9;
  return { input: up(spec.usdPerM.input), cachedInput: up(spec.usdPerM.cachedInput), output: up(spec.usdPerM.output) };
}

let config = { marginPct: DEFAULT_CLOUD_MARGIN_PCT, feeBps: 500 };

/** The coordinator's margin and network fee (CLOUD_MARGIN_PCT, NETWORK_FEE_BPS), set at start. */
export function configureCloudPricing(c: { marginPct: number; feeBps: number }): void {
  config = { marginPct: c.marginPct, feeBps: c.feeBps };
}

export function cloudPricingConfig(): { marginPct: number; feeBps: number; margin: number } {
  return { ...config, margin: effectiveCloudMargin(config.marginPct, config.feeBps) };
}

/**
 * The model's own token price when it is a cloud model (cost plus margin), else undefined: the
 * caller then prices it by size (job-pricing.ts tokenPriceUsdPerM).
 */
export function modelTokenPrice(model: string | undefined | null): Required<TokenPrice> | undefined {
  const spec = cloudModelSpec(model);
  return spec ? costPlusPrice(spec, effectiveCloudMargin(config.marginPct, config.feeBps)) : undefined;
}
