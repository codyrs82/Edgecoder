// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { safeTokenEqual } from "../common/crypto-utils.js";
import { tryPublicKeyFingerprint } from "../security/key-fingerprint.js";
import { SERVICE_REQUEST_MAX_SKEW_MS, verifyCoordinatorPortalSignature } from "../security/service-request-signing.js";

/*
 * Per-coordinator portal credentials. A coordinator calls the portal's /internal routes signed with
 * its own identity key (src/security/service-request-signing.ts); there is no shared secret. The
 * portal trusts that key for that coordinator when:
 *   - an active credential row names the key's fingerprint for the coordinator (portal Postgres,
 *     portal_service_credentials), or
 *   - the signed registry lists the coordinator, on probation or active, with that fingerprint
 *     (a credential row is then written for it, so it can be revoked like any other), or
 *   - the coordinator is enrolled (a coordinator node with its registration token) and presents
 *     that token once with the signed request: the key is then bound to the enrolment.
 * Revocation is per coordinator: a registry suspension refuses it at once, and an admin revoke marks
 * all its rows; a revoked coordinator cannot bind a new key itself (an admin enrols it again).
 *
 * Scopes:
 *   nodes:validate     POST /internal/nodes/validate, only for agents registering to that coordinator
 *                      (and its own coordinator node); the validation is recorded against it.
 *   nodes:lookup:self  POST /internal/nodes/lookup and GET /internal/nodes/pending, only about nodes
 *                      that validated against that coordinator.
 *   stats:read         GET /internal/stats/counts.
 * Every other /internal route refuses a coordinator credential.
 */

export const COORDINATOR_SCOPES = ["nodes:validate", "nodes:lookup:self", "stats:read"] as const;
export type CoordinatorScope = (typeof COORDINATOR_SCOPES)[number];

/** The scope each /internal route needs from a signed coordinator (Fastify route pattern -> scope). */
export const INTERNAL_ROUTE_SCOPES: Readonly<Record<string, CoordinatorScope>> = {
  "POST /internal/nodes/validate": "nodes:validate",
  "POST /internal/nodes/lookup": "nodes:lookup:self",
  "GET /internal/nodes/pending": "nodes:lookup:self",
  "GET /internal/stats/counts": "stats:read"
};

export function scopeForRoute(method: string, routePattern: string): CoordinatorScope | null {
  return INTERNAL_ROUTE_SCOPES[`${method.toUpperCase()} ${routePattern}`] ?? null;
}

export type CredentialSource = "enrolled" | "registry" | "admin";

export interface CoordinatorCredential {
  id: string;
  coordinatorNodeId: string;
  /** Portal user who operates the coordinator ("" when unknown). */
  operatorUserId: string;
  publicKeyFingerprint: string;
  scopes: CoordinatorScope[];
  source: CredentialSource;
  createdAtMs: number;
  revokedAtMs: number | null;
  revokedReason: string | null;
  lastUsedMs: number | null;
}

export interface CoordinatorCredentialStore {
  listForCoordinator(coordinatorNodeId: string): Promise<CoordinatorCredential[]>;
  list(limit?: number): Promise<CoordinatorCredential[]>;
  insert(c: CoordinatorCredential): Promise<void>;
  /** Revoke every active row of the coordinator; returns how many were revoked. */
  revokeCoordinator(coordinatorNodeId: string, reason: string, atMs: number): Promise<number>;
  revokeById(id: string, reason: string, atMs: number): Promise<boolean>;
  touch(id: string, atMs: number): Promise<void>;
  /** True the first time `nonce` is seen (shared by every portal machine with the Postgres store). */
  nonceOnce(nonce: string, expiresAtMs: number): Promise<boolean>;
}

export function normalizeScopes(raw: readonly string[] | undefined): CoordinatorScope[] {
  if (!raw) return [...COORDINATOR_SCOPES];
  return COORDINATOR_SCOPES.filter((s) => raw.includes(s));
}

export class MemoryCoordinatorCredentialStore implements CoordinatorCredentialStore {
  private readonly rows = new Map<string, CoordinatorCredential>();
  private readonly nonces = new Map<string, number>();

  async listForCoordinator(coordinatorNodeId: string): Promise<CoordinatorCredential[]> {
    return [...this.rows.values()].filter((r) => r.coordinatorNodeId === coordinatorNodeId).map((r) => ({ ...r, scopes: [...r.scopes] }));
  }
  async list(limit = 500): Promise<CoordinatorCredential[]> {
    return [...this.rows.values()].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, limit).map((r) => ({ ...r, scopes: [...r.scopes] }));
  }
  async insert(c: CoordinatorCredential): Promise<void> {
    this.rows.set(c.id, { ...c, scopes: [...c.scopes] });
  }
  async revokeCoordinator(coordinatorNodeId: string, reason: string, atMs: number): Promise<number> {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.coordinatorNodeId === coordinatorNodeId && r.revokedAtMs === null) {
        r.revokedAtMs = atMs;
        r.revokedReason = reason;
        n++;
      }
    }
    return n;
  }
  async revokeById(id: string, reason: string, atMs: number): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.revokedAtMs !== null) return false;
    r.revokedAtMs = atMs;
    r.revokedReason = reason;
    return true;
  }
  async touch(id: string, atMs: number): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.lastUsedMs = atMs;
  }
  async nonceOnce(nonce: string, expiresAtMs: number): Promise<boolean> {
    const now = Date.now();
    if (this.nonces.size > 50_000) for (const [k, exp] of this.nonces) if (exp < now) this.nonces.delete(k);
    const prev = this.nonces.get(nonce);
    if (prev !== undefined && prev >= now) return false;
    this.nonces.set(nonce, expiresAtMs);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/*  Postgres                                                           */
/* ------------------------------------------------------------------ */

export const COORDINATOR_CREDENTIALS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS portal_service_credentials (
  id TEXT PRIMARY KEY,
  coordinator_node_id TEXT NOT NULL,
  operator_user_id TEXT NOT NULL DEFAULT '',
  public_key_fingerprint TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  source TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  revoked_at_ms BIGINT,
  revoked_reason TEXT,
  last_used_ms BIGINT
);
CREATE INDEX IF NOT EXISTS portal_service_credentials_coordinator_idx ON portal_service_credentials (coordinator_node_id);
CREATE TABLE IF NOT EXISTS portal_service_credential_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_service_credential_nonces_expires_idx ON portal_service_credential_nonces (expires_at_ms);
`;

/** Called from PortalStore.migrate(): idempotent (IF NOT EXISTS throughout). */
export async function migrateCoordinatorCredentials(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(COORDINATOR_CREDENTIALS_SCHEMA_SQL);
}

type Row = Record<string, unknown>;
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function credentialFromRow(r: Row): CoordinatorCredential {
  return {
    id: String(r.id),
    coordinatorNodeId: String(r.coordinator_node_id),
    operatorUserId: String(r.operator_user_id ?? ""),
    publicKeyFingerprint: String(r.public_key_fingerprint),
    scopes: normalizeScopes((r.scopes as string[]) ?? []),
    source: (["enrolled", "registry", "admin"].includes(String(r.source)) ? r.source : "admin") as CredentialSource,
    createdAtMs: Number(r.created_at_ms),
    revokedAtMs: numOrNull(r.revoked_at_ms),
    revokedReason: (r.revoked_reason as string | null) ?? null,
    lastUsedMs: numOrNull(r.last_used_ms)
  };
}

export class PgCoordinatorCredentialStore implements CoordinatorCredentialStore {
  private nonceWrites = 0;
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async listForCoordinator(coordinatorNodeId: string): Promise<CoordinatorCredential[]> {
    const r = await this.pool.query(`SELECT * FROM portal_service_credentials WHERE coordinator_node_id = $1 ORDER BY created_at_ms DESC`, [coordinatorNodeId]);
    return r.rows.map(credentialFromRow);
  }
  async list(limit = 500): Promise<CoordinatorCredential[]> {
    const r = await this.pool.query(`SELECT * FROM portal_service_credentials ORDER BY created_at_ms DESC LIMIT $1`, [limit]);
    return r.rows.map(credentialFromRow);
  }
  async insert(c: CoordinatorCredential): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_service_credentials (id, coordinator_node_id, operator_user_id, public_key_fingerprint, scopes, source, created_at_ms, revoked_at_ms, revoked_reason, last_used_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [c.id, c.coordinatorNodeId, c.operatorUserId, c.publicKeyFingerprint, c.scopes, c.source, c.createdAtMs, c.revokedAtMs, c.revokedReason, c.lastUsedMs]
    );
  }
  async revokeCoordinator(coordinatorNodeId: string, reason: string, atMs: number): Promise<number> {
    const r = await this.pool.query(
      `UPDATE portal_service_credentials SET revoked_at_ms = $2, revoked_reason = $3 WHERE coordinator_node_id = $1 AND revoked_at_ms IS NULL`,
      [coordinatorNodeId, atMs, reason]
    );
    return r.rowCount ?? 0;
  }
  async revokeById(id: string, reason: string, atMs: number): Promise<boolean> {
    const r = await this.pool.query(`UPDATE portal_service_credentials SET revoked_at_ms = $2, revoked_reason = $3 WHERE id = $1 AND revoked_at_ms IS NULL`, [id, atMs, reason]);
    return (r.rowCount ?? 0) > 0;
  }
  async touch(id: string, atMs: number): Promise<void> {
    // At most one write a minute per credential.
    await this.pool.query(`UPDATE portal_service_credentials SET last_used_ms = $2 WHERE id = $1 AND (last_used_ms IS NULL OR last_used_ms < $2 - 60000)`, [id, atMs]);
  }
  async nonceOnce(nonce: string, expiresAtMs: number): Promise<boolean> {
    if (++this.nonceWrites % 500 === 0) {
      await this.pool.query(`DELETE FROM portal_service_credential_nonces WHERE expires_at_ms < $1`, [Date.now()]).catch(() => undefined);
    }
    const r = await this.pool.query(`INSERT INTO portal_service_credential_nonces (nonce, expires_at_ms) VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING`, [nonce, expiresAtMs]);
    return (r.rowCount ?? 0) > 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Verification                                                       */
/* ------------------------------------------------------------------ */

/** What the registry says about a coordinator (src/portal/coordinator-registry.ts members). */
export interface RegistryMemberView {
  nodeId: string;
  status: "pending" | "probation" | "active" | "suspended";
  keyFingerprints: string[];
  operatorUserId: string;
}

export interface CoordinatorCredentialDeps {
  store: CoordinatorCredentialStore;
  /** The registry's member for this node id, or null when unlisted (or no registry). */
  registryMember: (nodeId: string) => RegistryMemberView | null;
  /**
   * The coordinator's portal enrolment, when `registrationToken` is its COORDINATOR_REGISTRATION_TOKEN:
   * the owner's user id. Null otherwise.
   */
  enrolledCoordinator: (nodeId: string, registrationToken: string) => Promise<{ ownerUserId: string } | null>;
  now?: () => number;
  log?: (msg: string, extra: Record<string, unknown>) => void;
}

export type CoordinatorCaller = { coordinatorId: string; credentialId: string; scopes: CoordinatorScope[]; source: CredentialSource };
export type CoordinatorCredentialDecision = ({ ok: true } & CoordinatorCaller) | { ok: false; code: 401 | 403 | 409; error: string };

function headerStr(headers: Record<string, unknown>, k: string): string {
  const v = headers[k];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Verify a coordinator-signed /internal request in full: the signature (with the body bytes), the
 * trust in that key for that coordinator (registry, credential rows, enrolment), revocation, and the
 * single-use nonce.
 */
export async function verifyCoordinatorCredential(
  deps: CoordinatorCredentialDeps,
  input: { headers: Record<string, unknown>; method: string; path: string; rawBody: string | Buffer | null }
): Promise<CoordinatorCredentialDecision> {
  const now = deps.now?.() ?? Date.now();
  const sig = verifyCoordinatorPortalSignature({ headers: input.headers, method: input.method, path: input.path, rawBody: input.rawBody ?? "", nowMs: now });
  if (!sig.ok) return sig;
  const { coordinatorId, fingerprint } = sig;

  const member = deps.registryMember(coordinatorId);
  if (member?.status === "suspended") return { ok: false, code: 403, error: "coordinator_suspended" };

  const rows = await deps.store.listForCoordinator(coordinatorId);
  // A key bound through the registry holds only while the registry still lists it as the current one.
  const active = rows.find(
    (r) => r.revokedAtMs === null && r.publicKeyFingerprint === fingerprint && !(r.source === "registry" && member && member.keyFingerprints[0] !== fingerprint)
  );
  const revoked = rows.some((r) => r.revokedAtMs !== null);
  let credential: CoordinatorCredential | undefined = active;
  if (!credential) {
    if (revoked) return { ok: false, code: 403, error: "coordinator_credential_revoked" };
    const registryTrusted = member && (member.status === "probation" || member.status === "active") && member.keyFingerprints[0] === fingerprint;
    let source: CredentialSource | null = registryTrusted ? "registry" : null;
    let operatorUserId = registryTrusted ? member!.operatorUserId : "";
    if (!source) {
      const token = headerStr(input.headers, "x-coordinator-registration-token");
      const claimed = headerStr(input.headers, "x-coordinator-node-id");
      const enrolled = token.length >= 10 && claimed === coordinatorId ? await deps.enrolledCoordinator(coordinatorId, token) : null;
      if (enrolled) {
        source = "enrolled";
        operatorUserId = enrolled.ownerUserId;
      }
    }
    if (!source) return { ok: false, code: 403, error: "coordinator_not_enrolled" };
    credential = {
      id: `pcred-${randomUUID()}`,
      coordinatorNodeId: coordinatorId,
      operatorUserId,
      publicKeyFingerprint: fingerprint,
      scopes: [...COORDINATOR_SCOPES],
      source,
      createdAtMs: now,
      revokedAtMs: null,
      revokedReason: null,
      lastUsedMs: now
    };
    await deps.store.insert(credential);
    deps.log?.("portal_coordinator_credential_bound", { coordinatorId, source, fingerprint });
  }

  if (!(await deps.store.nonceOnce(`coord:${coordinatorId}:${sig.nonce}`, sig.issuedAtMs + 2 * SERVICE_REQUEST_MAX_SKEW_MS))) {
    return { ok: false, code: 409, error: "coordinator_signature_replayed" };
  }
  void deps.store.touch(credential.id, now).catch(() => undefined);
  return { ok: true, coordinatorId, credentialId: credential.id, scopes: credential.scopes, source: credential.source };
}

/** Admin enrolment of a coordinator key (also how a revoked coordinator is let back in). */
export async function enrollCoordinatorCredential(
  store: CoordinatorCredentialStore,
  input: { coordinatorNodeId: string; publicKeyPem?: string; publicKeyFingerprint?: string; scopes?: string[]; operatorUserId?: string },
  nowMs = Date.now()
): Promise<{ ok: true; credential: CoordinatorCredential } | { ok: false; error: string }> {
  const nodeId = input.coordinatorNodeId.trim();
  if (nodeId.length < 3) return { ok: false, error: "coordinator_node_id_invalid" };
  const fp = input.publicKeyPem ? tryPublicKeyFingerprint(input.publicKeyPem) : (input.publicKeyFingerprint ?? "").trim().toLowerCase();
  if (!fp || !/^[0-9a-f]{64}$/.test(fp)) return { ok: false, error: "public_key_invalid" };
  const scopes = normalizeScopes(input.scopes);
  if (scopes.length === 0) return { ok: false, error: "scopes_invalid" };
  const credential: CoordinatorCredential = {
    id: `pcred-${randomUUID()}`,
    coordinatorNodeId: nodeId,
    operatorUserId: input.operatorUserId ?? "",
    publicKeyFingerprint: fp,
    scopes,
    source: "admin",
    createdAtMs: nowMs,
    revokedAtMs: null,
    revokedReason: null,
    lastUsedMs: null
  };
  await store.insert(credential);
  return { ok: true, credential };
}

/**
 * The portal's wiring (server.ts): credential rows in the portal Postgres (memory without one), the
 * registry's members, and coordinator enrolments checked by their registration token hash.
 */
export function portalCoordinatorCredentials(opts: {
  pool: Pick<Pool, "query"> | null;
  registryMembers: () => RegistryMemberView[];
  enrollment: (nodeId: string) => Promise<{ nodeKind: string; registrationTokenHash: string; ownerUserId: string } | null>;
  sha256Hex: (v: string) => string;
  log?: (msg: string, extra: Record<string, unknown>) => void;
}): CoordinatorCredentialDeps {
  return {
    store: opts.pool ? new PgCoordinatorCredentialStore(opts.pool) : new MemoryCoordinatorCredentialStore(),
    registryMember: (nodeId) => opts.registryMembers().find((m) => m.nodeId === nodeId) ?? null,
    enrolledCoordinator: async (nodeId, registrationToken) => {
      const node = await opts.enrollment(nodeId);
      if (!node || node.nodeKind !== "coordinator") return null;
      return safeTokenEqual(node.registrationTokenHash, opts.sha256Hex(registrationToken)) ? { ownerUserId: node.ownerUserId } : null;
    },
    log: opts.log
  };
}
