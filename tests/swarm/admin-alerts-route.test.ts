import { afterAll, beforeAll, describe, expect, test } from "vitest";

/*
 * Production alerting on the real coordinator app: /admin/alerts, /admin/alerts/ack and
 * /admin/alerts/test sit behind the admin token, and security events reach the alert rules.
 * No ALERT_EMAILS / ALERT_WEBHOOK_URL: nothing is sent anywhere.
 */
const ADMIN = "admin-secret-alerts";
let app: any;
let alerts: typeof import("../../src/swarm/coordinator/alerts.js");
let ctx: typeof import("../../src/swarm/coordinator/context.js");

beforeAll(async () => {
  Object.assign(process.env, { ADMIN_API_TOKEN: ADMIN, MESH_AUTH_TOKEN: "mesh-secret-alerts", PORTAL_SERVICE_TOKEN: "portal-secret-alerts", BITCOIN_NETWORK: "signet", LIGHTNING_PROVIDER: "mock" });
  delete process.env.DATABASE_URL;
  delete process.env.ALERT_EMAILS;
  delete process.env.ALERT_WEBHOOK_URL;
  app = (await import("../../src/swarm/coordinator.js")).coordinatorServer;
  alerts = await import("../../src/swarm/coordinator/alerts.js");
  ctx = await import("../../src/swarm/coordinator/context.js");
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  delete process.env.ADMIN_API_TOKEN;
});

describe("coordinator /admin/alerts", () => {
  test("needs the admin token", async () => {
    for (const [method, url] of [["GET", "/admin/alerts"], ["POST", "/admin/alerts/ack"], ["POST", "/admin/alerts/test"]]) {
      expect((await app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode, url).toBe(401);
      expect((await app.inject({ method, url, headers: { "x-admin-token": "wrong" }, payload: method === "POST" ? {} : undefined })).statusCode, url).toBe(401);
    }
  });

  test("a security event becomes an alert listed here, and the admin can acknowledge it", async () => {
    ctx.securityLog.log({ level: "HIGH", event: "bot_control_not_owner", source: { type: "coordinator", id: "portal" }, details: { accountId: "acct-x", agentId: "mac-y" }, action: "refused", coordinatorId: ctx.identity.peerId });
    await alerts.coordinatorAlerts.apply("local", alerts.securityMonitor.name, await alerts.securityMonitor.check(Date.now()));
    const res = await app.inject({ method: "GET", url: "/admin/alerts", headers: { "x-admin-token": ADMIN } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe(ctx.identity.peerId);
    expect(body.channels).toEqual([]);
    const a = body.active.find((x: { key: string }) => x.key === "security:bot_control_not_owner");
    expect(a).toMatchObject({ severity: "warning", source: ctx.identity.peerId });
    expect(JSON.stringify(a.details)).toContain("mac-y");
    const ack = await app.inject({ method: "POST", url: "/admin/alerts/ack", headers: { "x-admin-token": ADMIN }, payload: { source: a.source, key: a.key, by: "root@example.com" } });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().alert.acknowledgedBy).toBe("root@example.com");
    expect((await app.inject({ method: "POST", url: "/admin/alerts/ack", headers: { "x-admin-token": ADMIN }, payload: { source: a.source, key: "nope" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/admin/alerts/ack", headers: { "x-admin-token": ADMIN }, payload: { key: 1 } })).statusCode).toBe(400);
  });

  test("Send test alert with no channel configured says so instead of pretending", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/alerts/test", headers: { "x-admin-token": ADMIN }, payload: { by: "root@example.com" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, channels: [] });
  });

  test("the coordinator's monitors are the expected rules", () => {
    const names = alerts.coordinatorMonitors().map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["peer_health", "portal_health", "payouts", "purchases", "ordering_chain", "security"]));
    // No database in this test: no ledger or database monitor.
    expect(names).not.toContain("database");
  });
});
