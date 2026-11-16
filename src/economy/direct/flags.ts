// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Payment paths (owner decision 2026-11-16, hybrid model; docs/design/noncustodial-payments.md).
 *
 * - `prepaid`: the closed-loop cSats wallet for spot, on-demand compute (Buy cSats, reserve and
 *   settle per call). On by default; this is today's path.
 * - `directReservations`: reservations, blocks of time and server commitments paid buyer → host
 *   directly (Lightning, on-chain BTC, Zcash), with the 5 % fee paid directly to EdgeCoder. Off by
 *   default; on under NODE_ENV=test. Turn on with PAYMENTS_DIRECT_RESERVATIONS=1.
 * - `nwc`: pay-as-you-go from the buyer's own wallet over Nostr Wallet Connect (a per-(buyer, host)
 *   tally settled in sats). Optional; off unless PAYMENTS_NWC=1.
 *
 * None of these change a live coordinator until its environment sets them.
 */

export interface PaymentFlags {
  prepaid: boolean;
  directReservations: boolean;
  nwc: boolean;
}

function flag(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  return fallback;
}

export function paymentFlags(env: NodeJS.ProcessEnv = process.env): PaymentFlags {
  const test = env.NODE_ENV === "test";
  return {
    prepaid: flag(env.PAYMENTS_PREPAID, true),
    directReservations: flag(env.PAYMENTS_DIRECT_RESERVATIONS, test),
    nwc: flag(env.PAYMENTS_NWC, false),
  };
}

/** Numbers for the NWC tally (env overrides; sats). */
export interface TallyLimits {
  settleMinSats: number;
  maxUnsettledSats: number;
  settleIntervalMs: number;
  maxFailures: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function tallyLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): TallyLimits {
  return {
    settleMinSats: positiveInt(env.SETTLE_MIN_SATS, 200),
    maxUnsettledSats: positiveInt(env.MAX_UNSETTLED_SATS, 500),
    settleIntervalMs: positiveInt(env.SETTLE_INTERVAL_MS, 3_600_000),
    maxFailures: positiveInt(env.SETTLE_MAX_FAILURES, 3),
  };
}
