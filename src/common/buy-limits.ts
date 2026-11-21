// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * How much one Buy cSats can be, and plain-language text for the purchase errors.
 *
 * The limit is the coordinator's range (100 to 1,000,000 sats per purchase); the coordinator still
 * enforces it, this only stops the user asking for what it will refuse.
 *
 * Shared by the desktop app (PlanUsage.svelte, buy-csats.ts) and the portal (Settings > Wallet,
 * src/portal/pages/wallet.ts). Kept byte-identical in src/common/buy-limits.ts and
 * desktop/src/lib/buy-limits.ts; tests/common/buy-limits.test.ts checks the two match.
 * Self-contained on purpose: the portal ships these functions to the browser via
 * Function.prototype.toString, so every function is a declaration and reads no module constant.
 */

export interface BuyLimit {
  minSats: number;
  /** The largest amount one purchase may be. */
  maxSats: number;
}

/** The limit. `globalMin`/`globalMax`: the coordinator's range (100 to 1,000,000 sats). */
export function buyLimit(input: { globalMin?: number; globalMax?: number }): BuyLimit {
  return { minSats: input.globalMin ?? 100, maxSats: input.globalMax ?? 1_000_000 };
}

/** An amount brought inside the limit (the minimum when nothing fits, so callers still get a number). */
export function clampBuyAmount(amount: number, limit: BuyLimit): number {
  const a = Math.round(Number(amount) || 0);
  return Math.max(limit.minSats, Math.min(a, limit.maxSats));
}

/** Whether `amount` can be bought now. */
export function buyAmountFits(amount: number, limit: BuyLimit): boolean {
  return Number.isInteger(amount) && amount >= limit.minSats && amount <= limit.maxSats;
}

/** "100 to 1M" for the usual range. */
export function buyRangeLabel(limit: BuyLimit): string {
  const g = function (n: number) { return Math.floor(n).toLocaleString("en-US"); };
  return g(limit.minSats) + " to " + (limit.maxSats === 1_000_000 ? "1M" : g(limit.maxSats));
}

/** Why an amount does not fit, before submit ("" when it fits). */
export function buyLimitText(amount: number, limit: BuyLimit): string {
  const g = function (n: number) { return Math.floor(n).toLocaleString("en-US"); };
  if (!Number.isFinite(amount) || amount <= 0) return "";
  if (amount < limit.minSats) return "The minimum is " + g(limit.minSats) + " sats.";
  if (!Number.isInteger(amount)) return "Enter whole sats.";
  if (amount <= limit.maxSats) return "";
  return "The most you can buy at once is " + g(limit.maxSats) + " sats.";
}

/**
 * Plain-language text for a purchase error code from the coordinator, the portal or the local
 * agent (never the raw code).
 */
export function buyErrorText(code: string | null | undefined): string {
  switch (code) {
    case "invalid_amount":
    case "invalid_request":
      return "Enter whole sats from 100 to 1,000,000.";
    case "amount_too_small":
    case "below_minimum":
      return "The minimum purchase is 100 sats.";
    case "amount_too_large":
    case "above_maximum":
      return "The most you can buy at once is 1,000,000 sats.";
    case "payments_disabled":
      return "Buying cSats is turned off on this coordinator.";
    case "no_coordinator":
    case "coordinator_unreachable":
    case "lightning_unavailable":
    case "invoice_failed":
      return "No payment could be started right now. Try again in a minute.";
    case "not_enrolled":
      return "This computer isn't connected to your account yet. Sign in, then try again.";
    case "not_authenticated":
    case "unauthorized":
      return "Your session ended. Sign in again.";
    case "rate_limited":
    case "too_many_requests":
      return "Too many tries in a row. Wait a minute, then try again.";
    default:
      return "Couldn't start the payment. Try again in a minute.";
  }
}
