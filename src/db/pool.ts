// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { Pool, type PoolConfig } from "pg";
import { moduleLogger } from "../common/logger.js";

/*
 * Every Postgres pool in src/ is built here, so each one has bounded timeouts and an "error"
 * listener. Without the listener, an idle client whose connection drops (database restart,
 * failover, network blip) emits "error" on the pool with nobody listening, and Node exits the
 * process. pg already discards the broken client; the next query opens a new connection.
 */

export const PG_POOL_DEFAULTS = {
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statementTimeoutMs: 30_000
} as const;

function intFrom(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** Pool settings from PG_POOL_MAX, PG_CONNECT_TIMEOUT_MS, PG_IDLE_TIMEOUT_MS, PG_STATEMENT_TIMEOUT_MS. */
export function pgPoolConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const statementTimeout = intFrom(env.PG_STATEMENT_TIMEOUT_MS, PG_POOL_DEFAULTS.statementTimeoutMs, 0);
  return {
    max: intFrom(env.PG_POOL_MAX, PG_POOL_DEFAULTS.max, 1),
    connectionTimeoutMillis: intFrom(env.PG_CONNECT_TIMEOUT_MS, PG_POOL_DEFAULTS.connectionTimeoutMillis, 0),
    idleTimeoutMillis: intFrom(env.PG_IDLE_TIMEOUT_MS, PG_POOL_DEFAULTS.idleTimeoutMillis, 0),
    // 0 leaves the server's own statement_timeout in place.
    ...(statementTimeout > 0 ? { statement_timeout: statementTimeout } : {})
  };
}

let poolErrors = 0;
/** Idle-client errors seen on any pool since start (for tests and diagnostics). */
export function pgPoolErrorCount(): number {
  return poolErrors;
}

/** Log an idle-client error and keep going: the pool has already dropped that client. */
export function attachPoolErrorListener(pool: Pool, name: string): Pool {
  const logger = moduleLogger("pg-pool");
  pool.on("error", (error: Error & { code?: string }) => {
    poolErrors += 1;
    // Message and code only: never the connection string.
    logger.warn({ pool: name, code: error?.code, error: error?.message }, "pg_pool_idle_client_error");
  });
  return pool;
}

export function createPgPool(connectionString: string, name: string, env: NodeJS.ProcessEnv = process.env): Pool {
  return attachPoolErrorListener(new Pool({ connectionString, ...pgPoolConfigFromEnv(env) }), name);
}
