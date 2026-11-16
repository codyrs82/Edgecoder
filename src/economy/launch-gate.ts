// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { PayoutLimits } from "./payout-safeguards.js";

/**
 * Soft launch: LAUNCH_MODE=invite on the portal and the coordinators (docs/going-to-mainnet.md,
 * "Soft launch").
 *
 * - Portal: a new account needs an invite code an admin minted (Settings > Admin). Existing
 *   accounts are grandfathered: sign-in, OAuth sign-in and re-signups of an existing agent key
 *   need no code.
 * - Coordinator: low per-account caps on top of everything else.
 *   - LAUNCH_MAX_BUY_SATS_PER_DAY: sats one account may buy per rolling 24 h (paid and still-open
 *     invoices count, so several open invoices cannot add up past it).
 *   - LAUNCH_MAX_BALANCE_SATS: cSats an account may hold after a purchase (its balance plus open
 *     invoices plus the new one). Earnings are not capped.
 *   - LAUNCH_MAX_PAYOUT_SATS_PER_DAY: layered under PAYOUT_MAX_ACCOUNT_DAILY_SATS (the lower of the
 *     two applies), for withdrawals and automatic payouts alike.
 *
 * LAUNCH_MODE=open (the default) turns all of this off. A cap of 0 means no cap.
 */

export type LaunchMode = "open" | "invite";

export interface LaunchConfig {
  mode: LaunchMode;
  /** Whole sats; 0 = no cap. Only applied in invite mode. */
  maxBuySatsPerDay: number;
  maxBalanceSats: number;
  maxPayoutSatsPerDay: number;
}

/** Caps applied in invite mode when the env leaves them unset. */
export const INVITE_DEFAULT_LIMITS = {
  maxBuySatsPerDay: 50_000,
  maxBalanceSats: 200_000,
  maxPayoutSatsPerDay: 50_000
} as const;

export const LAUNCH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** LAUNCH_MODE: "invite" turns the gate on; anything else (unset, "open") leaves it off. */
export function launchModeFromEnv(env: NodeJS.ProcessEnv = process.env): LaunchMode {
  return (env.LAUNCH_MODE ?? "").trim().toLowerCase() === "invite" ? "invite" : "open";
}

export function launchConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LaunchConfig {
  const num = (k: string, d: number) => {
    const v = env[k];
    if (v === undefined || v.trim() === "") return d;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`[launch] ${k} must be a whole number of sats >= 0`);
    return n;
  };
  return {
    mode: launchModeFromEnv(env),
    maxBuySatsPerDay: num("LAUNCH_MAX_BUY_SATS_PER_DAY", INVITE_DEFAULT_LIMITS.maxBuySatsPerDay),
    maxBalanceSats: num("LAUNCH_MAX_BALANCE_SATS", INVITE_DEFAULT_LIMITS.maxBalanceSats),
    maxPayoutSatsPerDay: num("LAUNCH_MAX_PAYOUT_SATS_PER_DAY", INVITE_DEFAULT_LIMITS.maxPayoutSatsPerDay)
  };
}

/** The lower of two caps where 0 means "no cap". */
function tighter(a: number, b: number): number {
  if (a <= 0) return Math.max(0, b);
  if (b <= 0) return a;
  return Math.min(a, b);
}

/** The payout caps with the launch cap layered under the per-account daily cap (invite mode only). */
export function layerLaunchPayoutLimits(limits: PayoutLimits, launch: LaunchConfig): PayoutLimits {
  if (launch.mode !== "invite") return limits;
  return { ...limits, maxAccountDailySats: tighter(limits.maxAccountDailySats, launch.maxPayoutSatsPerDay) };
}

export type LaunchBuyCode = "launch_buy_daily_cap" | "launch_balance_cap";

export interface LaunchBuyViolation {
  error: LaunchBuyCode;
  limitSats: number;
  /** Sats this account can still buy now (0 when none). */
  remainingSats: number;
  detail: string;
}

/**
 * Whether one more purchase fits the launch caps.
 * - `boughtWindowSats`: sats of this account's purchases created in the last 24 h that are paid
 *   or still payable (expired invoices excluded).
 * - `balanceSats` + `openCreditsSats`: cSats held now plus cSats that open invoices would add.
 * - `newCreditsSats`: cSats the new purchase adds (after the purchase fee).
 */
export function checkLaunchBuy(
  input: { amountSats: number; newCreditsSats: number; boughtWindowSats: number; balanceSats: number; openCreditsSats: number },
  launch: LaunchConfig
): LaunchBuyViolation | null {
  if (launch.mode !== "invite") return null;
  if (launch.maxBuySatsPerDay > 0 && input.boughtWindowSats + input.amountSats > launch.maxBuySatsPerDay) {
    const remainingSats = Math.max(0, Math.floor(launch.maxBuySatsPerDay - input.boughtWindowSats));
    return {
      error: "launch_buy_daily_cap",
      limitSats: launch.maxBuySatsPerDay,
      remainingSats,
      detail: `Early access: up to ${launch.maxBuySatsPerDay.toLocaleString("en-US")} sats of cSats per 24 hours. You can buy ${remainingSats.toLocaleString("en-US")} more now.`
    };
  }
  if (launch.maxBalanceSats > 0 && input.balanceSats + input.openCreditsSats + input.newCreditsSats > launch.maxBalanceSats) {
    const remainingSats = Math.max(0, Math.floor(launch.maxBalanceSats - input.balanceSats - input.openCreditsSats));
    return {
      error: "launch_balance_cap",
      limitSats: launch.maxBalanceSats,
      remainingSats,
      detail: `Early access: a balance of at most ${launch.maxBalanceSats.toLocaleString("en-US")} cSats. You can add ${remainingSats.toLocaleString("en-US")} more now.`
    };
  }
  return null;
}

/** What the wallet shows: the mode, the caps, and what was bought in the current window. */
export interface LaunchPolicyView {
  mode: LaunchMode;
  maxBuySatsPerDay: number;
  maxBalanceSats: number;
  maxPayoutSatsPerDay: number;
  boughtWindowSats?: number;
}

export function launchPolicyView(launch: LaunchConfig, boughtWindowSats?: number): LaunchPolicyView {
  if (launch.mode !== "invite") return { mode: "open", maxBuySatsPerDay: 0, maxBalanceSats: 0, maxPayoutSatsPerDay: 0 };
  return {
    mode: "invite",
    maxBuySatsPerDay: launch.maxBuySatsPerDay,
    maxBalanceSats: launch.maxBalanceSats,
    maxPayoutSatsPerDay: launch.maxPayoutSatsPerDay,
    ...(boughtWindowSats !== undefined ? { boughtWindowSats } : {})
  };
}

/** Purchase totals for the caps, from an account's payment intents (memory mode or a store's rows). */
export function launchBuyUsage(
  intents: Iterable<{ accountId: string; amountSats: number; quotedCredits: number; status: string; createdAtMs: number }>,
  accountId: string,
  nowMs: number,
  intentTtlMs: number
): { boughtWindowSats: number; openCreditsSats: number } {
  let boughtWindowSats = 0;
  let openCreditsSats = 0;
  for (const i of intents) {
    if (i.accountId !== accountId || i.createdAtMs < nowMs - LAUNCH_WINDOW_MS) continue;
    const open = i.status === "created" && nowMs - i.createdAtMs <= intentTtlMs;
    if (i.status === "settled" || open) boughtWindowSats += i.amountSats;
    if (open) openCreditsSats += Number(i.quotedCredits) || 0;
  }
  return { boughtWindowSats, openCreditsSats };
}
