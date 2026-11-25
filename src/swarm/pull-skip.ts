// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Why the agent's loop sends no /pull on a tick, and a log line for it (network run 10).
 *
 * In run 10 the coordinator showed 2-slot CPU hosts as "1 of 2 free" with their last pull 44-127 s
 * earlier, and held them back (start-eta.ts agentHeldBack). The agents' own logs showed both slots
 * busy the whole time: the coordinator had taken one call back (first piece overdue) and given it to
 * another host, while this agent went on generating it. Nothing on the agent said why it was not
 * pulling. This line does: the reason and the slot state, once when the reason starts and again
 * every REPEAT_MS while it lasts.
 */

export type PullSkipReason =
  /** No sandbox and not inference-only: this agent takes no swarm work at all. */
  | "no_swarm_role"
  /** Docker is configured but not usable. */
  | "sandbox_down"
  /** Draining or stopping (a restart or quit is coming: BHV006). */
  | "draining"
  /** Low on memory (memory-manager.ts pressure guard). */
  | "memory_pressure"
  | "shutting_down"
  /** Inference-only and every model slot runs a call. */
  | "all_slots_busy"
  /** Inference-only with an idle slot, but the engine cannot take a call (vLLM / MLX down, no model). */
  | "engine_not_ready";

export interface PullGateState {
  pullsFromCoordinator: boolean;
  sandboxDown: boolean;
  lifecycleCanPull: boolean;
  memoryOk: boolean;
  shuttingDown: boolean;
  inferenceOnly: boolean;
  slots: number;
  inflight: number;
  /** Free slots the pull would report (modelSlotReport). */
  free: number;
  /** A throttled host with idle slots still pulls, to say it has none free (modelSlotReport). */
  reportAnyway: boolean;
  /** Coming home after a drain failover: the pull goes out to report no free slot (drain-failover.ts). */
  drainReturnHold: boolean;
  cpuThrottled: boolean;
}

/** The reason this tick sends no /pull, or null when it pulls. Same rule as the loop's own gate. */
export function pullSkipReason(s: PullGateState): PullSkipReason | null {
  if (!s.pullsFromCoordinator) return "no_swarm_role";
  if (s.sandboxDown) return "sandbox_down";
  if (!s.lifecycleCanPull) return "draining";
  if (!s.memoryOk) return "memory_pressure";
  if (s.shuttingDown) return "shutting_down";
  if (s.inferenceOnly && s.free === 0 && !s.reportAnyway && !s.drainReturnHold) {
    return s.inflight >= s.slots ? "all_slots_busy" : "engine_not_ready";
  }
  return null;
}

/** "slots 2, running 2, free 0, cpu throttled no". */
export function describeSlots(s: Pick<PullGateState, "slots" | "inflight" | "free" | "cpuThrottled">): string {
  return `slots ${s.slots}, running ${s.inflight}, free ${s.free}, cpu throttled ${s.cpuThrottled ? "yes" : "no"}`;
}

/** Repeat the line this often while the same reason lasts. */
export const PULL_SKIP_REPEAT_MS = 60_000;

/** Decides when a skipped pull is logged: when its reason starts, and every PULL_SKIP_REPEAT_MS while it lasts. */
export class PullSkipLog {
  private reason: PullSkipReason | null = null;
  private sinceMs = 0;
  private loggedAtMs = 0;
  private skips = 0;

  /** Note this tick; returns the line to print, or null. `reason` null: the tick pulled. */
  note(reason: PullSkipReason | null, slots: string, nowMs = Date.now()): string | null {
    if (reason === null) {
      this.reason = null;
      this.skips = 0;
      return null;
    }
    if (reason !== this.reason) {
      this.reason = reason;
      this.sinceMs = nowMs;
      this.loggedAtMs = nowMs;
      this.skips = 1;
      return `pull skipped: ${reason} (${slots})`;
    }
    this.skips++;
    if (nowMs - this.loggedAtMs < PULL_SKIP_REPEAT_MS) return null;
    this.loggedAtMs = nowMs;
    return `pull skipped: ${reason} for ${Math.round((nowMs - this.sinceMs) / 1000)} s, ${this.skips} ticks (${slots})`;
  }
}
