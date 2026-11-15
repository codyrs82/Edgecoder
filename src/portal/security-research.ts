// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Security research access (docs/security-research-tier.md): admin-granted entitlements that let a
 * verified organisation's account call restricted models (`security_research`), or let an
 * account's machines host them (`security_research_host`).
 *
 * A system admin grants, suspends, reinstates and revokes them in Settings > Admin ("Security
 * research access"), recording the organisation, verification notes, the signed authorization
 * agreement (a document id or URL) and when it was accepted, an expiry, and who granted it. Every
 * change is pushed at once to the coordinators (POST /account/restricted-access/update, portal
 * service token): a suspension cancels the account's calls in flight. Coordinators also re-read
 * the full list (GET /internal/security-research/entitlements) on a timer and fail closed when
 * they cannot.
 *
 * The portal has no organisations: an entitlement belongs to one account, with the organisation
 * recorded on it.
 */

import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { z } from "zod";
import { moduleLogger } from "../common/logger.js";
import { ENTITLEMENT_KINDS, type EntitlementKind } from "../swarm/restricted-models.js";

const logger = moduleLogger("portal-security-research");

export type EntitlementStatus = "active" | "suspended" | "revoked";

export interface SecurityResearchEntitlement {
  userId: string;
  kind: EntitlementKind;
  orgName: string;
  verificationNotes: string;
  /** The signed authorization agreement: a document id or URL the admin recorded. */
  agreementRef: string;
  agreementAcceptedAtMs: number;
  expiresAtMs: number;
  grantedBy: string;
  grantedAtMs: number;
  status: EntitlementStatus;
  statusChangedBy: string | null;
  statusChangedAtMs: number | null;
}

export interface SecurityResearchStore {
  upsertRestrictedEntitlement(r: SecurityResearchEntitlement): Promise<void>;
  getRestrictedEntitlement(userId: string, kind: EntitlementKind): Promise<SecurityResearchEntitlement | null>;
  listRestrictedEntitlements(limit: number): Promise<SecurityResearchEntitlement[]>;
  setRestrictedEntitlementStatus(userId: string, kind: EntitlementKind, status: EntitlementStatus, by: string, nowMs: number): Promise<SecurityResearchEntitlement | null>;
}

/** "expired" once past its expiry, whatever its stored status. */
export function effectiveStatus(r: Pick<SecurityResearchEntitlement, "status" | "expiresAtMs">, nowMs: number): EntitlementStatus | "expired" {
  if (r.status !== "active") return r.status;
  return nowMs >= r.expiresAtMs ? "expired" : "active";
}

export const accountIdForUser = (userId: string) => `acct-${userId}`;

/** What a coordinator is told about one entitlement. */
export function coordinatorView(r: SecurityResearchEntitlement, nowMs: number): { accountId: string; kind: EntitlementKind; expiresAtMs: number; active: boolean } {
  return { accountId: accountIdForUser(r.userId), kind: r.kind, expiresAtMs: r.expiresAtMs, active: effectiveStatus(r, nowMs) === "active" };
}

type Change = ReturnType<typeof coordinatorView>;

/** Push one change to every coordinator; returns how many accepted it. Never throws. */
export async function pushToCoordinators(urls: string[], serviceToken: string | undefined, change: Change, timeoutMs = 5_000): Promise<{ notified: number; failed: number }> {
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await request(`${url.replace(/\/+$/, "")}/account/restricted-access/update`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(serviceToken ? { "x-portal-service-token": serviceToken } : {}) },
          body: JSON.stringify(change),
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          signal: AbortSignal.timeout(timeoutMs),
        });
        await res.body.dump().catch(() => undefined);
        return res.statusCode === 200;
      } catch {
        return false;
      }
    })
  );
  const notified = results.filter(Boolean).length;
  return { notified, failed: results.length - notified };
}

type User = { userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean };

export interface SecurityResearchDeps {
  store: SecurityResearchStore | null | undefined;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<User | null>;
  buildAccessContext: (user: User) => Promise<{ isSystemAdmin: boolean }>;
  /** Find the account an admin names (email or user id). */
  findUser: (emailOrId: string) => Promise<{ userId: string; email: string } | null>;
  /** Emails for the list. */
  emailsFor: (userIds: string[]) => Promise<Map<string, string>>;
  /** Tell the coordinators (pushToCoordinators in production). */
  notifyCoordinators: (change: Change) => Promise<{ notified: number; failed: number }>;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TERM_DAYS = 2 * 366;
const text = (max: number) => z.string().trim().max(max).regex(/^[^<>\u0000-\u0008\u000b\u000c\u000e-\u001f]*$/, "no angle brackets or control characters");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const grantBody = z.object({
  /** The account: email or user id. */
  account: z.string().trim().min(1).max(320),
  kind: z.enum(ENTITLEMENT_KINDS).default("security_research"),
  orgName: text(200).pipe(z.string().min(2)),
  verificationNotes: text(4000).pipe(z.string().min(1)),
  agreementRef: text(500).pipe(z.string().min(3)),
  agreementAcceptedAt: isoDate,
  expiresAt: isoDate,
});

function dayMs(d: string): number {
  const ms = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * System-admin API behind Settings > Admin > Security research access:
 *   GET  /portal/api/admin/security-research                         -> { entitlements }
 *   POST /portal/api/admin/security-research { account, kind, orgName, verificationNotes, agreementRef, agreementAcceptedAt, expiresAt }
 *   POST /portal/api/admin/security-research/:userId/:kind/(suspend|reinstate|revoke)
 * And for the signed-in user (the chat page's model picker):
 *   GET  /portal/api/security-research/me                            -> { securityResearch, host }
 */
export function registerSecurityResearchRoutes(app: FastifyInstance, deps: SecurityResearchDeps): void {
  const now = deps.now ?? Date.now;
  async function admin(req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (!deps.store) {
      reply.code(503).send({ error: "portal_database_not_configured" });
      return null;
    }
    const user = await deps.getCurrentUser(req as never);
    if (!user) {
      reply.code(401).send({ error: "not_authenticated" });
      return null;
    }
    if (!(await deps.buildAccessContext(user)).isSystemAdmin) {
      reply.code(403).send({ error: "admin_only" });
      return null;
    }
    return { user, store: deps.store };
  }
  const view = (r: SecurityResearchEntitlement, email?: string) => ({ ...r, accountId: accountIdForUser(r.userId), email: email ?? null, effectiveStatus: effectiveStatus(r, now()) });

  app.get("/portal/api/admin/security-research", async (req, reply) => {
    const a = await admin(req, reply);
    if (!a) return reply;
    const list = await a.store.listRestrictedEntitlements(1000);
    const emails = await deps.emailsFor([...new Set(list.map((r) => r.userId))]);
    return reply.send({ entitlements: list.map((r) => view(r, emails.get(r.userId))) });
  });

  app.post("/portal/api/admin/security-research", async (req, reply) => {
    const a = await admin(req, reply);
    if (!a) return reply;
    const parsed = grantBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_entitlement", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const b = parsed.data;
    const nowMs = now();
    const acceptedMs = dayMs(b.agreementAcceptedAt);
    // Expires at the end of the named day (UTC).
    const expiresMs = dayMs(b.expiresAt) + DAY_MS;
    if (!Number.isFinite(acceptedMs) || acceptedMs > nowMs) return reply.code(400).send({ error: "invalid_entitlement", detail: "agreementAcceptedAt: a real date, not in the future" });
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs || expiresMs > nowMs + MAX_TERM_DAYS * DAY_MS) return reply.code(400).send({ error: "invalid_entitlement", detail: `expiresAt: after today and within ${MAX_TERM_DAYS} days` });
    const target = await deps.findUser(b.account);
    if (!target) return reply.code(404).send({ error: "account_not_found" });
    const record: SecurityResearchEntitlement = {
      userId: target.userId, kind: b.kind, orgName: b.orgName, verificationNotes: b.verificationNotes, agreementRef: b.agreementRef,
      agreementAcceptedAtMs: acceptedMs, expiresAtMs: expiresMs, grantedBy: a.user.email, grantedAtMs: nowMs, status: "active", statusChangedBy: null, statusChangedAtMs: null,
    };
    await a.store.upsertRestrictedEntitlement(record);
    const pushed = await deps.notifyCoordinators(coordinatorView(record, nowMs));
    logger.info({ userId: record.userId, kind: record.kind, orgName: record.orgName, expiresAtMs: record.expiresAtMs, by: a.user.userId, ...pushed }, "security_research_granted");
    return reply.send({ entitlement: view(record, target.email), coordinators: pushed });
  });

  app.post("/portal/api/admin/security-research/:userId/:kind/:action", async (req, reply) => {
    const a = await admin(req, reply);
    if (!a) return reply;
    const p = z.object({ userId: z.string().min(1).max(200), kind: z.enum(ENTITLEMENT_KINDS), action: z.enum(["suspend", "reinstate", "revoke"]) }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_request" });
    const existing = await a.store.getRestrictedEntitlement(p.data.userId, p.data.kind);
    if (!existing) return reply.code(404).send({ error: "entitlement_not_found" });
    // A revoked entitlement stays revoked: access again is a new grant, with its own agreement.
    if (existing.status === "revoked") return reply.code(409).send({ error: "entitlement_revoked" });
    const status: EntitlementStatus = p.data.action === "suspend" ? "suspended" : p.data.action === "revoke" ? "revoked" : "active";
    const nowMs = now();
    const updated = await a.store.setRestrictedEntitlementStatus(p.data.userId, p.data.kind, status, a.user.email, nowMs);
    if (!updated) return reply.code(404).send({ error: "entitlement_not_found" });
    const pushed = await deps.notifyCoordinators(coordinatorView(updated, nowMs));
    logger.warn({ userId: updated.userId, kind: updated.kind, status, by: a.user.userId, ...pushed }, "security_research_status_changed");
    return reply.send({ entitlement: view(updated), coordinators: pushed });
  });

  app.get("/portal/api/security-research/me", async (req, reply) => {
    if (!deps.store) return reply.send({ securityResearch: null, host: null });
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const mine = async (kind: EntitlementKind) => {
      const r = await deps.store!.getRestrictedEntitlement(user.userId, kind);
      // The holder sees the organisation, status and expiry; never the admin's verification notes.
      return r ? { orgName: r.orgName, status: effectiveStatus(r, now()), expiresAtMs: r.expiresAtMs } : null;
    };
    return reply.send({ securityResearch: await mine("security_research"), host: await mine("security_research_host") });
  });
}

/** GET /internal/security-research/entitlements (inside the portal's token-checked /internal plugin): what coordinators sync. */
export function registerSecurityResearchInternalRoute(internal: FastifyInstance, deps: { store: SecurityResearchStore | null | undefined; now?: () => number }): void {
  internal.get("/internal/security-research/entitlements", async (_req, reply) => {
    if (!deps.store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const nowMs = (deps.now ?? Date.now)();
    const list = await deps.store.listRestrictedEntitlements(10_000);
    return reply.send({ entitlements: list.map((r) => coordinatorView(r, nowMs)).filter((e) => e.active) });
  });
}
