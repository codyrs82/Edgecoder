// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * How much one Buy cSats can be right now, and plain-language text for the purchase errors.
 *
 * The effective limit is the lowest of: the early-access daily buy cap minus what was bought in
 * the last 24 h, the early-access balance cap minus the current balance (in sats, before the
 * purchase fee), and the global 100 to 1,000,000 sat range. The caps come from the coordinator
 * (src/economy/launch-gate.ts, LAUNCH_MODE=invite) through /portal/api/wallet/overview `launch`;
 * the coordinator still enforces them, this only stops the user asking for what it will refuse.
 *
 * Shared by the desktop app (PlanUsage.svelte, buy-csats.ts) and the portal (Settings > Wallet,
 * src/portal/pages/wallet.ts). Kept byte-identical in src/common/buy-limits.ts and
 * desktop/src/lib/buy-limits.ts; tests/common/buy-limits.test.ts checks the two match.
 * Self-contained on purpose: the portal ships these functions to the browser via
 * Function.prototype.toString, so every function is a declaration and reads no module constant.
 */

/** The coordinator's soft-launch caps as the wallet overview reports them (null when open). */
export interface LaunchCaps {
  mode: string;
  maxBuySatsPerDay: number;
  maxBalanceSats: number;
  maxPayoutSatsPerDay?: number;
  boughtWindowSats?: number;
}

export interface BuyLimit {
  minSats: number;
  /** The largest amount that fits right now (below minSats when nothing fits). */
  maxSats: number;
  /** Which bound sets maxSats. */
  reason: "daily" | "balance" | "global";
  /** Early-access daily cap and what is left of it (null without a daily cap). */
  dailyCapSats: number | null;
  dailyLeftSats: number | null;
  /** Early-access balance cap and the cSats that still fit under it (null without one). */
  balanceCapSats: number | null;
  balanceLeftSats: number | null;
}

/**
 * The effective limit. `feeBps`: the purchase fee (a purchase adds amount minus fee to the balance).
 * `globalMin`/`globalMax`: the coordinator's range (100 to 1,000,000 sats).
 */
export function buyLimit(input: { launch?: LaunchCaps | null; balanceCSats?: number | null; feeBps?: number | null; globalMin?: number; globalMax?: number }): BuyLimit {
  const minSats = input.globalMin ?? 100;
  const globalMax = input.globalMax ?? 1_000_000;
  const l = input.launch && input.launch.mode === "invite" ? input.launch : null;
  let maxSats = globalMax;
  let reason: BuyLimit["reason"] = "global";
  let dailyCapSats: number | null = null;
  let dailyLeftSats: number | null = null;
  let balanceCapSats: number | null = null;
  let balanceLeftSats: number | null = null;
  if (l && l.maxBuySatsPerDay > 0) {
    dailyCapSats = l.maxBuySatsPerDay;
    dailyLeftSats = Math.max(0, Math.floor(l.maxBuySatsPerDay - (Number(l.boughtWindowSats) || 0)));
    if (dailyLeftSats < maxSats) { maxSats = dailyLeftSats; reason = "daily"; }
  }
  if (l && l.maxBalanceSats > 0 && input.balanceCSats != null && Number.isFinite(input.balanceCSats)) {
    balanceCapSats = l.maxBalanceSats;
    balanceLeftSats = Math.max(0, Math.floor(l.maxBalanceSats - input.balanceCSats));
    // The balance grows by amount minus the purchase fee, so a fee lets the amount be a bit larger.
    const fee = Math.min(9_999, Math.max(0, Number(input.feeBps) || 0));
    let amount = Math.floor((balanceLeftSats * 10_000) / (10_000 - fee));
    while (amount > 0 && amount - Math.floor((amount * fee) / 10_000) > balanceLeftSats) amount--;
    if (amount < maxSats) { maxSats = amount; reason = "balance"; }
  }
  return { minSats, maxSats, reason, dailyCapSats, dailyLeftSats, balanceCapSats, balanceLeftSats };
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

/** "100 to 50,000 today" under a cap, "100 to 1M" otherwise; "None left today" when nothing fits. */
export function buyRangeLabel(limit: BuyLimit): string {
  const g = function (n: number) { return Math.floor(n).toLocaleString("en-US"); };
  if (limit.maxSats < limit.minSats) return limit.reason === "daily" ? "None left today" : "None right now";
  if (limit.reason === "global") return g(limit.minSats) + " to " + (limit.maxSats === 1_000_000 ? "1M" : g(limit.maxSats));
  return g(limit.minSats) + " to " + g(limit.maxSats) + (limit.reason === "daily" ? " today" : "");
}

/** Why an amount does not fit, before submit ("" when it fits). */
export function buyLimitText(amount: number, limit: BuyLimit): string {
  const g = function (n: number) { return Math.floor(n).toLocaleString("en-US"); };
  if (!Number.isFinite(amount) || amount <= 0) return "";
  if (amount < limit.minSats) return "The minimum is " + g(limit.minSats) + " sats.";
  if (!Number.isInteger(amount)) return "Enter whole sats.";
  if (amount <= limit.maxSats) return "";
  if (limit.reason === "daily" && limit.dailyCapSats !== null) {
    return "Early access: up to " + g(limit.dailyCapSats) + " sats per day (" + g(limit.dailyLeftSats ?? 0) + " left today).";
  }
  if (limit.reason === "balance" && limit.balanceCapSats !== null) {
    return "Early access: a balance of up to " + g(limit.balanceCapSats) + " cSats. You can add up to " + g(Math.max(0, limit.maxSats)) + " sats now.";
  }
  return "The most you can buy at once is " + g(limit.maxSats) + " sats.";
}

/**
 * Plain-language text for a purchase error code from the coordinator, the portal or the local
 * agent (never the raw code). `info`: the refusal's `remainingSats`/`limitSats` when it has them.
 */
export function buyErrorText(code: string | null | undefined, info?: { remainingSats?: number | null; limitSats?: number | null } | null): string {
  const g = function (n: number) { return Math.floor(n).toLocaleString("en-US"); };
  const left = info && typeof info.remainingSats === "number" ? Math.max(0, info.remainingSats) : null;
  const cap = info && typeof info.limitSats === "number" ? info.limitSats : null;
  switch (code) {
    case "launch_buy_daily_cap":
      if (left === 0) return "You've reached today's early-access limit" + (cap ? " of " + g(cap) + " sats" : "") + ". You can buy more once some of today's purchases are 24 hours old.";
      return "That's over today's early-access limit." + (left !== null ? " You can buy up to " + g(left) + " sats more today." : "");
    case "launch_balance_cap":
      if (left === 0) return "Your balance is at the early-access limit" + (cap ? " of " + g(cap) + " cSats" : "") + ". Spend some cSats before buying more.";
      return "That would take your balance over the early-access limit" + (cap ? " of " + g(cap) + " cSats" : "") + "." + (left !== null ? " You can add up to " + g(left) + " cSats now." : "");
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
