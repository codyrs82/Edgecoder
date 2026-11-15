// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Round-trip time from this coordinator to each peer on its mesh WebSocket (agents and peer
 * coordinators), measured with WebSocket protocol pings. A `ws` client answers a ping with a pong
 * on its own (RFC 6455; `ws` autoPong is on by default), so agents need no change to be measured.
 *
 * Everything is in memory and bounded: one pending ping and one smoothed figure per peer, oldest
 * dropped first past `maxEntries`, and figures older than `maxAgeMs` are not reported.
 */

export interface RttSample {
  /** Smoothed round trip (exponentially weighted), ms. */
  rttMs: number;
  /** The latest single measurement, ms. */
  lastMs: number;
  samples: number;
  atMs: number;
}

/** A pong later than this is not a latency figure (the link stalled); it is dropped. */
export const RTT_MAX_PLAUSIBLE_MS = 30_000;

export class RttTracker {
  private readonly pending = new Map<string, number>();
  private readonly stats = new Map<string, RttSample>();

  constructor(
    private readonly maxEntries = 10_000,
    /** Weight of a new measurement in the smoothed figure. */
    private readonly alpha = 0.3,
    /** Figures older than this are treated as unknown. */
    private readonly maxAgeMs = 5 * 60_000
  ) {}

  /** A ping went out to `id` at `nowMs` (replaces an unanswered one). */
  sent(id: string, nowMs: number): void {
    this.pending.delete(id);
    this.pending.set(id, nowMs);
    trim(this.pending, this.maxEntries);
  }

  /** The pong for `id` arrived; returns the updated figure, or null when no ping was outstanding. */
  received(id: string, nowMs: number): RttSample | null {
    const sentAt = this.pending.get(id);
    if (sentAt === undefined) return null;
    this.pending.delete(id);
    const ms = nowMs - sentAt;
    if (!(ms >= 0) || ms > RTT_MAX_PLAUSIBLE_MS) return null;
    return this.record(id, ms, nowMs);
  }

  /** Record one measurement directly (e.g. a timed HTTP request to a peer coordinator). */
  record(id: string, ms: number, nowMs: number): RttSample {
    const prev = this.stats.get(id);
    const fresh = prev && nowMs - prev.atMs <= this.maxAgeMs;
    const rttMs = fresh ? prev.rttMs + this.alpha * (ms - prev.rttMs) : ms;
    const sample: RttSample = { rttMs: round1(rttMs), lastMs: round1(ms), samples: fresh ? prev.samples + 1 : 1, atMs: nowMs };
    this.stats.delete(id);
    this.stats.set(id, sample);
    trim(this.stats, this.maxEntries);
    return sample;
  }

  /** The current figure for `id`, or null when never measured or too old. */
  get(id: string, nowMs: number): RttSample | null {
    const s = this.stats.get(id);
    if (!s || nowMs - s.atMs > this.maxAgeMs) return null;
    return s;
  }

  /** Smoothed ms for `id`, or null. */
  rttMs(id: string, nowMs: number): number | null {
    return this.get(id, nowMs)?.rttMs ?? null;
  }

  /** Drop the outstanding ping (the socket closed); the last figure ages out on its own. */
  forgetPending(id: string): void {
    this.pending.delete(id);
  }

  get size(): number {
    return this.stats.size;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function trim<K, V>(m: Map<K, V>, max: number): void {
  while (m.size > max) {
    const first = m.keys().next();
    if (first.done) return;
    m.delete(first.value);
  }
}

/** The part of a `ws` WebSocket the pinger uses. */
export interface PingableSocket {
  readonly readyState: number;
  ping(): void;
  on(event: "pong", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

export interface PingTimers {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: PingTimers = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
};

/**
 * Ping `socket` now and every `intervalMs` while it is open, recording each round trip under `id`.
 * Returns a stop function (also called when the socket closes). `intervalMs` <= 0 does nothing.
 */
export function startRttPings(socket: PingableSocket, id: string, tracker: RttTracker, intervalMs: number, timers: PingTimers = realTimers): () => void {
  if (!(intervalMs > 0)) return () => {};
  let stopped = false;
  const ping = () => {
    if (stopped || socket.readyState !== 1) return;
    try {
      tracker.sent(id, timers.now());
      socket.ping();
    } catch {
      tracker.forgetPending(id);
    }
  };
  socket.on("pong", () => {
    if (!stopped) tracker.received(id, timers.now());
  });
  const handle = timers.setInterval(ping, intervalMs);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    timers.clearInterval(handle);
    tracker.forgetPending(id);
  };
  socket.on("close", stop);
  ping();
  return stop;
}
