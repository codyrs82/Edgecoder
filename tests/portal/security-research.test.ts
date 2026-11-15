import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  registerSecurityResearchInternalRoute,
  registerSecurityResearchRoutes,
  type SecurityResearchEntitlement,
  type SecurityResearchStore
} from "../../src/portal/security-research.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-15T12:00:00Z");

function memoryStore() {
  const rows = new Map<string, SecurityResearchEntitlement>();
  const k = (u: string, kind: string) => `${u}|${kind}`;
  const store: SecurityResearchStore = {
    async upsertRestrictedEntitlement(r) {
      rows.set(k(r.userId, r.kind), { ...r });
    },
    async getRestrictedEntitlement(u, kind) {
      const r = rows.get(k(u, kind));
      return r ? { ...r } : null;
    },
    async listRestrictedEntitlements(limit) {
      return [...rows.values()].sort((a, b) => b.grantedAtMs - a.grantedAtMs).slice(0, limit).map((r) => ({ ...r }));
    },
    async setRestrictedEntitlementStatus(u, kind, status, by, nowMs) {
      const r = rows.get(k(u, kind));
      if (!r || r.status === "revoked") return null;
      Object.assign(r, { status, statusChangedBy: by, statusChangedAtMs: nowMs });
      return { ...r };
    },
  };
  return { store, rows };
}

function setup(isAdmin: boolean) {
  const mem = memoryStore();
  const pushed: unknown[] = [];
  let now = NOW;
  const app = Fastify();
  const users = new Map([["u-lab", "lead@lab.example"]]);
  registerSecurityResearchRoutes(app, {
    store: mem.store,
    getCurrentUser: async (req) => (req.headers.cookie === "admin" ? { userId: "admin-1", email: "admin@edgecoder.io" } : req.headers.cookie === "lab" ? { userId: "u-lab", email: "lead@lab.example" } : null),
    buildAccessContext: async (u) => ({ isSystemAdmin: isAdmin && u.userId === "admin-1" }),
    findUser: async (a) => ([...users].find(([id, email]) => id === a || email === a) ? { userId: "u-lab", email: "lead@lab.example" } : null),
    emailsFor: async (ids) => new Map(ids.filter((id) => users.has(id)).map((id) => [id, users.get(id)!])),
    notifyCoordinators: async (change) => {
      pushed.push(change);
      return { notified: 2, failed: 0 };
    },
    now: () => now,
  });
  app.register(async (internal) => registerSecurityResearchInternalRoute(internal, { store: mem.store, now: () => now }));
  return { app, mem, pushed, advance: (ms: number) => (now += ms) };
}

const grant = {
  account: "lead@lab.example",
  kind: "security_research",
  orgName: "Example Lab Ltd",
  verificationNotes: "Company register checked; signatory verified by video call.",
  agreementRef: "https://docs.example/agreements/123",
  agreementAcceptedAt: "2026-11-10",
  expiresAt: "2027-05-15",
};

describe("Settings > Admin > Security research access", () => {
  it("is for system admins only", async () => {
    const { app } = setup(false);
    expect((await app.inject({ method: "GET", url: "/portal/api/admin/security-research" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/portal/api/admin/security-research", headers: { cookie: "admin" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/security-research", headers: { cookie: "admin" }, payload: grant })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/security-research/u-lab/security_research/suspend", headers: { cookie: "lab" } })).statusCode).toBe(403);
  });

  it("grants with organisation, notes, agreement, dates and granting admin; pushes it to coordinators; lists it", async () => {
    const { app, pushed } = setup(true);
    const res = await app.inject({ method: "POST", url: "/portal/api/admin/security-research", headers: { cookie: "admin" }, payload: grant });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().entitlement).toMatchObject({
      userId: "u-lab", accountId: "acct-u-lab", kind: "security_research", orgName: "Example Lab Ltd", agreementRef: grant.agreementRef,
      agreementAcceptedAtMs: Date.parse("2026-11-10T00:00:00Z"), expiresAtMs: Date.parse("2027-05-16T00:00:00Z"), grantedBy: "admin@edgecoder.io", status: "active", effectiveStatus: "active",
    });
    expect(res.json().coordinators).toEqual({ notified: 2, failed: 0 });
    expect(pushed).toEqual([{ accountId: "acct-u-lab", kind: "security_research", expiresAtMs: Date.parse("2027-05-16T00:00:00Z"), active: true }]);
    const list = (await app.inject({ method: "GET", url: "/portal/api/admin/security-research", headers: { cookie: "admin" } })).json();
    expect(list.entitlements).toHaveLength(1);
    expect(list.entitlements[0]).toMatchObject({ email: "lead@lab.example", verificationNotes: grant.verificationNotes });
  });

  it("validates the grant", async () => {
    const { app } = setup(true);
    const bad = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/portal/api/admin/security-research", headers: { cookie: "admin" }, payload: { ...grant, ...body } });
    expect((await bad({ agreementRef: "" })).statusCode).toBe(400);
    expect((await bad({ verificationNotes: "" })).statusCode).toBe(400);
    expect((await bad({ orgName: "<script>" })).statusCode).toBe(400);
    expect((await bad({ expiresAt: "2026-11-01" })).statusCode).toBe(400); // already past
    expect((await bad({ expiresAt: "2031-01-01" })).statusCode).toBe(400); // too long a term
    expect((await bad({ agreementAcceptedAt: "2027-01-01" })).statusCode).toBe(400); // in the future
    expect((await bad({ kind: "unfiltered" })).statusCode).toBe(400);
    expect((await bad({ account: "nobody@x.example" })).statusCode).toBe(404);
  });

  it("suspends and reinstates (pushed each time), revokes for good, and expires", async () => {
    const { app, pushed, advance } = setup(true);
    await app.inject({ method: "POST", url: "/portal/api/admin/security-research", headers: { cookie: "admin" }, payload: grant });
    const act = (a: string) => app.inject({ method: "POST", url: `/portal/api/admin/security-research/u-lab/security_research/${a}`, headers: { cookie: "admin" } });
    const internal = async () => (await app.inject({ method: "GET", url: "/internal/security-research/entitlements" })).json().entitlements;
    expect(await internal()).toHaveLength(1);

    const s = await act("suspend");
    expect(s.json().entitlement).toMatchObject({ status: "suspended", statusChangedBy: "admin@edgecoder.io" });
    expect(pushed.at(-1)).toMatchObject({ accountId: "acct-u-lab", active: false });
    expect(await internal()).toEqual([]);
    expect((await act("reinstate")).json().entitlement.status).toBe("active");
    expect(pushed.at(-1)).toMatchObject({ active: true });

    advance(200 * DAY);
    expect((await app.inject({ method: "GET", url: "/portal/api/admin/security-research", headers: { cookie: "admin" } })).json().entitlements[0].effectiveStatus).toBe("expired");
    expect(await internal()).toEqual([]);

    expect((await act("revoke")).json().entitlement.status).toBe("revoked");
    expect(pushed.at(-1)).toMatchObject({ active: false });
    expect((await act("reinstate")).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/security-research/u-none/security_research/suspend", headers: { cookie: "admin" } })).statusCode).toBe(404);
  });

  it("tells the holder their own status without the admin's notes", async () => {
    const { app } = setup(true);
    await app.inject({ method: "POST", url: "/portal/api/admin/security-research", headers: { cookie: "admin" }, payload: grant });
    expect((await app.inject({ method: "GET", url: "/portal/api/security-research/me" })).statusCode).toBe(401);
    const me = (await app.inject({ method: "GET", url: "/portal/api/security-research/me", headers: { cookie: "lab" } })).json();
    expect(me).toEqual({ securityResearch: { orgName: "Example Lab Ltd", status: "active", expiresAtMs: Date.parse("2027-05-16T00:00:00Z") }, host: null });
  });
});

describe("model pickers", () => {
  it("offer a restricted model (listed only to entitled accounts) on your own machines, never as network compute", async () => {
    const { computeOptions } = await import("../../src/portal/routes/compute.js");
    const opts = computeOptions([{ model: "sec:7b", agents: 1, classes: ["gpu"], restricted: "security_research" }, { model: "open:1b", agents: 1, classes: ["gpu"] }], {}, [], NOW);
    expect(opts.filter((o) => o.compute.model === "sec:7b").map((o) => o.group)).toEqual(["mine"]);
    expect(opts.filter((o) => o.compute.model === "open:1b").map((o) => o.group)).toContain("network");
    const { listNetworkModels } = await import("../../src/apps/ide/network-inference.js");
    const ids = (
      await listNetworkModels({
        forwarder: "", token: () => "", agentId: "a",
        transport: async () => ({ status: 200, json: { models: [{ model: "sec:7b", agents: 1, classes: ["gpu"], restricted: "security_research" }, { model: "open:1b", agents: 1, classes: ["gpu"] }] } }),
      })
    ).map((m) => m.id);
    expect(ids).toContain("mine/sec:7b");
    expect(ids.some((id) => id.startsWith("network/sec:7b"))).toBe(false);
    expect(ids).toContain("network/open:1b");
  });
});
