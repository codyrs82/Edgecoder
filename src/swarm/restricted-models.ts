// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Restricted models (the gated "security research" tier, docs/security-research-tier.md).
 *
 * A restricted model is one the operator lists in RESTRICTED_MODELS_JSON on the coordinators
 * (`{"<model tag>": "security_research"}`). Nothing an agent or a peer reports can make a model
 * restricted or unrestricted: the list is the operator's alone, and it is empty by default.
 *
 * A restricted model:
 * - is listed (GET /inference/models, /v1/models) only to accounts holding a valid entitlement for
 *   its tier;
 * - is refused at submit (403 restricted_model) unless the requesting account holds a valid
 *   entitlement, and then only for the requester's own machines or a lease it holds;
 * - is claimed only by an agent whose owner opted in (AGENT_ALLOW_RESTRICTED_MODELS=1, sent with a
 *   signed pull) and holds an admin-approved host entitlement for the tier.
 *
 * This module is the pure part: the catalog, the entitlement cache, the per-account rate limit and
 * the call log. The coordinator wiring is in src/swarm/coordinator/restricted.ts.
 */

/** Tiers a restricted model can be listed under. */
export const RESTRICTED_TIERS = ["security_research"] as const;
export type RestrictedTier = (typeof RESTRICTED_TIERS)[number];

/**
 * Entitlement kinds: `<tier>` lets an account call the tier's models; `<tier>_host` lets an
 * account's machines run them (with the agent's own opt-in).
 */
export const ENTITLEMENT_KINDS = ["security_research", "security_research_host"] as const;
export type EntitlementKind = (typeof ENTITLEMENT_KINDS)[number];

export function hostKindFor(tier: RestrictedTier): EntitlementKind {
  return `${tier}_host` as EntitlementKind;
}

/** Ollama tag as compared here: trimmed, lower case, ":latest" when no tag is named. */
export function normalizeModelTag(model: string): string {
  const t = model.trim().toLowerCase();
  if (!t) return t;
  const lastSegment = t.slice(t.lastIndexOf("/") + 1);
  return lastSegment.includes(":") ? t : `${t}:latest`;
}

/**
 * RESTRICTED_MODELS_JSON: a JSON object mapping model tags to a tier. Unset or empty = no
 * restricted models. Throws on anything else (the coordinator refuses to start with a list it
 * cannot read, rather than serve a model it was told to restrict as an open one).
 */
export function parseRestrictedModels(raw: string | undefined): Map<string, RestrictedTier> {
  const out = new Map<string, RestrictedTier>();
  if (raw === undefined || raw.trim() === "") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('must be a JSON object such as {"model:tag": "security_research"}');
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error('must be a JSON object such as {"model:tag": "security_research"}');
  for (const [model, tier] of Object.entries(parsed as Record<string, unknown>)) {
    const tag = normalizeModelTag(model);
    if (!tag || tag.length > 200) throw new Error(`has an empty or over-long model tag: ${JSON.stringify(model).slice(0, 40)}`);
    if (!RESTRICTED_TIERS.includes(tier as RestrictedTier)) throw new Error(`maps ${model} to an unknown tier (known: ${RESTRICTED_TIERS.join(", ")})`);
    out.set(tag, tier as RestrictedTier);
  }
  return out;
}

/** The operator's list of restricted models. */
export class RestrictedCatalog {
  constructor(private readonly byTag: Map<string, RestrictedTier> = new Map()) {}

  static fromEnv(raw: string | undefined): RestrictedCatalog {
    return new RestrictedCatalog(parseRestrictedModels(raw));
  }

  /** The tier a model is restricted to, or undefined for an open model. */
  tierOf(model: string | undefined): RestrictedTier | undefined {
    if (!model || this.byTag.size === 0) return undefined;
    return this.byTag.get(normalizeModelTag(model));
  }

  get size(): number {
    return this.byTag.size;
  }

  list(): Array<{ model: string; tier: RestrictedTier }> {
    return [...this.byTag.entries()].map(([model, tier]) => ({ model, tier }));
  }

  /** Tests and operator reloads. */
  replace(byTag: Map<string, RestrictedTier>): void {
    this.byTag.clear();
    for (const [k, v] of byTag) this.byTag.set(k, v);
  }
}

/** What a coordinator knows of one account's entitlement (from the portal). */
export interface EntitlementGrant {
  accountId: string;
  kind: EntitlementKind;
  /** null: no expiry. */
  expiresAtMs: number | null;
  /** false: suspended or revoked. */
  active: boolean;
}

/**
 * The coordinator's copy of the portal's entitlements. It fails closed: an entry is honoured only
 * while active, unexpired, and confirmed by the portal within `maxStaleMs` (a full sync or a push).
 * A suspension pushed by the portal takes effect at once.
 */
export class EntitlementBook {
  private readonly byKey = new Map<string, EntitlementGrant & { seenAtMs: number }>();
  lastSyncMs = 0;

  constructor(private readonly maxStaleMs: number) {}

  private key(accountId: string, kind: EntitlementKind): string {
    return `${kind}|${accountId}`;
  }

  /** A full list from the portal: only what it lists is kept. */
  replaceAll(list: EntitlementGrant[], nowMs = Date.now()): void {
    this.byKey.clear();
    for (const g of list) this.byKey.set(this.key(g.accountId, g.kind), { ...g, seenAtMs: nowMs });
    this.lastSyncMs = nowMs;
  }

  /** One change pushed by the portal (grant, suspend, revoke). */
  apply(g: EntitlementGrant, nowMs = Date.now()): void {
    if (!g.active) this.byKey.delete(this.key(g.accountId, g.kind));
    else this.byKey.set(this.key(g.accountId, g.kind), { ...g, seenAtMs: nowMs });
  }

  valid(accountId: string | undefined, kind: EntitlementKind, nowMs = Date.now()): boolean {
    if (!accountId) return false;
    const g = this.byKey.get(this.key(accountId, kind));
    if (!g || !g.active) return false;
    if (g.expiresAtMs !== null && nowMs >= g.expiresAtMs) return false;
    return nowMs - g.seenAtMs <= this.maxStaleMs;
  }

  list(): Array<EntitlementGrant & { seenAtMs: number }> {
    return [...this.byKey.values()].map((g) => ({ ...g }));
  }
}

/** Per-account sliding window on restricted calls (RESTRICTED_MODEL_RATE_LIMIT_PER_MIN). */
export class RestrictedRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly maxPerWindow: number, private readonly windowMs = 60_000) {}

  /** Takes one call for the account; false when it is over the limit (nothing is taken). */
  take(accountId: string, nowMs = Date.now()): boolean {
    const kept = (this.hits.get(accountId) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (kept.length >= this.maxPerWindow) {
      this.hits.set(accountId, kept);
      return false;
    }
    kept.push(nowMs);
    this.hits.set(accountId, kept);
    return true;
  }

  prune(nowMs = Date.now()): void {
    for (const [k, v] of this.hits) {
      const kept = v.filter((t) => nowMs - t < this.windowMs);
      if (kept.length) this.hits.set(k, kept);
      else this.hits.delete(k);
    }
  }
}

export type RestrictedPlacement = "mine" | "reserved";
export type RestrictedOutcome = "ok" | "failed" | "cancelled_suspended" | "no_capacity";

/** One restricted-model call, from submit to its end. */
export interface RestrictedCallRecord {
  subtaskId: string;
  taskId: string;
  accountId: string;
  model: string;
  tier: RestrictedTier;
  placement: RestrictedPlacement;
  reservationId?: string;
  submittedAtMs: number;
  agentId?: string;
  /** The account that owns the agent that ran it. */
  hostAccountId?: string;
  claimedAtMs?: number;
  endedAtMs?: number;
  outcome?: RestrictedOutcome;
  promptTokens?: number;
  outputTokens?: number;
  /** Only with RESTRICTED_MODEL_LOG_PROMPTS=true. */
  prompt?: string;
  output?: string;
}

export type RestrictedCallEvent = { type: "submitted" | "claimed" | "ended"; record: RestrictedCallRecord };

/**
 * Restricted calls in flight (the claim gate reads it: a subtask that was not submitted through the
 * gate on this coordinator is never claimable) and the most recent ended ones. Every change goes
 * to `sink` (the security log and the durable store).
 */
export class RestrictedCallLog {
  private readonly active = new Map<string, RestrictedCallRecord>();
  private readonly recentEnded: RestrictedCallRecord[] = [];

  constructor(private readonly sink: (e: RestrictedCallEvent) => void = () => undefined, private readonly keep = 1_000) {}

  submitted(r: RestrictedCallRecord): void {
    this.active.set(r.subtaskId, { ...r });
    this.emit("submitted", this.active.get(r.subtaskId)!);
  }

  get(subtaskId: string): RestrictedCallRecord | undefined {
    return this.active.get(subtaskId);
  }

  claimed(subtaskId: string, agentId: string, hostAccountId: string | undefined, nowMs = Date.now()): void {
    const r = this.active.get(subtaskId);
    if (!r) return;
    r.agentId = agentId;
    r.hostAccountId = hostAccountId;
    r.claimedAtMs = nowMs;
    this.emit("claimed", r);
  }

  /** The call ended (result, cancellation, no capacity). Idempotent: only the first end counts. */
  ended(subtaskId: string, outcome: RestrictedOutcome, extra: Partial<Pick<RestrictedCallRecord, "promptTokens" | "outputTokens" | "prompt" | "output">> = {}, nowMs = Date.now()): RestrictedCallRecord | undefined {
    const r = this.active.get(subtaskId);
    if (!r) return undefined;
    this.active.delete(subtaskId);
    const done: RestrictedCallRecord = { ...r, ...extra, outcome, endedAtMs: nowMs };
    this.recentEnded.push(done);
    if (this.recentEnded.length > this.keep) this.recentEnded.splice(0, this.recentEnded.length - this.keep);
    this.emit("ended", done);
    return done;
  }

  /** Calls in flight for which `match` holds. */
  activeWhere(match: (r: RestrictedCallRecord) => boolean): RestrictedCallRecord[] {
    return [...this.active.values()].filter(match).map((r) => ({ ...r }));
  }

  recent(limit = 200): RestrictedCallRecord[] {
    return this.recentEnded.slice(-limit).reverse().map((r) => ({ ...r }));
  }

  private emit(type: RestrictedCallEvent["type"], record: RestrictedCallRecord): void {
    try {
      this.sink({ type, record: { ...record } });
    } catch {
      // Logging never changes the call.
    }
  }
}
