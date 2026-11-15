import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

/*
 * #14: /metrics on the real coordinator app (Fastify inject). The onRequest auth hook lets the
 * path through on purpose; these tests pin that the route is still not public, and that the mesh
 * and admin tokens are not metrics credentials.
 */

const MESH = "mesh-secret-metrics";
const ADMIN = "admin-secret-metrics";
const METRICS = "metrics-secret-0123456789abcdef";
// app.inject() defaults to a loopback peer; this is a caller from the internet.
const REMOTE = "203.0.113.20";

/** The sample line for `name` whose label set contains every given label, in any order. */
function sample(body: string, name: string, labels: Record<string, string>): string | undefined {
  return body.split("\n").find((line) => line.startsWith(`${name}{`) && Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`)));
}

async function loadCoordinator(metricsToken: string | undefined) {
  vi.resetModules();
  process.env.MESH_AUTH_TOKEN = MESH;
  process.env.ADMIN_API_TOKEN = ADMIN;
  if (metricsToken === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = metricsToken;
  const { coordinatorServer } = await import("../../src/swarm/coordinator.js");
  await coordinatorServer.ready();
  return coordinatorServer;
}

describe("coordinator /metrics with METRICS_TOKEN set", () => {
  let app: any;
  beforeAll(async () => {
    app = await loadCoordinator(METRICS);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
  });

  test("a non-loopback caller without the token gets 401", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics", remoteAddress: REMOTE });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "metrics_token_required" });
  });

  test("a wrong token gets 401, and the mesh and admin tokens are not accepted", async () => {
    for (const headers of [
      { authorization: "Bearer wrong" },
      { authorization: `Bearer ${MESH}` },
      { authorization: `Bearer ${ADMIN}` },
      { "x-mesh-token": MESH },
      { "x-admin-token": ADMIN },
      { "x-mesh-token": MESH, "x-admin-token": ADMIN }
    ]) {
      const res = await app.inject({ method: "GET", url: "/metrics", remoteAddress: REMOTE, headers });
      expect(res.statusCode, JSON.stringify(headers)).toBe(401);
      expect(res.body).not.toContain("edgecoder_");
    }
  });

  test("the right token gets the exposition, with the coordinator's gauges", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics", remoteAddress: REMOTE, headers: { authorization: `Bearer ${METRICS}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain; version=0.0.4");
    expect(res.body).toMatch(/^edgecoder_queue_depth\{service="coordinator"\} \d+$/m);
    expect(res.body).toMatch(/^edgecoder_connected_agents\{service="coordinator"\} \d+$/m);
    expect(sample(res.body, "edgecoder_payout_reconcile_status", { status: "never_run", service: "coordinator" })).toMatch(/ 1$/);
    expect(res.body).toContain("# TYPE process_cpu_seconds_total counter");
    // Nothing secret is exported.
    for (const secret of [MESH, ADMIN, METRICS]) expect(res.body).not.toContain(secret);
  });

  test("a loopback caller needs no token", async () => {
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);
  });

  test("the metrics token opens nothing else", async () => {
    const res = await app.inject({ method: "GET", url: "/status", remoteAddress: REMOTE, headers: { authorization: `Bearer ${METRICS}` } });
    expect(res.statusCode).toBe(401);
  });

  // Fly's seed health check (deploy/fly/fly.seed-*.toml) calls this with no credentials.
  test("the Fly health check path needs no token", async () => {
    const res = await app.inject({ method: "GET", url: "/health/runtime", remoteAddress: REMOTE });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  test("requests are counted by route pattern", async () => {
    await app.inject({ method: "GET", url: "/identity", remoteAddress: REMOTE });
    await app.inject({ method: "GET", url: "/no-such-route-abc123", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
    const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
    const identity = { method: "GET", route: "/identity", status_class: "2xx", service: "coordinator" };
    expect(sample(body, "edgecoder_http_requests_total", identity)).toMatch(/ [1-9]\d*$/);
    expect(sample(body, "edgecoder_http_requests_total", { route: "unmatched", status_class: "4xx" })).toBeDefined();
    expect(body).not.toContain("no-such-route-abc123");
  });
});

describe("coordinator /metrics without METRICS_TOKEN", () => {
  let app: any;
  beforeAll(async () => {
    app = await loadCoordinator(undefined);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
  });

  test("a non-loopback caller gets 404, whatever it presents", async () => {
    for (const headers of [{}, { authorization: "Bearer anything" }, { "x-mesh-token": MESH }, { "x-admin-token": ADMIN }]) {
      const res = await app.inject({ method: "GET", url: "/metrics", remoteAddress: REMOTE, headers });
      expect(res.statusCode, JSON.stringify(headers)).toBe(404);
      expect(res.body).not.toContain("edgecoder_");
    }
  });

  test("a loopback caller is still served", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("edgecoder_queue_depth");
  });
});
