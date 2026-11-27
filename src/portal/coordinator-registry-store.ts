// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// Where the signed coordinator registry keeps its members and its audit trail: two portal tables,
// created by PortalStore.migrate() (migrateCoordinatorRegistry), so every portal machine sees the
// same pool.
//
//   portal_registry_members  one row per coordinator: node id, key fingerprints (current first),
//                            URLs, operator, region, admission, status, probation counters, and
//                            the suspension reason
//   portal_registry_audit    every admission, approval, suspension, key change and status change,
//                            append-only (a trigger refuses UPDATE and DELETE), each row's hash
//                            chained to the previous row's
//
// A member change and its audit row are written in one transaction, under an advisory lock, so
// three portal machines running health rounds at once never interleave a chain.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OperatorKind, RegistryAdmission } from "../discovery/registry.js";

/** pending: applied, waiting for the owner. probation and active: published and trusted. suspended: published as such, never trusted. */
export type StoredMemberStatus = "pending" | "probation" | "active" | "suspended";

export interface StoredMember {
  nodeId: string;
  /** sha256 hex of the SPKI DER: the current key first, then earlier keys (history, at most 4). */
  keyFingerprints: string[];
  urls: string[];
  region: string;
  /** The operator's portal user id ("edgecoder" for EdgeCoder's own coordinators). */
  operatorUserId: string;
  operatorName: string;
  operatorKind: OperatorKind;
  /** How to reach the operator (not published). */
  contact: string;
  admission: RegistryAdmission;
  createdAtMs: number;
  /** When the owner approved it (null while pending). */
  admittedAtMs: number | null;
  status: StoredMemberStatus;
  probationStartedAtMs: number | null;
  /** Consecutive clean UTC days counted by the health checker. */
  cleanDays: number;
  /** The UTC day (ms / 86_400_000) being counted, and whether a check failed in it. */
  cleanDayKey: number | null;
  cleanDayDirty: boolean;
  /** Since when /identity has answered with the wrong key or signature (null while it matches). */
  identityFailingSinceMs: number | null;
  suspensionReason: string | null;
  /**
   * Whether EdgeCoder's ledger service bills network calls for this member once it is active
   * (phase 4). Set only by the owner's passkey approval; cleared by suspension and reinstatement.
   * Absent: off.
   */
  billingEnabled?: boolean;
  updatedAtMs: number;
}

export interface AuditInput {
  atMs: number;
  /** The portal user who acted, or "system" (health checker, seeds). */
  actorUserId: string;
  action: string;
  nodeId: string;
  detail: Record<string, unknown>;
}

export interface AuditEntry extends AuditInput {
  seq: number;
  prevHash: string;
  hash: string;
}

export const AUDIT_GENESIS_HASH = "0".repeat(64);

/** JSON with object keys sorted at every level, so a row hashes the same after a JSONB round trip. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** sha256 over the previous hash and the entry's fields. */
export function auditEntryHash(prevHash: string, e: AuditInput): string {
  return createHash("sha256")
    .update(canonicalJson({ prevHash, atMs: e.atMs, actorUserId: e.actorUserId, action: e.action, nodeId: e.nodeId, detail: e.detail }))
    .digest("hex");
}

/** Check a chain read oldest first: each row links to the one before and its hash is right. */
export function verifyAuditChain(entries: readonly AuditEntry[]): { ok: true; length: number } | { ok: false; brokenAtSeq: number; reason: "prev_hash" | "hash" } {
  let prev = AUDIT_GENESIS_HASH;
  for (const e of entries) {
    if (e.prevHash !== prev) return { ok: false, brokenAtSeq: e.seq, reason: "prev_hash" };
    if (auditEntryHash(e.prevHash, e) !== e.hash) return { ok: false, brokenAtSeq: e.seq, reason: "hash" };
    prev = e.hash;
  }
  return { ok: true, length: entries.length };
}

/** What a transaction on one member decides: the member to write (null: leave it) and an audit row. */
export type MemberChange = { member: StoredMember | null; audit?: AuditInput | null };

export interface RegistryStore {
  listMembers(): Promise<StoredMember[]>;
  getMember(nodeId: string): Promise<StoredMember | null>;
  /**
   * Read one member (null when absent), let `fn` decide, then write the member and its audit row
   * together. Concurrent calls for any member are serialized.
   */
  transact(nodeId: string, fn: (current: StoredMember | null) => MemberChange): Promise<StoredMember | null>;
  /** Audit rows oldest first (the most recent `limit` when given). */
  listAudit(limit?: number): Promise<AuditEntry[]>;
}

/* ------------------------------------------------------------------ */
/*  In memory (tests, and a portal without PORTAL_DATABASE_URL)        */
/* ------------------------------------------------------------------ */

export class MemoryRegistryStore implements RegistryStore {
  private readonly members = new Map<string, StoredMember>();
  private readonly audit: AuditEntry[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  async listMembers(): Promise<StoredMember[]> {
    return [...this.members.values()].map((m) => structuredClone(m));
  }

  async getMember(nodeId: string): Promise<StoredMember | null> {
    const m = this.members.get(nodeId);
    return m ? structuredClone(m) : null;
  }

  transact(nodeId: string, fn: (current: StoredMember | null) => MemberChange): Promise<StoredMember | null> {
    const run = this.chain.then(() => {
      const current = this.members.get(nodeId);
      const change = fn(current ? structuredClone(current) : null);
      if (change.member) this.members.set(nodeId, structuredClone(change.member));
      if (change.audit) this.appendAudit(change.audit);
      const after = this.members.get(nodeId);
      return after ? structuredClone(after) : null;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private appendAudit(e: AuditInput): void {
    const prevHash = this.audit.length ? this.audit[this.audit.length - 1].hash : AUDIT_GENESIS_HASH;
    const detail = JSON.parse(canonicalJson(e.detail)) as Record<string, unknown>;
    const entry = { ...e, detail };
    this.audit.push({ ...entry, seq: this.audit.length + 1, prevHash, hash: auditEntryHash(prevHash, entry) });
  }

  async listAudit(limit?: number): Promise<AuditEntry[]> {
    const all = this.audit.map((e) => structuredClone(e));
    return limit ? all.slice(-limit) : all;
  }

  /** Tests: the raw audit rows, to show a tampered chain is caught. */
  auditRowsForTest(): AuditEntry[] {
    return this.audit;
  }
}

/* ------------------------------------------------------------------ */
/*  Postgres                                                           */
/* ------------------------------------------------------------------ */

export const REGISTRY_SCHEMA_SQL = `
-- One statement batch is one transaction: portal machines starting together migrate one at a time.
SELECT pg_advisory_xact_lock(hashtext('portal_registry_migrate'));
CREATE TABLE IF NOT EXISTS portal_registry_members (
  node_id TEXT PRIMARY KEY,
  key_fingerprints TEXT[] NOT NULL,
  urls TEXT[] NOT NULL,
  region TEXT NOT NULL DEFAULT 'unknown',
  operator_user_id TEXT NOT NULL,
  operator_name TEXT NOT NULL DEFAULT '',
  operator_kind TEXT NOT NULL DEFAULT 'community',
  contact TEXT NOT NULL DEFAULT '',
  admission JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at_ms BIGINT NOT NULL,
  admitted_at_ms BIGINT,
  status TEXT NOT NULL,
  probation_started_at_ms BIGINT,
  clean_days INTEGER NOT NULL DEFAULT 0,
  clean_day_key BIGINT,
  clean_day_dirty BOOLEAN NOT NULL DEFAULT FALSE,
  identity_failing_since_ms BIGINT,
  suspension_reason TEXT,
  updated_at_ms BIGINT NOT NULL
);
ALTER TABLE portal_registry_members ADD COLUMN IF NOT EXISTS billing_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS portal_registry_members_operator_idx ON portal_registry_members (operator_user_id);
CREATE TABLE IF NOT EXISTS portal_registry_audit (
  seq BIGSERIAL PRIMARY KEY,
  at_ms BIGINT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  node_id TEXT NOT NULL,
  detail JSONB NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);
CREATE OR REPLACE FUNCTION portal_registry_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'portal_registry_audit is append-only';
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'portal_registry_audit_no_change' AND tgrelid = 'portal_registry_audit'::regclass) THEN
    CREATE TRIGGER portal_registry_audit_no_change BEFORE UPDATE OR DELETE ON portal_registry_audit
      FOR EACH ROW EXECUTE FUNCTION portal_registry_audit_append_only();
  END IF;
END
$$;
`;

/** Called from PortalStore.migrate(): idempotent (IF NOT EXISTS throughout). */
export async function migrateCoordinatorRegistry(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(REGISTRY_SCHEMA_SQL);
}

const REGISTRY_LOCK = "portal_registry";

type Row = Record<string, unknown>;
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function memberFromRow(r: Row): StoredMember {
  return {
    nodeId: String(r.node_id),
    keyFingerprints: (r.key_fingerprints as string[]) ?? [],
    urls: (r.urls as string[]) ?? [],
    region: String(r.region ?? "unknown"),
    operatorUserId: String(r.operator_user_id),
    operatorName: String(r.operator_name ?? ""),
    operatorKind: r.operator_kind === "edgecoder" ? "edgecoder" : "community",
    contact: String(r.contact ?? ""),
    admission: { verifiedOperator: false, publishedKey: false, stakeSats: 0, ...((r.admission as Partial<RegistryAdmission>) ?? {}) },
    createdAtMs: Number(r.created_at_ms),
    admittedAtMs: numOrNull(r.admitted_at_ms),
    status: String(r.status) as StoredMemberStatus,
    probationStartedAtMs: numOrNull(r.probation_started_at_ms),
    cleanDays: Number(r.clean_days ?? 0),
    cleanDayKey: numOrNull(r.clean_day_key),
    cleanDayDirty: r.clean_day_dirty === true,
    identityFailingSinceMs: numOrNull(r.identity_failing_since_ms),
    suspensionReason: (r.suspension_reason as string | null) ?? null,
    billingEnabled: r.billing_enabled === true,
    updatedAtMs: Number(r.updated_at_ms)
  };
}

function auditFromRow(r: Row): AuditEntry {
  return {
    seq: Number(r.seq),
    atMs: Number(r.at_ms),
    actorUserId: String(r.actor_user_id),
    action: String(r.action),
    nodeId: String(r.node_id),
    detail: (r.detail as Record<string, unknown>) ?? {},
    prevHash: String(r.prev_hash),
    hash: String(r.hash)
  };
}

export class PgRegistryStore implements RegistryStore {
  constructor(private readonly pool: Pool) {}

  async listMembers(): Promise<StoredMember[]> {
    const r = await this.pool.query(`SELECT * FROM portal_registry_members ORDER BY created_at_ms, node_id`);
    return r.rows.map(memberFromRow);
  }

  async getMember(nodeId: string): Promise<StoredMember | null> {
    const r = await this.pool.query(`SELECT * FROM portal_registry_members WHERE node_id = $1`, [nodeId]);
    return r.rows[0] ? memberFromRow(r.rows[0]) : null;
  }

  async transact(nodeId: string, fn: (current: StoredMember | null) => MemberChange): Promise<StoredMember | null> {
    const c: PoolClient = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // One lock for members and the audit chain: a chain row is always written after the row before it committed.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [REGISTRY_LOCK]);
      const cur = await c.query(`SELECT * FROM portal_registry_members WHERE node_id = $1`, [nodeId]);
      const change = fn(cur.rows[0] ? memberFromRow(cur.rows[0]) : null);
      if (change.member) await this.writeMember(c, change.member);
      if (change.audit) await this.appendAudit(c, change.audit);
      const after = await c.query(`SELECT * FROM portal_registry_members WHERE node_id = $1`, [nodeId]);
      await c.query("COMMIT");
      return after.rows[0] ? memberFromRow(after.rows[0]) : null;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  private async writeMember(c: PoolClient, m: StoredMember): Promise<void> {
    await c.query(
      `INSERT INTO portal_registry_members (node_id, key_fingerprints, urls, region, operator_user_id, operator_name, operator_kind, contact,
         admission, created_at_ms, admitted_at_ms, status, probation_started_at_ms, clean_days, clean_day_key, clean_day_dirty,
         identity_failing_since_ms, suspension_reason, updated_at_ms, billing_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (node_id) DO UPDATE SET key_fingerprints = EXCLUDED.key_fingerprints, urls = EXCLUDED.urls, region = EXCLUDED.region,
         operator_user_id = EXCLUDED.operator_user_id, operator_name = EXCLUDED.operator_name, operator_kind = EXCLUDED.operator_kind,
         contact = EXCLUDED.contact, admission = EXCLUDED.admission, admitted_at_ms = EXCLUDED.admitted_at_ms, status = EXCLUDED.status,
         probation_started_at_ms = EXCLUDED.probation_started_at_ms, clean_days = EXCLUDED.clean_days, clean_day_key = EXCLUDED.clean_day_key,
         clean_day_dirty = EXCLUDED.clean_day_dirty, identity_failing_since_ms = EXCLUDED.identity_failing_since_ms,
         suspension_reason = EXCLUDED.suspension_reason, updated_at_ms = EXCLUDED.updated_at_ms, billing_enabled = EXCLUDED.billing_enabled`,
      [
        m.nodeId, m.keyFingerprints, m.urls, m.region, m.operatorUserId, m.operatorName, m.operatorKind, m.contact,
        JSON.stringify(m.admission), m.createdAtMs, m.admittedAtMs, m.status, m.probationStartedAtMs, m.cleanDays, m.cleanDayKey,
        m.cleanDayDirty, m.identityFailingSinceMs, m.suspensionReason, m.updatedAtMs, m.billingEnabled === true
      ]
    );
  }

  private async appendAudit(c: PoolClient, e: AuditInput): Promise<void> {
    const last = await c.query(`SELECT hash FROM portal_registry_audit ORDER BY seq DESC LIMIT 1`);
    const prevHash = last.rows[0] ? String(last.rows[0].hash) : AUDIT_GENESIS_HASH;
    await c.query(
      `INSERT INTO portal_registry_audit (at_ms, actor_user_id, action, node_id, detail, prev_hash, hash) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [e.atMs, e.actorUserId, e.action, e.nodeId, canonicalJson(e.detail), prevHash, auditEntryHash(prevHash, e)]
    );
  }

  async listAudit(limit?: number): Promise<AuditEntry[]> {
    const r = limit
      ? await this.pool.query(`SELECT * FROM (SELECT * FROM portal_registry_audit ORDER BY seq DESC LIMIT $1) t ORDER BY seq`, [limit])
      : await this.pool.query(`SELECT * FROM portal_registry_audit ORDER BY seq`);
    return r.rows.map(auditFromRow);
  }
}
