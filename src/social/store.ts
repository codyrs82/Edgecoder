// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Brand-post queue (src/social/service.ts). One row per post with a unique source key (a weekly
 * report, a release, a docs page, an import item, or a manual draft) so a source is drafted once,
 * a table of image bytes per post (bytea, at most 4 per post), and a small key/value table for the
 * admin switch and what the drafting job has already seen. Created here with CREATE TABLE IF NOT
 * EXISTS (and ADD COLUMN IF NOT EXISTS for columns added later), like src/alerting/store.ts.
 *
 * Every status change is a conditional UPDATE (only from the expected states), so two portal
 * machines cannot both send the same post.
 */
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { MAX_IMAGES_PER_POST, type ImageType, type ValidImage } from "./media.js";

export type PostStatus = "draft" | "approved" | "posting" | "posted" | "rejected" | "failed";
export type PostKind = "weekly" | "release" | "docs" | "manual" | "import";

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
  /** Posts with the same thread id go out as one X thread, in threadPosition order. */
  threadId: string | null;
  threadPosition: number | null;
  /** UTC send time; null: as soon as it is approved. */
  scheduledAtMs: number | null;
  /** The X id of our own previous thread post this one replied to (recorded when posted). */
  replyToTweetId: string | null;
}

export interface PostImage {
  id: string;
  postId: string;
  position: number;
  filename: string;
  contentType: ImageType;
  size: number;
  alt: string | null;
  createdAtMs: number;
}

export interface PostImageWithBytes extends PostImage {
  bytes: Uint8Array;
}

export type NewDraft = Pick<SocialPost, "sourceKey" | "kind" | "text"> & Partial<Pick<SocialPost, "threadId" | "threadPosition" | "scheduledAtMs">>;
export type PostPatch = Partial<Omit<SocialPost, "id" | "sourceKey" | "kind" | "createdAtMs">>;

export interface SocialStore {
  /** Insert a draft; null when a post with this source key already exists. */
  insertDraft(d: NewDraft, nowMs: number): Promise<SocialPost | null>;
  get(id: string): Promise<SocialPost | null>;
  getBySourceKey(sourceKey: string): Promise<SocialPost | null>;
  hasSourceKey(sourceKey: string): Promise<boolean>;
  list(statuses: PostStatus[], limit: number): Promise<SocialPost[]>;
  /** Approved posts whose send time is unset or not after `nowMs`, oldest approval first. */
  listDue(nowMs: number, limit: number): Promise<SocialPost[]>;
  /** Every post of a thread (any status), in position order. */
  threadPosts(threadId: string): Promise<SocialPost[]>;
  /** Apply `patch` only when the post is in one of `from`; null otherwise. */
  transition(id: string, from: PostStatus[], patch: PostPatch, nowMs: number): Promise<SocialPost | null>;
  /** Posts sent (or being sent) since `sinceMs`, with their dedupe hash. */
  postedSince(sinceMs: number): Promise<Array<{ id: string; dedupeHash: string | null }>>;
  /** Add an image; "full" when the post already has MAX_IMAGES_PER_POST. */
  addImage(postId: string, img: ValidImage, nowMs: number): Promise<PostImage | "full">;
  /** Image metadata (no bytes) of these posts, by post and position. */
  listImages(postIds: string[]): Promise<PostImage[]>;
  getImage(imageId: string): Promise<PostImageWithBytes | null>;
  postImages(postId: string): Promise<PostImageWithBytes[]>;
  deleteImage(postId: string, imageId: string): Promise<boolean>;
  getState<T>(name: string): Promise<T | null>;
  setState(name: string, value: unknown, nowMs: number): Promise<void>;
}

const clone = (p: SocialPost): SocialPost => ({ ...p });
const byThreadOrder = (a: SocialPost, b: SocialPost) => (a.threadPosition ?? 0) - (b.threadPosition ?? 0) || a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1);

export class MemorySocialStore implements SocialStore {
  readonly posts = new Map<string, SocialPost>();
  readonly images = new Map<string, PostImageWithBytes>();
  readonly state = new Map<string, unknown>();

  async insertDraft(d: NewDraft, nowMs: number) {
    for (const p of this.posts.values()) if (p.sourceKey === d.sourceKey) return null;
    const post: SocialPost = {
      id: randomUUID(), sourceKey: d.sourceKey, kind: d.kind, text: d.text, status: "draft", createdAtMs: nowMs, updatedAtMs: nowMs,
      approvedBy: null, approvedAtMs: null, postedAtMs: null, dedupeHash: null, xTweetId: null, nostrEventId: null, nostrNote: null, error: null,
      threadId: d.threadId ?? null, threadPosition: d.threadPosition ?? null, scheduledAtMs: d.scheduledAtMs ?? null, replyToTweetId: null
    };
    this.posts.set(post.id, post);
    return clone(post);
  }
  async get(id: string) {
    const p = this.posts.get(id);
    return p ? clone(p) : null;
  }
  async getBySourceKey(sourceKey: string) {
    for (const p of this.posts.values()) if (p.sourceKey === sourceKey) return clone(p);
    return null;
  }
  async hasSourceKey(sourceKey: string) {
    return (await this.getBySourceKey(sourceKey)) !== null;
  }
  async list(statuses: PostStatus[], limit: number) {
    return [...this.posts.values()]
      .filter((p) => statuses.includes(p.status))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, limit)
      .map(clone);
  }
  async listDue(nowMs: number, limit: number) {
    return [...this.posts.values()]
      .filter((p) => p.status === "approved" && (p.scheduledAtMs === null || p.scheduledAtMs <= nowMs))
      .sort((a, b) => (a.approvedAtMs ?? 0) - (b.approvedAtMs ?? 0))
      .slice(0, limit)
      .map(clone);
  }
  async threadPosts(threadId: string) {
    return [...this.posts.values()].filter((p) => p.threadId === threadId).sort(byThreadOrder).map(clone);
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
  async addImage(postId: string, img: ValidImage, nowMs: number): Promise<PostImage | "full"> {
    const mine = [...this.images.values()].filter((i) => i.postId === postId);
    if (mine.length >= MAX_IMAGES_PER_POST) return "full";
    const row: PostImageWithBytes = {
      id: randomUUID(), postId, position: mine.reduce((m, i) => Math.max(m, i.position + 1), 0), filename: img.filename, contentType: img.contentType,
      size: img.bytes.length, alt: img.alt, createdAtMs: nowMs, bytes: img.bytes
    };
    this.images.set(row.id, row);
    const { bytes: _b, ...meta } = row;
    return meta;
  }
  async listImages(postIds: string[]) {
    return [...this.images.values()]
      .filter((i) => postIds.includes(i.postId))
      .sort((a, b) => (a.postId < b.postId ? -1 : a.postId > b.postId ? 1 : a.position - b.position))
      .map(({ bytes: _b, ...meta }) => meta);
  }
  async getImage(imageId: string) {
    const i = this.images.get(imageId);
    return i ? { ...i } : null;
  }
  async postImages(postId: string) {
    return [...this.images.values()].filter((i) => i.postId === postId).sort((a, b) => a.position - b.position).map((i) => ({ ...i }));
  }
  async deleteImage(postId: string, imageId: string) {
    const i = this.images.get(imageId);
    if (!i || i.postId !== postId) return false;
    return this.images.delete(imageId);
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
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS thread_id TEXT;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS thread_position INTEGER;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS scheduled_at_ms BIGINT;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS reply_to_tweet_id TEXT;
CREATE INDEX IF NOT EXISTS social_posts_due_idx ON social_posts (scheduled_at_ms) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS social_posts_thread_idx ON social_posts (thread_id, thread_position) WHERE thread_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS social_post_images (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES social_posts (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  alt TEXT,
  bytes BYTEA NOT NULL,
  created_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS social_post_images_post_idx ON social_post_images (post_id, position);
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
    error: str(r.error),
    threadId: str(r.thread_id),
    threadPosition: num(r.thread_position),
    scheduledAtMs: num(r.scheduled_at_ms),
    replyToTweetId: str(r.reply_to_tweet_id)
  };
}

function imageFromRow(r: Row): PostImage {
  return {
    id: String(r.id),
    postId: String(r.post_id),
    position: Number(r.position),
    filename: String(r.filename),
    contentType: String(r.content_type) as ImageType,
    size: Number(r.size),
    alt: str(r.alt),
    createdAtMs: Number(r.created_at_ms)
  };
}

const withBytes = (r: Row): PostImageWithBytes => ({ ...imageFromRow(r), bytes: new Uint8Array(r.bytes as Buffer) });

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
  error: "error",
  threadId: "thread_id",
  threadPosition: "thread_position",
  scheduledAtMs: "scheduled_at_ms",
  replyToTweetId: "reply_to_tweet_id"
};

const IMAGE_META = "id, post_id, position, filename, content_type, size, alt, created_at_ms";

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
      `INSERT INTO social_posts (id, source_key, kind, text, status, created_at_ms, updated_at_ms, thread_id, thread_position, scheduled_at_ms)
       VALUES ($1, $2, $3, $4, 'draft', $5, $5, $6, $7, $8) ON CONFLICT (source_key) DO NOTHING RETURNING *`,
      [randomUUID(), d.sourceKey, d.kind, d.text, nowMs, d.threadId ?? null, d.threadPosition ?? null, d.scheduledAtMs ?? null]
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async get(id: string) {
    const rows = await this.q(`SELECT * FROM social_posts WHERE id = $1`, [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async getBySourceKey(sourceKey: string) {
    const rows = await this.q(`SELECT * FROM social_posts WHERE source_key = $1`, [sourceKey]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async hasSourceKey(sourceKey: string) {
    return (await this.q(`SELECT 1 FROM social_posts WHERE source_key = $1`, [sourceKey])).length > 0;
  }

  async list(statuses: PostStatus[], limit: number) {
    const rows = await this.q(`SELECT * FROM social_posts WHERE status = ANY($1::text[]) ORDER BY updated_at_ms DESC LIMIT $2`, [statuses, limit]);
    return rows.map(fromRow);
  }

  async listDue(nowMs: number, limit: number) {
    const rows = await this.q(
      `SELECT * FROM social_posts WHERE status = 'approved' AND (scheduled_at_ms IS NULL OR scheduled_at_ms <= $1) ORDER BY approved_at_ms ASC NULLS FIRST LIMIT $2`,
      [nowMs, limit]
    );
    return rows.map(fromRow);
  }

  async threadPosts(threadId: string) {
    const rows = await this.q(`SELECT * FROM social_posts WHERE thread_id = $1 ORDER BY thread_position ASC NULLS FIRST, created_at_ms ASC, id ASC`, [threadId]);
    return rows.map(fromRow);
  }

  async transition(id: string, from: PostStatus[], patch: PostPatch, nowMs: number) {
    const sets: string[] = [];
    const params: unknown[] = [id, from];
    for (const [k, v] of Object.entries({ ...patch, updatedAtMs: nowMs })) {
      const col = COLUMNS[k as keyof PostPatch];
      if (!col || v === undefined) continue;
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

  async addImage(postId: string, img: ValidImage, nowMs: number): Promise<PostImage | "full"> {
    // One statement: the count check and the insert see the same snapshot of this post's images.
    const rows = await this.q(
      `INSERT INTO social_post_images (id, post_id, position, filename, content_type, size, alt, bytes, created_at_ms)
       SELECT $1::text, $2::text, COALESCE(MAX(position) + 1, 0), $3::text, $4::text, $5::integer, $6::text, $7::bytea, $8::bigint
       FROM social_post_images WHERE post_id = $2::text
       HAVING COUNT(*) < $9::integer
       RETURNING ${IMAGE_META}`,
      [randomUUID(), postId, img.filename, img.contentType, img.bytes.length, img.alt, Buffer.from(img.bytes), nowMs, MAX_IMAGES_PER_POST]
    );
    return rows[0] ? imageFromRow(rows[0]) : "full";
  }

  async listImages(postIds: string[]) {
    if (!postIds.length) return [];
    const rows = await this.q(`SELECT ${IMAGE_META} FROM social_post_images WHERE post_id = ANY($1::text[]) ORDER BY post_id, position`, [postIds]);
    return rows.map(imageFromRow);
  }

  async getImage(imageId: string) {
    const rows = await this.q(`SELECT * FROM social_post_images WHERE id = $1`, [imageId]);
    return rows[0] ? withBytes(rows[0]) : null;
  }

  async postImages(postId: string) {
    const rows = await this.q(`SELECT * FROM social_post_images WHERE post_id = $1 ORDER BY position`, [postId]);
    return rows.map(withBytes);
  }

  async deleteImage(postId: string, imageId: string) {
    return (await this.q(`DELETE FROM social_post_images WHERE id = $1 AND post_id = $2 RETURNING id`, [imageId, postId])).length > 0;
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
