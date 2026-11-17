// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Reservation backfill (docs/reservation-backfill.md): while a lease holder is not using the
 * machine they reserved, the machine may take small, preemptible network model calls. The lease
 * is unchanged (the holder still pays for every second held, the host is still paid for them);
 * a backfill call is billed to whoever submitted it at the normal network price, and what the
 * host side earns for it (after the network fee) is split between the lease holder and the host.
 *
 * This module is pure: config, the earnings split, the slot cap and the eligibility decision.
 * The coordinator wiring is src/swarm/coordinator/backfill.ts.
 */

export interface BackfillConfig {
  /** Off: no lease takes backfill, whatever it chose (kill switch). */
  enabled: boolean;
  /** What a new lease gets when its request does not say (`backfill` field). */
  defaultOn: boolean;
  /** Holder's share of the host-side earnings (after the network fee), in basis points. */
  holderShareBps: number;
  /** Largest call taken as backfill: prompt + reply room, tokens (contextNeeded). */
  maxTokens: number;
  /** Longest expected run of a backfill call on the agent (prefill + decode), and the run time after which it may be preempted. */
  maxSeconds: number;
  /** Share of the agent's model slots backfill may hold at once (at least 1, and at least one slot left free when it has 2+). */
  slotFraction: number;
}

export const DEFAULT_BACKFILL_CONFIG: BackfillConfig = {
  enabled: true,
  defaultOn: true,
  holderShareBps: 5_000,
  maxTokens: 8_192,
  maxSeconds: 15,
  slotFraction: 0.5,
};

/** The config from RESERVATION_BACKFILL_* variables; a missing or invalid value keeps its default. */
export function backfillConfigFromEnv(env: Record<string, string | undefined> = process.env): BackfillConfig {
  const d = DEFAULT_BACKFILL_CONFIG;
  const num = (v: string | undefined, def: number, min: number, max: number) => {
    const n = Number(v);
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? n : def;
  };
  const flag = (v: string | undefined, def: boolean) => {
    const s = (v ?? "").trim().toLowerCase();
    if (["1", "true", "on", "yes"].includes(s)) return true;
    if (["0", "false", "off", "no"].includes(s)) return false;
    return def;
  };
  return {
    enabled: flag(env.RESERVATION_BACKFILL, d.enabled),
    defaultOn: flag(env.RESERVATION_BACKFILL_DEFAULT, d.defaultOn),
    holderShareBps: Math.round(num(env.RESERVATION_BACKFILL_HOLDER_SHARE, d.holderShareBps / 10_000, 0, 1) * 10_000),
    maxTokens: Math.floor(num(env.RESERVATION_BACKFILL_MAX_TOKENS, d.maxTokens, 256, 1_000_000)),
    maxSeconds: num(env.RESERVATION_BACKFILL_MAX_SECONDS, d.maxSeconds, 1, 600),
    slotFraction: num(env.RESERVATION_BACKFILL_SLOT_FRACTION, d.slotFraction, 0, 1),
  };
}

/**
 * Split the host-side earnings of one backfill call (agentMsat: the cost less the network fee)
 * between the lease holder and the host. Whole msat; the holder's part is rounded down, so
 * holderMsat + hostMsat === agentMsat exactly.
 */
export function splitBackfillEarnings(agentMsat: number, holderShareBps: number): { holderMsat: number; hostMsat: number } {
  const total = Math.max(0, Math.round(agentMsat));
  const bps = Math.max(0, Math.min(10_000, Math.floor(holderShareBps)));
  const holderMsat = Math.floor((total * bps) / 10_000);
  return { holderMsat, hostMsat: total - holderMsat };
}

/**
 * Model slots backfill may hold at once on an agent with `slots` slots: `slotFraction` of them,
 * rounded down, at least 1; with 2 or more slots at least one always stays free for the holder.
 * 0 when slotFraction is 0.
 */
export function backfillSlotCap(slots: number, slotFraction: number): number {
  const n = Math.max(1, Math.floor(slots));
  if (!(slotFraction > 0)) return 0;
  const cap = Math.max(1, Math.floor(n * Math.min(1, slotFraction)));
  return n >= 2 ? Math.min(cap, n - 1) : cap;
}

/** Ledger reasons of the two earn rows a backfill call writes (the network fee row is unchanged). */
export const BACKFILL_HOLDER_REASON_PREFIX = "reservation_backfill_holder:";
export const BACKFILL_HOST_REASON_PREFIX = "reservation_backfill_host:";
export const backfillHolderReason = (reservationId: string) => `${BACKFILL_HOLDER_REASON_PREFIX}${reservationId}`;
export const backfillHostReason = (reservationId: string) => `${BACKFILL_HOST_REASON_PREFIX}${reservationId}`;

/** What the lease and its agent look like right now (one queue scan per pull). */
export interface LeaseActivity {
  /** The lease opted in to backfill. */
  optedIn: boolean;
  /** The agent is live, not blacklisted, its circuit closed and its memory not under pressure. */
  healthy: boolean;
  /** Lease jobs queued and not yet claimed (any: claimable or not). */
  leaseQueued: number;
  /** Lease jobs the agent is running. */
  leaseRunning: number;
  /** Network (backfill) calls the agent is running. */
  backfillRunning: number;
  /** The agent's model slots (1 when it reports none). */
  slots: number;
}

export type BackfillGateReason = "disabled" | "not_opted_in" | "unhealthy" | "lease_job_waiting" | "lease_job_running" | "slot_cap";

/** May the agent start a new backfill call now (before looking at the call itself)? */
export function backfillGate(a: LeaseActivity, cfg: BackfillConfig): { open: true } | { open: false; reason: BackfillGateReason } {
  if (!cfg.enabled) return { open: false, reason: "disabled" };
  if (!a.optedIn) return { open: false, reason: "not_opted_in" };
  if (!a.healthy) return { open: false, reason: "unhealthy" };
  // Lease jobs go first: none starts behind backfill, and none waits while backfill starts.
  if (a.leaseQueued > 0) return { open: false, reason: "lease_job_waiting" };
  if (a.leaseRunning > 0) return { open: false, reason: "lease_job_running" };
  if (a.backfillRunning >= backfillSlotCap(a.slots, cfg.slotFraction)) return { open: false, reason: "slot_cap" };
  return { open: true };
}

/** The call itself: what is known about it at claim time. */
export interface BackfillCandidate {
  kind: string;
  /** A lease job (any lease) or an own-machines job: never backfill. */
  reservationId?: string;
  onlyAccountId?: string;
  /** A restricted (security research) model. */
  restricted: boolean;
  /** Paid from the buyer's own wallet (NWC): its host tally has no holder share, so it is not taken. */
  nwc: boolean;
  /** The model is loaded on the agent now (no load that would evict the holder's model). */
  modelLoaded: boolean;
  /** Prompt + reply room (contextNeeded), tokens. */
  tokensNeeded: number;
  /** Expected run time on this agent (prefill + decode of the expected reply), seconds. */
  expectedSeconds: number;
}

export type BackfillCallReason = "not_inference" | "lease_or_own_job" | "restricted" | "nwc_billed" | "model_not_loaded" | "too_many_tokens" | "too_long";

/** Is this call small and plain enough to run as backfill? */
export function backfillCallEligible(c: BackfillCandidate, cfg: BackfillConfig): { ok: true } | { ok: false; reason: BackfillCallReason } {
  if (c.kind !== "inference") return { ok: false, reason: "not_inference" };
  if (c.reservationId || c.onlyAccountId) return { ok: false, reason: "lease_or_own_job" };
  if (c.restricted) return { ok: false, reason: "restricted" };
  if (c.nwc) return { ok: false, reason: "nwc_billed" };
  if (!c.modelLoaded) return { ok: false, reason: "model_not_loaded" };
  if (!(c.tokensNeeded <= cfg.maxTokens)) return { ok: false, reason: "too_many_tokens" };
  if (!(c.expectedSeconds <= cfg.maxSeconds)) return { ok: false, reason: "too_long" };
  return { ok: true };
}

/**
 * Backfill calls to preempt: running longer than the cap while a lease job waits. Only those whose
 * requester has seen nothing yet can be handed to another agent (the caller checks that and does
 * the requeue); the rest finish.
 */
export function overrunBackfill<T extends { claimedAtMs: number }>(running: T[], leaseQueued: number, nowMs: number, cfg: BackfillConfig): T[] {
  if (leaseQueued <= 0) return [];
  return running.filter((r) => nowMs - r.claimedAtMs > cfg.maxSeconds * 1000);
}
