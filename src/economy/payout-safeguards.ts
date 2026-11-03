// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { BitcoinNetwork } from "../common/types.js";

/**
 * Hot-wallet safeguards in front of every outbound Lightning payment (docs/going-to-mainnet.md):
 *
 * - caps: a maximum single payout and maximum totals per rolling 24 h, per account and for the
 *   whole coordinator. Over-limit payouts are rejected (never queued): the balance stays payable,
 *   auto payouts simply skip, and nothing waits on an approval queue that could be drained later.
 * - kill switch: while paused, no withdrawal, auto payout or fee-pool distribution runs. Invoice
 *   based purchases (createInvoice / checkSettlement) are unaffected, so money can still come in.
 */

export const PAYOUT_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** All in sats; 0 = no cap. */
export interface PayoutLimits {
  maxSingleSats: number;
  maxAccountDailySats: number;
  maxGlobalDailySats: number;
}

/**
 * Applied on mainnet when the env leaves a cap unset. Sized for an early network's hot wallet:
 * one payout can never exceed 100k sats, one account 500k sats/day, the node 2M sats/day.
 * Set a variable to 0 to lift that cap deliberately.
 */
export const MAINNET_DEFAULT_PAYOUT_LIMITS: PayoutLimits = {
  maxSingleSats: 100_000,
  maxAccountDailySats: 500_000,
  maxGlobalDailySats: 2_000_000
};

const NO_LIMITS: PayoutLimits = { maxSingleSats: 0, maxAccountDailySats: 0, maxGlobalDailySats: 0 };

/** PAYOUT_MAX_SINGLE_SATS / PAYOUT_MAX_ACCOUNT_DAILY_SATS / PAYOUT_MAX_GLOBAL_DAILY_SATS. */
export function payoutLimitsFromEnv(network: BitcoinNetwork, env: NodeJS.ProcessEnv = process.env): PayoutLimits {
  const defaults = network === "bitcoin" ? MAINNET_DEFAULT_PAYOUT_LIMITS : NO_LIMITS;
  const num = (k: string, d: number) => {
    const v = env[k];
    if (v === undefined || v.trim() === "") return d;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`[payouts] ${k} must be a whole number of sats >= 0`);
    return n;
  };
  return {
    maxSingleSats: num("PAYOUT_MAX_SINGLE_SATS", defaults.maxSingleSats),
    maxAccountDailySats: num("PAYOUT_MAX_ACCOUNT_DAILY_SATS", defaults.maxAccountDailySats),
    maxGlobalDailySats: num("PAYOUT_MAX_GLOBAL_DAILY_SATS", defaults.maxGlobalDailySats)
  };
}

export function payoutLimitsActive(l: PayoutLimits): boolean {
  return l.maxSingleSats > 0 || l.maxAccountDailySats > 0 || l.maxGlobalDailySats > 0;
}

export type PayoutLimitCode = "payout_limit_single" | "payout_limit_account_daily" | "payout_limit_global_daily";

export interface PayoutLimitViolation {
  code: PayoutLimitCode;
  limitSats: number;
  /** msat the payout would bring the total to (amount + fee cap included). */
  wouldBeMsat: number;
}

/**
 * Pure cap check. `accountWindowMsat` / `globalWindowMsat` are the paid + pending payouts created
 * in the last 24 h (pending counted at their fee cap). The new payout counts at amount + fee cap,
 * so the caps bound what can actually leave the node, fees included.
 */
export function checkPayoutLimits(
  input: { amountMsat: number; maxFeeMsat: number; accountWindowMsat?: number; globalWindowMsat?: number },
  limits: PayoutLimits
): PayoutLimitViolation | null {
  const self = input.amountMsat + input.maxFeeMsat;
  if (limits.maxSingleSats > 0 && self > limits.maxSingleSats * 1000) return { code: "payout_limit_single", limitSats: limits.maxSingleSats, wouldBeMsat: self };
  if (limits.maxAccountDailySats > 0 && input.accountWindowMsat !== undefined) {
    const total = input.accountWindowMsat + self;
    if (total > limits.maxAccountDailySats * 1000) return { code: "payout_limit_account_daily", limitSats: limits.maxAccountDailySats, wouldBeMsat: total };
  }
  if (limits.maxGlobalDailySats > 0 && input.globalWindowMsat !== undefined) {
    const total = input.globalWindowMsat + self;
    if (total > limits.maxGlobalDailySats * 1000) return { code: "payout_limit_global_daily", limitSats: limits.maxGlobalDailySats, wouldBeMsat: total };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Kill switch                                                         */
/* ------------------------------------------------------------------ */

export type PauseSource = "env" | "admin" | "reconciliation";

export interface PayoutPauseState {
  paused: boolean;
  reason?: string;
  source?: PauseSource;
  changedBy?: string;
  changedAtMs?: number;
}

/** Where the shared pause flag lives: Postgres (both seeds, survives restarts) or memory. */
export interface PayoutPauseStore {
  getPayoutPause(): Promise<PayoutPauseState | null>;
  setPayoutPause(state: PayoutPauseState): Promise<void>;
}

export class MemoryPayoutPauseStore implements PayoutPauseStore {
  private state: PayoutPauseState | null = null;
  async getPayoutPause() {
    return this.state ? { ...this.state } : null;
  }
  async setPayoutPause(state: PayoutPauseState) {
    this.state = { ...state };
  }
}

/** PAYOUTS_PAUSED=1|true|yes|on. */
export function payoutsPausedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((env.PAYOUTS_PAUSED ?? "").trim().toLowerCase());
}

export type ResumeResult = { ok: true; state: PayoutPauseState } | { ok: false; code: "paused_by_env"; state: PayoutPauseState };

/**
 * The kill switch. PAYOUTS_PAUSED in the environment forces this instance paused and cannot be
 * lifted over HTTP (an operator with shell access decides, not whoever holds the admin token).
 * Otherwise the stored flag decides; an auto-pause by reconciliation is stored, so it holds across
 * restarts and on every instance sharing the database until an admin resumes.
 *
 * Reads fail closed: if the store cannot be read, payouts count as paused.
 */
export class PayoutPauseControl {
  constructor(
    private readonly d: { store: PayoutPauseStore; envPaused: boolean; now?: () => number; onChange?: (state: PayoutPauseState, previous: PayoutPauseState) => void | Promise<void> }
  ) {}

  async state(): Promise<PayoutPauseState> {
    if (this.d.envPaused) return { paused: true, source: "env", reason: "PAYOUTS_PAUSED is set in the environment" };
    try {
      return (await this.d.store.getPayoutPause()) ?? { paused: false };
    } catch (err) {
      return { paused: true, source: "reconciliation", reason: `pause state unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async isPaused(): Promise<boolean> {
    return (await this.state()).paused;
  }

  async pause(reason: string, source: Exclude<PauseSource, "env">, changedBy: string): Promise<PayoutPauseState> {
    const previous = await this.state();
    const next: PayoutPauseState = { paused: true, reason: reason.slice(0, 500), source, changedBy, changedAtMs: (this.d.now ?? Date.now)() };
    await this.d.store.setPayoutPause(next);
    await this.d.onChange?.(this.d.envPaused ? { ...next, source: "env" } : next, previous);
    return this.d.envPaused ? await this.state() : next;
  }

  async resume(changedBy: string, reason = "resumed by operator"): Promise<ResumeResult> {
    const previous = await this.state();
    if (this.d.envPaused) return { ok: false, code: "paused_by_env", state: previous };
    const next: PayoutPauseState = { paused: false, reason: reason.slice(0, 500), source: "admin", changedBy, changedAtMs: (this.d.now ?? Date.now)() };
    await this.d.store.setPayoutPause(next);
    await this.d.onChange?.(next, previous);
    return { ok: true, state: next };
  }
}
