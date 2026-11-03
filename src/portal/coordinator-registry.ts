// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// The portal's side of the signed coordinator registry (docs/discovery.md, "Signed registry and
// steering"): the pool (EdgeCoder seeds from REGISTRY_SEEDS plus admitted community coordinators),
// a health checker that confirms each one's /identity (peerId and key) and health on an interval,
// and GET /network/registry, signed with REGISTRY_SIGNING_KEY_PEM. Clients pick from it by latency.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { fingerprintMatches } from "../security/key-fingerprint.js";
import { normalizeCoordinatorUrl } from "../discovery/types.js";
import type { FetchLike } from "../discovery/selector.js";
import {
  loadRegistrySigningKey,
  signRegistry,
  type OperatorKind,
  type RegistryAdmission,
  type RegistryEntry,
  type RegistryHealth,
  type RegistryPayload,
  type SignedRegistry
} from "../discovery/registry.js";

/** A coordinator admitted to the pool (what an admin records; health is added by the checker). */
export interface PoolMember {
  peerId: string;
  publicKeyFingerprint: string;
  urls: string[];
  region: string;
  operator: { id: string; name: string; kind: OperatorKind };
  admission: RegistryAdmission;
  admittedAtMs: number;
  /** Suspended members stay on file but are not published. */
  suspended?: boolean;
}

export const poolMemberSchema = z.object({
  peerId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/),
  publicKeyFingerprint: z.string().regex(/^[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase()),
  urls: z.array(z.string().max(2048)).min(1).max(8),
  region: z.string().max(64).default("unknown"),
  operator: z.object({ id: z.string().min(1).max(256), name: z.string().max(256).default(""), kind: z.enum(["edgecoder", "community"]).default("community") }),
  admission: z.object({
    verifiedOperator: z.boolean().default(false),
    publishedKey: z.boolean().default(false),
    stakeSats: z.number().int().nonnegative().default(0)
  }),
  admittedAtMs: z.number().int().nonnegative().optional(),
  suspended: z.boolean().optional()
});

/**
 * The admission rules, as data checks. Every member needs a published key and valid URLs; a
 * community coordinator also needs a verified operator and https. Stake, uptime history and the
 * reliability score are recorded for later rules but not enforced yet.
 */
export function admissionProblems(m: PoolMember): string[] {
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
/*  Health checks                                                      */
/* ------------------------------------------------------------------ */

export interface MemberHealth {
  health: RegistryHealth;
  /** URLs that passed the last check (published while healthy). */
  passingUrls: string[];
}

export interface HealthCheckerOptions {
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  /** Consecutive network/health failures before a member is marked unhealthy (default 2). A wrong identity is immediate. */
  failThreshold?: number;
  /** The coordinator's public health route (default /health/runtime). */
  healthPath?: string;
}

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<{ status: number; body: unknown } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: ctl.signal });
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

type UrlCheck = { ok: true; latencyMs: number } | { ok: false; reason: string; identity: boolean };

export class RegistryHealthChecker {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly failThreshold: number;
  private readonly healthPath: string;

  constructor(opts: HealthCheckerOptions = {}) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.failThreshold = Math.max(1, opts.failThreshold ?? 2);
    this.healthPath = opts.healthPath ?? "/health/runtime";
  }

  async checkUrl(member: Pick<PoolMember, "peerId" | "publicKeyFingerprint">, url: string): Promise<UrlCheck> {
    const base = url.replace(/\/+$/, "");
    const started = this.now();
    const id = await getJson(this.fetchImpl, `${base}/identity`, this.timeoutMs);
    const latencyMs = this.now() - started;
    if (!id) return { ok: false, reason: "unreachable", identity: false };
    if (id.status < 200 || id.status >= 300) return { ok: false, reason: `identity_http_${id.status}`, identity: false };
    const body = (id.body ?? {}) as { peerId?: unknown; publicKeyPem?: unknown };
    if (typeof body.peerId !== "string" || typeof body.publicKeyPem !== "string") return { ok: false, reason: "identity_malformed", identity: false };
    if (body.peerId !== member.peerId) return { ok: false, reason: "identity_peer_mismatch", identity: true };
    if (!fingerprintMatches(member.publicKeyFingerprint, body.publicKeyPem)) return { ok: false, reason: "identity_key_mismatch", identity: true };
    const health = await getJson(this.fetchImpl, `${base}${this.healthPath}`, this.timeoutMs);
    if (!health) return { ok: false, reason: "health_unreachable", identity: false };
    if (health.status < 200 || health.status >= 300) return { ok: false, reason: `health_${health.status}`, identity: false };
    if ((health.body as { ok?: unknown } | null)?.ok === false) return { ok: false, reason: "health_not_ok", identity: false };
    return { ok: true, latencyMs };
  }

  /** Check every URL of a member and fold the result into its previous health. */
  async checkMember(member: PoolMember, prev?: MemberHealth): Promise<MemberHealth> {
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
      return { health: { status: "unhealthy", checkedAtMs, latencyMs: null, reason, consecutiveFailures: (prev?.health.consecutiveFailures ?? 0) + 1 }, passingUrls: [] };
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
/*  The registry service                                               */
/* ------------------------------------------------------------------ */

export interface RegistryServiceOptions {
  /** EdgeCoder's seeds (REGISTRY_SEEDS). */
  seeds?: PoolMember[];
  /** Community admissions file (REGISTRY_POOL_FILE): a JSON array of PoolMember. */
  poolFile?: string | null;
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
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class CoordinatorRegistryService {
  private readonly seeds: PoolMember[];
  private community: PoolMember[] = [];
  private readonly poolFile: string | null;
  private readonly signingKey: { privateKeyPem: string; publicKeyPem: string; keyId: string } | null;
  private readonly checker: RegistryHealthChecker;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly intervalMs: number;
  private readonly network: string;
  private readonly fallbackUrls: string[];
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly health = new Map<string, MemberHealth>();
  private signedCache: { doc: SignedRegistry; issuedAtMs: number; version: number } | null = null;
  private version = 0;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(opts: RegistryServiceOptions = {}) {
    this.seeds = opts.seeds ?? [];
    this.poolFile = opts.poolFile ?? null;
    this.signingKey = opts.signingKeyPem ? loadRegistrySigningKey(opts.signingKeyPem) : null;
    this.checker = opts.checker ?? new RegistryHealthChecker({ now: opts.now });
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.intervalMs = Math.max(5_000, opts.intervalMs ?? 60_000);
    this.network = opts.network ?? "edgecoder";
    this.fallbackUrls = (opts.fallbackUrls ?? []).map((u) => normalizeCoordinatorUrl(u)).filter((u): u is string => Boolean(u));
    this.log = opts.log ?? (() => {});
    if (this.poolFile && existsSync(this.poolFile)) {
      const raw = JSON.parse(readFileSync(this.poolFile, "utf8")) as unknown;
      const list = Array.isArray(raw) ? raw : [];
      for (const item of list) {
        const p = poolMemberSchema.safeParse(item);
        if (p.success) this.community.push({ ...p.data, admittedAtMs: p.data.admittedAtMs ?? this.now() });
        else this.log("registry_pool_entry_invalid", { issues: p.error.issues.length });
      }
    }
  }

  get configured(): boolean {
    return this.signingKey !== null;
  }

  publicKey(): { keyId: string; publicKeyPem: string } | null {
    return this.signingKey ? { keyId: this.signingKey.keyId, publicKeyPem: this.signingKey.publicKeyPem } : null;
  }

  /** Every member on file (seeds win over a community record with the same peerId). */
  members(): PoolMember[] {
    const seen = new Set(this.seeds.map((s) => s.peerId));
    return [...this.seeds, ...this.community.filter((c) => !seen.has(c.peerId))];
  }

  /** Members that pass the admission rules and are not suspended: the published pool. */
  admitted(): PoolMember[] {
    return this.members().filter((m) => !m.suspended && admissionProblems(m).length === 0);
  }

  memberHealth(peerId: string): MemberHealth | undefined {
    return this.health.get(peerId);
  }

  /** One round of health checks over the admitted pool. Concurrent callers share the round. */
  async runChecks(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      const pool = this.admitted();
      const results = await Promise.all(pool.map((m) => this.checker.checkMember(m, this.health.get(m.peerId)).catch(() => undefined)));
      pool.forEach((m, i) => {
        const r = results[i];
        if (!r) return;
        const before = this.health.get(m.peerId)?.health.status;
        this.health.set(m.peerId, r);
        if (before !== r.health.status) this.log("registry_health_changed", { peerId: m.peerId, from: before ?? "none", to: r.health.status, reason: r.health.reason });
      });
      for (const peerId of [...this.health.keys()]) if (!pool.some((m) => m.peerId === peerId)) this.health.delete(peerId);
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

  /** The registry as of the last health round (unsigned). Unhealthy members are listed and marked. */
  snapshot(): RegistryPayload {
    const issuedAtMs = this.now();
    const coordinators: RegistryEntry[] = this.admitted().map((m) => {
      const h = this.health.get(m.peerId);
      const health: RegistryHealth = h?.health ?? { status: "unknown", checkedAtMs: null, latencyMs: null };
      const urls = health.status === "healthy" && h && h.passingUrls.length > 0 ? h.passingUrls : m.urls.map((u) => normalizeCoordinatorUrl(u) ?? u);
      return {
        peerId: m.peerId,
        publicKeyFingerprint: m.publicKeyFingerprint,
        urls,
        region: m.region,
        operator: m.operator,
        admission: m.admission,
        admittedAtMs: m.admittedAtMs,
        health
      };
    });
    return { v: 1, network: this.network, issuedAtMs, expiresAtMs: issuedAtMs + this.ttlMs, coordinators, fallbackUrls: this.fallbackUrls };
  }

  /** The signed registry, re-signed after each health round or when a third of its lifetime has passed. */
  signed(): SignedRegistry | null {
    if (!this.signingKey) return null;
    const c = this.signedCache;
    if (c && c.version === this.version && this.now() - c.issuedAtMs < this.ttlMs / 3) return c.doc;
    const payload = this.snapshot();
    const doc = signRegistry(payload, this.signingKey);
    this.signedCache = { doc, issuedAtMs: payload.issuedAtMs, version: this.version };
    return doc;
  }

  /** Admin: add or replace a community member. Returns the admission problems (empty when admitted). */
  admit(input: PoolMember): string[] {
    if (this.seeds.some((s) => s.peerId === input.peerId)) return ["peer_is_a_seed"];
    const member: PoolMember = { ...input, urls: input.urls.map((u) => normalizeCoordinatorUrl(u) ?? u) };
    const problems = admissionProblems(member);
    if (problems.length > 0) return problems;
    this.community = [...this.community.filter((c) => c.peerId !== member.peerId), member];
    this.health.delete(member.peerId);
    this.version++;
    this.persist();
    return [];
  }

  /** Admin: suspend or reinstate a community member. False when it is unknown or a seed. */
  setSuspended(peerId: string, suspended: boolean): boolean {
    const m = this.community.find((c) => c.peerId === peerId);
    if (!m) return false;
    m.suspended = suspended;
    this.version++;
    this.persist();
    return true;
  }

  private persist(): void {
    if (!this.poolFile) return;
    try {
      const tmp = `${this.poolFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.community, null, 2), { mode: 0o600 });
      renameSync(tmp, this.poolFile);
    } catch (err) {
      this.log("registry_pool_write_failed", { error: String(err) });
    }
  }
}

/** Build the service from REGISTRY_* environment variables. */
export function registryServiceFromEnv(env: NodeJS.ProcessEnv = process.env, extra: Pick<RegistryServiceOptions, "log" | "checker" | "now"> = {}): CoordinatorRegistryService {
  const ttl = Number(env.REGISTRY_TTL_MS ?? "");
  const interval = Number(env.REGISTRY_HEALTH_INTERVAL_MS ?? "");
  // Where clients go when nothing in the pool is usable: the platform URL (the seeds).
  const fallback = (env.REGISTRY_FALLBACK_URLS ?? "https://coordinator.edgecoder.io").split(",").map((s) => s.trim()).filter(Boolean);
  return new CoordinatorRegistryService({
    seeds: parseRegistrySeeds(env.REGISTRY_SEEDS),
    poolFile: env.REGISTRY_POOL_FILE?.trim() || null,
    signingKeyPem: env.REGISTRY_SIGNING_KEY_PEM?.trim() || undefined,
    ttlMs: Number.isFinite(ttl) && ttl >= 60_000 ? ttl : undefined,
    intervalMs: Number.isFinite(interval) && interval > 0 ? interval : undefined,
    fallbackUrls: fallback.length > 0 ? fallback : undefined,
    ...extra
  });
}

/**
 * Portal wiring: the service from REGISTRY_* env, the routes, admin = system admin, and the health
 * loop (only when a signing key is set, and not under tests).
 */
export function registerPortalRegistry(
  app: FastifyInstance,
  requireOpsUser: (req: FastifyRequest, reply: FastifyReply) => Promise<{ access: { isSystemAdmin: boolean } } | null>,
  env: NodeJS.ProcessEnv = process.env
): CoordinatorRegistryService {
  const service = registryServiceFromEnv(env, { log: (msg, extra) => app.log.info({ extra }, msg) });
  registerRegistryRoutes(app, {
    service,
    requireAdmin: async (req, reply) => {
      const principal = await requireOpsUser(req, reply);
      if (!principal) return false;
      if (!principal.access.isSystemAdmin) {
        reply.code(403).send({ error: "system_admin_required" });
        return false;
      }
      return true;
    }
  });
  if (service.configured && !env.VITEST && env.NODE_ENV !== "test") service.start();
  app.addHook("onClose", async () => service.stop());
  return service;
}

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

export interface RegistryRouteDeps {
  service: CoordinatorRegistryService;
  /** Resolves true for a system admin; otherwise has already sent 401/403. */
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<boolean>;
}

/**
 *   GET  /network/registry                      signed registry (public; 503 until the key is set)
 *   GET  /network/registry/public-key           the registry key's public half and keyId
 *   GET  /admin/network/registry                admin: every member, admission problems, health
 *   POST /admin/network/registry/admissions     admin: admit a community coordinator (stub workflow)
 *   POST /admin/network/registry/suspend        admin: { peerId, suspended }
 */
export function registerRegistryRoutes(app: FastifyInstance, { service, requireAdmin }: RegistryRouteDeps): void {
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

  app.get("/admin/network/registry", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return reply.send({
      configured: service.configured,
      members: service.members().map((m) => ({ ...m, admissionProblems: admissionProblems(m), health: service.memberHealth(m.peerId)?.health ?? null }))
    });
  });

  app.post("/admin/network/registry/admissions", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const parsed = poolMemberSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_member", issues: parsed.error.issues.map((i) => i.path.join(".")) });
    const problems = service.admit({ ...parsed.data, operator: { ...parsed.data.operator, kind: "community" }, admittedAtMs: parsed.data.admittedAtMs ?? Date.now() });
    if (problems.length > 0) return reply.code(422).send({ error: "admission_rejected", problems });
    void service.runChecks();
    return reply.send({ ok: true, peerId: parsed.data.peerId });
  });

  app.post("/admin/network/registry/suspend", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const parsed = z.object({ peerId: z.string().min(1).max(256), suspended: z.boolean().default(true) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (!service.setSuspended(parsed.data.peerId, parsed.data.suspended)) return reply.code(404).send({ error: "not_a_community_member" });
    return reply.send({ ok: true });
  });
}
