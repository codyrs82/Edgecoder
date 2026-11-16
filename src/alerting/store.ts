// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Alert state (src/alerting/manager.ts). One row per (source, key) holding the current or last
 * incident, an event log for the admin page's history, and a small key/value table (the last
 * Postgres backup report). The tables are created here with CREATE TABLE IF NOT EXISTS, like
 * network_samples: the portal and the coordinators each keep theirs in their own database, and the
 * coordinators sharing one database share "shared"-scope incidents through it.
 *
 * Every notification goes through claimNotify, a conditional UPDATE: two coordinators evaluating
 * the same shared fact at the same moment send it once.
 */
import type { Pool } from "pg";
import type { AlertEvent, AlertInput, AlertRecord } from "./types.js";

export interface OpenInput extends AlertInput {
  source: string;
  rule: string;
  nowMs: number;
}

export interface AlertStore {
  get(source: string, key: string): Promise<AlertRecord | null>;
  /** Insert or refresh the incident; a resolved row starts a new incident (count, acknowledgement reset). */
  open(input: OpenInput): Promise<AlertRecord>;
  /** Take the right to notify: only when the last notification is at least `minIntervalMs` old. */
  claimNotify(source: string, key: string, nowMs: number, minIntervalMs: number): Promise<AlertRecord | null>;
  /** Close an active incident; null when it was not active (already resolved elsewhere). */
  resolve(source: string, key: string, nowMs: number): Promise<AlertRecord | null>;
  acknowledge(source: string, key: string, by: string, nowMs: number): Promise<AlertRecord | null>;
  listActive(sources: string[]): Promise<AlertRecord[]>;
  addEvent(event: AlertEvent): Promise<void>;
  listEvents(sources: string[], limit: number): Promise<AlertEvent[]>;
  getState<T>(name: string): Promise<{ value: T; updatedAtMs: number } | null>;
  setState(name: string, value: unknown, nowMs: number): Promise<void>;
}

const EVENT_CAP = 2_000;

export class MemoryAlertStore implements AlertStore {
  readonly rows = new Map<string, AlertRecord>();
  readonly events: AlertEvent[] = [];
  readonly state = new Map<string, { value: unknown; updatedAtMs: number }>();
  private id = (s: string, k: string) => `${s}\u0000${k}`;

  async get(source: string, key: string) {
    const r = this.rows.get(this.id(source, key));
    return r ? { ...r } : null;
  }
  async open(i: OpenInput) {
    const id = this.id(i.source, i.key);
    const prev = this.rows.get(id);
    const fresh = !prev || prev.status === "resolved";
    const row: AlertRecord = {
      source: i.source,
      key: i.key,
      rule: i.rule,
      severity: i.severity,
      title: i.title,
      summary: i.summary,
      link: i.link ?? null,
      details: i.details ?? null,
      status: "active",
      firstSeenMs: fresh ? Math.min(i.nowMs, i.sinceMs ?? i.nowMs) : prev!.firstSeenMs,
      lastSeenMs: i.nowMs,
      resolvedAtMs: null,
      lastNotifiedMs: prev?.lastNotifiedMs ?? null,
      notifyCount: fresh ? 0 : prev!.notifyCount,
      acknowledgedAtMs: fresh ? null : prev!.acknowledgedAtMs,
      acknowledgedBy: fresh ? null : prev!.acknowledgedBy
    };
    this.rows.set(id, row);
    return { ...row };
  }
  async claimNotify(source: string, key: string, nowMs: number, minIntervalMs: number) {
    const r = this.rows.get(this.id(source, key));
    if (!r || r.status !== "active") return null;
    if (r.lastNotifiedMs !== null && r.lastNotifiedMs > nowMs - minIntervalMs) return null;
    r.lastNotifiedMs = nowMs;
    r.notifyCount += 1;
    return { ...r };
  }
  async resolve(source: string, key: string, nowMs: number) {
    const r = this.rows.get(this.id(source, key));
    if (!r || r.status !== "active") return null;
    r.status = "resolved";
    r.resolvedAtMs = nowMs;
    return { ...r };
  }
  async acknowledge(source: string, key: string, by: string, nowMs: number) {
    const r = this.rows.get(this.id(source, key));
    if (!r || r.status !== "active") return null;
    r.acknowledgedAtMs = nowMs;
    r.acknowledgedBy = by;
    return { ...r };
  }
  async listActive(sources: string[]) {
    return [...this.rows.values()].filter((r) => r.status === "active" && sources.includes(r.source)).map((r) => ({ ...r }));
  }
  async addEvent(e: AlertEvent) {
    this.events.push({ ...e });
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP);
  }
  async listEvents(sources: string[], limit: number) {
    return this.events
      .filter((e) => sources.includes(e.source))
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }
  async getState<T>(name: string) {
    const s = this.state.get(name);
    return s ? { value: s.value as T, updatedAtMs: s.updatedAtMs } : null;
  }
  async setState(name: string, value: unknown, nowMs: number) {
    this.state.set(name, { value, updatedAtMs: nowMs });
  }
}

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function fromRow(r: Row): AlertRecord {
  return {
    source: String(r.source),
    key: String(r.alert_key),
    rule: String(r.rule),
    severity: r.severity === "critical" ? "critical" : "warning",
    title: String(r.title),
    summary: String(r.summary),
    link: (r.link as string | null) ?? null,
    details: (r.details as Record<string, unknown> | null) ?? null,
    status: r.status === "active" ? "active" : "resolved",
    firstSeenMs: Number(r.first_seen_ms),
    lastSeenMs: Number(r.last_seen_ms),
    resolvedAtMs: num(r.resolved_at_ms),
    lastNotifiedMs: num(r.last_notified_ms),
    notifyCount: Number(r.notify_count ?? 0),
    acknowledgedAtMs: num(r.acknowledged_at_ms),
    acknowledgedBy: (r.acknowledged_by as string | null) ?? null
  };
}

export const ALERT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ops_alerts (
  source TEXT NOT NULL,
  alert_key TEXT NOT NULL,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  link TEXT,
  details JSONB,
  status TEXT NOT NULL,
  first_seen_ms BIGINT NOT NULL,
  last_seen_ms BIGINT NOT NULL,
  resolved_at_ms BIGINT,
  last_notified_ms BIGINT,
  notify_count INT NOT NULL DEFAULT 0,
  acknowledged_at_ms BIGINT,
  acknowledged_by TEXT,
  PRIMARY KEY (source, alert_key)
);
CREATE TABLE IF NOT EXISTS ops_alert_events (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  alert_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  at_ms BIGINT NOT NULL,
  detail JSONB
);
CREATE INDEX IF NOT EXISTS ops_alert_events_at_idx ON ops_alert_events (at_ms DESC);
CREATE TABLE IF NOT EXISTS ops_alert_state (
  name TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL
)`;

/** Events older than this are pruned (at most once an hour). */
const EVENT_RETENTION_MS = 90 * 24 * 3_600_000;

export class PostgresAlertStore implements AlertStore {
  private migrated: Promise<void> | undefined;
  private lastPruneMs = 0;

  constructor(private readonly pool: Pool) {}

  migrate(): Promise<void> {
    this.migrated ??= this.pool.query(ALERT_SCHEMA_SQL).then(() => undefined);
    this.migrated.catch(() => {
      this.migrated = undefined;
    });
    return this.migrated;
  }

  private async q(sql: string, params: unknown[]): Promise<Row[]> {
    await this.migrate();
    return (await this.pool.query(sql, params)).rows as Row[];
  }

  async get(source: string, key: string) {
    const rows = await this.q(`SELECT * FROM ops_alerts WHERE source = $1 AND alert_key = $2`, [source, key]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async open(i: OpenInput) {
    const first = Math.min(i.nowMs, i.sinceMs ?? i.nowMs);
    const rows = await this.q(
      `INSERT INTO ops_alerts (source, alert_key, rule, severity, title, summary, link, details, status, first_seen_ms, last_seen_ms, notify_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, 0)
       ON CONFLICT (source, alert_key) DO UPDATE SET
         rule = EXCLUDED.rule, severity = EXCLUDED.severity, title = EXCLUDED.title, summary = EXCLUDED.summary,
         link = EXCLUDED.link, details = EXCLUDED.details, last_seen_ms = EXCLUDED.last_seen_ms,
         first_seen_ms = CASE WHEN ops_alerts.status = 'resolved' THEN EXCLUDED.first_seen_ms ELSE ops_alerts.first_seen_ms END,
         notify_count = CASE WHEN ops_alerts.status = 'resolved' THEN 0 ELSE ops_alerts.notify_count END,
         acknowledged_at_ms = CASE WHEN ops_alerts.status = 'resolved' THEN NULL ELSE ops_alerts.acknowledged_at_ms END,
         acknowledged_by = CASE WHEN ops_alerts.status = 'resolved' THEN NULL ELSE ops_alerts.acknowledged_by END,
         resolved_at_ms = NULL,
         status = 'active'
       RETURNING *`,
      [i.source, i.key, i.rule, i.severity, i.title, i.summary, i.link ?? null, i.details ? JSON.stringify(i.details) : null, first, i.nowMs]
    );
    return fromRow(rows[0]!);
  }

  async claimNotify(source: string, key: string, nowMs: number, minIntervalMs: number) {
    const rows = await this.q(
      `UPDATE ops_alerts SET last_notified_ms = $3, notify_count = notify_count + 1
       WHERE source = $1 AND alert_key = $2 AND status = 'active' AND (last_notified_ms IS NULL OR last_notified_ms <= $4)
       RETURNING *`,
      [source, key, nowMs, nowMs - minIntervalMs]
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async resolve(source: string, key: string, nowMs: number) {
    const rows = await this.q(
      `UPDATE ops_alerts SET status = 'resolved', resolved_at_ms = $3 WHERE source = $1 AND alert_key = $2 AND status = 'active' RETURNING *`,
      [source, key, nowMs]
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async acknowledge(source: string, key: string, by: string, nowMs: number) {
    const rows = await this.q(
      `UPDATE ops_alerts SET acknowledged_at_ms = $3, acknowledged_by = $4 WHERE source = $1 AND alert_key = $2 AND status = 'active' RETURNING *`,
      [source, key, nowMs, by]
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listActive(sources: string[]) {
    const rows = await this.q(`SELECT * FROM ops_alerts WHERE status = 'active' AND source = ANY($1::text[]) ORDER BY first_seen_ms DESC`, [sources]);
    return rows.map(fromRow);
  }

  async addEvent(e: AlertEvent) {
    await this.q(
      `INSERT INTO ops_alert_events (source, alert_key, kind, severity, title, summary, at_ms, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.source, e.key, e.kind, e.severity, e.title, e.summary, e.atMs, e.detail ? JSON.stringify(e.detail) : null]
    );
    if (e.atMs - this.lastPruneMs > 3_600_000) {
      this.lastPruneMs = e.atMs;
      await this.pool.query(`DELETE FROM ops_alert_events WHERE at_ms < $1`, [e.atMs - EVENT_RETENTION_MS]).catch(() => undefined);
    }
  }

  async listEvents(sources: string[], limit: number) {
    const rows = await this.q(`SELECT * FROM ops_alert_events WHERE source = ANY($1::text[]) ORDER BY at_ms DESC, id DESC LIMIT $2`, [sources, limit]);
    return rows.map((r) => ({
      source: String(r.source),
      key: String(r.alert_key),
      kind: r.kind as AlertEvent["kind"],
      severity: r.severity === "critical" ? ("critical" as const) : r.severity === "warning" ? ("warning" as const) : null,
      title: String(r.title),
      summary: String(r.summary),
      atMs: Number(r.at_ms),
      detail: (r.detail as Record<string, unknown> | null) ?? null
    }));
  }

  async getState<T>(name: string) {
    const rows = await this.q(`SELECT value, updated_at_ms FROM ops_alert_state WHERE name = $1`, [name]);
    return rows[0] ? { value: rows[0].value as T, updatedAtMs: Number(rows[0].updated_at_ms) } : null;
  }

  async setState(name: string, value: unknown, nowMs: number) {
    await this.q(
      `INSERT INTO ops_alert_state (name, value, updated_at_ms) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at_ms = EXCLUDED.updated_at_ms`,
      [name, JSON.stringify(value), nowMs]
    );
  }
}

/**
 * Postgres first, memory when Postgres fails: a database outage is itself something to alert on,
 * so the alerts about it must not depend on the database.
 */
export class ResilientAlertStore implements AlertStore {
  constructor(
    private readonly primary: AlertStore,
    private readonly fallback: AlertStore = new MemoryAlertStore(),
    private readonly onError: (error: unknown, op: string) => void = () => undefined
  ) {}
  private async run<T>(op: string, f: (s: AlertStore) => Promise<T>): Promise<T> {
    try {
      return await f(this.primary);
    } catch (error) {
      this.onError(error, op);
      return f(this.fallback);
    }
  }
  get(s: string, k: string) { return this.run("get", (x) => x.get(s, k)); }
  open(i: OpenInput) { return this.run("open", (x) => x.open(i)); }
  claimNotify(s: string, k: string, n: number, m: number) { return this.run("claimNotify", (x) => x.claimNotify(s, k, n, m)); }
  resolve(s: string, k: string, n: number) { return this.run("resolve", (x) => x.resolve(s, k, n)); }
  acknowledge(s: string, k: string, b: string, n: number) { return this.run("acknowledge", (x) => x.acknowledge(s, k, b, n)); }
  listActive(s: string[]) { return this.run("listActive", (x) => x.listActive(s)); }
  addEvent(e: AlertEvent) { return this.run("addEvent", (x) => x.addEvent(e)); }
  listEvents(s: string[], l: number) { return this.run("listEvents", (x) => x.listEvents(s, l)); }
  getState<T>(n: string) { return this.run("getState", (x) => x.getState<T>(n)); }
  setState(n: string, v: unknown, t: number) { return this.run("setState", (x) => x.setState(n, v, t)); }
}
