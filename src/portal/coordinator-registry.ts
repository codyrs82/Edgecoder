// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// The portal's side of the signed coordinator registry (docs/discovery.md, "Signed registry and
// steering"): the pool (EdgeCoder seeds from REGISTRY_SEEDS plus admitted community coordinators,
// kept in the portal Postgres by coordinator-registry-store.ts), a health checker that challenges
// each one's key on an interval, and GET /network/registry, signed with REGISTRY_SIGNING_KEY_PEM.
//
// A community coordinator's way in:
//   1. Its operator (a verified account with a passkey) applies: node id, key fingerprint, https
//      URL(s), region, contact. The portal sends a fresh nonce to <url>/identity/challenge and
//      checks the signed answer against the fingerprint (the key is published and held). The
//      member is `pending`; nothing is published.
//   2. The owner approves it with a passkey assertion made for that approval. The member is on
//      `probation`: published and trusted by peer coordinators, but no new agents and no billed
//      calls go to it.
//   3. After REGISTRY_PROBATION_DAYS (7) clean UTC days in a row, counted by the health checker,
//      it becomes `active`. Outside members still get no new agents until outside steering is
//      turned on (REGISTRY_STEER_OUTSIDE_MEMBERS, off until outside billing exists).
// A wrong key or signature at a health check marks the member unhealthy at once; one that keeps
// failing past REGISTRY_IDENTITY_SUSPEND_AFTER_MS is suspended. Every admission, approval,
// suspension, key change and status change goes to the append-only, hash-chained audit table.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { fingerprintMatches, publicKeyFingerprint, tryPublicKeyFingerprint } from "../security/key-fingerprint.js";
import { verifyPayload } from "../mesh/peer.js";
import { parseSigningKey, parseVerifyKeys, publicKeyBase64 } from "../security/portal-action.js";
import { normalizeCoordinatorUrl } from "../discovery/types.js";
import { registerRegistryBillingRoute, setMemberBilling } from "./coordinator-registry-billing.js";
import type { FetchResponseLike } from "../discovery/selector.js";
import { newChallengeNonce, verifyIdentityChallenge, IDENTITY_CHALLENGE_PATH } from "../trust/identity-challenge.js";
import {
  loadRegistrySigningKey,
  signRegistry,
  type OperatorKind,
  type RegistryAdmission,
  type RegistryEntry,
  type RegistryHealth,
  type RegistryMemberStatus,
  type RegistryPayload,
  type SignedRegistry
} from "../discovery/registry.js";
import {
  MemoryRegistryStore,
  verifyAuditChain,
  type AuditEntry,
  type AuditInput,
  type RegistryStore,
  type StoredMember,
  type StoredMemberStatus
} from "./coordinator-registry-store.js";

export const DAY_MS = 86_400_000;
export const DEFAULT_PROBATION_DAYS = 7;
export const DEFAULT_MAX_MEMBERS_PER_OPERATOR = 2;
export const DEFAULT_IDENTITY_SUSPEND_AFTER_MS = 10 * 60_000;
/** A key rotation signed by the old key is accepted this close to its timestamp. */
export const ROTATION_MAX_SKEW_MS = 10 * 60_000;
const SYSTEM_ACTOR = "system";

/** A seed from REGISTRY_SEEDS (EdgeCoder's own coordinator). */
export interface PoolMember {
  peerId: string;
  publicKeyFingerprint: string;
  urls: string[];
  region: string;
  operator: { id: string; name: string; kind: OperatorKind };
  admission: RegistryAdmission;
  admittedAtMs: number;
}

/**
 * The published-member rules, as data checks: a published key and valid URLs; a community
 * coordinator also needs a verified operator and https. Stake is recorded but not enforced yet.
 */
export function admissionProblems(m: Pick<PoolMember, "publicKeyFingerprint" | "urls" | "admission"> & { operator: { kind: OperatorKind } }): string[] {
  const problems: string[] = [];
  if (!/^[0-9a-f]{64}$/.test(m.publicKeyFingerprint)) problems.push("fingerprint_invalid");
  if (!m.admission.publishedKey) problems.push("key_not_published");
  if (m.operator.kind === "community" && !m.admission.verifiedOperator) problems.push("operator_not_verified");
  if (m.urls.length === 0) problems.push("no_urls");
  for (const u of m.urls) {
    const n = normalizeCoordinatorUrl(u);
    if (!n) problems.push(`url_invalid:${u}`);
    else if (m.operator.kind === "community" && !n.startsWith("https://")) problems.push(`url_not_https:${u}`);
  }
  return problems;
}

/**
 * REGISTRY_SEEDS: EdgeCoder's own coordinators, comma separated, `peerId:fingerprint@url[=region]`
 * (the trustEntry GET /identity reports, then its URL). Repeat an entry to list another URL.
 */
export function parseRegistrySeeds(raw: string | undefined, now: number = Date.now()): PoolMember[] {
  const byPeer = new Map<string, PoolMember>();
  for (const part of (raw ?? "").split(",")) {
    const s = part.trim();
    if (!s) continue;
    const m = /^([A-Za-z0-9._-]+):([0-9a-fA-F]{64})@(https?:\/\/[^=\s]+)(?:=([A-Za-z0-9._-]{1,64}))?$/.exec(s);
    if (!m) throw new Error(`invalid REGISTRY_SEEDS entry "${s}" (expected peerId:fingerprint@https://host[=region])`);
    const url = normalizeCoordinatorUrl(m[3]);
    if (!url) throw new Error(`invalid REGISTRY_SEEDS url "${m[3]}"`);
    const existing = byPeer.get(m[1]);
    if (existing) {
      if (existing.publicKeyFingerprint !== m[2].toLowerCase()) throw new Error(`REGISTRY_SEEDS lists two keys for ${m[1]}`);
      if (!existing.urls.includes(url)) existing.urls.push(url);
      if (m[4] && existing.region === "unknown") existing.region = m[4];
      continue;
    }
    byPeer.set(m[1], {
      peerId: m[1],
      publicKeyFingerprint: m[2].toLowerCase(),
      urls: [url],
      region: m[4] ?? "unknown",
      operator: { id: "edgecoder", name: "EdgeCoder", kind: "edgecoder" },
      admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 },
      admittedAtMs: now
    });
  }
  return [...byPeer.values()];
}

/* ------------------------------------------------------------------ */
/*  Health checks with a key challenge                                 */
/* ------------------------------------------------------------------ */

/** fetch, narrowed to what the checker sends (GET /identity and health, POST the challenge). */
export type RegistryFetch = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal }
) => Promise<FetchResponseLike>;

export interface MemberHealth {
  health: RegistryHealth;
  /** URLs that passed the last check (published while healthy). */
  passingUrls: string[];
  /** True when a URL answered with the wrong peer id, key or challenge signature. */
  identityFailure?: boolean;
}

export interface HealthCheckerOptions {
  fetch?: RegistryFetch;
  now?: () => number;
  timeoutMs?: number;
  /** Consecutive network/health failures before a member is marked unhealthy (default 2). A wrong identity is immediate. */
  failThreshold?: number;
  /** The coordinator's public health route (default /health/runtime). */
  healthPath?: string;
  /** The nonce for each challenge (tests pin it to show a replayed answer is refused). */
  newNonce?: () => string;
}

async function callJson(
  fetchImpl: RegistryFetch,
  url: string,
  timeoutMs: number,
  post?: unknown
): Promise<{ status: number; body: unknown } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: post === undefined ? "GET" : "POST",
      headers: post === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      ...(post === undefined ? {} : { body: JSON.stringify(post) }),
      signal: ctl.signal
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type UrlCheck = { ok: true; latencyMs: number } | { ok: false; reason: string; identity: boolean };

export class RegistryHealthChecker {
  private readonly fetchImpl: RegistryFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly failThreshold: number;
  private readonly healthPath: string;
  private readonly newNonce: () => string;

  constructor(opts: HealthCheckerOptions = {}) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as RegistryFetch);
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.failThreshold = Math.max(1, opts.failThreshold ?? 2);
    this.healthPath = opts.healthPath ?? "/health/runtime";
    this.newNonce = opts.newNonce ?? newChallengeNonce;
  }

  /**
   * One URL: GET /identity names the member's peer id and a key with its fingerprint; then a fresh
   * nonce goes to POST /identity/challenge and the answer must be signed by that key, for that
   * nonce and this URL (a replayed or relayed answer fails); then the health route answers ok.
   */
  async checkUrl(member: { peerId: string; publicKeyFingerprint: string }, url: string): Promise<UrlCheck> {
    const base = url.replace(/\/+$/, "");
    const started = this.now();
    const id = await callJson(this.fetchImpl, `${base}/identity`, this.timeoutMs);
    const latencyMs = this.now() - started;
    if (!id) return { ok: false, reason: "unreachable", identity: false };
    if (id.status < 200 || id.status >= 300) return { ok: false, reason: `identity_http_${id.status}`, identity: false };
    const body = (id.body ?? {}) as { peerId?: unknown; publicKeyPem?: unknown };
    if (typeof body.peerId !== "string" || typeof body.publicKeyPem !== "string") return { ok: false, reason: "identity_malformed", identity: false };
    if (body.peerId !== member.peerId) return { ok: false, reason: "identity_peer_mismatch", identity: true };
    if (!fingerprintMatches(member.publicKeyFingerprint, body.publicKeyPem)) return { ok: false, reason: "identity_key_mismatch", identity: true };
    const sent = { nonce: this.newNonce(), url: base };
    const challenge = await callJson(this.fetchImpl, `${base}${IDENTITY_CHALLENGE_PATH}`, this.timeoutMs, sent);
    if (!challenge) return { ok: false, reason: "challenge_unreachable", identity: false };
    if (challenge.status < 200 || challenge.status >= 300) return { ok: false, reason: `challenge_http_${challenge.status}`, identity: false };
    const verdict = verifyIdentityChallenge(challenge.body, sent, { peerId: member.peerId, publicKeyPem: body.publicKeyPem });
    if (!verdict.ok) {
      // Another public URL than this one is a configuration problem of that URL, not an impostor:
      // only that URL fails. A wrong nonce, peer or signature is an identity failure.
      return { ok: false, reason: verdict.error, identity: verdict.error !== "challenge_coordinator_url_mismatch" && verdict.error !== "challenge_url_mismatch" };
    }
    const health = await callJson(this.fetchImpl, `${base}${this.healthPath}`, this.timeoutMs);
    if (!health) return { ok: false, reason: "health_unreachable", identity: false };
    if (health.status < 200 || health.status >= 300) return { ok: false, reason: `health_${health.status}`, identity: false };
    if ((health.body as { ok?: unknown } | null)?.ok === false) return { ok: false, reason: "health_not_ok", identity: false };
    return { ok: true, latencyMs };
  }

  /** Check every URL of a member and fold the result into its previous health. */
  async checkMember(member: { peerId: string; publicKeyFingerprint: string; urls: string[] }, prev?: MemberHealth): Promise<MemberHealth> {
    const results = await Promise.all(member.urls.map((u) => this.checkUrl(member, u)));
    const passing: string[] = [];
    let best: number | null = null;
    let reason: string | undefined;
    let identityFailure = false;
    results.forEach((r, i) => {
      if (r.ok) {
        passing.push(normalizeCoordinatorUrl(member.urls[i]) ?? member.urls[i]);
        best = best === null ? r.latencyMs : Math.min(best, r.latencyMs);
      } else {
        reason ??= r.reason;
        if (r.identity) {
          identityFailure = true;
          reason = r.reason;
        }
      }
    });
    const checkedAtMs = this.now();
    // Any URL answering with another identity is an impersonation or a misconfiguration: out now.
    if (identityFailure) {
      return { health: { status: "unhealthy", checkedAtMs, latencyMs: null, reason, consecutiveFailures: (prev?.health.consecutiveFailures ?? 0) + 1 }, passingUrls: [], identityFailure: true };
    }
    if (passing.length > 0) {
      return { health: { status: "healthy", checkedAtMs, latencyMs: best, consecutiveFailures: 0 }, passingUrls: passing };
    }
    const failures = (prev?.health.consecutiveFailures ?? 0) + 1;
    const status = failures >= this.failThreshold ? "unhealthy" : prev?.health.status === "healthy" ? "healthy" : "unknown";
    return {
      health: { status, checkedAtMs, latencyMs: null, reason, consecutiveFailures: failures },
      passingUrls: status === "healthy" ? prev?.passingUrls ?? [] : []
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Probation, clean days and identity suspension (pure)               */
/* ------------------------------------------------------------------ */

export interface ProbationConfig {
  probationDays: number;
  identitySuspendAfterMs: number;
}

export type CheckEvent = { action: "promoted" | "auto_suspended"; detail: Record<string, unknown> };

/**
 * Fold one health result into a member's counters. A UTC day is clean when no check that day
 * found the member unhealthy; a day with a failure resets the count. The day probation starts in
 * is not counted. A wrong key or signature that persists past identitySuspendAfterMs suspends a
 * community member (EdgeCoder's own are only marked unhealthy).
 */
export function applyHealthResult(m: StoredMember, r: MemberHealth, nowMs: number, cfg: ProbationConfig): { member: StoredMember; event: CheckEvent | null } {
  const next: StoredMember = { ...m, updatedAtMs: nowMs };
  let event: CheckEvent | null = null;
  const dayKey = Math.floor(nowMs / DAY_MS);
  const failed = r.health.status === "unhealthy";
  if (next.cleanDayKey === null) {
    next.cleanDayKey = dayKey;
    next.cleanDayDirty = failed;
  } else if (dayKey > next.cleanDayKey) {
    next.cleanDays = next.cleanDayDirty ? 0 : next.cleanDays + 1;
    next.cleanDayKey = dayKey;
    next.cleanDayDirty = failed;
  } else if (failed) {
    next.cleanDayDirty = true;
  }

  if (r.identityFailure) {
    next.identityFailingSinceMs ??= nowMs;
    if (next.operatorKind === "community" && next.status !== "suspended" && nowMs - next.identityFailingSinceMs >= cfg.identitySuspendAfterMs) {
      next.status = "suspended";
      next.suspensionReason = `identity_mismatch: ${r.health.reason ?? "unknown"}`;
      event = { action: "auto_suspended", detail: { reason: next.suspensionReason, failingSinceMs: next.identityFailingSinceMs } };
    }
  } else if (r.health.status === "healthy") {
    next.identityFailingSinceMs = null;
  }

  if (next.status === "probation" && next.cleanDays >= cfg.probationDays) {
    next.status = "active";
    event = { action: "promoted", detail: { cleanDays: next.cleanDays, probationStartedAtMs: next.probationStartedAtMs } };
  }
  return { member: next, event };
}

/* ------------------------------------------------------------------ */
/*  Key rotation signed by the old key                                 */
/* ------------------------------------------------------------------ */

/** The exact bytes the old key signs to hand a node id over to a new key. */
export function keyRotationPayload(p: { nodeId: string; oldFingerprint: string; newFingerprint: string; issuedAtMs: number }): string {
  return ["edgecoder-registry-key-rotation-v1", p.nodeId, p.oldFingerprint.toLowerCase(), p.newFingerprint.toLowerCase(), String(p.issuedAtMs)].join("\n");
}

export const keyRotationSchema = z.object({
  nodeId: z.string().min(1).max(256),
  oldPublicKeyPem: z.string().min(40).max(4096),
  newPublicKeyPem: z.string().min(40).max(4096),
  issuedAtMs: z.number().int().nonnegative(),
  signature: z.string().min(16).max(1024)
});

/* ------------------------------------------------------------------ */
/*  The registry service                                               */
/* ------------------------------------------------------------------ */

export interface OperatorAccount {
  exists: boolean;
  emailVerified: boolean;
  passkeys: number;
}

export const applicationSchema = z.object({
  nodeId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/),
  publicKeyFingerprint: z.string().regex(/^[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase()),
  urls: z.array(z.string().max(2048)).min(1).max(8),
  region: z.string().max(64).regex(/^[A-Za-z0-9._-]*$/).default("unknown"),
  contact: z.string().trim().min(3).max(256),
  operatorName: z.string().trim().max(256).default("")
});
export type RegistryApplication = z.infer<typeof applicationSchema>;

export interface RegistryServiceOptions {
  /** EdgeCoder's seeds (REGISTRY_SEEDS), written to the store as active platform members. */
  seeds?: PoolMember[];
  /** Members and audit (the portal Postgres; in memory when absent). */
  store?: RegistryStore;
  /** PKCS#8 PEM of the Ed25519 registry key (REGISTRY_SIGNING_KEY_PEM). Without it the registry is not served. */
  signingKeyPem?: string;
  checker?: RegistryHealthChecker;
  now?: () => number;
  /** How long a signed registry is valid (default 15 min). */
  ttlMs?: number;
  /** Health-check interval (default 60 s). */
  intervalMs?: number;
  network?: string;
  fallbackUrls?: string[];
  probationDays?: number;
  maxMembersPerOperator?: number;
  identitySuspendAfterMs?: number;
  /** Looks up an applicant's account: verified email and passkeys are required to apply. */
  operatorAccount?: (userId: string) => Promise<OperatorAccount>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /**
   * The portal's action-signing public keys to publish (raw Ed25519, base64): the current key's
   * public half, then PORTAL_ACTION_PREVIOUS_VERIFY_KEYS during a rotation. Never a private key.
   */
  portalActionKeys?: string[];
}

export type ServiceResult<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; status: number; error: string; problems?: string[] };

const COUNTED_STATUSES: ReadonlySet<StoredMemberStatus> = new Set(["pending", "probation", "active"]);
const PUBLISHED_STATUSES: ReadonlySet<StoredMemberStatus> = new Set(["probation", "active", "suspended"]);
const CHECKED_STATUSES: ReadonlySet<StoredMemberStatus> = new Set(["probation", "active"]);

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export class CoordinatorRegistryService {
  private readonly seeds: PoolMember[];
  readonly store: RegistryStore;
  private readonly signingKey: { privateKeyPem: string; publicKeyPem: string; keyId: string } | null;
  private readonly checker: RegistryHealthChecker;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly intervalMs: number;
  private readonly network: string;
  private readonly fallbackUrls: string[];
  private readonly cfg: ProbationConfig;
  readonly maxMembersPerOperator: number;
  private readonly operatorAccount: ((userId: string) => Promise<OperatorAccount>) | null;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly portalKeys: string[];
  private readonly health = new Map<string, MemberHealth>();
  private cache: StoredMember[] = [];
  private seeded = false;
  private signedCache: { doc: SignedRegistry; issuedAtMs: number; version: number } | null = null;
  private version = 0;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(opts: RegistryServiceOptions = {}) {
    this.seeds = opts.seeds ?? [];
    this.store = opts.store ?? new MemoryRegistryStore();
    this.signingKey = opts.signingKeyPem ? loadRegistrySigningKey(opts.signingKeyPem) : null;
    this.now = opts.now ?? Date.now;
    this.checker = opts.checker ?? new RegistryHealthChecker({ now: this.now });
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.intervalMs = Math.max(5_000, opts.intervalMs ?? 60_000);
    this.network = opts.network ?? "edgecoder";
    this.fallbackUrls = (opts.fallbackUrls ?? []).map((u) => normalizeCoordinatorUrl(u)).filter((u): u is string => Boolean(u));
    this.cfg = {
      probationDays: Math.max(1, opts.probationDays ?? DEFAULT_PROBATION_DAYS),
      identitySuspendAfterMs: Math.max(0, opts.identitySuspendAfterMs ?? DEFAULT_IDENTITY_SUSPEND_AFTER_MS)
    };
    this.maxMembersPerOperator = Math.max(1, opts.maxMembersPerOperator ?? DEFAULT_MAX_MEMBERS_PER_OPERATOR);
    this.operatorAccount = opts.operatorAccount ?? null;
    this.log = opts.log ?? (() => {});
    this.portalKeys = [...new Set(opts.portalActionKeys ?? [])];
  }

  /** The portal's action-signing public keys this registry publishes (current first). */
  portalActionKeys(): string[] {
    return [...this.portalKeys];
  }

  get configured(): boolean {
    return this.signingKey !== null;
  }

  publicKey(): { keyId: string; publicKeyPem: string } | null {
    return this.signingKey ? { keyId: this.signingKey.keyId, publicKeyPem: this.signingKey.publicKeyPem } : null;
  }

  /** Every member on file, as of the last load (seeds included once written). */
  members(): StoredMember[] {
    return this.cache.map((m) => ({ ...m }));
  }

  memberHealth(nodeId: string): MemberHealth | undefined {
    return this.health.get(nodeId);
  }

  /** Write the seeds (first load), then read every member from the store. */
  async load(): Promise<void> {
    if (!this.seeded) {
      for (const s of this.seeds) await this.writeSeed(s);
      this.seeded = true;
    }
    this.cache = await this.store.listMembers();
    this.version++;
  }

  private async writeSeed(s: PoolMember): Promise<void> {
    const now = this.now();
    const urls = s.urls.map((u) => normalizeCoordinatorUrl(u) ?? u);
    await this.store.transact(s.peerId, (cur) => {
      if (cur && cur.operatorKind === "edgecoder" && cur.keyFingerprints[0] === s.publicKeyFingerprint && sameList(cur.urls, urls) && cur.region === s.region && cur.status === "active") {
        return { member: null };
      }
      const member: StoredMember = {
        nodeId: s.peerId,
        keyFingerprints: [s.publicKeyFingerprint, ...(cur?.keyFingerprints ?? []).filter((f) => f !== s.publicKeyFingerprint)].slice(0, 4),
        urls,
        region: s.region,
        operatorUserId: s.operator.id,
        operatorName: s.operator.name,
        operatorKind: "edgecoder",
        contact: "",
        admission: s.admission,
        createdAtMs: cur?.createdAtMs ?? now,
        admittedAtMs: cur?.admittedAtMs ?? now,
        status: "active",
        probationStartedAtMs: null,
        cleanDays: cur?.cleanDays ?? 0,
        cleanDayKey: cur?.cleanDayKey ?? null,
        cleanDayDirty: cur?.cleanDayDirty ?? false,
        identityFailingSinceMs: null,
        suspensionReason: null,
        updatedAtMs: now
      };
      return { member, audit: this.audit(SYSTEM_ACTOR, cur ? "seed_updated" : "seeded", s.peerId, { fingerprint: s.publicKeyFingerprint, urls, region: s.region }) };
    });
  }

  private audit(actorUserId: string, action: string, nodeId: string, detail: Record<string, unknown>): AuditInput {
    return { atMs: this.now(), actorUserId, action, nodeId, detail };
  }

  /** One round: reload, challenge every probation and active member, fold the results into the store. */
  async runChecks(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        await this.load();
      } catch (err) {
        this.log("registry_load_failed", { error: String(err) });
        return;
      }
      const pool = this.cache.filter((m) => CHECKED_STATUSES.has(m.status));
      const results = await Promise.all(
        pool.map((m) => this.checker.checkMember({ peerId: m.nodeId, publicKeyFingerprint: m.keyFingerprints[0], urls: m.urls }, this.health.get(m.nodeId)).catch(() => undefined))
      );
      for (let i = 0; i < pool.length; i++) {
        const m = pool[i];
        const r = results[i];
        if (!r) continue;
        const before = this.health.get(m.nodeId)?.health.status;
        this.health.set(m.nodeId, r);
        if (before !== r.health.status) this.log("registry_health_changed", { peerId: m.nodeId, from: before ?? "none", to: r.health.status, reason: r.health.reason });
        await this.store
          .transact(m.nodeId, (cur) => {
            if (!cur || !CHECKED_STATUSES.has(cur.status) || cur.keyFingerprints[0] !== m.keyFingerprints[0]) return { member: null };
            const { member, event } = applyHealthResult(cur, r, this.now(), this.cfg);
            if (event) this.log(`registry_member_${event.action}`, { peerId: m.nodeId, ...event.detail });
            return { member, audit: event ? this.audit(SYSTEM_ACTOR, event.action, m.nodeId, event.detail) : null };
          })
          .catch((err) => this.log("registry_member_update_failed", { peerId: m.nodeId, error: String(err) }));
      }
      for (const id of [...this.health.keys()]) if (!pool.some((m) => m.nodeId === id)) this.health.delete(id);
      try {
        this.cache = await this.store.listMembers();
      } catch {
        // keep the last list
      }
      this.version++;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  start(): void {
    if (this.timer) return;
    void this.runChecks();
    this.timer = setInterval(() => void this.runChecks(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The registry as of the last round (unsigned): probation, active and suspended members. */
  snapshot(): RegistryPayload {
    const issuedAtMs = this.now();
    const coordinators: RegistryEntry[] = this.cache
      .filter((m) => PUBLISHED_STATUSES.has(m.status) && m.keyFingerprints.length > 0)
      .map((m) => {
        const status = m.status as RegistryMemberStatus;
        const h = this.health.get(m.nodeId);
        // A suspended member is listed so peers drop it; old clients read it as unhealthy and skip it.
        const health: RegistryHealth =
          status === "suspended" ? { status: "unhealthy", checkedAtMs: h?.health.checkedAtMs ?? null, latencyMs: null, reason: "suspended" } : h?.health ?? { status: "unknown", checkedAtMs: null, latencyMs: null };
        const urls = health.status === "healthy" && h && h.passingUrls.length > 0 ? h.passingUrls : m.urls.map((u) => normalizeCoordinatorUrl(u) ?? u);
        return {
          peerId: m.nodeId,
          publicKeyFingerprint: m.keyFingerprints[0],
          urls,
          region: m.region,
          operator: { id: m.operatorUserId, name: m.operatorName, kind: m.operatorKind },
          admission: m.admission,
          admittedAtMs: m.admittedAtMs ?? m.createdAtMs,
          health,
          status,
          // Phase 4: the ledger service bills for an active community member with this set.
          ...(m.operatorKind === "community" && m.billingEnabled === true ? { billingEnabled: true } : {})
        };
      });
    return {
      v: 1,
      network: this.network,
      issuedAtMs,
      expiresAtMs: issuedAtMs + this.ttlMs,
      coordinators,
      fallbackUrls: this.fallbackUrls,
      ...(this.portalKeys.length > 0 ? { portalActionKeys: [...this.portalKeys] } : {})
    };
  }

  /** The signed registry, re-signed after each round or change, or when a third of its lifetime has passed. */
  signed(): SignedRegistry | null {
    if (!this.signingKey) return null;
    const c = this.signedCache;
    if (c && c.version === this.version && this.now() - c.issuedAtMs < this.ttlMs / 3) return c.doc;
    const payload = this.snapshot();
    const doc = signRegistry(payload, this.signingKey);
    this.signedCache = { doc, issuedAtMs: payload.issuedAtMs, version: this.version };
    return doc;
  }

  /** Members an operator holds that count against the cap (pending, probation, active). */
  private operatorCount(operatorUserId: string, exceptNodeId?: string): number {
    return this.cache.filter((m) => m.operatorUserId === operatorUserId && m.nodeId !== exceptNodeId && COUNTED_STATUSES.has(m.status)).length;
  }

  /** Enrolment and approval: every URL must pass the key challenge and the health check now. */
  private async challengeAll(nodeId: string, fingerprint: string, urls: string[]): Promise<MemberHealth> {
    return this.checker.checkMember({ peerId: nodeId, publicKeyFingerprint: fingerprint, urls });
  }

  /**
   * An operator applies (signed in as `operatorUserId`). Needs a verified account with a passkey,
   * https URLs, contact details, room under the per-operator cap, and a key challenge that passes
   * at every URL (the key is published at /identity and held). The member is `pending`.
   */
  async apply(input: RegistryApplication, operatorUserId: string): Promise<ServiceResult<{ member: StoredMember }>> {
    await this.load();
    if (this.seeds.some((s) => s.peerId === input.nodeId)) return { ok: false, status: 409, error: "node_is_a_platform_coordinator" };
    const account = this.operatorAccount ? await this.operatorAccount(operatorUserId) : null;
    const problems: string[] = [];
    if (!account?.exists) problems.push("operator_unknown");
    else {
      if (!account.emailVerified) problems.push("operator_email_not_verified");
      if (account.passkeys < 1) problems.push("operator_passkey_required");
    }
    const urls = input.urls.map((u) => normalizeCoordinatorUrl(u) ?? u);
    problems.push(
      ...admissionProblems({ publicKeyFingerprint: input.publicKeyFingerprint, urls, operator: { kind: "community" }, admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 } })
    );
    if (problems.length > 0) return { ok: false, status: 422, error: "admission_rejected", problems };
    const existing = this.cache.find((m) => m.nodeId === input.nodeId);
    if (existing && existing.operatorUserId !== operatorUserId) return { ok: false, status: 409, error: "node_id_taken" };
    if (existing && existing.status !== "pending") return { ok: false, status: 409, error: "already_admitted", problems: [existing.status] };
    if (this.operatorCount(operatorUserId, input.nodeId) >= this.maxMembersPerOperator) return { ok: false, status: 422, error: "operator_cap_reached", problems: [`max_${this.maxMembersPerOperator}`] };
    const check = await this.challengeAll(input.nodeId, input.publicKeyFingerprint, urls);
    if (check.health.status !== "healthy" || check.passingUrls.length !== urls.length) {
      return { ok: false, status: 422, error: "identity_challenge_failed", problems: [check.health.reason ?? "not_all_urls_passed"] };
    }
    const now = this.now();
    const member: StoredMember = {
      nodeId: input.nodeId,
      keyFingerprints: [input.publicKeyFingerprint],
      urls,
      region: input.region || "unknown",
      operatorUserId,
      operatorName: input.operatorName,
      operatorKind: "community",
      contact: input.contact,
      admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 },
      createdAtMs: existing?.createdAtMs ?? now,
      admittedAtMs: null,
      status: "pending",
      probationStartedAtMs: null,
      cleanDays: 0,
      cleanDayKey: null,
      cleanDayDirty: false,
      identityFailingSinceMs: null,
      suspensionReason: null,
      updatedAtMs: now
    };
    const saved = await this.store.transact(input.nodeId, (cur) => {
      if (cur && (cur.operatorUserId !== operatorUserId || cur.status !== "pending")) return { member: null };
      return { member, audit: this.audit(operatorUserId, "applied", input.nodeId, { fingerprint: input.publicKeyFingerprint, urls, region: member.region }) };
    });
    await this.load();
    if (!saved || saved.status !== "pending" || saved.operatorUserId !== operatorUserId) return { ok: false, status: 409, error: "node_id_taken" };
    return { ok: true, member: saved };
  }

  /**
   * The owner approves a pending member, reinstates a suspended one, or re-approves a node id
   * under a new key (`publicKeyFingerprint`). The caller has already verified the owner's passkey
   * assertion for this approval. The key challenge must pass now; the member starts probation.
   */
  async approve(nodeId: string, actorUserId: string, opts: { publicKeyFingerprint?: string } = {}): Promise<ServiceResult<{ member: StoredMember }>> {
    await this.load();
    const cur = this.cache.find((m) => m.nodeId === nodeId);
    if (!cur) return { ok: false, status: 404, error: "not_found" };
    if (cur.operatorKind !== "community") return { ok: false, status: 409, error: "platform_coordinator" };
    const newFp = opts.publicKeyFingerprint?.toLowerCase();
    const rotating = Boolean(newFp && newFp !== cur.keyFingerprints[0]);
    if (!rotating && cur.status !== "pending" && cur.status !== "suspended") return { ok: false, status: 409, error: "not_pending", problems: [cur.status] };
    if (cur.status !== "probation" && cur.status !== "active" && this.operatorCount(cur.operatorUserId, nodeId) >= this.maxMembersPerOperator) {
      return { ok: false, status: 422, error: "operator_cap_reached", problems: [`max_${this.maxMembersPerOperator}`] };
    }
    const fingerprint = newFp ?? cur.keyFingerprints[0];
    const check = await this.challengeAll(nodeId, fingerprint, cur.urls);
    if (check.health.status !== "healthy") return { ok: false, status: 422, error: "identity_challenge_failed", problems: [check.health.reason ?? "unhealthy"] };
    const now = this.now();
    const action = rotating ? "key_rotated" : cur.status === "suspended" ? "reinstated" : "approved";
    const saved = await this.store.transact(nodeId, (row) => {
      if (!row || row.status !== cur.status || row.keyFingerprints[0] !== cur.keyFingerprints[0]) return { member: null };
      const member: StoredMember = {
        ...row,
        keyFingerprints: rotating ? [fingerprint, ...row.keyFingerprints.filter((f) => f !== fingerprint)].slice(0, 4) : row.keyFingerprints,
        admittedAtMs: row.admittedAtMs ?? now,
        status: "probation",
        probationStartedAtMs: now,
        cleanDays: 0,
        // The day probation starts in does not count.
        cleanDayKey: Math.floor(now / DAY_MS),
        cleanDayDirty: true,
        identityFailingSinceMs: null,
        suspensionReason: null,
        // Billing is approved on its own, after probation (setBilling).
        billingEnabled: false,
        updatedAtMs: now
      };
      const detail: Record<string, unknown> = { from: row.status, confirmedWith: "passkey" };
      if (rotating) Object.assign(detail, { via: "owner", fromFingerprint: row.keyFingerprints[0], toFingerprint: fingerprint });
      return { member, audit: this.audit(actorUserId, action, nodeId, detail) };
    });
    await this.load();
    if (!saved || saved.status !== "probation" || saved.probationStartedAtMs !== now) return { ok: false, status: 409, error: "changed_concurrently" };
    this.health.set(nodeId, check);
    return { ok: true, member: saved };
  }

  /** Suspend a community member: unpublished from trust at once, peers drop it at their next refresh. */
  async suspend(nodeId: string, actorUserId: string, reason: string): Promise<ServiceResult<{ member: StoredMember }>> {
    await this.load();
    const cur = this.cache.find((m) => m.nodeId === nodeId);
    if (!cur) return { ok: false, status: 404, error: "not_found" };
    if (cur.operatorKind !== "community") return { ok: false, status: 409, error: "platform_coordinator" };
    if (cur.status === "suspended") return { ok: true, member: cur };
    const now = this.now();
    const saved = await this.store.transact(nodeId, (row) => {
      if (!row || row.status === "suspended") return { member: null };
      return {
        member: { ...row, status: "suspended", suspensionReason: reason, billingEnabled: false, updatedAtMs: now },
        audit: this.audit(actorUserId, "suspended", nodeId, { from: row.status, reason })
      };
    });
    await this.load();
    return saved ? { ok: true, member: saved } : { ok: false, status: 404, error: "not_found" };
  }

  /** Ledger-service billing on or off for a community member (coordinator-registry-billing.ts). */
  setBilling(nodeId: string, actorUserId: string, enabled: boolean): Promise<ServiceResult<{ member: StoredMember }>> {
    return setMemberBilling(this, nodeId, actorUserId, enabled, this.now());
  }

  /**
   * An operator moves its node id to a new key with a statement signed by the current key. Status
   * and probation counters are kept. Without the old key's signature the owner must re-approve.
   */
  async rotateKey(input: z.infer<typeof keyRotationSchema>, operatorUserId: string): Promise<ServiceResult<{ member: StoredMember }>> {
    await this.load();
    const cur = this.cache.find((m) => m.nodeId === input.nodeId);
    if (!cur || cur.operatorKind !== "community") return { ok: false, status: 404, error: "not_found" };
    if (cur.operatorUserId !== operatorUserId) return { ok: false, status: 403, error: "not_your_coordinator" };
    if (cur.status === "suspended") return { ok: false, status: 409, error: "suspended_needs_owner_approval" };
    const oldFp = tryPublicKeyFingerprint(input.oldPublicKeyPem);
    const newFp = tryPublicKeyFingerprint(input.newPublicKeyPem);
    if (!oldFp || !newFp) return { ok: false, status: 400, error: "invalid_key" };
    if (oldFp !== cur.keyFingerprints[0]) return { ok: false, status: 403, error: "old_key_not_current" };
    if (newFp === oldFp) return { ok: false, status: 400, error: "same_key" };
    if (Math.abs(this.now() - input.issuedAtMs) > ROTATION_MAX_SKEW_MS) return { ok: false, status: 401, error: "rotation_stale" };
    const payload = keyRotationPayload({ nodeId: input.nodeId, oldFingerprint: oldFp, newFingerprint: newFp, issuedAtMs: input.issuedAtMs });
    if (!verifyPayload(payload, input.signature, input.oldPublicKeyPem)) return { ok: false, status: 401, error: "rotation_signature_invalid" };
    const now = this.now();
    const saved = await this.store.transact(input.nodeId, (row) => {
      if (!row || row.keyFingerprints[0] !== oldFp) return { member: null };
      return {
        member: { ...row, keyFingerprints: [newFp, ...row.keyFingerprints].slice(0, 4), identityFailingSinceMs: null, updatedAtMs: now },
        audit: this.audit(operatorUserId, "key_rotated", input.nodeId, { via: "old_key", fromFingerprint: oldFp, toFingerprint: newFp, issuedAtMs: input.issuedAtMs })
      };
    });
    await this.load();
    if (!saved || saved.keyFingerprints[0] !== newFp) return { ok: false, status: 409, error: "changed_concurrently" };
    this.health.delete(input.nodeId);
    return { ok: true, member: saved };
  }

  async auditTrail(limit?: number): Promise<{ entries: AuditEntry[]; chain: ReturnType<typeof verifyAuditChain> }> {
    const all = await this.store.listAudit();
    return { entries: limit ? all.slice(-limit) : all, chain: verifyAuditChain(all) };
  }
}

/**
 * The portal action keys to publish: the public half of PORTAL_ACTION_SIGNING_KEY, then each key in
 * PORTAL_ACTION_PREVIOUS_VERIFY_KEYS (the old public key while a rotation overlaps). Raw base64.
 */
export function portalActionKeysFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const signing = (env.PORTAL_ACTION_SIGNING_KEY ?? "").trim();
  if (signing) out.push(publicKeyBase64(parseSigningKey(signing)));
  for (const k of parseVerifyKeys(env.PORTAL_ACTION_PREVIOUS_VERIFY_KEYS)) out.push(publicKeyBase64(k));
  return [...new Set(out)];
}

/** Build the service from REGISTRY_* environment variables. */
export function registryServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  extra: Pick<RegistryServiceOptions, "log" | "checker" | "now" | "store" | "operatorAccount"> = {}
): CoordinatorRegistryService {
  const num = (v: string | undefined) => {
    const n = Number(v ?? "");
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) ? n : undefined;
  };
  const ttl = num(env.REGISTRY_TTL_MS);
  const interval = num(env.REGISTRY_HEALTH_INTERVAL_MS);
  // Where clients go when nothing in the pool is usable: the platform URL (the seeds).
  const fallback = (env.REGISTRY_FALLBACK_URLS ?? "https://coordinator.edgecoder.io").split(",").map((s) => s.trim()).filter(Boolean);
  return new CoordinatorRegistryService({
    seeds: parseRegistrySeeds(env.REGISTRY_SEEDS),
    signingKeyPem: env.REGISTRY_SIGNING_KEY_PEM?.trim() || undefined,
    ttlMs: ttl !== undefined && ttl >= 60_000 ? ttl : undefined,
    intervalMs: interval !== undefined && interval > 0 ? interval : undefined,
    fallbackUrls: fallback.length > 0 ? fallback : undefined,
    probationDays: num(env.REGISTRY_PROBATION_DAYS),
    maxMembersPerOperator: num(env.REGISTRY_MAX_MEMBERS_PER_OPERATOR),
    identitySuspendAfterMs: num(env.REGISTRY_IDENTITY_SUSPEND_AFTER_MS),
    portalActionKeys: portalActionKeysFromEnv(env),
    ...extra
  });
}

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

export interface RegistryPasskey {
  options(user: { userId: string; email?: string }): Promise<{ ok: true; challengeId: string; options: unknown } | { ok: false; status: number; error: string }>;
  verify(user: { userId: string }, body: unknown): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
}

export interface RegistryRouteDeps {
  service: CoordinatorRegistryService;
  /** Resolves the system admin (owner), or sends 401/403 and resolves null. */
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<{ userId: string; email?: string } | null>;
  /** The signed-in user, or null. */
  currentUser: (req: FastifyRequest) => Promise<{ userId: string; email?: string } | null>;
  /** WebAuthn assertion by the acting user's own passkey (null: passkeys not configured). */
  passkey: RegistryPasskey | null;
}

const nodeBody = z.object({ nodeId: z.string().min(1).max(256) });

function send(reply: FastifyReply, r: ServiceResult<Record<string, unknown>>, ok: () => unknown) {
  if (!r.ok) return reply.code(r.status).send({ error: r.error, ...(r.problems ? { problems: r.problems } : {}) });
  return reply.send(ok());
}

function memberView(m: StoredMember) {
  return {
    nodeId: m.nodeId,
    keyFingerprints: m.keyFingerprints,
    urls: m.urls,
    region: m.region,
    operator: { id: m.operatorUserId, name: m.operatorName, kind: m.operatorKind },
    status: m.status,
    createdAtMs: m.createdAtMs,
    admittedAtMs: m.admittedAtMs,
    probationStartedAtMs: m.probationStartedAtMs,
    cleanDays: m.cleanDays,
    suspensionReason: m.suspensionReason,
    billingEnabled: m.billingEnabled === true
  };
}

/**
 *   GET  /network/registry                                 signed registry (public; 503 until the key is set)
 *   GET  /network/registry/public-key                      the registry key's public half and keyId
 *   GET  /network/portal-keys                              the portal's action-signing public keys
 *   POST /portal/api/coordinators/registry/apply           operator: apply (key challenge now; pending)
 *   POST /portal/api/coordinators/registry/rotate-key      operator: new key, signed by the current key
 *   GET  /portal/api/coordinators/registry/mine            operator: own members and their status
 *   GET  /admin/network/registry                           owner: every member, health, audit chain check
 *   GET  /admin/network/registry/audit                     owner: the audit trail and its chain check
 *   POST /admin/network/registry/passkey-options           owner: a passkey challenge for one approval
 *   POST /admin/network/registry/approve                   owner: { nodeId, publicKeyFingerprint?, challengeId, response }
 *   POST /admin/network/registry/suspend                   owner: { nodeId, reason }
 *   POST /admin/network/registry/billing                   owner: { nodeId, enabled, challengeId?, response? } (passkey to turn on)
 */
export function registerRegistryRoutes(app: FastifyInstance, { service, requireAdmin, currentUser, passkey }: RegistryRouteDeps): void {
  app.get("/network/registry", async (_req, reply) => {
    const doc = service.signed();
    if (!doc) return reply.code(503).send({ error: "registry_not_configured" });
    return reply.header("cache-control", "public, max-age=30").send(doc);
  });

  app.get("/network/registry/public-key", async (_req, reply) => {
    const key = service.publicKey();
    if (!key) return reply.code(503).send({ error: "registry_not_configured" });
    return reply.send(key);
  });

  // The portal's action-signing public keys, for convenience. The same list is inside the signed
  // registry, which is what coordinators trust.
  app.get("/network/portal-keys", async (_req, reply) => {
    return reply.header("cache-control", "public, max-age=60").send({ keys: service.portalActionKeys(), format: "ed25519-raw-base64" });
  });

  app.post("/portal/api/coordinators/registry/apply", async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const parsed = applicationSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_application", issues: parsed.error.issues.map((i) => i.path.join(".")) });
    const r = await service.apply(parsed.data, user.userId);
    return send(reply, r, () => ({ ok: true, member: r.ok ? memberView(r.member) : null }));
  });

  app.post("/portal/api/coordinators/registry/rotate-key", async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const parsed = keyRotationSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const r = await service.rotateKey(parsed.data, user.userId);
    return send(reply, r, () => ({ ok: true, member: r.ok ? memberView(r.member) : null }));
  });

  app.get("/portal/api/coordinators/registry/mine", async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    await service.load().catch(() => undefined);
    return reply.send({ maxPerOperator: service.maxMembersPerOperator, members: service.members().filter((m) => m.operatorUserId === user.userId).map(memberView) });
  });

  app.get("/admin/network/registry", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    await service.load().catch(() => undefined);
    const { chain } = await service.auditTrail(1);
    return reply.send({
      configured: service.configured,
      maxPerOperator: service.maxMembersPerOperator,
      auditChain: chain,
      members: service.members().map((m) => ({ ...memberView(m), contact: m.contact, health: service.memberHealth(m.nodeId)?.health ?? null }))
    });
  });

  app.get("/admin/network/registry/audit", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const q = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }).safeParse(req.query ?? {});
    return reply.send(await service.auditTrail(q.success ? q.data.limit : 200));
  });

  app.post("/admin/network/registry/passkey-options", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    if (!passkey) return reply.code(503).send({ error: "passkeys_not_configured" });
    const r = await passkey.options(admin);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return reply.send({ challengeId: r.challengeId, options: r.options });
  });

  app.post("/admin/network/registry/approve", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const body = z
      .object({
        nodeId: z.string().min(1).max(256),
        publicKeyFingerprint: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
        challengeId: z.string().min(10).max(64).optional(),
        credentialId: z.string().max(1024).optional(),
        response: z.unknown().optional()
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    // The owner's passkey, asserted for this approval (a session step-up is not enough).
    if (!passkey) return reply.code(503).send({ error: "passkeys_not_configured" });
    if (!body.data.challengeId || body.data.response === undefined) return reply.code(403).send({ error: "passkey_required", detail: "Confirm the approval with your passkey." });
    const v = await passkey.verify(admin, { challengeId: body.data.challengeId, credentialId: body.data.credentialId, response: body.data.response });
    if (!v.ok) return reply.code(v.status).send({ error: v.error });
    const r = await service.approve(body.data.nodeId, admin.userId, { publicKeyFingerprint: body.data.publicKeyFingerprint });
    return send(reply, r, () => ({ ok: true, member: r.ok ? memberView(r.member) : null }));
  });

  registerRegistryBillingRoute(app, { service, requireAdmin, passkey, view: memberView });

  app.post("/admin/network/registry/suspend", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const parsed = nodeBody.extend({ reason: z.string().trim().min(1).max(500).default("suspended_by_owner") }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const r = await service.suspend(parsed.data.nodeId, admin.userId, parsed.data.reason);
    return send(reply, r, () => ({ ok: true, member: r.ok ? memberView(r.member) : null }));
  });
}

/**
 * Portal wiring: the service from REGISTRY_* env and the portal Postgres, the routes (admin =
 * system admin), and the health loop (only when a signing key is set, and not under tests).
 */
export function registerPortalRegistry(
  app: FastifyInstance,
  deps: {
    requireOpsUser: (req: FastifyRequest, reply: FastifyReply) => Promise<{ user: { userId: string; email?: string }; access: { isSystemAdmin: boolean } } | null>;
    currentUser: (req: FastifyRequest) => Promise<{ userId: string; email?: string } | null>;
    store?: RegistryStore;
    operatorAccount?: (userId: string) => Promise<OperatorAccount>;
    passkey: RegistryPasskey | null;
  },
  env: NodeJS.ProcessEnv = process.env
): CoordinatorRegistryService {
  const service = registryServiceFromEnv(env, {
    log: (msg, extra) => app.log.info({ extra }, msg),
    store: deps.store,
    operatorAccount: deps.operatorAccount
  });
  registerRegistryRoutes(app, {
    service,
    currentUser: deps.currentUser,
    passkey: deps.passkey,
    requireAdmin: async (req, reply) => {
      const principal = await deps.requireOpsUser(req, reply);
      if (!principal) return null;
      if (!principal.access.isSystemAdmin) {
        reply.code(403).send({ error: "system_admin_required" });
        return null;
      }
      return principal.user;
    }
  });
  if (service.configured && !env.VITEST && env.NODE_ENV !== "test") service.start();
  app.addHook("onClose", async () => service.stop());
  return service;
}

/** Fingerprint helper for tooling and tests. */
export { publicKeyFingerprint };
