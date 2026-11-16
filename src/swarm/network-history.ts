// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Keeps the admin Network page's time series across restarts. Each 15 s sample is queued in memory
 * and written to Postgres in one batch a minute; at start the last 7 days (or NETWORK_HISTORY_DAYS,
 * if shorter) are read back into the ring, so the graphs are full right after a deploy. Rows older
 * than NETWORK_HISTORY_DAYS are deleted hourly.
 *
 * Nothing here is on a request path: writes are batched off the sampler, every database call runs on
 * the coordinator pool (statement timeout included), and a failure is logged and the work carries
 * on. Without a database (dev, tests) the series lives in memory only, as before.
 */
import type { NetworkHistoryStore } from "../db/network-history-store.js";
import { MAX_SERIES_RANGE_MS, type NetworkSample, type RingBuffer } from "./network-observer.js";

export const DAY_MS = 24 * 60 * 60_000;
export const FLUSH_INTERVAL_MS = 60_000;
export const PRUNE_INTERVAL_MS = 60 * 60_000;
/** Samples kept for writing while the database is unreachable (1 day); the oldest go first. */
export const MAX_PENDING = DAY_MS / 15_000;

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface NetworkHistoryOptions {
  /** null: no database, memory only. */
  store: NetworkHistoryStore | null;
  /** Row key; both seeds share one database. */
  coordinatorId: string;
  ring: RingBuffer<NetworkSample>;
  retentionDays: number;
  log: Log;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class NetworkHistory {
  private pending: NetworkSample[] = [];
  private flushing: Promise<void> | undefined;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly opts: NetworkHistoryOptions) {}

  get enabled(): boolean {
    return this.opts.store !== null;
  }

  get retentionMs(): number {
    return this.opts.retentionDays * DAY_MS;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Queue a sample for the next write (no-op without a database). */
  record(sample: NetworkSample): void {
    if (!this.opts.store) return;
    this.pending.push(sample);
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
  }

  /** Write what is queued. One write at a time; a failed batch is kept for the next try. */
  flush(): Promise<void> {
    const store = this.opts.store;
    if (!store || !this.pending.length) return this.flushing ?? Promise.resolve();
    if (this.flushing) return this.flushing;
    const batch = this.pending;
    this.pending = [];
    this.flushing = store
      .insert(this.opts.coordinatorId, batch)
      .catch((err) => {
        this.pending = [...batch, ...this.pending].slice(-MAX_PENDING);
        this.opts.log.warn({ error: errorText(err), samples: batch.length }, "network_history_write_failed");
      })
      .finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }

  /**
   * Read stored samples into the ring, older than anything sampled since start (those stay), so the
   * series covers the time before this restart. Returns how many were added.
   */
  async restore(nowMs = Date.now()): Promise<number> {
    const store = this.opts.store;
    if (!store) return 0;
    try {
      const since = nowMs - Math.min(this.retentionMs, MAX_SERIES_RANGE_MS);
      const stored = await store.load(this.opts.coordinatorId, since);
      const live = this.opts.ring.toArray();
      const firstLive = live[0]?.atMs ?? Infinity;
      const older = stored.filter((s) => Number.isFinite(s.atMs) && s.atMs < firstLive);
      if (!older.length) return 0;
      this.opts.ring.clear();
      for (const s of older) this.opts.ring.push(s);
      for (const s of live) this.opts.ring.push(s);
      this.opts.log.info({ samples: older.length }, "network_history_restored");
      return older.length;
    } catch (err) {
      this.opts.log.warn({ error: errorText(err) }, "network_history_restore_failed");
      return 0;
    }
  }

  /** Delete samples older than the retention window (every coordinator's). */
  async prune(nowMs = Date.now()): Promise<number> {
    const store = this.opts.store;
    if (!store) return 0;
    try {
      const removed = await store.prune(nowMs - this.retentionMs);
      if (removed > 0) this.opts.log.info({ removed, days: this.opts.retentionDays }, "network_history_pruned");
      return removed;
    } catch (err) {
      this.opts.log.warn({ error: errorText(err) }, "network_history_prune_failed");
      return 0;
    }
  }

  /** Restore, prune once, then write every minute and prune every hour. Timers never hold the process. */
  start(): void {
    if (!this.opts.store || this.timers.length) return;
    void this.restore().then(() => this.prune());
    const flush = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    const prune = setInterval(() => void this.prune(), PRUNE_INTERVAL_MS);
    flush.unref?.();
    prune.unref?.();
    this.timers.push(flush, prune);
  }

  /** Stop the timers and write what is queued, waiting at most `timeoutMs`. */
  async stop(timeoutMs = 3_000): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (!this.opts.store) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      (async () => {
        await this.flush();
        await this.flush();
      })(),
      new Promise<void>((r) => {
        timer = setTimeout(r, timeoutMs);
        timer.unref?.();
      })
    ]);
    if (timer) clearTimeout(timer);
  }
}
