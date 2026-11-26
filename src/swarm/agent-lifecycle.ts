// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The worker's own view of whether it may take network work right now, for BHV006 (abandoned
 * claims) and for the desktop app:
 *
 *  - draining: the app is about to restart (an update) or quit, or the process is stopping. The
 *    worker pulls nothing new and tells the coordinator it is going offline (a heartbeat with
 *    goingOffline), which hands any claims it holds to other agents at once: no abandoned claims.
 *    A drain the app asked for lapses by itself, so a restart that never happens doesn't leave the
 *    machine idle for good.
 *  - paused: the coordinator refused this agent (blacklisted). The reason is kept so the app can
 *    say "This Mac was paused by the network's safety check: <reason>" instead of "not connected".
 *  - claims: subtasks pulled from the coordinator that are running now (the app's update restart
 *    waits while there are any).
 */

import type { MemoryStatusView } from "./memory-manager.js";

export type GoingOfflineReason = "update" | "quit" | "sleep" | "shutdown" | "drain";

export interface PausedState {
  reason: string;
  sinceMs: number;
}

export interface LifecycleStatus {
  paused: PausedState | null;
  draining: boolean;
  drainingUntilMs: number | null;
  claims: number;
  /** Host memory: pressure, budget, loaded and served models (src/swarm/memory-manager.ts). */
  memory?: MemoryStatusView;
}

/** How long a drain the app asked for lasts when the restart doesn't come. */
export const DEFAULT_DRAIN_MS = 3 * 60_000;

export class AgentLifecycle {
  private paused: PausedState | null = null;
  private drainingUntilMs = 0;
  private claims = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The coordinator refused this agent as blacklisted. */
  notePaused(reason: string): void {
    if (this.paused?.reason === reason) return;
    this.paused = { reason, sinceMs: this.now() };
  }

  /** The coordinator accepted a register or heartbeat: no longer paused. */
  noteAccepted(): void {
    this.paused = null;
  }

  /** Stop pulling new work for `ms` (Infinity: until the process ends). */
  startDrain(ms: number = DEFAULT_DRAIN_MS): void {
    this.drainingUntilMs = Math.max(this.drainingUntilMs, ms === Infinity ? Infinity : this.now() + Math.max(0, ms));
  }

  /** Take work again (the restart was put off). */
  endDrain(): void {
    if (this.drainingUntilMs !== Infinity) this.drainingUntilMs = 0;
  }

  draining(): boolean {
    return this.now() < this.drainingUntilMs;
  }

  canPull(): boolean {
    return !this.draining() && !this.paused;
  }

  /** A claim pulled from the coordinator started running; call the returned function once it ends. */
  claimStarted(): () => void {
    this.claims += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.claims = Math.max(0, this.claims - 1);
    };
  }

  status(): LifecycleStatus {
    const draining = this.draining();
    return {
      paused: this.paused ? { ...this.paused } : null,
      draining,
      drainingUntilMs: draining && Number.isFinite(this.drainingUntilMs) ? this.drainingUntilMs : null,
      claims: this.claims,
    };
  }
}

/**
 * The blacklist reason in a coordinator refusal, e.g. the worker's
 * `POST /register failed (403): {"error":"agent_blacklisted","reason":"Auto-blacklisted ..."}`.
 * Null when the error is anything else.
 */
export function blacklistReasonFromError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!message.includes("agent_blacklisted")) return null;
  const brace = message.indexOf("{");
  if (brace >= 0) {
    try {
      const body = JSON.parse(message.slice(brace)) as { error?: unknown; reason?: unknown };
      if (body.error === "agent_blacklisted") return typeof body.reason === "string" && body.reason ? body.reason : "blacklisted";
    } catch {
      // not JSON: fall through
    }
  }
  return "blacklisted";
}

/**
 * Critical memory pressure cancels the network calls running here and hands this agent's claims back.
 * With no call running there is nothing to hand back: any claim still held is one whose result is
 * already on its way (network run 17: a host handed a call back 3 ms after posting its finished
 * result, and another host ran it again). A claim still waiting for memory admission is refused by
 * that admission (a memory_ result), so it is handed back either way.
 */
export function handBackOnCriticalPressure(runningCalls: number): boolean {
  return runningCalls > 0;
}

/**
 * Tell the coordinator this agent is going offline so its claims go to other agents now. Bounded
 * by `timeoutMs` and never throws: a stopping process can't wait long, and if the call fails the
 * claims are requeued at lease expiry anyway (one abandoned claim, never a blacklist on its own).
 */
export async function announceGoingOffline(
  send: (body: { agentId: string; goingOffline: GoingOfflineReason }) => Promise<unknown>,
  agentId: string,
  reason: GoingOfflineReason,
  timeoutMs = 3_000
): Promise<{ ok: boolean; released: number }> {
  try {
    const reply = (await Promise.race([
      send({ agentId, goingOffline: reason }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref?.()),
    ])) as { offline?: boolean; released?: number } | undefined;
    return { ok: Boolean(reply?.offline), released: typeof reply?.released === "number" ? reply.released : 0 };
  } catch {
    return { ok: false, released: 0 };
  }
}
