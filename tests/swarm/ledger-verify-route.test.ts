import { afterAll, beforeAll, describe, expect, test } from "vitest";

/*
 * #115: GET /ledger/verify. With the mesh token alone it still answers the in-memory ordering-chain
 * check (unchanged); the credits-ledger reconciliation needs the admin token as well, and Postgres.
 * The reconciliation itself is covered by tests/ledger/reconcile.test.ts and
 * tests/ledger/ledger-verify-pg.test.ts.
 */

const MESH = "mesh-secret-115";
const ADMIN = "admin-secret-115";
let app: any;

beforeAll(async () => {
  process.env.ADMIN_API_TOKEN = ADMIN;
  process.env.MESH_AUTH_TOKEN = MESH;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const get = (headers: Record<string, string>, url = "/ledger/verify") => app.inject({ method: "GET", url, remoteAddress: "203.0.113.115", headers });

describe("/ledger/verify", () => {
  test("mesh token only: the ordering-chain status, as before; no token: refused", async () => {
    expect((await get({})).statusCode).toBe(401);
    expect((await get({ "x-admin-token": ADMIN })).statusCode).toBe(401); // the mesh token is still required
    const res = await get({ "x-mesh-token": MESH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  test("the reconciliation is admin-only", async () => {
    expect((await get({ "x-mesh-token": MESH, "x-admin-token": "wrong" })).statusCode).toBe(401);
    expect((await get({ "x-mesh-token": MESH, "x-admin-token": ADMIN }, "/ledger/verify?max=0")).statusCode).toBe(400);
    const res = await get({ "x-mesh-token": MESH, "x-admin-token": ADMIN });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("ledger_verify_requires_postgres");
  });
});
