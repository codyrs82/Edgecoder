// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Brand-post queue (src/social/service.ts). One row per post with a unique source key (a weekly
 * report, a release, a docs page, or a manual draft) so a source is drafted once, and a small
 * key/value table for the admin switch and what the drafting job has already seen. Created here
 * with CREATE TABLE IF NOT EXISTS, like src/alerting/store.ts.
 *
 * Every status change is a conditional UPDATE (only from the expected states), so two portal
 * machines cannot both send the same post.
 */
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

export type PostStatus = "draft" | "approved" | "posting" | "posted" | "rejected" | "failed";
export type PostKind = "weekly" | "release" | "docs" | "manual";

export interface SocialPost {
  id: string;
  sourceKey: string;
  kind: PostKind;
  text: string;
  status: PostStatus;
  createdAtMs: number;
  updatedAtMs: number;
  approvedBy: string | null;
  approvedAtMs: number | null;
  postedAtMs: number | null;
  /** sha256 of the normalized text, set when posted (the 90-day duplicate check). */
  dedupeHash: string | null;
  xTweetId: string | null;
  nostrEventId: string | null;
  /** "posted to 2 of 3 relays", "skipped: NOSTR_BRAND_NSEC not set", or the relay error. */
  nostrNote: string | null;
  error: string | null;
}

export type NewDraft = Pick<SocialPost, "sourceKey" | "kind" | "text">;
export type PostPatch = Partial<Omit<SocialPost, "id" | "sourceKey" | "kind" | "createdAtMs">>;

export interface SocialStore {
  /** Insert a draft; null when a post with this source key already exists. */
  insertDraft(d: NewDraft, nowMs: number): Promise<SocialPost | null>;
  get(id: string): Promise<SocialPost | null>;
  hasSourceKey(sourceKey: string): Promise<boolean>;
  list(statuses: PostStatus[], limit: number): Promise<SocialPost[]>;
  /** Apply `patch` only when the post is in one of `from`; null otherwise. */
  transition(id: string, from: PostStatus[], patch: PostPatch, nowMs: number): Promise<SocialPost | null>;
  /** Posts sent (or being sent) since `sinceMs`, with their dedupe hash. */
  postedSince(sinceMs: number): Promise<Array<{ id: string; dedupeHash: string | null }>>;
  getState<T>(name: string): Promise<T | null>;
  setState(name: string, value: unknown, nowMs: number): Promise<void>;
}

const clone = (p: SocialPost): SocialPost => ({ ...p });

export class MemorySocialStore implements SocialStore {
  readonly posts = new Map<string, SocialPost>();
  readonly state = new Map<string, unknown>();

  async insertDraft(d: NewDraft, nowMs: number) {
    for (const p of this.posts.values()) if (p.sourceKey === d.sourceKey) return null;
    const post: SocialPost = {
      id: randomUUID(), sourceKey: d.sourceKey, kind: d.kind, text: d.text, status: "draft", createdAtMs: nowMs, updatedAtMs: nowMs,
      approvedBy: null, approvedAtMs: null, postedAtMs: null, dedupeHash: null, xTweetId: null, nostrEventId: null, nostrNote: null, error: null
    };
    this.posts.set(post.id, post);
    return clone(post);
  }
  async get(id: string) {
    const p = this.posts.get(id);
    return p ? clone(p) : null;
  }
  async hasSourceKey(sourceKey: string) {
    for (const p of this.posts.values()) if (p.sourceKey === sourceKey) return true;
    return false;
  }
  async list(statuses: PostStatus[], limit: number) {
    return [...this.posts.values()]
      .filter((p) => statuses.includes(p.status))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, limit)
      .map(clone);
  }
  async transition(id: string, from: PostStatus[], patch: PostPatch, nowMs: number) {
    const p = this.posts.get(id);
    if (!p || !from.includes(p.status)) return null;
    Object.assign(p, patch, { updatedAtMs: nowMs });
    return clone(p);
  }
  async postedSince(sinceMs: number) {
    return [...this.posts.values()]
      .filter((p) => (p.status === "posted" && (p.postedAtMs ?? 0) >= sinceMs) || p.status === "posting")
      .map((p) => ({ id: p.id, dedupeHash: p.dedupeHash }));
  }
  async getState<T>(name: string) {
    return this.state.has(name) ? (structuredClone(this.state.get(name)) as T) : null;
  }
  async setState(name: string, value: unknown) {
    this.state.set(name, structuredClone(value));
  }
}

export const SOCIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  approved_by TEXT,
  approved_at_ms BIGINT,
  posted_at_ms BIGINT,
  dedupe_hash TEXT,
  x_tweet_id TEXT,
  nostr_event_id TEXT,
  nostr_note TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS social_posts_status_idx ON social_posts (status, updated_at_ms DESC);
CREATE TABLE IF NOT EXISTS social_state (
  name TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL
)`;

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function fromRow(r: Row): SocialPost {
  return {
    id: String(r.id),
    sourceKey: String(r.source_key),
    kind: String(r.kind) as PostKind,
    text: String(r.text),
    status: String(r.status) as PostStatus,
    createdAtMs: Number(r.created_at_ms),
    updatedAtMs: Number(r.updated_at_ms),
    approvedBy: str(r.approved_by),
    approvedAtMs: num(r.approved_at_ms),
    postedAtMs: num(r.posted_at_ms),
    dedupeHash: str(r.dedupe_hash),
    xTweetId: str(r.x_tweet_id),
    nostrEventId: str(r.nostr_event_id),
    nostrNote: str(r.nostr_note),
    error: str(r.error)
  };
}

const COLUMNS: Record<keyof PostPatch, string> = {
  text: "text",
  status: "status",
  updatedAtMs: "updated_at_ms",
  approvedBy: "approved_by",
  approvedAtMs: "approved_at_ms",
  postedAtMs: "posted_at_ms",
  dedupeHash: "dedupe_hash",
  xTweetId: "x_tweet_id",
  nostrEventId: "nostr_event_id",
  nostrNote: "nostr_note",
  error: "error"
};

export class PostgresSocialStore implements SocialStore {
  private migrated: Promise<void> | undefined;

  constructor(private readonly pool: Pool) {}

  migrate(): Promise<void> {
    this.migrated ??= this.pool.query(SOCIAL_SCHEMA_SQL).then(() => undefined);
    this.migrated.catch(() => {
      this.migrated = undefined;
    });
    return this.migrated;
  }

  private async q(sql: string, params: unknown[]): Promise<Row[]> {
    await this.migrate();
    return (await this.pool.query(sql, params)).rows as Row[];
  }

  async insertDraft(d: NewDraft, nowMs: number) {
    const rows = await this.q(
      `INSERT INTO social_posts (id, source_key, kind, text, status, created_at_ms, updated_at_ms)
       VALUES ($1, $2, $3, $4, 'draft', $5, $5) ON CONFLICT (source_key) DO NOTHING RETURNING *`,
      [randomUUID(), d.sourceKey, d.kind, d.text, nowMs]
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async get(id: string) {
    const rows = await this.q(`SELECT * FROM social_posts WHERE id = $1`, [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async hasSourceKey(sourceKey: string) {
    return (await this.q(`SELECT 1 FROM social_posts WHERE source_key = $1`, [sourceKey])).length > 0;
  }

  async list(statuses: PostStatus[], limit: number) {
    const rows = await this.q(`SELECT * FROM social_posts WHERE status = ANY($1::text[]) ORDER BY updated_at_ms DESC LIMIT $2`, [statuses, limit]);
    return rows.map(fromRow);
  }

  async transition(id: string, from: PostStatus[], patch: PostPatch, nowMs: number) {
    const sets: string[] = [];
    const params: unknown[] = [id, from];
    for (const [k, v] of Object.entries({ ...patch, updatedAtMs: nowMs })) {
      const col = COLUMNS[k as keyof PostPatch];
      if (!col) continue;
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    }
    const rows = await this.q(`UPDATE social_posts SET ${sets.join(", ")} WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`, params);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async postedSince(sinceMs: number) {
    const rows = await this.q(`SELECT id, dedupe_hash FROM social_posts WHERE (status = 'posted' AND posted_at_ms >= $1) OR status = 'posting'`, [sinceMs]);
    return rows.map((r) => ({ id: String(r.id), dedupeHash: str(r.dedupe_hash) }));
  }

  async getState<T>(name: string) {
    const rows = await this.q(`SELECT value FROM social_state WHERE name = $1`, [name]);
    return rows[0] ? (rows[0].value as T) : null;
  }

  async setState(name: string, value: unknown, nowMs: number) {
    await this.q(
      `INSERT INTO social_state (name, value, updated_at_ms) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at_ms = EXCLUDED.updated_at_ms`,
      [name, JSON.stringify(value), nowMs]
    );
  }
}
