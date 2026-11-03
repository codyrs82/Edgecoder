// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

// Shared Postgres store for @fastify/rate-limit. The portal runs on more than one Fly machine; with
// the plugin's default in-memory store each machine counted on its own (every limit was effectively
// multiplied by the machine count) and a restart reset the counts. This store keeps one fixed-window
// counter per key in portal_rate_limits, incremented atomically by a single upsert.
//
// When Postgres is unavailable or slower than `timeoutMs`, that request is counted in a per-process
// in-memory fallback instead, so limits still apply (never fail open) and a database outage cannot
// stall the login path.

import type { FastifyRateLimitStore, FastifyRateLimitStoreCtor } from "@fastify/rate-limit";

/** The slice of pg.Pool the store needs (lets tests pass a fake). */
export interface RateLimitPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

export interface RateLimitLogger {
  warn(obj: unknown, msg?: string): void;
}

/** Created by PortalStore.migrate() with the rest of the portal schema. */
export const RATE_LIMIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS portal_rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_portal_rate_limits_reset_at ON portal_rate_limits(reset_at);
`;

// $1 key, $2 window in ms. A row whose window has passed restarts at 1 with a fresh window. The
// ON CONFLICT path locks the row, so concurrent increments of one key serialize and none is lost.
const INCR_SQL = `
INSERT INTO portal_rate_limits (key, count, reset_at)
VALUES ($1, 1, now() + $2::double precision * interval '1 millisecond')
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN portal_rate_limits.reset_at <= now() THEN 1 ELSE portal_rate_limits.count + 1 END,
  reset_at = CASE WHEN portal_rate_limits.reset_at <= now()
    THEN now() + $2::double precision * interval '1 millisecond'
    ELSE portal_rate_limits.reset_at END
RETURNING count, GREATEST(0, CEIL(EXTRACT(EPOCH FROM (reset_at - now())) * 1000))::bigint AS ttl_ms
`;

const CLEANUP_SQL = `
DELETE FROM portal_rate_limits
WHERE key IN (SELECT key FROM portal_rate_limits WHERE reset_at <= now() LIMIT $1)
`;

export interface PgRateLimitStoreOptions {
  /** Give up on Postgres for a request after this long and count it in memory (default 200 ms). */
  timeoutMs?: number;
  log?: RateLimitLogger;
  /** At most one fallback warning per this interval (default 60 s). */
  warnIntervalMs?: number;
  /** Expired-row cleanup period (default 5 minutes); 0 disables the timer. */
  cleanupIntervalMs?: number;
  /** Rows deleted per cleanup run (default 1000). */
  cleanupBatch?: number;
  /** Max keys held by the in-memory fallback (default 10000). */
  fallbackMaxKeys?: number;
}

type IncrResult = { current: number; ttl: number };
type IncrCallback = (err: Error | null, res?: IncrResult) => void;

/** Fixed-window counters for requests that could not reach Postgres. */
class MemoryFallback {
  private readonly windows = new Map<string, { count: number; resetAtMs: number }>();
  constructor(private readonly maxKeys: number) {}

  incr(key: string, timeWindow: number): IncrResult {
    const now = Date.now();
    let w = this.windows.get(key);
    if (!w || w.resetAtMs <= now) {
      if (!w && this.windows.size >= this.maxKeys) this.prune(now);
      w = { count: 0, resetAtMs: now + timeWindow };
      this.windows.set(key, w);
    }
    w.count += 1;
    return { current: w.count, ttl: Math.max(0, w.resetAtMs - now) };
  }

  private prune(now: number): void {
    for (const [k, w] of this.windows) if (w.resetAtMs <= now) this.windows.delete(k);
    // Still full: drop the oldest entries (Map preserves insertion order).
    for (const k of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break;
      this.windows.delete(k);
    }
  }
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`rate-limit store query exceeded ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface PgRateLimitStoreHandle {
  /** Pass as `store` to @fastify/rate-limit (the plugin constructs it itself). */
  Store: FastifyRateLimitStoreCtor;
  /** Delete one batch of expired rows; returns the number deleted. */
  cleanupExpired(): Promise<number>;
  /** Stop the cleanup timer. */
  stop(): void;
}

/**
 * Build a rate-limit store class bound to `pool`. Keys are namespaced per route (method + url, set
 * by the plugin's `child()` call for each rate-limited route), so different limits never share a
 * counter, matching what the per-route in-memory stores did before.
 */
export function createPgRateLimitStore(pool: RateLimitPool, opts: PgRateLimitStoreOptions = {}): PgRateLimitStoreHandle {
  const timeoutMs = opts.timeoutMs ?? 200;
  const warnIntervalMs = opts.warnIntervalMs ?? 60_000;
  const cleanupBatch = opts.cleanupBatch ?? 1000;
  const fallback = new MemoryFallback(opts.fallbackMaxKeys ?? 10_000);
  let lastWarnMs = 0;
  let suppressed = 0;

  const warnFallback = (err: unknown) => {
    const now = Date.now();
    if (now - lastWarnMs < warnIntervalMs) {
      suppressed += 1;
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    opts.log?.warn({ err: detail, suppressedSinceLastWarning: suppressed }, "rate-limit store: Postgres unavailable or slow; counting in memory for this request");
    lastWarnMs = now;
    suppressed = 0;
  };

  class PgRateLimitStore implements FastifyRateLimitStore {
    constructor(_params?: unknown, readonly namespace = "global") {}

    incr(key: string, cb: IncrCallback, timeWindow: number, _max: number): void {
      const fullKey = `${this.namespace}|${key}`;
      withTimeout(pool.query(INCR_SQL, [fullKey, timeWindow]), timeoutMs)
        .then((res) => {
          const row = res.rows[0];
          if (!row) throw new Error("rate-limit upsert returned no row");
          cb(null, { current: Number(row.count), ttl: Number(row.ttl_ms) });
        })
        .catch((err: unknown) => {
          warnFallback(err);
          cb(null, fallback.incr(fullKey, timeWindow));
        });
    }

    // The plugin passes the merged route params, with the route itself under `routeInfo`.
    child(routeOptions: Parameters<FastifyRateLimitStore["child"]>[0]): PgRateLimitStore {
      const info = (routeOptions as unknown as { routeInfo?: { method?: string | string[]; url?: string } })?.routeInfo ?? {};
      const method = Array.isArray(info.method) ? info.method.join(",") : (info.method ?? "");
      return new PgRateLimitStore(undefined, `${method}:${info.url ?? ""}`);
    }
  }

  const cleanupExpired = async (): Promise<number> => {
    const res = await pool.query(CLEANUP_SQL, [cleanupBatch]);
    return res.rowCount ?? 0;
  };

  const intervalMs = opts.cleanupIntervalMs ?? 5 * 60_000;
  const timer = intervalMs > 0
    ? setInterval(() => {
      cleanupExpired().catch((err: unknown) => {
        opts.log?.warn({ err: err instanceof Error ? err.message : String(err) }, "rate-limit store: expired-row cleanup failed");
      });
    }, intervalMs)
    : undefined;
  timer?.unref();

  return { Store: PgRateLimitStore, cleanupExpired, stop: () => clearInterval(timer) };
}
