import { describe, expect, test } from "vitest";
import { safeTokenEqual } from "../../src/swarm/coordinator-utils.js";

// ---------------------------------------------------------------------------
// Local helpers that reimplement the guard patterns from coordinator.ts.
// The real functions use module-level env vars and are not exported, so we
// recreate the logic here on top of the exported `safeTokenEqual`.
// ---------------------------------------------------------------------------

function hasMeshToken(
  headers: Record<string, unknown>,
  meshAuthToken: string,
): boolean {
  if (!meshAuthToken) return true;
  const token = headers["x-mesh-token"];
  return typeof token === "string" && safeTokenEqual(token, meshAuthToken);
}

function hasPortalServiceToken(
  headers: Record<string, unknown>,
  portalServiceToken: string,
): boolean {
  if (!portalServiceToken) return true;
  const token = headers["x-portal-service-token"];
  return typeof token === "string" && safeTokenEqual(token, portalServiceToken);
}

function requireMeshToken(
  headers: Record<string, unknown>,
  meshAuthToken: string,
): { ok: true } | { ok: false; code: number } {
  if (!meshAuthToken) return { ok: true };
  const token = headers["x-mesh-token"];
  if (typeof token === "string" && safeTokenEqual(token, meshAuthToken))
    return { ok: true };
  return { ok: false, code: 401 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("coordinator auth guards", () => {
  // ---- requireMeshToken pattern ----

  describe("requireMeshToken pattern", () => {
    test("no global token configured (empty string) -> always passes", () => {
      const result = requireMeshToken({}, "");
      expect(result).toEqual({ ok: true });
    });

    test("correct token -> passes", () => {
      const secret = "mesh-secret-42";
      const result = requireMeshToken(
        { "x-mesh-token": secret },
        secret,
      );
      expect(result).toEqual({ ok: true });
    });

    test("wrong token -> 401", () => {
      const result = requireMeshToken(
        { "x-mesh-token": "wrong-token" },
        "correct-token",
      );
      expect(result).toEqual({ ok: false, code: 401 });
    });
  });

  // ---- hasMeshToken pattern ----

  describe("hasMeshToken pattern", () => {
    test("no global token configured -> true", () => {
      expect(hasMeshToken({}, "")).toBe(true);
    });

    test("correct token -> true", () => {
      const secret = "mesh-secret-99";
      expect(hasMeshToken({ "x-mesh-token": secret }, secret)).toBe(true);
    });

    test("missing header -> false", () => {
      expect(hasMeshToken({}, "some-secret")).toBe(false);
    });

    test("non-string header value -> false", () => {
      expect(hasMeshToken({ "x-mesh-token": 12345 }, "some-secret")).toBe(
        false,
      );
    });
  });

  // ---- hasPortalServiceToken pattern ----

  describe("hasPortalServiceToken pattern", () => {
    test("no global token configured -> true", () => {
      expect(hasPortalServiceToken({}, "")).toBe(true);
    });

    test("correct token -> true", () => {
      const secret = "portal-secret-77";
      expect(
        hasPortalServiceToken({ "x-portal-service-token": secret }, secret),
      ).toBe(true);
    });

    test("missing header -> false", () => {
      expect(hasPortalServiceToken({}, "portal-secret")).toBe(false);
    });
  });

  // ---- Payment webhook secret / safeTokenEqual directly ----

  describe("payment webhook secret (safeTokenEqual)", () => {
    test("timing-safe comparison succeeds for matching strings", () => {
      const webhookSecret = "whsec_abc123xyz";
      expect(safeTokenEqual(webhookSecret, webhookSecret)).toBe(true);
    });

    test("type check: non-string values are rejected before reaching safeTokenEqual", () => {
      // safeTokenEqual expects strings; the guard pattern checks typeof first.
      // Verify that the guard rejects a numeric header before calling safeTokenEqual.
      const headers: Record<string, unknown> = {
        "x-mesh-token": 99999,
      };
      const token = headers["x-mesh-token"];
      const accepted =
        typeof token === "string" && safeTokenEqual(token, "real-secret");
      expect(accepted).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// #5: production with an empty MESH_AUTH_TOKEN must not be "open".
// Uses the real shared helper the coordinator's requireMeshToken delegates to.
// ---------------------------------------------------------------------------
import Fastify from "fastify";
import { checkSharedToken } from "../../src/common/env-guard.js";

describe("empty mesh token in production (#5)", () => {
  function buildApp(meshToken: string, isProd: boolean) {
    const app = Fastify();
    app.post("/mesh/route", async (req, reply) => {
      const result = checkSharedToken(meshToken, req.headers["x-mesh-token"], isProd);
      if (result !== "ok") {
        reply.code(result === "not_configured" ? 503 : 401);
        return reply.send({ error: "mesh_unauthorized" });
      }
      return { ok: true };
    });
    return app;
  }

  test("NODE_ENV=production + empty MESH_AUTH_TOKEN -> 503, not 200", async () => {
    const app = buildApp("", true);
    const res = await app.inject({ method: "POST", url: "/mesh/route", payload: {} });
    expect(res.statusCode).toBe(503);
  });

  test("dev + empty MESH_AUTH_TOKEN -> still open (unchanged local-dev behaviour)", async () => {
    const app = buildApp("", false);
    const res = await app.inject({ method: "POST", url: "/mesh/route", payload: {} });
    expect(res.statusCode).toBe(200);
  });

  test("production + configured token -> 401 without header, 200 with it", async () => {
    const app = buildApp("mesh-secret", true);
    expect((await app.inject({ method: "POST", url: "/mesh/route", payload: {} })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/mesh/route", payload: {}, headers: { "x-mesh-token": "mesh-secret" } })).statusCode
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// #40: sensitive coordinator routes, table-driven. Add new sensitive routes here.
// ---------------------------------------------------------------------------
import { debugRoutesEnabled } from "../../src/common/env-guard.js";
import { isBleSyncAuthorized } from "../../src/credits/ble-sync.js";
import { verifyPaymentWebhookSignature } from "../../src/economy/payment-settlement.js";

const ADMIN_ROUTES: Array<{ method: "GET" | "POST"; url: string; route: string }> = [
  { method: "GET", url: "/admin/dashboard", route: "/admin/dashboard" },
  { method: "GET", url: "/admin/dashboard/api/overview", route: "/admin/dashboard/api/overview" },
  { method: "GET", url: "/admin/agents/x/behavior", route: "/admin/agents/:agentId/behavior" },
  { method: "POST", url: "/security/blacklist", route: "/security/blacklist" }
];

describe("coordinator admin/debug/webhook/ble-sync auth (#40)", () => {
  // Mirrors coordinator authorizeAdmin (503 when unset, 401 on missing/wrong x-admin-token).
  function buildAdminApp(adminToken: string) {
    const app = Fastify();
    const authorizeAdmin = (req: any, reply: any) => {
      if (!adminToken) {
        reply.code(503).send({ error: "admin_dashboard_not_configured" });
        return false;
      }
      const t = req.headers["x-admin-token"];
      if (typeof t !== "string" || !safeTokenEqual(t, adminToken)) {
        reply.code(401).send({ error: "invalid_admin_token" });
        return false;
      }
      return true;
    };
    for (const r of ADMIN_ROUTES) {
      app.route({
        method: r.method,
        url: r.route,
        handler: async (req, reply) => {
          if (!authorizeAdmin(req, reply)) return;
          return { ok: true };
        }
      });
    }
    return app;
  }

  for (const r of ADMIN_ROUTES) {
    test(`${r.method} ${r.url} -> 401 without x-admin-token (mesh token is not enough)`, async () => {
      const app = buildAdminApp("admin-secret");
      const res = await app.inject({ method: r.method, url: r.url, headers: { "x-mesh-token": "mesh" }, payload: r.method === "POST" ? {} : undefined });
      expect(res.statusCode).toBe(401);
      const ok = await app.inject({ method: r.method, url: r.url, headers: { "x-admin-token": "admin-secret" }, payload: r.method === "POST" ? {} : undefined });
      expect(ok.statusCode).toBe(200);
    });
  }

  test("/debug/enqueue is not registered in production (-> 404)", async () => {
    expect(debugRoutesEnabled({ NODE_ENV: "production", ENABLE_DEBUG_ROUTES: "1" })).toBe(false);
    expect(debugRoutesEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(debugRoutesEnabled({ NODE_ENV: "test", ENABLE_DEBUG_ROUTES: "1" })).toBe(true);
    const app = Fastify();
    if (debugRoutesEnabled({ NODE_ENV: "production", ENABLE_DEBUG_ROUTES: "1" })) {
      app.post("/debug/enqueue", async () => ({ ok: true }));
    }
    expect((await app.inject({ method: "POST", url: "/debug/enqueue", payload: {} })).statusCode).toBe(404);
  });

  test("payments webhook unsigned -> rejected (401) (#42)", () => {
    expect(verifyPaymentWebhookSignature('{"invoiceRef":"lnbc-xxxxxxxx"}', undefined, "secret")).toBe(false);
  });

  test("/credits/ble-sync unauthenticated -> 401 (#41)", () => {
    expect(isBleSyncAuthorized(null, false, false)).toBe(false);
  });
});
