// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Keeps the admin Network page's "Routing decisions" across restarts, like network-history.ts does
 * for the time series. A decision is queued when it is made and again when its outcome changes; the
 * queue is written to Postgres in one upsert a minute. At start the newest ROUTING_LOG_SIZE decisions
 * of the last NETWORK_HISTORY_DAYS are read back into the log; rows older than that are deleted hourly.
 *
 * Nothing here is on a request path: writes are batched, every database call runs on the coordinator
 * pool (statement timeout included), and a failure is logged and the work carries on. Without a
 * database (dev, tests) the decisions live in memory only, as before.
 */
import type { RoutingDecisionStore } from "../db/routing-decision-store.js";
import type { RoutingDecision, StoredRoutingDecision } from "./coordinator/routing.js";
import { DAY_MS, FLUSH_INTERVAL_MS, PRUNE_INTERVAL_MS } from "./network-history.js";

/** Decisions kept for writing while the database is unreachable; the oldest go first. */
export const MAX_PENDING_DECISIONS = 5_000;

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface RoutingHistoryOptions {
  /** null: no database, memory only. */
  store: RoutingDecisionStore | null;
  /** Row key; both seeds share one database. */
  coordinatorId: string;
  retentionDays: number;
  /** How many to read back (the log's size). */
  restoreLimit: number;
  /** Puts restored decisions into the live log (routing.ts restoreDecisions). */
  restoreInto: (stored: readonly StoredRoutingDecision[]) => number;
  /** A decision as it is written (routing.ts storedDecision). */
  serialize: (d: RoutingDecision) => StoredRoutingDecision;
  log: Log;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class RoutingHistory {
  /** taskId -> the live decision (its latest state is written). */
  private pending = new Map<string, RoutingDecision>();
  private flushing: Promise<void> | undefined;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly opts: RoutingHistoryOptions) {}

  get enabled(): boolean {
    return this.opts.store !== null;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Queue a decision (new or changed) for the next write; no-op without a database. */
  record(d: RoutingDecision): void {
    if (!this.opts.store) return;
    this.pending.delete(d.taskId);
    this.pending.set(d.taskId, d);
    while (this.pending.size > MAX_PENDING_DECISIONS) this.pending.delete(this.pending.keys().next().value as string);
  }

  /** Write what is queued. One write at a time; a failed batch is kept for the next try. */
  flush(): Promise<void> {
    const store = this.opts.store;
    if (!store || !this.pending.size) return this.flushing ?? Promise.resolve();
    if (this.flushing) return this.flushing;
    const batch = [...this.pending.values()];
    this.pending = new Map();
    this.flushing = store
      .upsert(this.opts.coordinatorId, batch.map(this.opts.serialize))
      .catch((err) => {
        // Re-queue unless a newer change is already queued.
        for (const d of batch) if (!this.pending.has(d.taskId)) this.pending.set(d.taskId, d);
        while (this.pending.size > MAX_PENDING_DECISIONS) this.pending.delete(this.pending.keys().next().value as string);
        this.opts.log.warn({ error: errorText(err), decisions: batch.length }, "routing_history_write_failed");
      })
      .finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }

  /** Read the newest stored decisions into the log. Returns how many were added. */
  async restore(nowMs = Date.now()): Promise<number> {
    const store = this.opts.store;
    if (!store) return 0;
    try {
      const stored = await store.load(this.opts.coordinatorId, nowMs - this.opts.retentionDays * DAY_MS, this.opts.restoreLimit);
      const added = this.opts.restoreInto(stored);
      if (added > 0) this.opts.log.info({ decisions: added }, "routing_history_restored");
      return added;
    } catch (err) {
      this.opts.log.warn({ error: errorText(err) }, "routing_history_restore_failed");
      return 0;
    }
  }

  /** Delete decisions older than the retention window (every coordinator's). */
  async prune(nowMs = Date.now()): Promise<number> {
    const store = this.opts.store;
    if (!store) return 0;
    try {
      const removed = await store.prune(nowMs - this.opts.retentionDays * DAY_MS);
      if (removed > 0) this.opts.log.info({ removed, days: this.opts.retentionDays }, "routing_history_pruned");
      return removed;
    } catch (err) {
      this.opts.log.warn({ error: errorText(err) }, "routing_history_prune_failed");
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
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
