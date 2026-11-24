// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Growth signals (src/portal/growth.ts): daily visit and sign-up counts per campaign, the first-touch
 * campaign of each new account, and which new-sign-up alerts went out. Tables are created here with
 * CREATE TABLE IF NOT EXISTS on first use, like src/social/store.ts and src/alerting/store.ts.
 *
 *   growth_utm_daily  one row per Chicago day and campaign (source, medium, campaign, content):
 *                     visits and signups. Aggregates only: no IP, user agent or user id.
 *   growth_signups    one row per human account created since this shipped: how it signed up, its
 *                     first-touch campaign, and the alert state. The email is not copied: it is
 *                     read from portal_users, and the row goes when the account is deleted.
 *   growth_state      claims that keep two portal machines from both sending the daily digest or
 *                     the same batch of held alerts.
 */
import type { Pool } from "pg";
import type { FirstTouch, Utm } from "./attribution.js";

export type SignupAlertState = "pending" | "sent" | "batched" | "ignored" | "off";

export interface SignupRecord {
  userId: string;
  email: string;
  method: string;
  createdAtMs: number;
  day: string;
  first: FirstTouch | null;
  ignored: boolean;
  alertState: SignupAlertState;
  alertedAtMs: number | null;
}

export interface DailyRow extends Utm {
  day: string;
  visits: number;
  signups: number;
}

/** A day's campaign rows can grow only this far (junk tags from scanners stop at the cap). */
export const MAX_CAMPAIGN_ROWS_PER_DAY = 500;

export interface GrowthStore {
  addVisit(day: string, u: Utm): Promise<void>;
  /** Records a new account (once; a second call for the same user does nothing and returns false). */
  recordSignup(s: Omit<SignupRecord, "alertedAtMs">): Promise<boolean>;
  /** Marks one pending signup alerted, when fewer than `max` were alerted since `sinceMs`. */
  claimSignupAlert(userId: string, nowMs: number, sinceMs: number, max: number): Promise<boolean>;
  /** Takes every pending signup (marks them batched) when the batch claim allows; [] otherwise. */
  claimPendingBatch(nowMs: number, minGapMs: number): Promise<SignupRecord[]>;
  /** How many alerts are held, and when the oldest of them signed up. */
  pendingSummary(): Promise<{ count: number; oldestMs: number | null }>;
  dailyRows(fromDay: string, toDay: string): Promise<DailyRow[]>;
  signupsOn(day: string): Promise<SignupRecord[]>;
  signupsSince(fromDay: string): Promise<Array<{ day: string; total: number; attributed: number }>>;
  /** Sets `name` to `day` only when it was unset or an earlier day: true when this caller won. */
  claimDay(name: string, day: string, nowMs: number): Promise<boolean>;
}

const keyOf = (day: string, u: Utm) => `${day}|${u.source}|${u.medium}|${u.campaign}|${u.content}`;

export class MemoryGrowthStore implements GrowthStore {
  readonly daily = new Map<string, DailyRow>();
  readonly signups = new Map<string, SignupRecord>();
  readonly state = new Map<string, { value: string; atMs: number }>();

  async addVisit(day: string, u: Utm) {
    this.bump(day, u, "visits");
  }
  private bump(day: string, u: Utm, field: "visits" | "signups") {
    const k = keyOf(day, u);
    let row = this.daily.get(k);
    if (!row) {
      if ([...this.daily.values()].filter((r) => r.day === day).length >= MAX_CAMPAIGN_ROWS_PER_DAY) return;
      row = { day, ...u, visits: 0, signups: 0 };
      this.daily.set(k, row);
    }
    row[field] += 1;
  }
  async recordSignup(s: Omit<SignupRecord, "alertedAtMs">) {
    if (this.signups.has(s.userId)) return false;
    this.signups.set(s.userId, { ...s, alertedAtMs: null });
    if (s.first && !s.ignored) this.bump(s.day, s.first, "signups");
    return true;
  }
  async claimSignupAlert(userId: string, nowMs: number, sinceMs: number, max: number) {
    const s = this.signups.get(userId);
    if (!s || s.alertState !== "pending") return false;
    const recent = [...this.signups.values()].filter((x) => x.alertState === "sent" && (x.alertedAtMs ?? 0) > sinceMs).length;
    if (recent >= max) return false;
    s.alertState = "sent";
    s.alertedAtMs = nowMs;
    return true;
  }
  async claimPendingBatch(nowMs: number, minGapMs: number) {
    const pending = [...this.signups.values()].filter((s) => s.alertState === "pending");
    if (!pending.length) return [];
    const last = this.state.get("signup_batch_ms");
    if (last && nowMs - Number(last.value) < minGapMs) return [];
    this.state.set("signup_batch_ms", { value: String(nowMs), atMs: nowMs });
    for (const s of pending) {
      s.alertState = "batched";
      s.alertedAtMs = nowMs;
    }
    return pending.map((s) => ({ ...s })).sort((a, b) => a.createdAtMs - b.createdAtMs);
  }
  async pendingSummary() {
    const p = [...this.signups.values()].filter((s) => s.alertState === "pending");
    return { count: p.length, oldestMs: p.length ? Math.min(...p.map((s) => s.createdAtMs)) : null };
  }
  async dailyRows(fromDay: string, toDay: string) {
    return [...this.daily.values()].filter((r) => r.day >= fromDay && r.day <= toDay).map((r) => ({ ...r }));
  }
  async signupsOn(day: string) {
    return [...this.signups.values()].filter((s) => s.day === day).sort((a, b) => a.createdAtMs - b.createdAtMs);
  }
  async signupsSince(fromDay: string) {
    const by = new Map<string, { day: string; total: number; attributed: number }>();
    for (const s of this.signups.values()) {
      if (s.day < fromDay || s.ignored) continue;
      const row = by.get(s.day) ?? { day: s.day, total: 0, attributed: 0 };
      row.total += 1;
      if (s.first) row.attributed += 1;
      by.set(s.day, row);
    }
    return [...by.values()];
  }
  async claimDay(name: string, day: string, nowMs: number) {
    const cur = this.state.get(name);
    if (cur && cur.value >= day) return false;
    this.state.set(name, { value: day, atMs: nowMs });
    return true;
  }
}

export const GROWTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS growth_utm_daily (
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  medium TEXT NOT NULL,
  campaign TEXT NOT NULL,
  content TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  signups INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, medium, campaign, content)
);
CREATE TABLE IF NOT EXISTS growth_signups (
  user_id TEXT PRIMARY KEY REFERENCES portal_users (user_id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  day TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  first_touch_ms BIGINT,
  ignored BOOLEAN NOT NULL DEFAULT false,
  alert_state TEXT NOT NULL,
  alerted_at_ms BIGINT
);
CREATE INDEX IF NOT EXISTS growth_signups_day_idx ON growth_signups (day);
CREATE INDEX IF NOT EXISTS growth_signups_alert_idx ON growth_signups (alert_state, alerted_at_ms);
CREATE TABLE IF NOT EXISTS growth_state (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms BIGINT NOT NULL
)`;

type Row = Record<string, unknown>;

function signupFromRow(r: Row): SignupRecord {
  const first: FirstTouch | null =
    r.first_touch_ms === null || r.first_touch_ms === undefined
      ? null
      : { source: String(r.utm_source ?? ""), medium: String(r.utm_medium ?? ""), campaign: String(r.utm_campaign ?? ""), content: String(r.utm_content ?? ""), atMs: Number(r.first_touch_ms) };
  return {
    userId: String(r.user_id),
    email: String(r.email ?? ""),
    method: String(r.method),
    createdAtMs: Number(r.created_at_ms),
    day: String(r.day),
    first,
    ignored: Boolean(r.ignored),
    alertState: String(r.alert_state) as SignupAlertState,
    alertedAtMs: r.alerted_at_ms === null || r.alerted_at_ms === undefined ? null : Number(r.alerted_at_ms)
  };
}

const SIGNUP_COLUMNS = `g.user_id, u.email, g.method, g.created_at_ms, g.day, g.utm_source, g.utm_medium, g.utm_campaign, g.utm_content, g.first_touch_ms, g.ignored, g.alert_state, g.alerted_at_ms`;

export class PostgresGrowthStore implements GrowthStore {
  private migrated: Promise<void> | undefined;

  constructor(private readonly pool: Pool) {}

  migrate(): Promise<void> {
    this.migrated ??= this.pool.query(GROWTH_SCHEMA_SQL).then(() => undefined);
    this.migrated.catch(() => {
      this.migrated = undefined;
    });
    return this.migrated;
  }

  private async q(sql: string, params: unknown[]): Promise<Row[]> {
    await this.migrate();
    return (await this.pool.query(sql, params)).rows as Row[];
  }

  private async bump(day: string, u: Utm, field: "visits" | "signups") {
    const p = [day, u.source, u.medium, u.campaign, u.content];
    const updated = await this.q(
      `UPDATE growth_utm_daily SET ${field} = ${field} + 1 WHERE day = $1 AND source = $2 AND medium = $3 AND campaign = $4 AND content = $5 RETURNING day`,
      p
    );
    if (updated.length) return;
    // A new campaign row for the day, unless the day already has the cap (then it is dropped).
    await this.q(
      `INSERT INTO growth_utm_daily (day, source, medium, campaign, content, ${field})
       SELECT $1, $2, $3, $4, $5, 1 WHERE (SELECT count(*) FROM growth_utm_daily WHERE day = $1) < $6
       ON CONFLICT (day, source, medium, campaign, content) DO UPDATE SET ${field} = growth_utm_daily.${field} + 1`,
      [...p, MAX_CAMPAIGN_ROWS_PER_DAY]
    );
  }

  async addVisit(day: string, u: Utm) {
    await this.bump(day, u, "visits");
  }

  async recordSignup(s: Omit<SignupRecord, "alertedAtMs">) {
    const f = s.first;
    const rows = await this.q(
      `INSERT INTO growth_signups (user_id, method, created_at_ms, day, utm_source, utm_medium, utm_campaign, utm_content, first_touch_ms, ignored, alert_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
      [s.userId, s.method, s.createdAtMs, s.day, f?.source ?? null, f?.medium ?? null, f?.campaign ?? null, f?.content ?? null, f?.atMs ?? null, s.ignored, s.alertState]
    );
    if (!rows.length) return false;
    if (f && !s.ignored) await this.bump(s.day, f, "signups");
    return true;
  }

  async claimSignupAlert(userId: string, nowMs: number, sinceMs: number, max: number) {
    const rows = await this.q(
      `UPDATE growth_signups SET alert_state = 'sent', alerted_at_ms = $2
       WHERE user_id = $1 AND alert_state = 'pending'
         AND (SELECT count(*) FROM growth_signups WHERE alert_state = 'sent' AND alerted_at_ms > $3) < $4
       RETURNING user_id`,
      [userId, nowMs, sinceMs, max]
    );
    return rows.length > 0;
  }

  async claimPendingBatch(nowMs: number, minGapMs: number) {
    if ((await this.pendingSummary()).count === 0) return [];
    // One machine wins the batch: the stored time moves only when the last batch is old enough.
    const won = await this.q(
      `INSERT INTO growth_state (name, value, updated_at_ms) VALUES ('signup_batch_ms', $1, $2)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at_ms = EXCLUDED.updated_at_ms
       WHERE growth_state.value::bigint <= $3 RETURNING name`,
      [String(nowMs), nowMs, nowMs - minGapMs]
    );
    if (!won.length) return [];
    const taken = await this.q(`UPDATE growth_signups SET alert_state = 'batched', alerted_at_ms = $1 WHERE alert_state = 'pending' RETURNING user_id`, [nowMs]);
    if (!taken.length) return [];
    const rows = await this.q(`SELECT ${SIGNUP_COLUMNS} FROM growth_signups g JOIN portal_users u ON u.user_id = g.user_id WHERE g.user_id = ANY($1::text[]) ORDER BY g.created_at_ms`, [
      taken.map((r) => String(r.user_id))
    ]);
    return rows.map(signupFromRow);
  }

  async pendingSummary() {
    const rows = await this.q(`SELECT count(*)::int AS n, min(created_at_ms) AS oldest FROM growth_signups WHERE alert_state = 'pending'`, []);
    const n = Number(rows[0]?.n ?? 0);
    return { count: n, oldestMs: n && rows[0]?.oldest !== null ? Number(rows[0]!.oldest) : null };
  }

  async dailyRows(fromDay: string, toDay: string) {
    const rows = await this.q(`SELECT * FROM growth_utm_daily WHERE day >= $1 AND day <= $2 ORDER BY day DESC, visits DESC, signups DESC`, [fromDay, toDay]);
    return rows.map((r) => ({
      day: String(r.day),
      source: String(r.source),
      medium: String(r.medium),
      campaign: String(r.campaign),
      content: String(r.content),
      visits: Number(r.visits),
      signups: Number(r.signups)
    }));
  }

  async signupsOn(day: string) {
    const rows = await this.q(`SELECT ${SIGNUP_COLUMNS} FROM growth_signups g JOIN portal_users u ON u.user_id = g.user_id WHERE g.day = $1 ORDER BY g.created_at_ms`, [day]);
    return rows.map(signupFromRow);
  }

  async signupsSince(fromDay: string) {
    const rows = await this.q(
      `SELECT day, count(*)::int AS total, count(first_touch_ms)::int AS attributed FROM growth_signups WHERE day >= $1 AND NOT ignored GROUP BY day`,
      [fromDay]
    );
    return rows.map((r) => ({ day: String(r.day), total: Number(r.total), attributed: Number(r.attributed) }));
  }

  async claimDay(name: string, day: string, nowMs: number) {
    const rows = await this.q(
      `INSERT INTO growth_state (name, value, updated_at_ms) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at_ms = EXCLUDED.updated_at_ms
       WHERE growth_state.value < EXCLUDED.value RETURNING name`,
      [name, day, nowMs]
    );
    return rows.length > 0;
  }
}
