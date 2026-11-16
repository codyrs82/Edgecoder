// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The admin Network page's time series in Postgres (src/swarm/network-history.ts): one row per
 * 15 s sample, keyed by coordinator (both seeds share one database), the sample itself as JSONB so
 * a new field needs no schema change. The table is created here, like restricted_model_calls.
 */
import type { Pool } from "pg";
import type { NetworkSample } from "../swarm/network-observer.js";

export interface NetworkHistoryStore {
  /** Store samples; a sample already stored (same coordinator and time) is skipped. */
  insert(coordinatorId: string, samples: readonly NetworkSample[]): Promise<void>;
  /** This coordinator's samples at or after `sinceMs`, oldest first. */
  load(coordinatorId: string, sinceMs: number): Promise<NetworkSample[]>;
  /** Delete every coordinator's samples before `beforeMs`; returns how many went. */
  prune(beforeMs: number): Promise<number>;
}

/** Rows per INSERT statement. */
const INSERT_CHUNK = 500;

export class PostgresNetworkHistoryStore implements NetworkHistoryStore {
  private migrated: Promise<void> | undefined;

  constructor(private readonly pool: Pool) {}

  migrate(): Promise<void> {
    this.migrated ??= this.pool
      .query(
        `CREATE TABLE IF NOT EXISTS network_samples (
           coordinator_id TEXT NOT NULL, at_ms BIGINT NOT NULL, sample JSONB NOT NULL,
           PRIMARY KEY (coordinator_id, at_ms));
         CREATE INDEX IF NOT EXISTS network_samples_at_idx ON network_samples (at_ms)`
      )
      .then(() => undefined);
    // A failed attempt is retried on the next call.
    this.migrated.catch(() => {
      this.migrated = undefined;
    });
    return this.migrated;
  }

  async insert(coordinatorId: string, samples: readonly NetworkSample[]): Promise<void> {
    if (!samples.length) return;
    await this.migrate();
    for (let i = 0; i < samples.length; i += INSERT_CHUNK) {
      const chunk = samples.slice(i, i + INSERT_CHUNK);
      await this.pool.query(
        `INSERT INTO network_samples (coordinator_id, at_ms, sample)
         SELECT $1, t.at_ms, t.sample FROM unnest($2::bigint[], $3::jsonb[]) AS t(at_ms, sample)
         ON CONFLICT (coordinator_id, at_ms) DO NOTHING`,
        [coordinatorId, chunk.map((s) => s.atMs), chunk.map((s) => JSON.stringify(s))]
      );
    }
  }

  async load(coordinatorId: string, sinceMs: number): Promise<NetworkSample[]> {
    await this.migrate();
    const r = await this.pool.query<{ at_ms: string; sample: NetworkSample }>(
      `SELECT at_ms, sample FROM network_samples WHERE coordinator_id = $1 AND at_ms >= $2 ORDER BY at_ms`,
      [coordinatorId, sinceMs]
    );
    return r.rows.map((row) => ({ ...row.sample, atMs: Number(row.at_ms) }));
  }

  async prune(beforeMs: number): Promise<number> {
    await this.migrate();
    const r = await this.pool.query(`DELETE FROM network_samples WHERE at_ms < $1`, [beforeMs]);
    return Number(r.rowCount ?? 0);
  }
}
