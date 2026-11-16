import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alertConfigFromEnv } from "../../src/alerting/config.js";
import { AlertManager } from "../../src/alerting/manager.js";
import { MemoryAlertStore } from "../../src/alerting/store.js";
import type { AlertNotification, AlertRecord } from "../../src/alerting/types.js";
import { BACKUP_STATE, readBackupReports, registerBackupReportRoute, registerPortalAlertRoutes } from "../../src/portal/alerts.js";

/** Settings > Network's Alerts: system admins only; the portal's own alerts plus every coordinator's. */
describe("portal alert admin routes", () => {
  const TOKEN = "coord-admin-token";
  const coordinators: FastifyInstance[] = [];
  const bases: string[] = [];
  const seen: Array<{ coordinator: string; method: string; url: string; token: unknown; body?: unknown }> = [];
  const shared = (over: Partial<AlertRecord> = {}): AlertRecord => ({
    source: "shared", key: "payout_failed", rule: "payouts", severity: "warning", title: "Payout failed", summary: "1 payout failed", link: null, details: null, status: "active",
    firstSeenMs: 1_000, lastSeenMs: 2_000, resolvedAtMs: null, lastNotifiedMs: 1_000, notifyCount: 1, acknowledgedAtMs: null, acknowledgedBy: null, ...over
  });
  let user: { userId: string; email: string; emailVerified: boolean } | null;
  let isAdmin = true;
  let sent: AlertNotification[];
  let manager: AlertManager;
  let store: MemoryAlertStore;

  beforeAll(async () => {
    for (const name of ["ord", "eu"] as const) {
      const c = Fastify();
      c.get("/admin/alerts", async (req, reply) => {
        seen.push({ coordinator: name, method: "GET", url: req.url, token: req.headers["x-admin-token"] });
        if (req.headers["x-admin-token"] !== TOKEN) return reply.code(401).send({ error: "invalid_admin_token" });
        return {
          source: `coord-${name}`, reporter: `coordinator ${name}`, channels: name === "ord" ? ["email"] : [], enabled: true,
          active: [shared(), shared({ source: `coord-${name}`, key: "ln_low_outbound", rule: "lightning", severity: "critical", title: `Low outbound (${name})`, firstSeenMs: 5_000 })],
          history: [{ source: "shared", key: "payout_failed", kind: "raised", severity: "warning", title: "Payout failed", summary: "", atMs: 1_000 }]
        };
      });
      c.post("/admin/alerts/ack", async (req, reply) => {
        seen.push({ coordinator: name, method: "POST", url: req.url, token: req.headers["x-admin-token"], body: req.body });
        return reply.send({ ok: true });
      });
      c.post("/admin/alerts/test", async (req) => {
        seen.push({ coordinator: name, method: "POST", url: req.url, token: req.headers["x-admin-token"], body: req.body });
        return name === "ord" ? { ok: true, channels: [{ channel: "email", ok: true }] } : { ok: false, channels: [] };
      });
      await c.listen({ port: 0, host: "127.0.0.1" });
      const a = c.server.address();
      bases.push(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`);
      coordinators.push(c);
    }
  });
  afterAll(async () => {
    for (const c of coordinators) await c.close();
  });

  const build = (token = TOKEN): FastifyInstance => {
    const app = Fastify();
    registerPortalAlertRoutes(app, {
      manager,
      config: alertConfigFromEnv({}),
      coordinatorAdminToken: token,
      timeoutMs: 3_000,
      coordinatorUrls: async () => [...bases, `${bases[0]}/`],
      getCurrentUser: async () => user,
      buildAccessContext: async () => ({ isSystemAdmin: isAdmin })
    });
    return app;
  };

  beforeEach(async () => {
    seen.length = 0;
    sent = [];
    user = { userId: "u-root", email: "root@example.com", emailVerified: true };
    isAdmin = true;
    store = new MemoryAlertStore();
    manager = new AlertManager({ store, channels: [{ name: "email", send: async (n) => void sent.push(n) }], sourceId: "portal", reporter: "portal", portalUrl: "https://p.example", rateLimitMs: 900_000, renotifyMs: 0 });
    await manager.raise("local", "coordinator_health", { key: "coordinator_down:seed-eu", severity: "critical", title: "Coordinator seed-eu is down", summary: "3 failed checks" });
  });

  it("refuses anonymous and non-admin sessions on every route", async () => {
    const app = build();
    for (const [method, url] of [["GET", "/portal/api/admin/alerts"], ["POST", "/portal/api/admin/alerts/ack"], ["POST", "/portal/api/admin/alerts/test"]] as const) {
      user = null;
      expect((await app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode, url).toBe(401);
      user = { userId: "u2", email: "u@example.com", emailVerified: true };
      isAdmin = false;
      expect((await app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode, url).toBe(403);
      isAdmin = true;
    }
    expect(seen).toEqual([]);
    expect(sent.filter((n) => n.kind === "test")).toEqual([]);
  });

  it("lists the portal's and every coordinator's alerts, the shared incident once, critical first", async () => {
    const res = await build().inject({ method: "GET", url: "/portal/api/admin/alerts" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(seen.filter((s) => s.method === "GET").map((s) => s.token)).toEqual([TOKEN, TOKEN]); // the trailing-slash duplicate is asked once
    expect(body.active.map((a: { key: string; origin: string }) => a.key)).toEqual(["coordinator_down:seed-eu", "ln_low_outbound", "ln_low_outbound", "payout_failed"]);
    expect(body.active.filter((a: { key: string }) => a.key === "payout_failed")).toHaveLength(1);
    expect(body.active.find((a: { key: string }) => a.key === "payout_failed").reporter).toBe("coordinators (shared database)");
    expect(body.sources.map((s: { reporter: string; channels: string[] }) => `${s.reporter}:${s.channels.join("+")}`)).toEqual(["portal:email", "coordinator ord:email", "coordinator eu:"]);
    expect(body.history.filter((e: { key: string }) => e.key === "payout_failed")).toHaveLength(1);
  });

  it("reports a coordinator that rejects the token and still answers with the rest", async () => {
    const body = (await build("wrong").inject({ method: "GET", url: "/portal/api/admin/alerts" })).json();
    expect(body.sources.filter((s: { ok: boolean }) => !s.ok).map((s: { error: string }) => s.error)).toEqual(["admin_token_rejected", "admin_token_rejected"]);
    expect(body.active.map((a: { key: string }) => a.key)).toEqual(["coordinator_down:seed-eu"]);
  });

  it("acknowledges a portal alert locally and forwards a coordinator's to that coordinator only", async () => {
    const app = build();
    const local = await app.inject({ method: "POST", url: "/portal/api/admin/alerts/ack", payload: { origin: "portal", source: "portal", key: "coordinator_down:seed-eu" } });
    expect(local.statusCode).toBe(200);
    expect((await manager.list()).active[0]!.acknowledgedBy).toBe("root@example.com");
    const remote = await app.inject({ method: "POST", url: "/portal/api/admin/alerts/ack", payload: { origin: bases[1], source: "coord-eu", key: "ln_low_outbound" } });
    expect(remote.statusCode).toBe(200);
    expect(seen).toEqual([{ coordinator: "eu", method: "POST", url: "/admin/alerts/ack", token: TOKEN, body: { source: "coord-eu", key: "ln_low_outbound", by: "root@example.com" } }]);
    // A URL the portal does not already talk to is never called.
    const evil = await app.inject({ method: "POST", url: "/portal/api/admin/alerts/ack", payload: { origin: "http://169.254.169.254", source: "x", key: "y" } });
    expect(evil.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/alerts/ack", payload: { origin: "portal", source: "portal", key: "nope" } })).statusCode).toBe(404);
  });

  it("Send test alert: the portal's channels and every coordinator's, with the result of each", async () => {
    const res = await build().inject({ method: "POST", url: "/portal/api/admin/alerts/test", payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(sent.filter((n) => n.kind === "test")).toHaveLength(1);
    expect(body.results.map((r: { ok: boolean; error?: string }) => `${r.ok}:${r.error ?? ""}`)).toEqual(["true:", "true:", "false:no_channel_configured"]);
    expect(body.ok).toBe(false);
    expect(seen.filter((s) => s.url === "/admin/alerts/test").map((s) => s.body)).toEqual([{ by: "root@example.com" }, { by: "root@example.com" }]);
  });
});

describe("POST /internal/alerts/backup-report", () => {
  const build = (manager: AlertManager, now: () => number) => {
    const app = Fastify();
    registerBackupReportRoute(app, { manager, serviceToken: "svc-token", now });
    return app;
  };
  it("needs the portal service token, validates, and stores one report per database", async () => {
    const store = new MemoryAlertStore();
    const manager = new AlertManager({ store, channels: [], sourceId: "portal", reporter: "portal", portalUrl: "https://p", rateLimitMs: 1, renotifyMs: 0 });
    const now = Date.UTC(2026, 10, 16, 12);
    const app = build(manager, () => now);
    const post = (payload: unknown, token = "svc-token") => app.inject({ method: "POST", url: "/internal/alerts/backup-report", headers: { "x-portal-service-token": token }, payload: payload as object });
    expect((await post({ app: "portal-db", lastSuccessAt: "2026-11-16T03:00:00Z" }, "coordinator-read-token")).statusCode).toBe(401);
    expect((await post({ app: "bad name!", lastSuccessAt: null })).statusCode).toBe(400);
    expect((await post({ app: "portal-db", lastSuccessAt: "yesterday-ish" })).statusCode).toBe(400);
    expect((await post({ app: "portal-db", lastSuccessAt: "2026-11-16T03:00:00Z", detail: "3 backups" })).statusCode).toBe(200);
    expect((await post({ app: "coord-db", lastSuccessAt: null, detail: "fly postgres backup list failed" })).statusCode).toBe(200);
    expect(await readBackupReports(manager)).toEqual([
      { app: "portal-db", lastSuccessAtMs: Date.UTC(2026, 10, 16, 3), reportedAtMs: now, detail: "3 backups" },
      { app: "coord-db", lastSuccessAtMs: null, reportedAtMs: now, detail: "fly postgres backup list failed" }
    ]);
    expect((await store.getState(BACKUP_STATE))!.updatedAtMs).toBe(now);
  });
});
