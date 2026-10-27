import { describe, expect, test } from "vitest";
import Fastify from "fastify";
import { checkInternalServiceToken, portalAllowOpenInternal } from "../../src/common/env-guard.js";

// #40: table of every portal /internal/* route. Add new internal routes here.
const INTERNAL_ROUTES: Array<{ method: "GET" | "POST"; url: string; route: string }> = [
  { method: "POST", url: "/internal/nodes/validate", route: "/internal/nodes/validate" },
  { method: "POST", url: "/internal/nodes/node-1/approval", route: "/internal/nodes/:nodeId/approval" },
  { method: "POST", url: "/internal/nodes/lookup", route: "/internal/nodes/lookup" },
  { method: "GET", url: "/internal/nodes/pending", route: "/internal/nodes/pending" },
  { method: "GET", url: "/internal/stats/counts", route: "/internal/stats/counts" }
];

/** Same shape as src/portal/server.ts: an /internal plugin whose onRequest hook enforces the token. */
async function buildPortal(serviceToken: string, allowOpenWhenUnset = false) {
  const app = Fastify();
  await app.register(async (internal) => {
    internal.addHook("onRequest", async (req, reply) => {
      const result = checkInternalServiceToken(serviceToken, req.headers["x-portal-service-token"], { allowOpenWhenUnset });
      if (result === "not_configured") return reply.code(503).send({ error: "internal_auth_not_configured" });
      if (result !== "ok") return reply.code(401).send({ error: "portal_service_token_required" });
    });
    for (const r of INTERNAL_ROUTES) {
      internal.route({ method: r.method, url: r.route, handler: async () => ({ ok: true }) });
    }
  });
  return app;
}

describe("portal /internal/* auth (#40)", () => {
  for (const r of INTERNAL_ROUTES) {
    test(`${r.method} ${r.url}: 401 without token, 401 wrong token, 200 with token`, async () => {
      const app = await buildPortal("svc-token");
      expect((await app.inject({ method: r.method, url: r.url, payload: r.method === "POST" ? {} : undefined })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: r.method, url: r.url, headers: { "x-portal-service-token": "wrong" }, payload: r.method === "POST" ? {} : undefined })).statusCode
      ).toBe(401);
      expect(
        (await app.inject({ method: r.method, url: r.url, headers: { "x-portal-service-token": "svc-token" }, payload: r.method === "POST" ? {} : undefined })).statusCode
      ).not.toBe(401);
    });

    test(`${r.method} ${r.url}: 503 when PORTAL_SERVICE_TOKEN is unset`, async () => {
      const app = await buildPortal("");
      expect((await app.inject({ method: r.method, url: r.url, payload: r.method === "POST" ? {} : undefined })).statusCode).toBe(503);
    });
  }

  test("routes with no per-route check are still guarded by the plugin hook", async () => {
    const app = await buildPortal("svc-token");
    const res = await app.inject({ method: "GET", url: "/internal/nodes/pending", headers: {} });
    expect(res.statusCode).toBe(401);
  });

  test("PORTAL_ALLOW_OPEN_INTERNAL only works outside production", () => {
    expect(portalAllowOpenInternal({ NODE_ENV: "development", PORTAL_ALLOW_OPEN_INTERNAL: "1" })).toBe(true);
    expect(portalAllowOpenInternal({ NODE_ENV: "production", PORTAL_ALLOW_OPEN_INTERNAL: "1" })).toBe(false);
    expect(portalAllowOpenInternal({ NODE_ENV: "development" })).toBe(false);
  });
});
