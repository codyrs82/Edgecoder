// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Reserved capacity: an account holds one agent of a compute class for a set time, paid up front
 * in cSats. While the lease runs the agent takes that account's jobs first (and those jobs aren't
 * billed per second: the lease covers them). A lease that opted in to backfill (`backfill`) lets
 * the agent take small network calls while the holder has none queued or running; those are billed
 * to their submitters and the host-side earnings are split with the holder
 * (src/economy/reservation-backfill.ts, docs/reservation-backfill.md). Otherwise the agent takes
 * only the lease's jobs. When it ends (time up, cancelled, or the agent went
 * offline) the agent is paid for the time it was held, minus the network fee, and the rest is
 * refunded to the account. A lease whose agent went offline is held until the agent was last seen
 * (its last heartbeat, clamped to the lease), not until the coordinator noticed: the time
 * the machine was already gone is refunded. With no last-seen time known (0 or missing: a clean
 * goodbye without a shared store, or a coordinator restart without Postgres) it falls back to the
 * time the coordinator noticed.
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
  /**
   * Paid buyer → host directly (src/economy/direct/reservations-direct.ts), not from cSats: ending
   * it moves no cSats (no payout, no refund); usedMsat/refundMsat are informational, and a refund
   * of unused time (host offline) is owed by the host. Absent on prepaid leases.
   */
  direct?: { rail: "lightning" | "onchain" | "zcash"; receiptIds: string[] };
  /**
   * "Let the network use my idle time": while the holder has no lease job queued or running, the
   * agent may take small network calls (docs/reservation-backfill.md). Absent on leases made
   * before backfill existed: off.
   */
  backfill?: boolean;
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

/**
 * When a lease whose agent went offline is billed to: the agent's last-seen time (registration,
 * heartbeat or mesh activity; newest any coordinator recorded), clamped to [startMs, endMs]. Unknown (undefined or 0, as
 * after a clean goodbye) falls back to `detectedAtMs`, the time the coordinator noticed.
 */
export function offlineEndMs(r: Pick<Reservation, "startMs" | "endMs">, lastSeenMs: number | undefined, detectedAtMs: number): number {
  const at = lastSeenMs !== undefined && lastSeenMs > 0 ? lastSeenMs : detectedAtMs;
  return Math.max(r.startMs, Math.min(r.endMs, at));
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

  /**
   * Active leases that should end now: time is up, or the agent hasn't been seen for a while.
   * `atMs` is when the lease is billed to: its end when expired; for an offline agent the time it
   * was last seen (offlineEndMs), else `now`.
   */
  due(now: number, lastSeenMs: (agentId: string) => number | undefined): Array<{ r: Reservation; reason: ReservationEndReason; atMs: number }> {
    const out: Array<{ r: Reservation; reason: ReservationEndReason; atMs: number }> = [];
    for (const r of this.byId.values()) {
      if (r.status !== "active") continue;
      if (now >= r.endMs) out.push({ r, reason: "expired", atMs: r.endMs });
      else {
        const seen = lastSeenMs(r.agentId);
        if (seen === undefined || now - seen > RESERVATION_OFFLINE_MS) out.push({ r, reason: "agent_offline", atMs: offlineEndMs(r, seen, now) });
      }
    }
    return out;
  }

  /** Mark a lease ended and work out the split (the caller pays and refunds, idempotently). */
  end(id: string, atMs: number, reason: ReservationEndReason): Reservation | undefined {
    const ended = this.endedCopy(id, atMs, reason);
    if (ended) this.byId.set(id, ended);
    return ended;
  }

  /** What ending the lease now would record, without changing the book (see claimReservationEnd). */
  endedCopy(id: string, atMs: number, reason: ReservationEndReason): Reservation | undefined {
    const r = this.byId.get(id);
    if (!r || r.status !== "active") return undefined;
    const endAt = reason === "expired" ? r.endMs : Math.max(r.startMs, Math.min(atMs, r.endMs));
    const { usedMsat, refundMsat } = reservationUsage(r, endAt);
    return { ...r, status: "ended", endedAtMs: endAt, endReason: reason, usedMsat, refundMsat };
  }

  /** Replace one lease with the stored (authoritative) copy. */
  put(r: Reservation): void {
    this.byId.set(r.id, r);
  }

  /** Ids of the leases still active in this book. */
  activeAgentIds(): string[] {
    return [...new Set([...this.byId.values()].filter((r) => r.status === "active").map((r) => r.agentId))];
  }

  prune(now = Date.now()): void {
    for (const [id, r] of this.byId) if (r.status === "ended" && now - (r.endedAtMs ?? 0) > 7 * 24 * 3_600_000) this.byId.delete(id);
  }
}

/**
 * Leases across coordinators. Every coordinator on one database holds a ReservationBook; the
 * compute_reservations table is the source of truth. A coordinator refreshes its book from it,
 * judges "agent offline" by the newest heartbeat any coordinator recorded (agent_registry), and
 * ends a lease only by winning a compare-and-set on the stored row, so exactly one coordinator
 * pays the agent and refunds the requester.
 */
export interface SharedReservationStore {
  listReservations(): Promise<Reservation[]>;
  getReservation(id: string): Promise<Reservation | null>;
  /** Stores `ended` only if the stored lease is still active (or absent). True = this caller won. */
  endReservationIfActive(ended: Reservation): Promise<boolean>;
  /** Newest heartbeat any coordinator recorded for each agent. */
  agentLastSeenMs(agentIds: string[]): Promise<Map<string, number>>;
}

/** Load every stored lease into the book (stored state wins over what this coordinator remembers). */
export async function syncReservations(book: ReservationBook, store: SharedReservationStore | null | undefined): Promise<void> {
  if (!store) return;
  book.load(await store.listReservations());
}

/** Active leases due to end, using this coordinator's and every other coordinator's view of the agent. */
export async function dueReservations(
  book: ReservationBook,
  store: SharedReservationStore | null | undefined,
  now: number,
  localLastSeenMs: (agentId: string) => number | undefined
): Promise<Array<{ r: Reservation; reason: ReservationEndReason; atMs: number }>> {
  const shared = store ? await store.agentLastSeenMs(book.activeAgentIds()) : new Map<string, number>();
  return book.due(now, (agentId) => {
    const local = localLastSeenMs(agentId);
    const remote = shared.get(agentId);
    if (local === undefined) return remote;
    return remote === undefined ? local : Math.max(local, remote);
  });
}

/**
 * End a lease once across coordinators. Returns the ended lease when this caller won (it must
 * then settle it); undefined when it was not active here or another coordinator ended it first
 * (the book then holds the stored copy). A store error leaves the lease active so a later tick retries.
 */
export async function claimReservationEnd(
  book: ReservationBook,
  store: SharedReservationStore | null | undefined,
  id: string,
  atMs: number,
  reason: ReservationEndReason
): Promise<Reservation | undefined> {
  const ended = book.endedCopy(id, atMs, reason);
  if (!ended) return undefined;
  if (!store) {
    book.put(ended);
    return ended;
  }
  if (await store.endReservationIfActive(ended)) {
    book.put(ended);
    return ended;
  }
  const stored = await store.getReservation(id);
  if (stored) book.put(stored);
  return undefined;
}
