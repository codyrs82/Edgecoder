// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * CPU steal guard: an agent on a throttled VM takes no new model calls.
 *
 * Shared-CPU VMs (the Fly test fleet runs shared-cpu-4x) may burst to all their cores only while a
 * CPU credit balance lasts. Once it is spent the host throttles the VM to its baseline (0.25 of a
 * core on shared-cpu-4x, 1/16 of its burst), and the guest sees the difference as steal time.
 * Network run 6 (2026-11-25): a fleet deploy had just reset every machine's balance (about 15-20k of
 * a 200k cap), the earlier tests spent the rest, and during the pinned 1.5b CPU ramp 8 of 9 hosts sat
 * at an empty balance with ~370% of their 400% CPU stolen. A 1.5b model that writes ~33 tokens/s on
 * an idle host wrote ~1.5 tokens/s, so admitted calls ran to the 180 s deadline or produced their
 * first token after it. Nothing on the coordinator side can see this: the host looked like a free
 * 2-slot CPU host.
 *
 * The guard reads /proc/stat (Linux) and computes the share of the guest's busy CPU time that was
 * stolen. When that share reaches the threshold the agent reports no free model slot (and so is
 * handed no model call; calls already running go on) until `holdMs` has passed without a throttled
 * sample. The hold lets the balance refill a little before the host takes work again: an idle VM
 * shows no steal, so without it the guard would release as soon as the host went quiet.
 * Shared-host noise outside throttling is a few percent, far below the default threshold.
 */

import { readFileSync } from "node:fs";

/** Cumulative CPU time (in /proc/stat ticks) across all CPUs. */
export interface CpuTimes {
  /** Every state except guest time (already counted in user and nice). */
  total: number;
  idle: number;
  steal: number;
}

/** Share of busy CPU time stolen at which the guard holds the host back. */
export const CPU_STEAL_THRESHOLD = 0.5;
/** How long the host takes no new model call after the last throttled sample. */
export const CPU_STEAL_HOLD_MS = 120_000;
/** Shortest span one share is computed over. */
export const CPU_STEAL_WINDOW_MS = 5_000;
/** Below this share of all CPU time busy (or stolen), a span says nothing about throttling. */
const MIN_BUSY_SHARE = 0.05;

/** The aggregate `cpu` line of /proc/stat; null when it is missing or malformed. */
export function parseProcStatCpu(text: string): CpuTimes | null {
  const line = text.split("\n").find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  if (f.length < 4 || f.some((n) => !Number.isFinite(n) || n < 0)) return null;
  // user nice system idle iowait irq softirq steal [guest guest_nice]
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = f;
  return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle: idle + iowait, steal };
}

/** This host's CPU times; null where /proc/stat cannot be read (not Linux). */
export function readProcStatCpu(): CpuTimes | null {
  try {
    return parseProcStatCpu(readFileSync("/proc/stat", "utf8"));
  } catch {
    return null;
  }
}

/** Stolen share of the busy (non-idle) CPU time between two readings; null when there was too little activity to tell. */
export function stealShare(from: CpuTimes, to: CpuTimes): number | null {
  const total = to.total - from.total;
  const busy = total - (to.idle - from.idle);
  const steal = to.steal - from.steal;
  if (!(total > 0) || busy < 0 || steal < 0 || busy < total * MIN_BUSY_SHARE) return null;
  return Math.min(1, steal / busy);
}

export interface CpuStealState {
  /** The host takes no new model call. */
  throttled: boolean;
  /** The state changed with this sample (for a log line). */
  changed: boolean;
  /** The share measured by this sample, when a span completed. */
  share: number | null;
}

export class CpuStealGuard {
  private base: { atMs: number; times: CpuTimes } | null = null;
  private throttledUntilMs = 0;
  private wasThrottled = false;
  private lastShare: number | null = null;
  private lastShareAtMs = 0;
  private readonly threshold: number;
  private readonly holdMs: number;
  private readonly windowMs: number;
  private readonly read: () => CpuTimes | null;

  constructor(opts: { threshold?: number; holdMs?: number; windowMs?: number; read?: () => CpuTimes | null } = {}) {
    this.threshold = opts.threshold ?? CPU_STEAL_THRESHOLD;
    this.holdMs = Math.max(0, opts.holdMs ?? CPU_STEAL_HOLD_MS);
    this.windowMs = Math.max(1, opts.windowMs ?? CPU_STEAL_WINDOW_MS);
    this.read = opts.read ?? readProcStatCpu;
  }

  /** Take a reading (cheap; call it on each loop tick) and say whether the host is held back. */
  sample(nowMs = Date.now()): CpuStealState {
    const times = this.read();
    let share: number | null = null;
    if (times) {
      if (!this.base || times.total < this.base.times.total) this.base = { atMs: nowMs, times };
      else if (nowMs - this.base.atMs >= this.windowMs) {
        share = stealShare(this.base.times, times);
        this.base = { atMs: nowMs, times };
        if (share !== null) {
          this.lastShare = share;
          this.lastShareAtMs = nowMs;
        }
        if (share !== null && share >= this.threshold) this.throttledUntilMs = nowMs + this.holdMs;
      }
    }
    const throttled = nowMs < this.throttledUntilMs;
    const changed = throttled !== this.wasThrottled;
    this.wasThrottled = throttled;
    return { throttled, changed, share };
  }

  /** Most recent measured share (for logs). */
  recentShare(): number | null {
    return this.lastShare;
  }

  /**
   * Run 7: what the agent tells the coordinator with each pull and reply piece (coordinator
   * host-steal.ts): the share measured within the last `maxAgeMs` (default two reading spans; an
   * older one, such as from before the host went idle, is left out) and whether the guard holds the
   * host back. Takes no reading (sample() does, on the agent's loop tick).
   */
  report(nowMs = Date.now(), maxAgeMs = 2 * this.windowMs + 1_000): CpuStealReport {
    const throttled = nowMs < this.throttledUntilMs;
    const fresh = this.lastShare !== null && nowMs - this.lastShareAtMs <= maxAgeMs;
    return { ...(fresh ? { cpuStealShare: Math.round(this.lastShare! * 100) / 100 } : {}), cpuThrottled: throttled };
  }
}

/** Run 7: the steal fields an agent adds to its pull and reply pieces. */
export interface CpuStealReport {
  cpuStealShare?: number;
  cpuThrottled?: boolean;
}

/**
 * The model slots an agent reports with its pull. `free`: its slots less the calls it runs, 0 when
 * the engine or memory cannot take a call or the CPU is throttled. `reportAnyway`: an inference-only
 * agent normally skips a pull it could take nothing from; a throttled one with idle slots still
 * pulls, so the coordinator hears that it has no free slot (it would otherwise keep counting the
 * idle slots, route calls to this host and leave them waiting for a claim).
 */
export function modelSlotReport(o: { slots: number; inflight: number; available: boolean; cpuThrottled: boolean }): { free: number; reportAnyway: boolean } {
  const idle = Math.max(0, o.slots - o.inflight);
  if (!o.available) return { free: 0, reportAnyway: false };
  if (o.cpuThrottled) return { free: 0, reportAnyway: idle > 0 };
  return { free: idle, reportAnyway: false };
}
