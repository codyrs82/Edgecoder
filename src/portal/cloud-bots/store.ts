// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Where cloud bots live: three portal tables, created by PortalStore.migrate() (migrateCloudBots).
 *
 *   portal_cloud_bots          one row per bot: settings (config JSON), the sealed GitHub token,
 *                              the GitHub poller's cursor, paused, the next scheduled run
 *   portal_cloud_bot_messages  each bot's conversation: user, assistant and event turns
 *   portal_cloud_bot_runs      every run: trigger, start/end, status, cost
 *
 * The portal runs two machines (bluegreen), so whatever is claimed (a queued run, a due schedule,
 * a due GitHub poll) is claimed inside a transaction holding a Postgres advisory lock, with
 * FOR UPDATE SKIP LOCKED on the rows: one machine gets each. A bot has at most one queued and one
 * running run (partial unique indexes); a new message joins the queued run.
 *
 * Every read a route makes names the user: a bot id alone never reaches another account's rows.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CloudBot, CloudBotConfig, CloudMessage, CloudRun, CloudRunStatus } from "./types.js";

export const CLOUD_BOTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS portal_cloud_bots (
  bot_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  compute TEXT NOT NULL DEFAULT 'auto',
  config JSONB NOT NULL,
  github_token_enc TEXT,
  github_state JSONB,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  next_run_at_ms BIGINT,
  next_poll_at_ms BIGINT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  UNIQUE (user_id, request_id)
);
CREATE INDEX IF NOT EXISTS portal_cloud_bots_user_idx ON portal_cloud_bots (user_id, created_at_ms);
CREATE INDEX IF NOT EXISTS portal_cloud_bots_due_idx ON portal_cloud_bots (next_run_at_ms) WHERE next_run_at_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS portal_cloud_bots_poll_idx ON portal_cloud_bots (next_poll_at_ms) WHERE next_poll_at_ms IS NOT NULL;
CREATE TABLE IF NOT EXISTS portal_cloud_bot_messages (
  message_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  run_id TEXT,
  meta JSONB,
  created_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_cloud_bot_messages_bot_idx ON portal_cloud_bot_messages (bot_id, created_at_ms);
CREATE TABLE IF NOT EXISTS portal_cloud_bot_runs (
  run_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  started_at_ms BIGINT,
  ended_at_ms BIGINT,
  lease_until_ms BIGINT,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  cost_csats DOUBLE PRECISION NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  error TEXT,
  activity TEXT,
  where_ran TEXT
);
CREATE INDEX IF NOT EXISTS portal_cloud_bot_runs_bot_idx ON portal_cloud_bot_runs (bot_id, created_at_ms);
CREATE INDEX IF NOT EXISTS portal_cloud_bot_runs_status_idx ON portal_cloud_bot_runs (status, created_at_ms) WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS portal_cloud_bot_runs_one_queued ON portal_cloud_bot_runs (bot_id) WHERE status = 'queued';
CREATE UNIQUE INDEX IF NOT EXISTS portal_cloud_bot_runs_one_running ON portal_cloud_bot_runs (bot_id) WHERE status = 'running';
`;

/** The GitHub poller's memory per bot: the token's login, the time it last looked, the event ids it has seen. */
export interface GithubPollState {
  login?: string;
  sinceMs?: number;
  seen?: string[];
  error?: string;
  checkedAtMs?: number;
}

export interface NewCloudBot {
  id: string;
  userId: string;
  requestId: string;
  name: string;
  role: string;
  instructions: string;
  compute: string;
  config: CloudBotConfig;
  githubTokenSealed: string | null;
  nextRunAtMs: number | null;
  nextPollAtMs: number | null;
  nowMs: number;
}

export interface CloudBotPatch {
  name?: string;
  role?: string;
  instructions?: string;
  compute?: string;
  config?: CloudBotConfig;
  paused?: boolean;
  /** undefined: keep; null: remove. */
  githubTokenSealed?: string | null;
  nextRunAtMs?: number | null;
  nextPollAtMs?: number | null;
  /** Reset the GitHub poller (the repo changed). */
  resetGithubState?: boolean;
}

export interface ClaimedRun {
  run: CloudRun;
  bot: CloudBot;
}

export interface CloudBotStore {
  /** Made, or the one this account already made with this request id (created false). */
  createBot(b: NewCloudBot): Promise<{ bot: CloudBot; created: boolean }>;
  countBots(userId: string): Promise<number>;
  listBots(userId: string): Promise<CloudBot[]>;
  getBot(userId: string, botId: string): Promise<CloudBot | null>;
  updateBot(userId: string, botId: string, patch: CloudBotPatch, nowMs: number): Promise<CloudBot | null>;
  /** The bot, its conversation and its runs. */
  deleteBot(userId: string, botId: string): Promise<boolean>;
  /** The sealed token (decrypted only by BotSecrets, only for a run or a poll). */
  getGithubTokenSealed(botId: string): Promise<string | null>;
  getGithubState(botId: string): Promise<GithubPollState | null>;
  saveGithubState(botId: string, state: GithubPollState): Promise<void>;

  addMessage(m: Omit<CloudMessage, "id"> & { id?: string }): Promise<CloudMessage>;
  /** Newest first when reversed: the page before (beforeMs, beforeId), oldest first. */
  listMessages(userId: string, botId: string, opts: { limit: number; beforeMs?: number; beforeId?: string }): Promise<{ items: CloudMessage[]; more: boolean }>;
  countMessages(botId: string): Promise<number>;
  getMessage(userId: string, messageId: string): Promise<CloudMessage | null>;

  /** A queued run for the bot (the one already queued, if any). */
  enqueueRun(input: { userId: string; botId: string; trigger: string; source: string; nowMs: number }): Promise<{ runId: string; created: boolean }>;
  /** Queued runs moved to running, at most one per bot and `maxPerAccount` running per account. */
  claimRuns(input: { nowMs: number; leaseMs: number; limit: number; maxPerAccount: number }): Promise<ClaimedRun[]>;
  touchRun(runId: string, input: { leaseUntilMs: number; activity?: string | null; cSats?: number; where?: string | null }): Promise<{ cancelRequested: boolean; botExists: boolean }>;
  finishRun(runId: string, input: { status: CloudRunStatus; endedAtMs: number; cSats: number; summary: string; error?: string | null; where?: string | null }): Promise<void>;
  /** Running runs whose lease ran out (the machine running them went away): marked interrupted, returned. */
  expireRuns(nowMs: number): Promise<CloudRun[]>;
  requestCancel(userId: string, botId: string): Promise<boolean>;
  getRun(userId: string, runId: string): Promise<CloudRun | null>;
  listRuns(userId: string, botId: string, limit: number): Promise<CloudRun[]>;
  /** The bot's queued or running run. */
  activeRun(botId: string): Promise<CloudRun | null>;
  /** cSats spent and runs started on their own (not messages) since `sinceMs`. */
  usageSince(botId: string, sinceMs: number): Promise<{ cSats: number; ownRuns: number; runs: number }>;

  /** Bots whose schedule is due: their next run is moved on (`next(bot)`) in the same transaction. */
  claimDueSchedules(nowMs: number, limit: number, next: (bot: CloudBot) => number | null): Promise<CloudBot[]>;
  /** Bots whose GitHub poll is due: the next poll is set to now + intervalMs in the same transaction. */
  claimDuePolls(nowMs: number, limit: number, intervalMs: number): Promise<CloudBot[]>;
}

// ---- Postgres ----

const CLAIM_LOCK = "edgecoder.cloud_bots.claim";
const SCHEDULE_LOCK = "edgecoder.cloud_bots.schedule";

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function mapBot(r: Record<string, any>): CloudBot {
  return {
    id: r.bot_id,
    userId: r.user_id,
    requestId: r.request_id,
    name: r.name,
    role: r.role,
    instructions: r.instructions,
    compute: r.compute,
    config: r.config as CloudBotConfig,
    hasGithubToken: Boolean(r.has_token),
    paused: Boolean(r.paused),
    nextRunAtMs: nOrNull(r.next_run_at_ms),
    createdAtMs: n(r.created_at_ms),
    updatedAtMs: n(r.updated_at_ms),
  };
}
function mapRun(r: Record<string, any>): CloudRun {
  return {
    id: r.run_id,
    botId: r.bot_id,
    userId: r.user_id,
    trigger: r.trigger,
    source: r.source ?? "",
    status: r.status,
    createdAtMs: n(r.created_at_ms),
    startedAtMs: nOrNull(r.started_at_ms),
    endedAtMs: nOrNull(r.ended_at_ms),
    cSats: Number(r.cost_csats ?? 0),
    summary: r.summary ?? "",
    error: r.error ?? null,
    activity: r.activity ?? null,
    where: r.where_ran ?? null,
  };
}
function mapMessage(r: Record<string, any>): CloudMessage {
  return { id: r.message_id, botId: r.bot_id, userId: r.user_id, role: r.role, content: r.content, runId: r.run_id ?? null, meta: r.meta ?? null, createdAtMs: n(r.created_at_ms) };
}

// The token column is never selected with a bot: only whether there is one.
const BOT_COLUMNS = `bot_id, user_id, request_id, name, role, instructions, compute, config, (github_token_enc IS NOT NULL) AS has_token, paused, next_run_at_ms, created_at_ms, updated_at_ms`;
const RUN_COLUMNS = `run_id, bot_id, user_id, trigger, source, status, created_at_ms, started_at_ms, ended_at_ms, cost_csats, summary, error, activity, where_ran`;

export async function migrateCloudBots(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(CLOUD_BOTS_SCHEMA_SQL);
}

export class PgCloudBotStore implements CloudBotStore {
  constructor(private readonly pool: Pool) {}

  private async tx<T>(lock: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lock]);
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async createBot(b: NewCloudBot) {
    const r = await this.pool.query(
      `INSERT INTO portal_cloud_bots (bot_id, user_id, request_id, name, role, instructions, compute, config, github_token_enc, paused, next_run_at_ms, next_poll_at_ms, created_at_ms, updated_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,$10,$11,$12,$12)
       ON CONFLICT (user_id, request_id) DO NOTHING
       RETURNING ${BOT_COLUMNS}`,
      [b.id, b.userId, b.requestId, b.name, b.role, b.instructions, b.compute, JSON.stringify(b.config), b.githubTokenSealed, b.nextRunAtMs, b.nextPollAtMs, b.nowMs],
    );
    if (r.rows[0]) return { bot: mapBot(r.rows[0]), created: true };
    const same = await this.pool.query(`SELECT ${BOT_COLUMNS} FROM portal_cloud_bots WHERE user_id = $1 AND request_id = $2`, [b.userId, b.requestId]);
    if (!same.rows[0]) throw new Error("cloud_bot_conflict");
    return { bot: mapBot(same.rows[0]), created: false };
  }

  async countBots(userId: string) {
    const r = await this.pool.query(`SELECT COUNT(*) AS n FROM portal_cloud_bots WHERE user_id = $1`, [userId]);
    return n(r.rows[0]?.n);
  }

  async listBots(userId: string) {
    const r = await this.pool.query(`SELECT ${BOT_COLUMNS} FROM portal_cloud_bots WHERE user_id = $1 ORDER BY created_at_ms LIMIT 200`, [userId]);
    return r.rows.map(mapBot);
  }

  async getBot(userId: string, botId: string) {
    const r = await this.pool.query(`SELECT ${BOT_COLUMNS} FROM portal_cloud_bots WHERE user_id = $1 AND bot_id = $2`, [userId, botId]);
    return r.rows[0] ? mapBot(r.rows[0]) : null;
  }

  async updateBot(userId: string, botId: string, p: CloudBotPatch, nowMs: number) {
    const sets: string[] = [];
    const vals: unknown[] = [userId, botId];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (p.name !== undefined) set("name", p.name);
    if (p.role !== undefined) set("role", p.role);
    if (p.instructions !== undefined) set("instructions", p.instructions);
    if (p.compute !== undefined) set("compute", p.compute);
    if (p.config !== undefined) set("config", JSON.stringify(p.config));
    if (p.paused !== undefined) set("paused", p.paused);
    if (p.githubTokenSealed !== undefined) set("github_token_enc", p.githubTokenSealed);
    if (p.nextRunAtMs !== undefined) set("next_run_at_ms", p.nextRunAtMs);
    if (p.nextPollAtMs !== undefined) set("next_poll_at_ms", p.nextPollAtMs);
    if (p.resetGithubState) sets.push("github_state = NULL");
    set("updated_at_ms", nowMs);
    const r = await this.pool.query(`UPDATE portal_cloud_bots SET ${sets.join(", ")} WHERE user_id = $1 AND bot_id = $2 RETURNING ${BOT_COLUMNS}`, vals);
    return r.rows[0] ? mapBot(r.rows[0]) : null;
  }

  async deleteBot(userId: string, botId: string) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(`DELETE FROM portal_cloud_bots WHERE user_id = $1 AND bot_id = $2`, [userId, botId]);
      if (!r.rowCount) {
        await c.query("ROLLBACK");
        return false;
      }
      await c.query(`DELETE FROM portal_cloud_bot_messages WHERE user_id = $1 AND bot_id = $2`, [userId, botId]);
      // A running run sees its bot gone at its next step and stops; its row goes now.
      await c.query(`DELETE FROM portal_cloud_bot_runs WHERE user_id = $1 AND bot_id = $2`, [userId, botId]);
      await c.query("COMMIT");
      return true;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async getGithubTokenSealed(botId: string) {
    const r = await this.pool.query(`SELECT github_token_enc FROM portal_cloud_bots WHERE bot_id = $1`, [botId]);
    return (r.rows[0]?.github_token_enc as string | null | undefined) ?? null;
  }
  async getGithubState(botId: string) {
    const r = await this.pool.query(`SELECT github_state FROM portal_cloud_bots WHERE bot_id = $1`, [botId]);
    return (r.rows[0]?.github_state as GithubPollState | null | undefined) ?? null;
  }
  async saveGithubState(botId: string, state: GithubPollState) {
    await this.pool.query(`UPDATE portal_cloud_bots SET github_state = $2 WHERE bot_id = $1`, [botId, JSON.stringify(state)]);
  }

  async addMessage(m: Omit<CloudMessage, "id"> & { id?: string }) {
    const id = m.id ?? `cm-${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO portal_cloud_bot_messages (message_id, bot_id, user_id, role, content, run_id, meta, created_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, m.botId, m.userId, m.role, m.content, m.runId, m.meta ? JSON.stringify(m.meta) : null, m.createdAtMs],
    );
    return { ...m, id };
  }

  async listMessages(userId: string, botId: string, opts: { limit: number; beforeMs?: number; beforeId?: string }) {
    const vals: unknown[] = [userId, botId, opts.limit + 1];
    let where = "";
    if (opts.beforeMs !== undefined) {
      vals.push(opts.beforeMs, opts.beforeId ?? "");
      where = `AND (created_at_ms < $4 OR (created_at_ms = $4 AND message_id < $5))`;
    }
    const r = await this.pool.query(
      `SELECT * FROM portal_cloud_bot_messages WHERE user_id = $1 AND bot_id = $2 ${where} ORDER BY created_at_ms DESC, message_id DESC LIMIT $3`,
      vals,
    );
    const rows = r.rows.map(mapMessage);
    const more = rows.length > opts.limit;
    return { items: rows.slice(0, opts.limit).reverse(), more };
  }

  async countMessages(botId: string) {
    const r = await this.pool.query(`SELECT COUNT(*) AS n FROM portal_cloud_bot_messages WHERE bot_id = $1`, [botId]);
    return n(r.rows[0]?.n);
  }

  async getMessage(userId: string, messageId: string) {
    const r = await this.pool.query(`SELECT * FROM portal_cloud_bot_messages WHERE user_id = $1 AND message_id = $2`, [userId, messageId]);
    return r.rows[0] ? mapMessage(r.rows[0]) : null;
  }

  async enqueueRun(input: { userId: string; botId: string; trigger: string; source: string; nowMs: number }): Promise<{ runId: string; created: boolean }> {
    const id = `cr-${randomUUID()}`;
    const r = await this.pool.query(
      `INSERT INTO portal_cloud_bot_runs (run_id, bot_id, user_id, trigger, source, status, created_at_ms) VALUES ($1,$2,$3,$4,$5,'queued',$6) ON CONFLICT DO NOTHING RETURNING run_id`,
      [id, input.botId, input.userId, input.trigger, input.source, input.nowMs],
    );
    if (r.rows[0]) return { runId: id, created: true };
    const q = await this.pool.query(`SELECT run_id FROM portal_cloud_bot_runs WHERE bot_id = $1 AND status = 'queued'`, [input.botId]);
    if (q.rows[0]) return { runId: q.rows[0].run_id as string, created: false };
    // The queued one was claimed meanwhile: queue again.
    return this.enqueueRun(input);
  }

  async claimRuns(input: { nowMs: number; leaseMs: number; limit: number; maxPerAccount: number }) {
    return this.tx(CLAIM_LOCK, async (c) => {
      const out: ClaimedRun[] = [];
      // One at a time, so the per-account count sees the runs claimed a moment ago.
      for (let i = 0; i < input.limit; i++) {
        const r = await c.query(
          `UPDATE portal_cloud_bot_runs SET status = 'running', started_at_ms = $1, lease_until_ms = $2
           WHERE run_id = (
             SELECT q.run_id FROM portal_cloud_bot_runs q
             WHERE q.status = 'queued'
               AND NOT EXISTS (SELECT 1 FROM portal_cloud_bot_runs x WHERE x.bot_id = q.bot_id AND x.status = 'running')
               AND (SELECT COUNT(*) FROM portal_cloud_bot_runs y WHERE y.user_id = q.user_id AND y.status = 'running') < $3
             ORDER BY q.created_at_ms LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING ${RUN_COLUMNS}`,
          [input.nowMs, input.nowMs + input.leaseMs, input.maxPerAccount],
        );
        if (!r.rows[0]) break;
        const run = mapRun(r.rows[0]);
        const b = await c.query(`SELECT ${BOT_COLUMNS} FROM portal_cloud_bots WHERE bot_id = $1`, [run.botId]);
        if (!b.rows[0]) {
          await c.query(`DELETE FROM portal_cloud_bot_runs WHERE run_id = $1`, [run.id]);
          continue;
        }
        out.push({ run, bot: mapBot(b.rows[0]) });
      }
      return out;
    });
  }

  async touchRun(runId: string, input: { leaseUntilMs: number; activity?: string | null; cSats?: number; where?: string | null }) {
    const r = await this.pool.query(
      `UPDATE portal_cloud_bot_runs r SET lease_until_ms = $2, activity = COALESCE($3, r.activity), cost_csats = COALESCE($4, r.cost_csats), where_ran = COALESCE($5, r.where_ran)
       WHERE run_id = $1 RETURNING cancel_requested, EXISTS (SELECT 1 FROM portal_cloud_bots b WHERE b.bot_id = r.bot_id) AS bot_exists`,
      [runId, input.leaseUntilMs, input.activity ?? null, input.cSats ?? null, input.where ?? null],
    );
    const row = r.rows[0];
    return { cancelRequested: Boolean(row?.cancel_requested), botExists: Boolean(row?.bot_exists) };
  }

  async finishRun(runId: string, input: { status: CloudRunStatus; endedAtMs: number; cSats: number; summary: string; error?: string | null; where?: string | null }) {
    await this.pool.query(
      `UPDATE portal_cloud_bot_runs SET status = $2, ended_at_ms = $3, cost_csats = $4, summary = $5, error = $6, where_ran = COALESCE($7, where_ran), activity = NULL, lease_until_ms = NULL WHERE run_id = $1`,
      [runId, input.status, input.endedAtMs, input.cSats, input.summary.slice(0, 500), input.error?.slice(0, 500) ?? null, input.where ?? null],
    );
  }

  async expireRuns(nowMs: number) {
    const r = await this.pool.query(
      `UPDATE portal_cloud_bot_runs SET status = 'interrupted', ended_at_ms = $1, error = 'interrupted', activity = NULL WHERE status = 'running' AND lease_until_ms < $1 RETURNING ${RUN_COLUMNS}`,
      [nowMs],
    );
    return r.rows.map(mapRun);
  }

  async requestCancel(userId: string, botId: string) {
    const r = await this.pool.query(`UPDATE portal_cloud_bot_runs SET cancel_requested = TRUE WHERE user_id = $1 AND bot_id = $2 AND status = 'running'`, [userId, botId]);
    await this.pool.query(`UPDATE portal_cloud_bot_runs SET status = 'cancelled', ended_at_ms = $3 WHERE user_id = $1 AND bot_id = $2 AND status = 'queued'`, [userId, botId, Date.now()]);
    return (r.rowCount ?? 0) > 0;
  }

  async getRun(userId: string, runId: string) {
    const r = await this.pool.query(`SELECT ${RUN_COLUMNS} FROM portal_cloud_bot_runs WHERE user_id = $1 AND run_id = $2`, [userId, runId]);
    return r.rows[0] ? mapRun(r.rows[0]) : null;
  }

  async listRuns(userId: string, botId: string, limit: number) {
    const r = await this.pool.query(`SELECT ${RUN_COLUMNS} FROM portal_cloud_bot_runs WHERE user_id = $1 AND bot_id = $2 ORDER BY created_at_ms DESC LIMIT $3`, [userId, botId, limit]);
    return r.rows.map(mapRun);
  }

  async activeRun(botId: string) {
    const r = await this.pool.query(`SELECT ${RUN_COLUMNS} FROM portal_cloud_bot_runs WHERE bot_id = $1 AND status IN ('running', 'queued') ORDER BY (status = 'running') DESC LIMIT 1`, [botId]);
    return r.rows[0] ? mapRun(r.rows[0]) : null;
  }

  async usageSince(botId: string, sinceMs: number) {
    const r = await this.pool.query(
      `SELECT COALESCE(SUM(cost_csats), 0) AS c, COUNT(*) FILTER (WHERE trigger <> 'message') AS own, COUNT(*) AS runs
       FROM portal_cloud_bot_runs WHERE bot_id = $1 AND created_at_ms >= $2 AND status <> 'cancelled'`,
      [botId, sinceMs],
    );
    return { cSats: Number(r.rows[0]?.c ?? 0), ownRuns: n(r.rows[0]?.own), runs: n(r.rows[0]?.runs) };
  }

  async claimDueSchedules(nowMs: number, limit: number, next: (bot: CloudBot) => number | null) {
    return this.tx(SCHEDULE_LOCK, async (c) => {
      const r = await c.query(
        `SELECT ${BOT_COLUMNS} FROM portal_cloud_bots WHERE paused = FALSE AND next_run_at_ms IS NOT NULL AND next_run_at_ms <= $1 ORDER BY next_run_at_ms LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [nowMs, limit],
      );
      const bots = r.rows.map(mapBot);
      for (const b of bots) await c.query(`UPDATE portal_cloud_bots SET next_run_at_ms = $2 WHERE bot_id = $1`, [b.id, next(b)]);
      return bots;
    });
  }

  async claimDuePolls(nowMs: number, limit: number, intervalMs: number) {
    return this.tx(SCHEDULE_LOCK, async (c) => {
      const r = await c.query(
        `SELECT ${BOT_COLUMNS} FROM portal_cloud_bots WHERE paused = FALSE AND github_token_enc IS NOT NULL AND next_poll_at_ms IS NOT NULL AND next_poll_at_ms <= $1 ORDER BY next_poll_at_ms LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [nowMs, limit],
      );
      const bots = r.rows.map(mapBot);
      for (const b of bots) await c.query(`UPDATE portal_cloud_bots SET next_poll_at_ms = $2 WHERE bot_id = $1`, [b.id, nowMs + intervalMs]);
      return bots;
    });
  }
}
