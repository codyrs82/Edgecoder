// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Whether the agent's mesh WebSocket is one the coordinator actually counts (network run 12).
 *
 * In run 12 the owner's Mac (desktop app) believed its mesh WebSocket was open: it sent the
 * 10-minute model-state report that only an open socket sends, and pings kept it alive. The
 * coordinator never counted a socket for it (admin network view `socketConnected: false` for the
 * whole run, and in every earlier run) and saw no /mesh/ws attempt from it in 50 minutes. So the
 * agent got no work_available nudges, yet idled at the slower "nudges arrive" poll, and calls placed
 * on it were not claimed within the decision window.
 *
 * The coordinator now says in each heartbeat reply whether it holds an authenticated open socket
 * for the agent (`socketConnected`). This class turns those answers into two decisions:
 *  - poll at the fast idle pace unless nudges can actually arrive (`nudgesExpected`);
 *  - reopen a socket the coordinator keeps denying (`observe` returns "reopen"), with a growing
 *    pause between reopens while it never confirms one.
 * A coordinator that does not send the field (older version) changes nothing.
 */

/** A socket this young may still be binding on the coordinator: its denials are not counted. */
export const MESH_SOCKET_CONFIRM_GRACE_MS = 15_000;
/** Consecutive heartbeat denials (past the grace) before the socket is reopened. */
export const MESH_SOCKET_DENIALS_BEFORE_REOPEN = 2;
/** First pause between reopens of unconfirmed sockets; doubles up to the max. */
export const MESH_SOCKET_REOPEN_MIN_INTERVAL_MS = 30_000;
export const MESH_SOCKET_REOPEN_MAX_INTERVAL_MS = 10 * 60_000;

export type MeshSocketVerdict = "ok" | "reopen";

export class MeshSocketConfirmation {
  private denials = 0;
  /** What the coordinator last said about the current socket; undefined = nothing yet or not said. */
  private lastSaid: boolean | undefined;
  private reopenInterval = MESH_SOCKET_REOPEN_MIN_INTERVAL_MS;
  private lastReopenAtMs = Number.NEGATIVE_INFINITY;

  /** A socket opened or closed: what the coordinator said about the previous one no longer applies. */
  socketChanged(): void {
    this.denials = 0;
    this.lastSaid = undefined;
  }

  /**
   * A heartbeat reply arrived. `coordinatorSays` is its `socketConnected` (undefined when the
   * coordinator does not send it); `openedAtMs` is when the local socket opened (null when none is open).
   */
  observe(input: { localOpen: boolean; openedAtMs: number | null; coordinatorSays: boolean | undefined; nowMs: number }): MeshSocketVerdict {
    const { localOpen, openedAtMs, coordinatorSays, nowMs } = input;
    if (typeof coordinatorSays !== "boolean") return "ok";
    this.lastSaid = coordinatorSays;
    if (coordinatorSays) {
      this.denials = 0;
      this.reopenInterval = MESH_SOCKET_REOPEN_MIN_INTERVAL_MS;
      return "ok";
    }
    if (!localOpen || openedAtMs === null || nowMs - openedAtMs < MESH_SOCKET_CONFIRM_GRACE_MS) return "ok";
    this.denials++;
    if (this.denials < MESH_SOCKET_DENIALS_BEFORE_REOPEN) return "ok";
    if (nowMs - this.lastReopenAtMs < this.reopenInterval) return "ok";
    // A reopen that never gets confirmed waits longer before the next one.
    if (Number.isFinite(this.lastReopenAtMs)) this.reopenInterval = Math.min(this.reopenInterval * 2, MESH_SOCKET_REOPEN_MAX_INTERVAL_MS);
    this.lastReopenAtMs = nowMs;
    this.denials = 0;
    return "reopen";
  }

  /** Nudges can arrive: a socket is open and the coordinator has not said it holds none. */
  nudgesExpected(localOpen: boolean): boolean {
    return localOpen && this.lastSaid !== false;
  }
}

/**
 * Idle waits that run much later than asked (macOS App Nap or timer coalescing on a background
 * app, a suspended laptop): counted, and reported at most once a minute so the next network run
 * can tell a throttled host from a slow coordinator.
 */
export const IDLE_WAIT_LATE_MS = 2_000;
export const IDLE_WAIT_LATE_REPORT_MS = 60_000;

export class IdleWaitLateness {
  private late = 0;
  private maxLateMs = 0;
  private lastReportAtMs: number | null = null;

  /** One idle wait finished; returns a log line when it is time to report late waits. */
  note(requestedMs: number, actualMs: number, nowMs: number): string | null {
    const lateMs = actualMs - requestedMs;
    if (lateMs >= IDLE_WAIT_LATE_MS) {
      this.late++;
      this.maxLateMs = Math.max(this.maxLateMs, lateMs);
    }
    if (this.late === 0) return null;
    if (this.lastReportAtMs !== null && nowMs - this.lastReportAtMs < IDLE_WAIT_LATE_REPORT_MS) return null;
    const line = `idle wait ran late ${this.late}x since the last report (worst ${Math.round(this.maxLateMs)} ms late): the OS is throttling this process's timers (App Nap, timer coalescing) or it was suspended`;
    this.lastReportAtMs = nowMs;
    this.late = 0;
    this.maxLateMs = 0;
    return line;
  }
}
