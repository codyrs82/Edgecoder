// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";
import { request } from "undici";
import { moduleLogger } from "../common/logger.js";

const logger = moduleLogger("portal-account-admin");

/*
 * Settings > Admin > Users: the account list, deleting an account, and the cleanup of abandoned
 * sign-ups (routes/admin-users.ts; the SQL is PortalStore's).
 *
 * Deleting an account removes every portal row tied to it, in one transaction, after sessions and
 * API keys have been cut. What the coordinators hold (the credit ledger, payouts, usage) is never
 * touched: ledger rows are history. The account must hold nothing there first; the portal asks
 * every coordinator before deleting. A short tombstone (user id + email hash) and an admin audit
 * entry are kept.
 */

// ── The rows an account owns ──

/**
 * One DELETE per entry, run in this order (children first, portal_users last).
 * - by "userId": `DELETE FROM table WHERE column = $1` with the user id;
 * - by "email": `DELETE FROM table WHERE lower(column) = $1` with the lower-cased email;
 * - via: `DELETE FROM table WHERE column IN (SELECT via.column FROM via.table WHERE user_id = $1)`.
 * tests/portal/admin-users-delete.test.ts checks that every user/email/account column created by
 * PortalStore.migrate() is either here or in RETAINED_USER_COLUMNS, so a new table cannot be missed.
 */
export type DeleteStep = { table: string; column: string; by: "userId" | "email" } | { table: string; column: string; via: { table: string; column: string } };

export const USER_DELETE_PLAN: readonly DeleteStep[] = [
  // Access first (they were also cut before the transaction; this catches any created since).
  { table: "portal_sessions", column: "user_id", by: "userId" },
  { table: "portal_mobile_oauth_tokens", column: "user_id", by: "userId" },
  { table: "portal_api_keys", column: "user_id", by: "userId" },
  { table: "portal_oauth_states", column: "link_user_id", by: "userId" },
  { table: "portal_oauth_links", column: "user_id", by: "userId" },
  { table: "portal_oauth_pending_links", column: "user_id", by: "userId" },
  { table: "portal_passkey_credentials", column: "user_id", by: "userId" },
  { table: "portal_passkey_challenges", column: "user_id", by: "userId" },
  { table: "portal_passkey_challenges", column: "email", by: "email" },
  { table: "portal_email_verifications", column: "user_id", by: "userId" },
  { table: "portal_password_resets", column: "user_id", by: "userId" },
  { table: "portal_github_tokens", column: "user_id", by: "userId" },
  // Sign-up challenges are keyed by the agent's public key, so they go before the identity.
  { table: "portal_agent_challenges", column: "public_key", via: { table: "portal_agent_identities", column: "public_key" } },
  { table: "portal_agent_identities", column: "user_id", by: "userId" },
  { table: "portal_messages", column: "conversation_id", via: { table: "portal_conversations", column: "conversation_id" } },
  { table: "portal_conversations", column: "user_id", by: "userId" },
  { table: "portal_invite_redemptions", column: "user_id", by: "userId" },
  { table: "portal_wallet_send_mfa_challenges", column: "user_id", by: "userId" },
  { table: "portal_wallet_send_requests", column: "user_id", by: "userId" },
  { table: "portal_wallet_onboarding", column: "user_id", by: "userId" },
  { table: "portal_onboarding", column: "user_id", by: "userId" },
  { table: "portal_withdraw_challenges", column: "user_id", by: "userId" },
  { table: "portal_payout_destination_challenges", column: "user_id", by: "userId" },
  { table: "portal_payout_destinations", column: "user_id", by: "userId" },
  // Hosting by request (src/portal/host-requests.ts) is keyed by email, not user id. The approval goes
  // with the account: an address that signs up again must be approved again, not inherit the right
  // to take other accounts' work.
  { table: "portal_host_requests", column: "email", by: "email" },
  { table: "portal_host_approvals", column: "email", by: "email" },
  // Security research access (src/portal/security-research.ts) goes with the account: an address that
  // signs up again must be verified and granted again. The signed agreement itself is kept in the
  // company's records (agreement_ref points there) and each call stays in the coordinators' log.
  { table: "portal_security_research_entitlements", column: "user_id", by: "userId" },
  // Deletion is refused while machines are enrolled; this only matters for a row added mid-way.
  { table: "portal_node_enrollments", column: "owner_user_id", by: "userId" },
  { table: "portal_users", column: "user_id", by: "userId" }
];

/** User-identifying columns the delete does not match on, each with the reason. */
export const RETAINED_USER_COLUMNS: Readonly<Record<string, string>> = {
  "portal_users.email": "same row as portal_users.user_id",
  "portal_node_enrollments.owner_email": "same row as owner_user_id",
  "portal_oauth_links.email_snapshot": "same row as user_id",
  "portal_oauth_pending_links.email": "same row as user_id",
  "portal_passkey_credentials.webauthn_user_id": "same row as user_id (a random WebAuthn handle)",
  "portal_wallet_onboarding.account_id": "same row as user_id (acct-<userId>)",
  "portal_wallet_send_mfa_challenges.account_id": "same row as user_id",
  "portal_wallet_send_requests.account_id": "same row as user_id",
  "portal_payout_destinations.account_id": "same row as user_id",
  "portal_invite_codes.created_by": "the creating admin's email; admins cannot be deleted",
  "portal_host_requests.updated_by": "the admin who last changed the request (same row as email)",
  "portal_host_approvals.approved_by": "the approving admin or 'migration' (same row as email)",
  "portal_security_research_entitlements.granted_by": "the granting admin's email (same row as user_id)",
  "portal_security_research_entitlements.status_changed_by": "the admin who last suspended, reinstated or revoked it (same row as user_id)",
  "portal_deleted_accounts.user_id": "the tombstone, kept by design",
  "portal_deleted_accounts.email_hash": "the tombstone, kept by design",
  "portal_deleted_accounts.deleted_by": "the acting admin, kept by design",
  "portal_admin_audit.actor_user_id": "audit history, kept by design",
  "portal_admin_audit.actor_email": "audit history, kept by design",
  "portal_admin_audit.target_user_id": "audit history, kept by design",
  "portal_admin_audit.target_email_hash": "audit history, kept by design",
  "portal_admin_audit.target_email_hint": "audit history (a masked hint, not the address)"
};

export function deleteStatement(step: DeleteStep, userId: string, email: string): { sql: string; params: unknown[] } {
  if ("via" in step) {
    return { sql: `DELETE FROM ${step.table} WHERE ${step.column} IN (SELECT ${step.via.column} FROM ${step.via.table} WHERE user_id = $1)`, params: [userId] };
  }
  if (step.by === "email") return { sql: `DELETE FROM ${step.table} WHERE lower(${step.column}) = $1`, params: [email.trim().toLowerCase()] };
  return { sql: `DELETE FROM ${step.table} WHERE ${step.column} = $1`, params: [userId] };
}

export const emailHash = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

/** "co…@gmail.com": enough for an admin to recognise an audit entry, not the address itself. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}…@${domain}`;
}

// ── The list ──

/** One row of the admin user list (PortalStore.listAdminUserSummaries). */
export interface AdminUserSummary {
  userId: string;
  email: string;
  displayName?: string;
  role: "user" | "admin";
  emailVerified: boolean;
  accountKind: string;
  /** Signed up with an agent public key (portal_agent_identities, or the @agents.invalid placeholder). */
  agentKey: boolean;
  createdAtMs: number;
  lastSessionMs: number | null;
  activeSessions: number;
  machines: number;
  approvedMachines: number;
  apiKeys: number;
  /** The latest of: created, signed in, API key used, chat, machine seen. */
  lastActivityMs: number;
}

export type AccountLabel = "verified" | "unverified" | "agent";
export const ACCOUNT_LABEL_TEXT: Record<AccountLabel, string> = { verified: "Verified", unverified: "Unverified", agent: "Agent (key sign-in)" };

/** Agent accounts have no email by design, so they are labelled as such rather than "unverified". */
export const accountLabel = (u: Pick<AdminUserSummary, "agentKey" | "emailVerified">): AccountLabel => (u.agentKey ? "agent" : u.emailVerified ? "verified" : "unverified");

export const USER_FILTERS = ["all", "verified", "unverified", "agent", "admin"] as const;
export type UserFilter = (typeof USER_FILTERS)[number];

export function matchesFilter(u: AdminUserSummary, filter: UserFilter): boolean {
  if (filter === "all") return true;
  if (filter === "admin") return u.role === "admin";
  return accountLabel(u) === filter;
}

/** Filter, search (email, id, display name; case-insensitive) and page the list, newest first. */
export function filterUserList(users: AdminUserSummary[], opts: { filter: UserFilter; q?: string; page: number; pageSize: number }) {
  const q = (opts.q ?? "").trim().toLowerCase();
  const counts = Object.fromEntries(USER_FILTERS.map((f) => [f, users.filter((u) => matchesFilter(u, f)).length])) as Record<UserFilter, number>;
  const matched = users
    .filter((u) => matchesFilter(u, opts.filter))
    .filter((u) => !q || u.email.toLowerCase().includes(q) || u.userId.toLowerCase().includes(q) || (u.displayName ?? "").toLowerCase().includes(q))
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  const pages = Math.max(1, Math.ceil(matched.length / opts.pageSize));
  const page = Math.min(Math.max(1, opts.page), pages);
  return {
    users: matched.slice((page - 1) * opts.pageSize, page * opts.pageSize).map((u) => ({ ...u, label: accountLabel(u), labelText: ACCOUNT_LABEL_TEXT[accountLabel(u)] })),
    total: matched.length,
    page,
    pages,
    pageSize: opts.pageSize,
    counts
  };
}

// ── Balances on the coordinators ──

export interface CoordinatorBalance {
  url: string;
  ok: boolean;
  error?: string;
  cSats?: number;
  pendingMsat?: number;
  payableMsat?: number;
  heldMsat?: number;
  pendingPayouts?: number;
}

export interface AccountBalances {
  accountId: string;
  /** Every coordinator answered both questions. */
  complete: boolean;
  /** The largest seen on any coordinator (they may share one ledger, so these are not summed). */
  cSats: number;
  pendingMsat: number;
  payableMsat: number;
  heldMsat: number;
  pendingPayouts: number;
  coordinators: CoordinatorBalance[];
}

export interface BalanceDeps {
  /** Allowlisted coordinator base URLs (the service token goes to these only). */
  coordinatorUrls: () => Promise<string[]>;
  serviceToken: string;
  timeoutMs: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

async function getJson(url: string, method: "GET" | "POST", token: string, timeoutMs: number, body?: object): Promise<{ status: number; json: any }> {
  const res = await request(url, {
    method,
    headers: { ...(token ? { "x-portal-service-token": token } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  });
  const text = await res.body.text();
  try {
    return { status: res.statusCode, json: JSON.parse(text) };
  } catch {
    return { status: res.statusCode, json: null };
  }
}

/**
 * Ask every coordinator, with the portal service token, for the account's cSats balance
 * (POST /account/summary) and its payouts (GET /economy/payouts/:accountId). Read-only on the
 * coordinator side. A coordinator that does not answer makes the result incomplete, and an
 * incomplete result never counts as "no balance".
 */
export async function fetchAccountBalances(deps: BalanceDeps, userId: string): Promise<AccountBalances> {
  const accountId = `acct-${userId}`;
  const urls = [...new Set((await deps.coordinatorUrls().catch(() => [] as string[])).map((u) => u.replace(/\/+$/, "")))];
  const coordinators = await Promise.all(
    urls.map(async (base): Promise<CoordinatorBalance> => {
      try {
        const [summary, payouts] = await Promise.all([
          getJson(`${base}/account/summary`, "POST", deps.serviceToken, deps.timeoutMs, { accountId }),
          getJson(`${base}/economy/payouts/${encodeURIComponent(accountId)}`, "GET", deps.serviceToken, deps.timeoutMs)
        ]);
        if (summary.status !== 200 || !summary.json) return { url: base, ok: false, error: `account_summary_${summary.status}` };
        if (payouts.status !== 200 || !payouts.json) return { url: base, ok: false, error: `payouts_${payouts.status}` };
        const bal = (payouts.json.balance ?? {}) as Record<string, unknown>;
        const list = Array.isArray(payouts.json.payouts) ? (payouts.json.payouts as Array<{ status?: unknown }>) : [];
        return {
          url: base,
          ok: true,
          cSats: num(summary.json.cSats ?? summary.json.balance),
          pendingMsat: num(bal.pendingMsat),
          payableMsat: num(bal.payableMsat),
          heldMsat: num(bal.heldMsat),
          pendingPayouts: list.filter((p) => p?.status === "pending").length
        };
      } catch (err) {
        logger.warn({ err, url: base }, "coordinator balance lookup failed");
        return { url: base, ok: false, error: "unreachable" };
      }
    })
  );
  const okOnes = coordinators.filter((c) => c.ok);
  const max = (k: keyof CoordinatorBalance) => okOnes.reduce((m, c) => Math.max(m, num(c[k])), 0);
  return {
    accountId,
    complete: coordinators.length > 0 && okOnes.length === coordinators.length,
    cSats: max("cSats"),
    pendingMsat: max("pendingMsat"),
    payableMsat: max("payableMsat"),
    heldMsat: max("heldMsat"),
    pendingPayouts: max("pendingPayouts"),
    coordinators
  };
}

// ── Whether an account may be deleted ──

/** Without force, an account with activity in the last this-many days is not deleted. */
export const DELETE_INACTIVE_DAYS = 7;
const DAY_MS = 86_400_000;

export type Refusal = { error: string; detail: string };

/** Checks that need nothing from the coordinators (run first, so a refusal costs no calls). */
export function localDeleteRefusal(
  target: AdminUserSummary,
  ctx: { actorUserId: string; targetIsAdmin: boolean; force: boolean; nowMs: number; inactiveDays?: number }
): Refusal | null {
  if (target.userId === ctx.actorUserId) return { error: "cannot_delete_self", detail: "You cannot delete your own account." };
  if (ctx.targetIsAdmin || target.role === "admin") return { error: "cannot_delete_admin", detail: "Remove the admin role (and any SYSTEM_ADMIN_EMAILS entry) first." };
  if (target.machines > 0) {
    return { error: "has_machines", detail: `The account has ${target.machines} enrolled machine(s) (${target.approvedMachines} approved). Remove them first.` };
  }
  const days = ctx.inactiveDays ?? DELETE_INACTIVE_DAYS;
  if (!ctx.force && ctx.nowMs - target.lastActivityMs < days * DAY_MS) {
    return { error: "recent_activity", detail: `Last activity ${new Date(target.lastActivityMs).toISOString()}, within ${days} days. Pass force to delete anyway.` };
  }
  return null;
}

/** The coordinator side: any balance or pending payout refuses, and so does not knowing. Force does not apply. */
export function balanceRefusal(b: AccountBalances): Refusal | null {
  if (!b.complete) {
    const failed = b.coordinators.filter((c) => !c.ok).map((c) => `${c.url} (${c.error})`);
    return {
      error: "balance_unknown",
      detail: b.coordinators.length === 0 ? "No coordinator is configured to confirm the account holds no balance." : `Could not confirm the balance with: ${failed.join(", ")}.`
    };
  }
  if (b.cSats > 0 || b.payableMsat > 0 || b.heldMsat > 0) {
    return { error: "has_balance", detail: `The account holds ${b.cSats} cSats (payable ${Math.floor(b.payableMsat / 1000)} sats, held ${Math.floor(b.heldMsat / 1000)} sats). Accounts with a balance are never deleted.` };
  }
  if (b.pendingMsat > 0 || b.pendingPayouts > 0) return { error: "pending_payouts", detail: `The account has ${b.pendingPayouts} pending payout(s). Wait for them to settle.` };
  return null;
}

// ── Deleting ──

export interface DeleteAccountInput {
  userId: string;
  email: string;
  accountKind: string;
  actorUserId: string;
  actorEmail: string;
  reason: string;
  force: boolean;
  /** What the coordinators said, recorded in the audit entry. */
  balances?: Pick<AccountBalances, "cSats" | "pendingMsat" | "complete"> & { coordinators: number };
  bulk?: boolean;
}

export type DeleteAccountResult = { deleted: true; counts: Record<string, number>; auditId: string } | { deleted: false; error: string; detail: string };

export interface AdminAuditEntry {
  auditId: string;
  atMs: number;
  actorUserId: string;
  actorEmail: string;
  action: string;
  targetUserId: string | null;
  targetEmailHint: string | null;
  detail: Record<string, unknown>;
}

/** What the routes and the purge job need from the store (PortalStore implements it). */
export interface AccountAdminStore {
  listAdminUserSummaries(nowMs: number): Promise<AdminUserSummary[]>;
  getAdminUserSummary(userId: string, nowMs: number): Promise<AdminUserSummary | null>;
  deleteUserAccount(input: DeleteAccountInput): Promise<DeleteAccountResult>;
  appendAdminAudit(entry: Omit<AdminAuditEntry, "auditId" | "atMs">): Promise<string>;
  listAdminAudit(limit: number): Promise<AdminAuditEntry[]>;
}

// ── Bulk cleanup (the admin button and the optional daily job) ──

export interface CleanupCandidate {
  userId: string;
  email: string;
  label: AccountLabel;
  createdAtMs: number;
  lastActivityMs: number;
}

export interface CleanupPlan {
  olderThanDays: number;
  candidates: CleanupCandidate[];
  skipped: Array<{ userId: string; email: string; error: string; detail: string }>;
}

/** Unverified (optionally also agent-key) accounts older than N days with nothing attached and no recent activity. */
export function cleanupPreselect(users: AdminUserSummary[], opts: { olderThanDays: number; includeAgentAccounts: boolean; actorUserId: string; nowMs: number }) {
  const cutoff = opts.nowMs - opts.olderThanDays * DAY_MS;
  return users.filter((u) => {
    const label = accountLabel(u);
    if (label === "verified" || (label === "agent" && !opts.includeAgentAccounts)) return false;
    if (u.userId === opts.actorUserId || u.role === "admin") return false;
    return u.createdAtMs < cutoff && u.lastActivityMs < cutoff && u.machines === 0 && u.apiKeys === 0;
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    })
  );
  return out;
}

export interface CleanupDeps {
  store: AccountAdminStore;
  balances: (userId: string) => Promise<AccountBalances>;
  /** Admin by any route (role, SYSTEM_ADMIN_EMAILS); such accounts are never cleaned up. */
  isAdmin: (u: AdminUserSummary) => boolean | Promise<boolean>;
  now?: () => number;
}

/** The dry run: who would be deleted, each checked with the coordinators too, and who was skipped and why. */
export async function planCleanup(deps: CleanupDeps, opts: { olderThanDays: number; includeAgentAccounts: boolean; actorUserId: string }): Promise<CleanupPlan & { balances: Map<string, AccountBalances> }> {
  const nowMs = (deps.now ?? Date.now)();
  const pre: AdminUserSummary[] = [];
  for (const u of cleanupPreselect(await deps.store.listAdminUserSummaries(nowMs), { ...opts, nowMs })) if (!(await deps.isAdmin(u))) pre.push(u);
  const checked = await mapLimit(pre, 4, async (u) => ({ u, b: await deps.balances(u.userId) }));
  const plan: CleanupPlan & { balances: Map<string, AccountBalances> } = { olderThanDays: opts.olderThanDays, candidates: [], skipped: [], balances: new Map() };
  for (const { u, b } of checked) {
    const refusal = balanceRefusal(b);
    if (refusal) plan.skipped.push({ userId: u.userId, email: u.email, ...refusal });
    else {
      plan.candidates.push({ userId: u.userId, email: u.email, label: accountLabel(u), createdAtMs: u.createdAtMs, lastActivityMs: u.lastActivityMs });
      plan.balances.set(u.userId, b);
    }
  }
  return plan;
}

/**
 * Delete the plan's candidates (only those in `onlyUserIds` when given: the list the admin saw).
 * Each deletion is its own transaction and audit entry; one summary entry records the run.
 */
export async function runCleanup(
  deps: CleanupDeps,
  opts: { olderThanDays: number; includeAgentAccounts: boolean; actorUserId: string; actorEmail: string; reason: string; onlyUserIds?: string[] }
): Promise<{ deleted: Array<{ userId: string; counts: Record<string, number> }>; skipped: CleanupPlan["skipped"]; auditId: string }> {
  const plan = await planCleanup(deps, opts);
  const wanted = opts.onlyUserIds ? new Set(opts.onlyUserIds) : null;
  const deleted: Array<{ userId: string; counts: Record<string, number> }> = [];
  const skipped = [...plan.skipped];
  for (const c of plan.candidates) {
    if (wanted && !wanted.has(c.userId)) continue;
    const b = plan.balances.get(c.userId)!;
    const r = await deps.store.deleteUserAccount({
      userId: c.userId,
      email: c.email,
      accountKind: c.label === "agent" ? "agent" : "person",
      actorUserId: opts.actorUserId,
      actorEmail: opts.actorEmail,
      reason: opts.reason,
      force: false,
      balances: { cSats: b.cSats, pendingMsat: b.pendingMsat, complete: b.complete, coordinators: b.coordinators.length },
      bulk: true
    });
    if (r.deleted) deleted.push({ userId: c.userId, counts: r.counts });
    else skipped.push({ userId: c.userId, email: c.email, error: r.error, detail: r.detail });
  }
  // Requested but no longer eligible (activity, a balance or a machine appeared since the dry run).
  if (wanted) for (const id of wanted) if (!plan.candidates.some((c) => c.userId === id) && !skipped.some((s) => s.userId === id)) skipped.push({ userId: id, email: "", error: "no_longer_eligible", detail: "Not in the cleanup list any more." });
  const auditId = await deps.store.appendAdminAudit({
    actorUserId: opts.actorUserId,
    actorEmail: opts.actorEmail,
    action: "account.bulk_delete",
    targetUserId: null,
    targetEmailHint: null,
    detail: { olderThanDays: opts.olderThanDays, includeAgentAccounts: opts.includeAgentAccounts, reason: opts.reason, deleted: deleted.map((d) => d.userId), skipped: skipped.map((s) => ({ userId: s.userId, error: s.error })) }
  });
  return { deleted, skipped, auditId };
}

// ── PORTAL_PURGE_UNVERIFIED_AFTER_DAYS: the optional daily job ──

export const PURGE_ACTOR = "system:purge-unverified";
const PURGE_INTERVAL_MS = DAY_MS;

export async function runUnverifiedPurge(deps: CleanupDeps, days: number): Promise<void> {
  try {
    const r = await runCleanup(deps, { olderThanDays: days, includeAgentAccounts: false, actorUserId: PURGE_ACTOR, actorEmail: PURGE_ACTOR, reason: `PORTAL_PURGE_UNVERIFIED_AFTER_DAYS=${days}` });
    if (r.deleted.length || r.skipped.length) logger.info({ deleted: r.deleted.length, skipped: r.skipped.length, auditId: r.auditId }, "unverified account purge ran");
  } catch (err) {
    logger.error({ err }, "unverified account purge failed");
  }
}

/** Off unless `days` is set: daily, first run 10 minutes after startup. */
export function startUnverifiedPurge(deps: CleanupDeps | null, days: number | undefined): void {
  if (!deps || !days) return;
  setInterval(() => void runUnverifiedPurge(deps, days), PURGE_INTERVAL_MS).unref?.();
  setTimeout(() => void runUnverifiedPurge(deps, days), 10 * 60_000).unref?.();
}
