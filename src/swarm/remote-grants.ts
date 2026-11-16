// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Cross-coordinator execution grants: a subtask offered to peer coordinators (task_offer) runs on
 * at most one coordinator. The origin is the only authority: a peer that wants to run an offered
 * subtask asks for it (task_claim, sent to the origin) and waits for the answer before any of its
 * agents may claim it. The origin grants it to the first peer that asks while its own copy is still
 * queued and unclaimed, and takes that copy off its queue; every later claim, by a peer or by a
 * local agent, finds nothing to take.
 *
 * The origin accepts the forwarded result only from the granted peer, once, and answers with what it
 * charged its requester for the work; the peer pays its agent at most that (results.ts). A grant
 * whose result never comes back expires and the subtask is queued again at the origin; a late
 * result from the expired grant is refused, so it is not paid twice.
 */
import type { Subtask } from "../common/types.js";

export interface RemoteGrant {
  subtask: Subtask;
  peerId: string;
  grantedAtMs: number;
  deadlineMs: number;
  /** A forwarded result for this grant is being processed. */
  inProgress: boolean;
}

export type GrantDecision = { granted: true; ttlMs: number } | { granted: false; reason: string };

export type ForwardAdmission =
  | { kind: "accept"; grant: RemoteGrant }
  | { kind: "duplicate"; chargedMsat: number }
  | { kind: "in_progress" }
  | { kind: "not_granted" };

/** How long a peer has, beyond the subtask's own time limit, to queue, run and forward it. */
export const REMOTE_GRANT_SLACK_MS = 120_000;
/** A settled grant is remembered this long, so a re-sent forward gets the same answer and no second charge. */
export const SETTLED_GRANT_TTL_MS = 30 * 60_000;
const MAX_SETTLED = 50_000;

export function remoteGrantTtlMs(timeoutMs: number, maxTimeoutMs: number): number {
  const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, maxTimeoutMs) : maxTimeoutMs;
  return t + REMOTE_GRANT_SLACK_MS;
}

export class RemoteGrantBook {
  private readonly grants = new Map<string, RemoteGrant>();
  private readonly settled = new Map<string, { peerId: string; chargedMsat: number; expiresAtMs: number }>();

  get(subtaskId: string): RemoteGrant | undefined {
    return this.grants.get(subtaskId);
  }

  /** Record a grant (the caller has already taken the subtask off its own queue). */
  grant(subtask: Subtask, peerId: string, nowMs: number, ttlMs: number): RemoteGrant {
    const g: RemoteGrant = { subtask, peerId, grantedAtMs: nowMs, deadlineMs: nowMs + ttlMs, inProgress: false };
    this.grants.set(subtask.id, g);
    return g;
  }

  /** The same peer asking again for a subtask it holds gets the same grant; anyone else is refused. */
  regrant(subtaskId: string, peerId: string, nowMs: number): GrantDecision | undefined {
    const g = this.grants.get(subtaskId);
    if (!g) return this.settled.has(subtaskId) ? { granted: false, reason: "already_settled" } : undefined;
    if (g.peerId !== peerId) return { granted: false, reason: "granted_elsewhere" };
    return { granted: true, ttlMs: Math.max(0, g.deadlineMs - nowMs) };
  }

  /** Subtasks of `taskId` running on a peer (not yet settled): the task is not finished while any are. */
  openCountForTask(taskId: string): number {
    let n = 0;
    for (const g of this.grants.values()) if (g.subtask.taskId === taskId) n++;
    return n;
  }

  /** What a settled grant to `peerId` was charged (a re-sent forward), else undefined. */
  settledCharge(subtaskId: string, peerId: string, nowMs: number): number | undefined {
    const done = this.settled.get(subtaskId);
    return done && done.expiresAtMs > nowMs && done.peerId === peerId ? done.chargedMsat : undefined;
  }

  /** A forwarded result from `peerId` for `subtaskId`: is it the granted one? Marks it in progress. */
  admitForward(subtaskId: string, peerId: string, nowMs: number): ForwardAdmission {
    const done = this.settled.get(subtaskId);
    if (done && done.expiresAtMs > nowMs) return done.peerId === peerId ? { kind: "duplicate", chargedMsat: done.chargedMsat } : { kind: "not_granted" };
    const g = this.grants.get(subtaskId);
    if (!g || g.peerId !== peerId) return { kind: "not_granted" };
    if (g.inProgress) return { kind: "in_progress" };
    g.inProgress = true;
    return { kind: "accept", grant: g };
  }

  /** The forwarded result was recorded: the grant is closed with what the requester was charged. */
  settle(subtaskId: string, chargedMsat: number, nowMs: number): void {
    const g = this.grants.get(subtaskId);
    if (!g) return;
    this.grants.delete(subtaskId);
    this.pruneSettled(nowMs);
    this.settled.set(subtaskId, { peerId: g.peerId, chargedMsat, expiresAtMs: nowMs + SETTLED_GRANT_TTL_MS });
  }

  /** Processing the forwarded result failed before anything was recorded: it may be sent again. */
  release(subtaskId: string): void {
    const g = this.grants.get(subtaskId);
    if (g) g.inProgress = false;
  }

  /** Remove and return grants past their deadline (none being processed). */
  expire(nowMs: number): RemoteGrant[] {
    const out: RemoteGrant[] = [];
    for (const [id, g] of this.grants) {
      if (g.inProgress || g.deadlineMs > nowMs) continue;
      this.grants.delete(id);
      out.push(g);
    }
    return out;
  }

  size(): number {
    return this.grants.size;
  }

  private pruneSettled(nowMs: number): void {
    for (const [id, s] of this.settled) {
      if (s.expiresAtMs > nowMs && this.settled.size < MAX_SETTLED) break;
      this.settled.delete(id);
    }
  }
}
