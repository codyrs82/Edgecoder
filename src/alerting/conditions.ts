// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/** Small stateful helpers the monitors share. Every one takes the time as an argument (fake clocks in tests). */

/** N failures in a row per target, and when the run of failures started. */
export class ConsecutiveFailures {
  private readonly runs = new Map<string, { count: number; sinceMs: number; lastError?: string }>();
  constructor(private readonly threshold: number) {}

  record(target: string, ok: boolean, nowMs: number, error?: string): { failing: boolean; count: number; sinceMs: number; lastError?: string } {
    if (ok) {
      this.runs.delete(target);
      return { failing: false, count: 0, sinceMs: nowMs };
    }
    const r = this.runs.get(target) ?? { count: 0, sinceMs: nowMs };
    r.count += 1;
    r.lastError = error;
    this.runs.set(target, r);
    return { failing: r.count >= this.threshold, count: r.count, sinceMs: r.sinceMs, lastError: error };
  }

  forget(target: string): void {
    this.runs.delete(target);
  }
}

/** A condition that counts only once it has held continuously for `durationMs`. */
export class Sustained {
  private readonly since = new Map<string, number>();
  constructor(private readonly durationMs: number) {}

  update(key: string, active: boolean, nowMs: number): { fire: boolean; sinceMs: number } {
    if (!active) {
      this.since.delete(key);
      return { fire: false, sinceMs: nowMs };
    }
    const s = this.since.get(key) ?? nowMs;
    this.since.set(key, s);
    return { fire: nowMs - s >= this.durationMs, sinceMs: s };
  }

  /** Forget keys not seen in this round (a model or agent that went away). */
  retain(keys: Set<string>): void {
    for (const k of this.since.keys()) if (!keys.has(k)) this.since.delete(k);
  }
}

/** Timestamps of events per key, counted over a sliding window. Bounded per key. */
export class EventWindow {
  private readonly events = new Map<string, Array<{ atMs: number; detail?: Record<string, unknown> }>>();
  constructor(
    private readonly maxPerKey = 1_000,
    private readonly maxAgeMs = 24 * 3_600_000
  ) {}

  add(key: string, atMs: number, detail?: Record<string, unknown>): void {
    const list = this.events.get(key) ?? [];
    list.push({ atMs, detail });
    if (list.length > this.maxPerKey) list.splice(0, list.length - this.maxPerKey);
    this.events.set(key, list);
  }

  /** Events of `key` at or after `sinceMs`, oldest first. */
  since(key: string, sinceMs: number): Array<{ atMs: number; detail?: Record<string, unknown> }> {
    return (this.events.get(key) ?? []).filter((e) => e.atMs >= sinceMs);
  }

  prune(nowMs: number): void {
    for (const [k, list] of this.events) {
      const kept = list.filter((e) => e.atMs >= nowMs - this.maxAgeMs);
      if (kept.length) this.events.set(k, kept);
      else this.events.delete(k);
    }
  }
}

/** A cumulative counter sampled over time: how much it grew over the last `windowMs`. */
export class CounterWindow {
  private readonly samples: Array<{ atMs: number; value: number }> = [];
  constructor(private readonly windowMs: number) {}

  /** Record the counter now and return its growth over the window (from the oldest sample inside it). */
  observe(value: number, nowMs: number): number {
    this.samples.push({ atMs: nowMs, value });
    // Keep one sample at or before the window start as the baseline.
    while (this.samples.length > 2 && this.samples[1]!.atMs <= nowMs - this.windowMs) this.samples.shift();
    const base = this.samples[0]!;
    return Math.max(0, value - base.value);
  }
}
