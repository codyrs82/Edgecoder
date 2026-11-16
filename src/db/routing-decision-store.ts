// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The admin Network page's "Routing decisions" in Postgres (src/swarm/routing-history.ts): one row
 * per model "auto" call, keyed by coordinator and task, the decision itself as JSONB so a new field
 * needs no schema change. A row is written when the call is routed and again once its outcome is in
 * (upsert). The table is created here, like network_samples.
 */
import type { Pool } from "pg";
import type { StoredRoutingDecision } from "../swarm/coordinator/routing.js";

export interface RoutingDecisionStore {
  /** Store decisions; one already stored (same coordinator and task) is replaced. */
  upsert(coordinatorId: string, decisions: readonly StoredRoutingDecision[]): Promise<void>;
  /** This coordinator's newest `limit` decisions at or after `sinceMs`, oldest first. */
  load(coordinatorId: string, sinceMs: number, limit: number): Promise<StoredRoutingDecision[]>;
  /** Delete every coordinator's decisions before `beforeMs`; returns how many went. */
  prune(beforeMs: number): Promise<number>;
}

/** Rows per INSERT statement. */
const INSERT_CHUNK = 200;

export class PostgresRoutingDecisionStore implements RoutingDecisionStore {
  private migrated: Promise<void> | undefined;

  constructor(private readonly pool: Pool) {}

  migrate(): Promise<void> {
    this.migrated ??= this.pool
      .query(
        `CREATE TABLE IF NOT EXISTS routing_decisions (
           coordinator_id TEXT NOT NULL, task_id TEXT NOT NULL, at_ms BIGINT NOT NULL, decision JSONB NOT NULL,
           PRIMARY KEY (coordinator_id, task_id));
         CREATE INDEX IF NOT EXISTS routing_decisions_at_idx ON routing_decisions (at_ms)`
      )
      .then(() => undefined);
    // A failed attempt is retried on the next call.
    this.migrated.catch(() => {
      this.migrated = undefined;
    });
    return this.migrated;
  }

  async upsert(coordinatorId: string, decisions: readonly StoredRoutingDecision[]): Promise<void> {
    if (!decisions.length) return;
    await this.migrate();
    for (let i = 0; i < decisions.length; i += INSERT_CHUNK) {
      const chunk = decisions.slice(i, i + INSERT_CHUNK);
      await this.pool.query(
        `INSERT INTO routing_decisions (coordinator_id, task_id, at_ms, decision)
         SELECT $1, t.task_id, t.at_ms, t.decision FROM unnest($2::text[], $3::bigint[], $4::jsonb[]) AS t(task_id, at_ms, decision)
         ON CONFLICT (coordinator_id, task_id) DO UPDATE SET at_ms = EXCLUDED.at_ms, decision = EXCLUDED.decision`,
        [coordinatorId, chunk.map((d) => d.taskId), chunk.map((d) => d.atMs), chunk.map((d) => JSON.stringify(d))]
      );
    }
  }

  async load(coordinatorId: string, sinceMs: number, limit: number): Promise<StoredRoutingDecision[]> {
    await this.migrate();
    const r = await this.pool.query<{ at_ms: string; task_id: string; decision: StoredRoutingDecision }>(
      `SELECT at_ms, task_id, decision FROM routing_decisions WHERE coordinator_id = $1 AND at_ms >= $2 ORDER BY at_ms DESC LIMIT $3`,
      [coordinatorId, sinceMs, limit]
    );
    return r.rows.reverse().map((row) => ({ ...row.decision, taskId: row.task_id, atMs: Number(row.at_ms) }));
  }

  async prune(beforeMs: number): Promise<number> {
    await this.migrate();
    const r = await this.pool.query(`DELETE FROM routing_decisions WHERE at_ms < $1`, [beforeMs]);
    return Number(r.rowCount ?? 0);
  }
}
