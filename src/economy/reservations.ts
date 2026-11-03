// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Reserved capacity: an account holds one agent of a compute class for a set time, paid up front
 * in cSats. While the lease runs the agent takes only that account's jobs (and those jobs aren't
 * billed per second: the lease covers them). When it ends (time up, cancelled, or the agent went
 * offline) the agent is paid for the time it was held, minus the network fee, and the rest is
 * refunded to the account.
 *
 * Price: the class's reference per-second rate times the agent's tier weight, for every second
 * held, used or not (that is what holding a machine costs its owner).
 */

export type ReservationEndReason = "expired" | "cancelled" | "agent_offline";

export interface Reservation {
  id: string;
  accountId: string;
  agentId: string;
  /** The agent owner's account, paid when the lease ends. */
  agentAccountId: string;
  computeClass: string;
  tier?: string;
  creditsPerSecond: number;
  model?: string;
  startMs: number;
  endMs: number;
  ratePerSecondMsat: number;
  prepaidMsat: number;
  status: "active" | "ended";
  endedAtMs?: number;
  endReason?: ReservationEndReason;
  usedMsat?: number;
  refundMsat?: number;
}

export const RESERVATION_MIN_MINUTES = 5;
export const RESERVATION_MAX_MINUTES = 24 * 60;
/** An agent unseen this long ends its lease early (the unused time is refunded). */
export const RESERVATION_OFFLINE_MS = 2 * 60_000;

/** What a lease costs up front. */
export function reservationPriceMsat(minutes: number, ratePerSecondMsat: number): number {
  return Math.ceil(Math.max(0, minutes) * 60 * Math.max(0, ratePerSecondMsat));
}

/** What the held time used up when a lease ends at `atMs`, never more than was paid. */
export function reservationUsage(r: Pick<Reservation, "startMs" | "endMs" | "ratePerSecondMsat" | "prepaidMsat">, atMs: number): { usedMsat: number; refundMsat: number } {
  const heldMs = Math.max(0, Math.min(atMs, r.endMs) - r.startMs);
  const usedMsat = Math.min(r.prepaidMsat, Math.round((heldMs / 1000) * r.ratePerSecondMsat));
  return { usedMsat, refundMsat: r.prepaidMsat - usedMsat };
}

export class ReservationBook {
  private readonly byId = new Map<string, Reservation>();

  load(list: Reservation[]): void {
    for (const r of list) this.byId.set(r.id, r);
  }

  get(id: string): Reservation | undefined {
    return this.byId.get(id);
  }

  add(r: Reservation): void {
    this.byId.set(r.id, r);
  }

  /** The lease holding this agent now, if any. */
  activeForAgent(agentId: string, now = Date.now()): Reservation | undefined {
    for (const r of this.byId.values()) if (r.status === "active" && r.agentId === agentId && now < r.endMs) return r;
    return undefined;
  }

  isHeld(agentId: string, now = Date.now()): boolean {
    return this.activeForAgent(agentId, now) !== undefined;
  }

  /** An account's leases, newest first (ended ones kept for a day). */
  listForAccount(accountId: string, now = Date.now()): Reservation[] {
    return [...this.byId.values()]
      .filter((r) => r.accountId === accountId && (r.status === "active" || now - (r.endedAtMs ?? 0) < 24 * 3_600_000))
      .sort((a, b) => b.startMs - a.startMs);
  }

  /** Active leases that should end now: time is up, or the agent hasn't been seen for a while. */
  due(now: number, lastSeenMs: (agentId: string) => number | undefined): Array<{ r: Reservation; reason: ReservationEndReason }> {
    const out: Array<{ r: Reservation; reason: ReservationEndReason }> = [];
    for (const r of this.byId.values()) {
      if (r.status !== "active") continue;
      if (now >= r.endMs) out.push({ r, reason: "expired" });
      else {
        const seen = lastSeenMs(r.agentId);
        if (seen === undefined || now - seen > RESERVATION_OFFLINE_MS) out.push({ r, reason: "agent_offline" });
      }
    }
    return out;
  }

  /** Mark a lease ended and work out the split (the caller pays and refunds, idempotently). */
  end(id: string, atMs: number, reason: ReservationEndReason): Reservation | undefined {
    const r = this.byId.get(id);
    if (!r || r.status !== "active") return undefined;
    const endAt = reason === "expired" ? r.endMs : Math.min(atMs, r.endMs);
    const { usedMsat, refundMsat } = reservationUsage(r, endAt);
    Object.assign(r, { status: "ended", endedAtMs: endAt, endReason: reason, usedMsat, refundMsat });
    return r;
  }

  prune(now = Date.now()): void {
    for (const [id, r] of this.byId) if (r.status === "ended" && now - (r.endedAtMs ?? 0) > 7 * 24 * 3_600_000) this.byId.delete(id);
  }
}
