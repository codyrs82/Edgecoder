import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

/*
 * Admin-token routes on the real coordinator app, as deployed on Fly (FLY_APP_NAME set): only
 * internal sockets (loopback, Fly's private network) may use them, whatever headers say, and the
 * token is still required. Also: the dual-accept window for rotated tokens, and the internal-only
 * admin listener (ADMIN_LISTEN_PORT).
 */

const ADMIN = "admin-secret-origin-current";
const OLD_ADMIN = "admin-secret-origin-previous";
const MESH = "mesh-secret-origin-current";
const OLD_MESH = "mesh-secret-origin-previous";
let app: any;

beforeAll(async () => {
  Object.assign(process.env, {
    ADMIN_API_TOKEN: ADMIN,
    ADMIN_API_TOKEN_PREVIOUS: OLD_ADMIN,
    MESH_AUTH_TOKEN: MESH,
    MESH_AUTH_TOKEN_PREVIOUS: OLD_MESH,
    TOKEN_PREVIOUS_UNTIL: new Date(Date.now() + 3_600_000).toISOString(),
    FLY_APP_NAME: "edgecoder-origin-test",
    BITCOIN_NETWORK: "signet",
    LIGHTNING_PROVIDER: "mock"
  });
  delete process.env.DATABASE_URL;
  delete process.env.ADMIN_ALLOWED_CIDRS;
  delete process.env.COORDINATOR_TRUST_PROXY;
  app = (await import("../../src/swarm/coordinator.js")).coordinatorServer;
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  for (const k of ["ADMIN_API_TOKEN", "ADMIN_API_TOKEN_PREVIOUS", "MESH_AUTH_TOKEN_PREVIOUS", "TOKEN_PREVIOUS_UNTIL", "FLY_APP_NAME"]) delete process.env[k];
});

const get = (url: string, remoteAddress: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, remoteAddress, headers: { "x-mesh-token": MESH, ...headers } });

describe("admin routes refuse the public path", () => {
  test("a public address with the right token is refused (403), headers cannot change that", async () => {
    for (const ip of ["203.0.113.9", "172.16.3.2", "2001:db8::7"]) {
      const res = await get("/admin/payouts/pause", ip, { "x-admin-token": ADMIN, "x-forwarded-for": "127.0.0.1", "x-real-ip": "fdaa::1" });
      expect(res.statusCode, ip).toBe(403);
      expect(res.json()).toMatchObject({ error: "admin_internal_only", reason: "not_internal" });
    }
  });

  test("a request through Fly's edge (Fly-Client-IP / Fly-Forwarded-Port) is refused even on an internal socket", async () => {
    expect((await get("/admin/payouts/pause", "127.0.0.1", { "x-admin-token": ADMIN, "fly-client-ip": "198.51.100.4" })).json()).toMatchObject({ reason: "public_ingress" });
    expect((await get("/admin/revenue", "fdaa:0:1::2", { "x-admin-token": ADMIN, "fly-forwarded-port": "443" })).statusCode).toBe(403);
  });

  test("admin-token routes outside /admin/* get the same check", async () => {
    expect((await get("/ledger/verify", "203.0.113.9", { "x-admin-token": ADMIN })).statusCode).toBe(403);
    const res = await app.inject({ method: "POST", url: "/economy/fee-pool/distribute", remoteAddress: "203.0.113.9", headers: { "x-mesh-token": MESH, "x-admin-token": ADMIN, "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(403);
  });

  test("internal sockets with the token are allowed: loopback and Fly's private network", async () => {
    expect((await get("/admin/payouts/pause", "127.0.0.1", { "x-admin-token": ADMIN })).statusCode).toBe(200);
    expect((await get("/admin/payouts/pause", "fdaa:0:1234:a7b:1f:5ab2:1d71:2", { "x-admin-token": ADMIN })).statusCode).toBe(200);
  });

  test("internal is not enough: the token is still required", async () => {
    expect((await get("/admin/payouts/pause", "127.0.0.1")).statusCode).toBe(401);
    expect((await get("/admin/payouts/pause", "fdaa::2", { "x-admin-token": "wrong" })).statusCode).toBe(401);
  });
});

describe("token rotation: dual-accept", () => {
  test("the previous admin and mesh tokens work until TOKEN_PREVIOUS_UNTIL, then stop", async () => {
    expect((await get("/admin/payouts/pause", "127.0.0.1", { "x-admin-token": OLD_ADMIN })).statusCode).toBe(200);
    const oldMesh = await app.inject({ method: "GET", url: "/mesh/peers", remoteAddress: "203.0.113.9", headers: { "x-mesh-token": OLD_MESH } });
    expect(oldMesh.statusCode).toBe(200);
    const later = Date.now() + 2 * 3_600_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      expect((await get("/admin/payouts/pause", "127.0.0.1", { "x-admin-token": OLD_ADMIN })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/mesh/peers", remoteAddress: "203.0.113.9", headers: { "x-mesh-token": OLD_MESH } })).statusCode).toBe(401);
      expect((await get("/admin/payouts/pause", "127.0.0.1", { "x-admin-token": ADMIN })).statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("internal admin listener (ADMIN_LISTEN_PORT)", () => {
  test("serves the same app on the extra port; loopback with the token gets through", async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createNetServer().listen(0, "::1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const { startAdminListener } = await import("../../src/swarm/coordinator/admin-listener.js");
    const server = await startAdminListener(app, port, "::1");
    try {
      const ok = await fetch(`http://[::1]:${port}/admin/payouts/pause`, { headers: { "x-admin-token": ADMIN, "x-mesh-token": MESH } });
      expect(ok.status).toBe(200);
      const noToken = await fetch(`http://[::1]:${port}/admin/payouts/pause`, { headers: { "x-mesh-token": MESH } });
      expect(noToken.status).toBe(401);
    } finally {
      await new Promise<void>((r) => server!.close(() => r()));
    }
    expect(await startAdminListener(app, 0)).toBeNull();
  });
});
