import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/*
 * DoS: /register is reachable without any credential. A denied registration costs an audit record
 * (kept in memory and written to the ledger), a signature and a portal round trip, so it must be
 * bounded in size and throttled per address.
 */

const REMOTE = "203.0.113.77";
let portal: Server;
let portalCalls = 0;
let app: any;
let ordering: any;

beforeAll(async () => {
  portal = createServer((req, res) => {
    portalCalls++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = "mesh-secret-flood";
  process.env.PREAUTH_FAILURE_MAX_PER_IP = "20";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  ({ ordering } = await import("../../src/swarm/coordinator/agent-state.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  delete process.env.PREAUTH_FAILURE_MAX_PER_IP;
});

function register(agentId: string, remoteAddress = REMOTE) {
  const payload = JSON.stringify({ os: "macos", version: "1", mode: "swarm-only", agentId, registrationToken: "garbage-token-xyz" });
  return app.inject({ method: "POST", url: "/register", remoteAddress, headers: { "content-type": "application/json" }, payload });
}

describe("unauthenticated /register flood", () => {
  test("an oversized agent id is refused before any work", async () => {
    const before = ordering.snapshot().length;
    const res = await register("x".repeat(200_000));
    expect(res.statusCode).toBe(400);
    expect(ordering.snapshot().length).toBe(before);
  });

  test("denied registrations from one address are throttled; others are unaffected", async () => {
    const before = ordering.snapshot().length;
    const callsBefore = portalCalls;
    const codes: number[] = [];
    for (let i = 0; i < 60; i++) codes.push((await register(`flood-${i}`)).statusCode);
    expect(codes.filter((c) => c === 403).length).toBe(20);
    expect(codes.filter((c) => c === 429).length).toBe(40);
    // Throttled requests leave no audit record and make no portal call.
    expect(ordering.snapshot().length - before).toBe(20);
    expect(portalCalls - callsBefore).toBe(20);
    expect((await register("flood-other", "198.51.100.5")).statusCode).toBe(403);
  });
});
