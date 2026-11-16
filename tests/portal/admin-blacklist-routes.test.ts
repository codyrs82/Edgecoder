import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerNetworkAdminRoutes } from "../../src/portal/routes/network-admin.js";

/** Settings > Network's paused agents: system admins only; every coordinator asked with the admin token. */
describe("portal admin blacklist list and lift", () => {
  const seen: Array<{ coordinator: string; method: string; url: string; token: unknown; body?: unknown }> = [];
  const coordinators: FastifyInstance[] = [];
  const bases: string[] = [];
  const active = { us: new Set(["mac-owner-1"]), eu: new Set(["mac-owner-1", "griefer-9"]) };
  let user: { userId: string; email: string; emailVerified: boolean } | null;
  let isAdmin = true;
  const NOW = Date.now();

  beforeAll(async () => {
    for (const name of ["us", "eu"] as const) {
      const c = Fastify();
      c.get("/admin/security/blacklist", async (req, reply) => {
        seen.push({ coordinator: name, method: "GET", url: req.url, token: req.headers["x-admin-token"] });
        if (req.headers["x-admin-token"] !== "coord-admin-token") return reply.code(401).send({ error: "invalid_admin_token" });
        return {
          records: [...active[name]].map((agentId, i) => ({
            agentId, reasonCode: "dos_behavior", reason: `Auto-blacklisted by behavioral monitoring: BHV006 — ${name}`, reportedBy: "behavioral_monitoring", automatic: true,
            timestampMs: NOW - (name === "eu" ? 1_000 : 5_000) - i, expiresAtMs: NOW + 3_600_000,
          })),
        };
      });
      c.post("/admin/security/blacklist/:agentId/lift", async (req, reply) => {
        const agentId = (req.params as { agentId: string }).agentId;
        seen.push({ coordinator: name, method: "POST", url: req.url, token: req.headers["x-admin-token"], body: req.body });
        if (req.headers["x-admin-token"] !== "coord-admin-token") return reply.code(401).send({ error: "invalid_admin_token" });
        if (!active[name].delete(agentId)) return reply.code(404).send({ error: "not_blacklisted" });
        return { ok: true };
      });
      await c.listen({ port: 0, host: "127.0.0.1" });
      const addr = c.server.address();
      bases.push(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
      coordinators.push(c);
    }
  });
  afterAll(async () => {
    for (const c of coordinators) await c.close();
  });

  const build = (token = "coord-admin-token"): FastifyInstance => {
    const app = Fastify();
    registerNetworkAdminRoutes(app, {
      coordinatorAdminToken: token,
      EXTERNAL_HTTP_TIMEOUT_MS: 3000,
      coordinatorUrls: async () => [...bases],
      getCurrentUser: async () => user,
      buildAccessContext: async () => ({ isSystemAdmin: isAdmin }),
      lookupOwners: async () => ({ nodeOwners: new Map([["mac-owner-1", { userId: "u-owner", email: "owner@portal.example" }]]), userEmails: new Map() }),
    });
    return app;
  };

  beforeEach(() => {
    seen.length = 0;
    user = { userId: "u-root", email: "root@example.com", emailVerified: true };
    isAdmin = true;
  });

  it("refuses anyone who is not a system admin, before any coordinator call", async () => {
    const app = build();
    user = null;
    expect((await app.inject({ url: "/portal/api/admin/blacklist" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/blacklist/mac-owner-1/lift" })).statusCode).toBe(401);
    user = { userId: "u-1", email: "someone@example.com", emailVerified: true };
    isAdmin = false;
    expect((await app.inject({ url: "/portal/api/admin/blacklist" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/blacklist/mac-owner-1/lift" })).statusCode).toBe(403);
    expect(seen).toEqual([]);
    isAdmin = true;
    expect((await build("").inject({ url: "/portal/api/admin/blacklist" })).statusCode).toBe(503);
  });

  it("lists paused agents across coordinators with the admin token, joined to owners", async () => {
    const res = await build().inject({ url: "/portal/api/admin/blacklist" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(seen.every((s) => s.token === "coord-admin-token")).toBe(true);
    const owner = res.json().agents.find((a: { agentId: string }) => a.agentId === "mac-owner-1");
    expect(owner).toMatchObject({ automatic: true, ownerEmail: "owner@portal.example" });
    expect(owner.coordinators).toHaveLength(2);
    expect(owner.reason).toContain("eu"); // newest record wins
    expect(res.json().agents.map((a: { agentId: string }) => a.agentId).sort()).toEqual(["griefer-9", "mac-owner-1"]);
  });

  it("lifts on every coordinator that has it, naming the admin", async () => {
    const res = await build().inject({ method: "POST", url: "/portal/api/admin/blacklist/mac-owner-1/lift" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, agentId: "mac-owner-1", lifted: 2 });
    expect(seen.filter((s) => s.method === "POST").every((s) => (s.body as { reason: string }).reason.includes("root@example.com"))).toBe(true);
    const again = await build().inject({ method: "POST", url: "/portal/api/admin/blacklist/mac-owner-1/lift" });
    expect(again.statusCode).toBe(404);
    expect((await build().inject({ method: "POST", url: "/portal/api/admin/blacklist/bad%20id/lift" })).statusCode).toBe(400);
  });
});
