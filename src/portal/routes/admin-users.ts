// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  USER_FILTERS,
  balanceRefusal,
  fetchAccountBalances,
  filterUserList,
  localDeleteRefusal,
  planCleanup,
  runCleanup,
  type AccountAdminStore,
  type AdminUserSummary,
  type BalanceDeps,
  type CleanupDeps
} from "../account-admin.js";

/*
 * Settings > Admin > Users, system admins only (src/portal/account-admin.ts has the rules):
 *   GET  /portal/api/admin/users                    list with labels, counts, filters, search, pages
 *   POST /portal/api/admin/users/:userId/role       make or remove an admin
 *   GET  /portal/api/admin/users/:userId/balance    the account's balance on every coordinator
 *   POST /portal/api/admin/users/:userId/delete     delete one account (409 with the reason when refused)
 *   POST /portal/api/admin/users/cleanup            bulk-delete abandoned unverified accounts (dry run first)
 *   GET  /portal/api/admin/audit                    the admin audit log
 */

type PortalUserLike = { userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean };

export interface AdminUsersDeps {
  store: (AccountAdminStore & { getUserById(userId: string): Promise<PortalUserLike | null>; setUserRole(userId: string, role: "user" | "admin"): Promise<void> }) | null | undefined;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<PortalUserLike | null>;
  buildAccessContext: (user: PortalUserLike) => Promise<{ isSystemAdmin: boolean }>;
  balances: BalanceDeps;
  now?: () => number;
}

const listQuery = z.object({
  filter: z.enum(USER_FILTERS).default("all"),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50)
});
const deleteBody = z.object({
  confirmEmail: z.string().max(320),
  force: z.boolean().default(false),
  reason: z.string().max(500).default("")
});
const cleanupBody = z.object({
  olderThanDays: z.number().int().min(1).max(3650).default(30),
  includeAgentAccounts: z.boolean().default(false),
  dryRun: z.boolean().default(true),
  /** On the real run: the user ids the dry run showed; only those are deleted. */
  userIds: z.array(z.string().max(200)).max(1000).optional(),
  /** On the real run: "DELETE <n>" with n = userIds.length. */
  confirm: z.string().max(40).optional(),
  reason: z.string().max(500).default("")
});

export function registerAdminUserRoutes(app: FastifyInstance, deps: AdminUsersDeps): void {
  const now = deps.now ?? Date.now;

  /** The signed-in system admin, or null after replying 503/401/403. */
  const admin = async (req: { headers: Record<string, unknown> }, reply: FastifyReply) => {
    if (!deps.store) {
      reply.code(503).send({ error: "portal_database_not_configured" });
      return null;
    }
    const user = await deps.getCurrentUser(req);
    if (!user) {
      reply.code(401).send({ error: "not_authenticated" });
      return null;
    }
    if (!(await deps.buildAccessContext(user)).isSystemAdmin) {
      reply.code(403).send({ error: "admin_only" });
      return null;
    }
    return { user, store: deps.store };
  };
  const balancesOf = (userId: string) => fetchAccountBalances(deps.balances, userId);
  /** Admin by role or by SYSTEM_ADMIN_EMAILS (summaries carry role; the allowlist needs the access context). */
  const isAdminSummary = async (u: AdminUserSummary) => u.role === "admin" || (await deps.buildAccessContext({ userId: u.userId, email: u.email, role: u.role, emailVerified: u.emailVerified })).isSystemAdmin;
  const cleanupDeps = (store: AccountAdminStore): CleanupDeps => ({ store, balances: balancesOf, isAdmin: isAdminSummary, now });

  app.get("/portal/api/admin/users", async (req, reply) => {
    const a = await admin(req as never, reply);
    if (!a) return reply;
    const q = listQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const users = await a.store.listAdminUserSummaries(now());
    return reply.send({ ...filterUserList(users, q.data), selfUserId: a.user.userId });
  });

  app.post("/portal/api/admin/users/:userId/role", async (req, reply) => {
    const a = await admin(req as never, reply);
    if (!a) return reply;
    const { userId } = req.params as { userId: string };
    const body = z.object({ role: z.enum(["user", "admin"]) }).parse(req.body);
    const target = await a.store.getUserById(userId);
    if (!target) return reply.code(404).send({ error: "user_not_found" });
    await a.store.setUserRole(userId, body.role);
    await a.store.appendAdminAudit({ actorUserId: a.user.userId, actorEmail: a.user.email, action: "account.role", targetUserId: userId, targetEmailHint: null, detail: { role: body.role } });
    return reply.send({ ok: true, userId, role: body.role });
  });

  app.get("/portal/api/admin/users/:userId/balance", async (req, reply) => {
    const a = await admin(req as never, reply);
    if (!a) return reply;
    const { userId } = req.params as { userId: string };
    if (!(await a.store.getAdminUserSummary(userId, now()))) return reply.code(404).send({ error: "user_not_found" });
    return reply.send(await balancesOf(userId));
  });

  app.post("/portal/api/admin/users/:userId/delete", async (req, reply) => {
    const a = await admin(req as never, reply);
    if (!a) return reply;
    const { userId } = req.params as { userId: string };
    const parsed = deleteBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: "confirmEmail is required." });
    const body = parsed.data;
    const nowMs = now();
    const target = await a.store.getAdminUserSummary(userId, nowMs);
    if (!target) return reply.code(404).send({ error: "user_not_found" });
    if (body.confirmEmail.trim().toLowerCase() !== target.email.toLowerCase()) {
      return reply.code(400).send({ error: "confirmation_mismatch", detail: "Type the account's email exactly to confirm." });
    }
    const local = localDeleteRefusal(target, { actorUserId: a.user.userId, targetIsAdmin: await isAdminSummary(target), force: body.force, nowMs });
    if (local) return reply.code(409).send(local);
    // The coordinators last: force never overrides a balance, a pending payout, or not knowing.
    const balances = await balancesOf(userId);
    const remote = balanceRefusal(balances);
    if (remote) return reply.code(409).send({ ...remote, balances });
    const result = await a.store.deleteUserAccount({
      userId,
      email: target.email,
      accountKind: target.agentKey ? "agent" : "person",
      actorUserId: a.user.userId,
      actorEmail: a.user.email,
      reason: body.reason,
      force: body.force,
      balances: { cSats: balances.cSats, pendingMsat: balances.pendingMsat, complete: balances.complete, coordinators: balances.coordinators.length }
    });
    if (!result.deleted) return reply.code(result.error === "user_not_found" ? 404 : 409).send({ error: result.error, detail: result.detail });
    req.log.info({ userId, actorUserId: a.user.userId, auditId: result.auditId, force: body.force }, "admin_account_deleted");
    return reply.send({ ok: true, userId, counts: result.counts, auditId: result.auditId });
  });

  app.post("/portal/api/admin/users/cleanup", async (req, reply) => {
    const a = await admin(req as never, reply);
    if (!a) return reply;
    const parsed = cleanupBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const body = parsed.data;
    const opts = { olderThanDays: body.olderThanDays, includeAgentAccounts: body.includeAgentAccounts, actorUserId: a.user.userId };
    const cdeps = cleanupDeps(a.store);
    if (body.dryRun) {
      const { balances: _b, ...plan } = await planCleanup(cdeps, opts);
      return reply.send({ dryRun: true, ...plan, confirm: `DELETE ${plan.candidates.length}` });
    }
    if (!body.userIds || body.userIds.length === 0) return reply.code(400).send({ error: "user_ids_required", detail: "Run the dry run first and send the user ids it listed." });
    if (body.confirm !== `DELETE ${body.userIds.length}`) return reply.code(400).send({ error: "confirmation_mismatch", detail: `Send confirm: "DELETE ${body.userIds.length}".` });
    const r = await runCleanup(cdeps, { ...opts, actorEmail: a.user.email, reason: body.reason || "bulk cleanup of unverified accounts", onlyUserIds: body.userIds });
    req.log.info({ actorUserId: a.user.userId, deleted: r.deleted.length, skipped: r.skipped.length, auditId: r.auditId }, "admin_accounts_bulk_deleted");
    return reply.send({ dryRun: false, ...r });
  });

  app.get("/portal/api/admin/audit", async (req, reply) => {
    const a = await admin(req as never, reply);
    if (!a) return reply;
    const limit = Math.min(500, Math.max(1, Number((req.query as { limit?: string } | undefined)?.limit ?? 100) || 100));
    return reply.send({ entries: await a.store.listAdminAudit(limit) });
  });
}
