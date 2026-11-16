// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Durable log of restricted-model calls (security research tier, docs/security-research-tier.md):
 * one row per call, written at submit, claim and end. Prompts and outputs are stored only when
 * the coordinator runs with RESTRICTED_MODEL_LOG_PROMPTS=true (the caller leaves them out otherwise).
 */
import type { Pool } from "pg";
import type { RestrictedCallRecord } from "../swarm/restricted-models.js";

export class PostgresRestrictedCallStore {
  private migrated: Promise<void> | undefined;

  constructor(private readonly pool: Pool) {}

  migrate(): Promise<void> {
    this.migrated ??= this.pool
      .query(
        `CREATE TABLE IF NOT EXISTS restricted_model_calls (
           subtask_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, account_id TEXT NOT NULL, model TEXT NOT NULL,
           tier TEXT NOT NULL, placement TEXT NOT NULL, reservation_id TEXT, agent_id TEXT, host_account_id TEXT,
           submitted_at_ms BIGINT NOT NULL, claimed_at_ms BIGINT, ended_at_ms BIGINT, outcome TEXT,
           prompt_tokens INTEGER, output_tokens INTEGER, prompt TEXT, output TEXT);
         CREATE INDEX IF NOT EXISTS restricted_model_calls_account_idx ON restricted_model_calls (account_id, submitted_at_ms)`
      )
      .then(() => undefined);
    return this.migrated;
  }

  async upsert(r: RestrictedCallRecord): Promise<void> {
    await this.migrate();
    await this.pool.query(
      `INSERT INTO restricted_model_calls (subtask_id, task_id, account_id, model, tier, placement, reservation_id, agent_id, host_account_id,
         submitted_at_ms, claimed_at_ms, ended_at_ms, outcome, prompt_tokens, output_tokens, prompt, output)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (subtask_id) DO UPDATE SET agent_id = EXCLUDED.agent_id, host_account_id = EXCLUDED.host_account_id,
         claimed_at_ms = EXCLUDED.claimed_at_ms, ended_at_ms = EXCLUDED.ended_at_ms, outcome = EXCLUDED.outcome,
         prompt_tokens = EXCLUDED.prompt_tokens, output_tokens = EXCLUDED.output_tokens, prompt = EXCLUDED.prompt, output = EXCLUDED.output`,
      [
        r.subtaskId, r.taskId, r.accountId, r.model, r.tier, r.placement, r.reservationId ?? null, r.agentId ?? null, r.hostAccountId ?? null,
        r.submittedAtMs, r.claimedAtMs ?? null, r.endedAtMs ?? null, r.outcome ?? null, r.promptTokens ?? null, r.outputTokens ?? null,
        r.prompt ?? null, r.output ?? null,
      ]
    );
  }
}
