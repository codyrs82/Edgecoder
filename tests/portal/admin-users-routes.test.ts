import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accountLabel,
  filterUserList,
  type AccountAdminStore,
  type AdminAuditEntry,
  type AdminUserSummary,
  type DeleteAccountInput
} from "../../src/portal/account-admin.js";
import { registerAdminUserRoutes } from "../../src/portal/routes/admin-users.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 15, 12);
const SERVICE_TOKEN = "portal-service-token";

const summary = (over: Partial<AdminUserSummary> & Pick<AdminUserSummary, "userId" | "email">): AdminUserSummary => ({
  role: "user",
  emailVerified: false,
  accountKind: "person",
  agentKey: false,
  createdAtMs: NOW - 60 * DAY,
  lastSessionMs: null,
  activeSessions: 0,
  machines: 0,
  approvedMachines: 0,
  apiKeys: 0,
  lastActivityMs: NOW - 60 * DAY,
  ...over
});

/** In-memory AccountAdminStore (the SQL side is tests/portal/admin-users-delete.test.ts). */
function memoryStore(users: AdminUserSummary[]) {
  const audit: AdminAuditEntry[] = [];
  const deletes: DeleteAccountInput[] = [];
  const store: AccountAdminStore & { getUserById: (id: string) => Promise<any>; setUserRole: (id: string, role: "user" | "admin") => Promise<void> } = {
    listAdminUserSummaries: async () => users.map((u) => ({ ...u })),
    getAdminUserSummary: async (id) => users.find((u) => u.userId === id) ?? null,
    getUserById: async (id) => users.find((u) => u.userId === id) ?? null,
    setUserRole: async (id, role) => void (users.find((u) => u.userId === id)!.role = role),
    deleteUserAccount: async (input) => {
      deletes.push(input);
      const i = users.findIndex((u) => u.userId === input.userId);
      if (i < 0) return { deleted: false, error: "user_not_found", detail: "" };
      users.splice(i, 1);
      const auditId = `audit-${audit.length + 1}`;
      audit.push({ auditId, atMs: NOW, actorUserId: input.actorUserId, actorEmail: input.actorEmail, action: "account.delete", targetUserId: input.userId, targetEmailHint: null, detail: { bulk: Boolean(input.bulk), force: input.force } });
      return { deleted: true, counts: { portal_users: 1 }, auditId };
    },
    appendAdminAudit: async (e) => {
      const auditId = `audit-${audit.length + 1}`;
      audit.push({ ...e, auditId, atMs: NOW });
      return auditId;
    },
    listAdminAudit: async (limit) => audit.slice(-limit).reverse()
  };
  return { store, audit, deletes };
}

/** Balances per account on the fake coordinators: cSats and pending payouts. */
const ledger = new Map<string, { cSats?: number; pending?: number }>();
const coordinators: FastifyInstance[] = [];
const bases: string[] = [];
let downBase = "";
const seenTokens: unknown[] = [];

beforeAll(async () => {
  for (let i = 0; i < 2; i++) {
    const c = Fastify();
    c.post("/account/summary", async (req) => {
      seenTokens.push(req.headers["x-portal-service-token"]);
      const { accountId } = req.body as { accountId: string };
      return { accountId, cSats: ledger.get(accountId)?.cSats ?? 0 };
    });
    c.get("/economy/payouts/:accountId", async (req) => {
      const { accountId } = req.params as { accountId: string };
      const pending = ledger.get(accountId)?.pending ?? 0;
      return { accountId, balance: { pendingMsat: pending * 1000, payableMsat: 0, heldMsat: 0 }, payouts: pending ? [{ status: "pending" }] : [{ status: "paid" }] };
    });
    await c.listen({ port: 0, host: "127.0.0.1" });
    const addr = c.server.address();
    bases.push(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
    coordinators.push(c);
  }
  // A port nothing listens on.
  const tmp = Fastify();
  await tmp.listen({ port: 0, host: "127.0.0.1" });
  const addr = tmp.server.address();
  downBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  await tmp.close();
});
afterAll(async () => {
  for (const c of coordinators) await c.close();
});

const ADMIN = { userId: "u-admin", email: "admin@example.com", role: "admin" as const, emailVerified: true };

function fixture() {
  return [
    summary({ userId: "u-admin", email: "admin@example.com", role: "admin", emailVerified: true }),
    summary({ userId: "u-other-admin", email: "ops@example.com", role: "admin", emailVerified: true }),
    summary({ userId: "u-verified", email: "alice@example.com", emailVerified: true }),
    // The test sign-ups: created today, a session today.
    ...Array.from({ length: 3 }, (_, i) =>
      summary({ userId: `u-ec${i + 1}`, email: `codyrs82+ecagent${i + 1}@gmail.com`, createdAtMs: NOW - DAY / 2, lastActivityMs: NOW - DAY / 4, lastSessionMs: NOW - DAY / 4 })
    ),
    summary({ userId: "u-agent", email: "agent-1b2c@agents.invalid", accountKind: "agent", agentKey: true, apiKeys: 1, createdAtMs: NOW - DAY / 2, lastActivityMs: NOW - DAY / 2 }),
    summary({ userId: "u-old-a", email: "old-a@example.com" }),
    summary({ userId: "u-old-b", email: "old-b@example.com" }),
    summary({ userId: "u-machine", email: "mach@example.com", machines: 1, approvedMachines: 1 }),
    summary({ userId: "u-rich", email: "rich@example.com" }),
    summary({ userId: "u-paying", email: "paying@example.com" })
  ];
}

let users: AdminUserSummary[];
let mem: ReturnType<typeof memoryStore>;
let current: typeof ADMIN | { userId: string; email: string; role: "user"; emailVerified: boolean } | null;
let urls: string[];

function build(): FastifyInstance {
  const app = Fastify();
  registerAdminUserRoutes(app, {
    store: mem.store,
    getCurrentUser: async () => current,
    buildAccessContext: async (u) => ({ isSystemAdmin: u.role === "admin" }),
    balances: { coordinatorUrls: async () => urls, serviceToken: SERVICE_TOKEN, timeoutMs: 2000 },
    now: () => NOW
  });
  return app;
}

beforeEach(() => {
  users = fixture();
  mem = memoryStore(users);
  current = ADMIN;
  urls = [bases[0]!, bases[1]! + "/"];
  ledger.clear();
  ledger.set("acct-u-rich", { cSats: 12 });
  ledger.set("acct-u-paying", { pending: 50 });
  seenTokens.length = 0;
});

describe("list labels and filters", () => {
  it("labels agent-key accounts as agents, not unverified", () => {
    expect(accountLabel({ agentKey: true, emailVerified: false })).toBe("agent");
    expect(accountLabel({ agentKey: false, emailVerified: false })).toBe("unverified");
    expect(accountLabel({ agentKey: false, emailVerified: true })).toBe("verified");
    const all = filterUserList(fixture(), { filter: "all", page: 1, pageSize: 50 });
    expect(all.users.find((u) => u.userId === "u-agent")).toMatchObject({ label: "agent", labelText: "Agent (key sign-in)" });
    expect(all.counts).toEqual({ all: 12, verified: 3, unverified: 8, agent: 1, admin: 2 });
  });

  it("filters, searches and pages", () => {
    const list = fixture();
    expect(filterUserList(list, { filter: "agent", page: 1, pageSize: 50 }).users.map((u) => u.userId)).toEqual(["u-agent"]);
    expect(filterUserList(list, { filter: "admin", page: 1, pageSize: 50 }).users.map((u) => u.userId).sort()).toEqual(["u-admin", "u-other-admin"]);
    expect(filterUserList(list, { filter: "unverified", page: 1, pageSize: 50 }).users.every((u) => u.label === "unverified")).toBe(true);
    expect(filterUserList(list, { filter: "all", q: "ECAGENT", page: 1, pageSize: 50 }).total).toBe(3);
    const p2 = filterUserList(list, { filter: "all", page: 2, pageSize: 5 });
    expect(p2).toMatchObject({ page: 2, pages: 3, total: 12 });
    expect(p2.users).toHaveLength(5);
    expect(filterUserList(list, { filter: "all", page: 99, pageSize: 5 }).page).toBe(3);
  });

  it("GET /portal/api/admin/users: admins only, with filter and counts", async () => {
    const app = build();
    current = null;
    expect((await app.inject({ url: "/portal/api/admin/users" })).statusCode).toBe(401);
    current = { userId: "u-verified", email: "alice@example.com", role: "user", emailVerified: true };
    expect((await app.inject({ url: "/portal/api/admin/users" })).statusCode).toBe(403);
    current = ADMIN;
    const res = await app.inject({ url: "/portal/api/admin/users?filter=unverified&q=ecagent" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.selfUserId).toBe("u-admin");
    expect(body.users[0]).toMatchObject({ label: "unverified", machines: 0, apiKeys: 0 });
    expect((await app.inject({ url: "/portal/api/admin/users?filter=bogus" })).statusCode).toBe(400);
  });
});

const del = (app: FastifyInstance, userId: string, body: object) => app.inject({ method: "POST", url: `/portal/api/admin/users/${userId}/delete`, payload: body });

describe("POST /portal/api/admin/users/:userId/delete", () => {
  it("refuses non-admins before anything else", async () => {
    const app = build();
    current = { userId: "u-verified", email: "alice@example.com", role: "user", emailVerified: true };
    expect((await del(app, "u-old-a", { confirmEmail: "old-a@example.com" })).statusCode).toBe(403);
    expect(mem.deletes).toEqual([]);
  });

  it("refuses your own account and another admin", async () => {
    const app = build();
    const self = await del(app, "u-admin", { confirmEmail: "admin@example.com", force: true });
    expect([self.statusCode, self.json().error]).toEqual([409, "cannot_delete_self"]);
    const other = await del(app, "u-other-admin", { confirmEmail: "ops@example.com", force: true });
    expect([other.statusCode, other.json().error]).toEqual([409, "cannot_delete_admin"]);
    expect(mem.deletes).toEqual([]);
  });

  it("needs the email typed to confirm", async () => {
    const r = await del(build(), "u-old-a", { confirmEmail: "old-b@example.com" });
    expect([r.statusCode, r.json().error]).toEqual([400, "confirmation_mismatch"]);
  });

  it("refuses an account with a machine, even with force", async () => {
    const r = await del(build(), "u-machine", { confirmEmail: "mach@example.com", force: true });
    expect([r.statusCode, r.json().error]).toEqual([409, "has_machines"]);
  });

  it("refuses recent activity without force, and deletes with force", async () => {
    const app = build();
    const r = await del(app, "u-ec1", { confirmEmail: "codyrs82+ecagent1@gmail.com" });
    expect([r.statusCode, r.json().error]).toEqual([409, "recent_activity"]);
    const ok = await del(app, "u-ec1", { confirmEmail: "CodyRS82+ecagent1@gmail.com", force: true, reason: "test sign-up" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, userId: "u-ec1", auditId: "audit-1" });
    expect(mem.deletes[0]).toMatchObject({ userId: "u-ec1", actorUserId: "u-admin", force: true, reason: "test sign-up", balances: { cSats: 0, complete: true, coordinators: 2 } });
    // Each coordinator was asked, with the service token.
    expect(seenTokens).toEqual([SERVICE_TOKEN, SERVICE_TOKEN]);
  });

  it("deletes an agent-key account with force (its keys are revoked by the store)", async () => {
    const r = await del(build(), "u-agent", { confirmEmail: "agent-1b2c@agents.invalid", force: true });
    expect(r.statusCode).toBe(200);
    expect(mem.deletes[0]).toMatchObject({ accountKind: "agent" });
  });

  it("refuses a balance or a pending payout, force or not", async () => {
    const app = build();
    const rich = await del(app, "u-rich", { confirmEmail: "rich@example.com", force: true });
    expect([rich.statusCode, rich.json().error]).toEqual([409, "has_balance"]);
    expect(rich.json().balances.cSats).toBe(12);
    const paying = await del(app, "u-paying", { confirmEmail: "paying@example.com", force: true });
    expect([paying.statusCode, paying.json().error]).toEqual([409, "pending_payouts"]);
    expect(mem.deletes).toEqual([]);
  });

  it("refuses when a coordinator cannot be asked, or none is configured", async () => {
    urls = [bases[0]!, downBase];
    const app = build();
    const r = await del(app, "u-old-a", { confirmEmail: "old-a@example.com" });
    expect([r.statusCode, r.json().error]).toEqual([409, "balance_unknown"]);
    urls = [];
    const none = await del(app, "u-old-a", { confirmEmail: "old-a@example.com" });
    expect([none.statusCode, none.json().error]).toEqual([409, "balance_unknown"]);
    expect(mem.deletes).toEqual([]);
  });

  it("deletes an old idle account without force", async () => {
    const r = await del(build(), "u-old-a", { confirmEmail: "old-a@example.com" });
    expect(r.statusCode).toBe(200);
    expect(users.some((u) => u.userId === "u-old-a")).toBe(false);
  });
});

describe("GET /portal/api/admin/users/:userId/balance", () => {
  it("reports what every coordinator says", async () => {
    const r = await build().inject({ url: "/portal/api/admin/users/u-rich/balance" });
    expect(r.json()).toMatchObject({ accountId: "acct-u-rich", complete: true, cSats: 12, pendingPayouts: 0 });
    expect(r.json().coordinators).toHaveLength(2);
  });
});

const cleanup = (app: FastifyInstance, body: object) => app.inject({ method: "POST", url: "/portal/api/admin/users/cleanup", payload: body });

describe("bulk cleanup of unverified accounts", () => {
  it("dry run lists old idle unverified accounts with nothing attached, and says why others were skipped", async () => {
    const app = build();
    const r = await cleanup(app, { olderThanDays: 30, dryRun: true });
    expect(r.statusCode).toBe(200);
    const plan = r.json();
    expect(plan.candidates.map((c: { userId: string }) => c.userId).sort()).toEqual(["u-old-a", "u-old-b"]);
    expect(plan.skipped.map((s: { userId: string; error: string }) => [s.userId, s.error]).sort()).toEqual([
      ["u-paying", "pending_payouts"],
      ["u-rich", "has_balance"]
    ]);
    expect(plan.confirm).toBe("DELETE 2");
    // Nothing deleted, nothing audited, by a dry run.
    expect(mem.deletes).toEqual([]);
    expect(mem.audit).toEqual([]);
  });

  it("deletes exactly the listed accounts after confirmation, and records the audit entries", async () => {
    const app = build();
    expect((await cleanup(app, { olderThanDays: 30, dryRun: false, userIds: ["u-old-a"] })).json().error).toBe("confirmation_mismatch");
    const r = await cleanup(app, { olderThanDays: 30, dryRun: false, userIds: ["u-old-a", "u-rich"], confirm: "DELETE 2" });
    expect(r.statusCode).toBe(200);
    const out = r.json();
    expect(out.deleted.map((d: { userId: string }) => d.userId)).toEqual(["u-old-a"]);
    expect(out.skipped.find((s: { userId: string }) => s.userId === "u-rich").error).toBe("has_balance");
    expect(users.some((u) => u.userId === "u-old-b")).toBe(true); // not in the confirmed list
    expect(mem.deletes.map((d) => [d.userId, d.bulk, d.force])).toEqual([["u-old-a", true, false]]);
    const audit = (await app.inject({ url: "/portal/api/admin/audit" })).json().entries;
    expect(audit.map((e: AdminAuditEntry) => e.action)).toEqual(["account.bulk_delete", "account.delete"]);
    expect(audit[0]).toMatchObject({ actorUserId: "u-admin", auditId: out.auditId });
    expect(audit[0].detail.deleted).toEqual(["u-old-a"]);
  });

  it("leaves agent-key accounts out unless asked, and never includes admins or verified accounts", async () => {
    users.push(summary({ userId: "u-old-agent", email: "agent-9@agents.invalid", agentKey: true, accountKind: "agent" }));
    users.push(summary({ userId: "u-old-admin", email: "old-admin@example.com", role: "admin" }));
    users.push(summary({ userId: "u-old-verified", email: "v@example.com", emailVerified: true }));
    const app = build();
    const ids = async (body: object) => (await cleanup(app, body)).json().candidates.map((c: { userId: string }) => c.userId).sort();
    expect(await ids({ olderThanDays: 30 })).toEqual(["u-old-a", "u-old-b"]);
    expect(await ids({ olderThanDays: 30, includeAgentAccounts: true })).toEqual(["u-old-a", "u-old-agent", "u-old-b"]);
  });
});
