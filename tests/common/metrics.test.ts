import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { isLoopbackCaller, metricsAccess, registerMetrics, statusClass } from "../../src/common/metrics.js";
import { registerCoordinatorMetrics } from "../../src/swarm/coordinator-metrics.js";

const TOKEN = "m".repeat(32);
// app.inject() defaults to a loopback peer (127.0.0.1, Host: localhost:80); this is "the internet".
const REMOTE = "203.0.113.5";

function build(env: NodeJS.ProcessEnv = {}, path?: string) {
  const app = Fastify();
  const metrics = registerMetrics(app, "test-svc", { env, path });
  app.get("/nodes/:nodeId", async () => ({ ok: true }));
  app.post("/boom", async () => {
    throw new Error("boom");
  });
  return { app, metrics };
}

/** The sample line for `name` whose label set contains every given label, in any order. */
function sample(body: string, name: string, labels: Record<string, string>): string | undefined {
  return body.split("\n").find((line) => {
    if (!line.startsWith(`${name}{`)) return false;
    return Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`));
  });
}

describe("Prometheus /metrics (#14)", () => {
  it("counts requests by method, route pattern and status class, never the raw URL", async () => {
    const { app } = build();
    await app.inject({ url: "/nodes/node-abc123?token=sekret-value" });
    await app.inject({ url: "/nodes/node-def456" });
    await app.inject({ url: "/no/such/path-xyz789" });
    await app.inject({ method: "POST", url: "/boom" });
    const res = await app.inject({ url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain; version=0.0.4");

    const ok = { service: "test-svc", method: "GET", route: "/nodes/:nodeId", status_class: "2xx" };
    expect(sample(res.body, "edgecoder_http_requests_total", ok)).toMatch(/ 2$/);
    expect(sample(res.body, "edgecoder_http_requests_total", { route: "unmatched", status_class: "4xx" })).toMatch(/ 1$/);
    expect(sample(res.body, "edgecoder_http_requests_total", { method: "POST", route: "/boom", status_class: "5xx" })).toMatch(/ 1$/);
    expect(sample(res.body, "edgecoder_http_request_duration_seconds_bucket", { ...ok, le: "+Inf" })).toMatch(/ 2$/);
    expect(sample(res.body, "edgecoder_http_request_duration_seconds_count", ok)).toMatch(/ 2$/);
    expect(res.body).toContain("# TYPE edgecoder_http_request_duration_seconds histogram");

    for (const leaked of ["node-abc123", "node-def456", "path-xyz789", "sekret-value", "token="]) {
      expect(res.body, leaked).not.toContain(leaked);
    }
    // Scrapes are not counted, or every scrape would change the numbers it reads.
    expect(res.body).not.toContain('route="/metrics"');
    await app.close();
  });

  it("only ever uses a fixed set of label names", async () => {
    const { app } = build();
    await app.inject({ url: "/nodes/1" });
    const res = await app.inject({ url: "/metrics" });
    const names = new Set<string>();
    for (const line of res.body.split("\n")) {
      if (!line.startsWith("edgecoder_http_")) continue;
      for (const m of line.matchAll(/([a-z_]+)="/g)) names.add(m[1]!);
    }
    expect([...names].sort()).toEqual(["le", "method", "route", "service", "status_class"]);
    await app.close();
  });

  it("includes the default process metrics", async () => {
    const { app } = build();
    const res = await app.inject({ url: "/metrics" });
    expect(res.body).toContain("# TYPE process_resident_memory_bytes gauge");
    expect(res.body).toContain("# TYPE process_cpu_seconds_total counter");
    expect(res.body).toContain("# TYPE nodejs_eventloop_lag_seconds gauge");
    await app.close();
  });

  it("folds unknown methods and status codes into fixed label values", () => {
    const { metrics } = build();
    metrics.observeRequest("PROPFIND-" + "x".repeat(50), "/nodes/:nodeId", 200, 0.01);
    expect(statusClass(204)).toBe("2xx");
    expect(statusClass(503)).toBe("5xx");
    expect(statusClass(0)).toBe("other");
    expect(statusClass(999)).toBe("other");
    return metrics.render().then((body) => {
      expect(sample(body, "edgecoder_http_requests_total", { method: "OTHER" })).toBeDefined();
      expect(body).not.toContain("PROPFIND");
    });
  });

  it("supports a custom path", async () => {
    const { app } = build({}, "/metrics/prometheus");
    expect((await app.inject({ url: "/metrics/prometheus" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/metrics" })).statusCode).toBe(404);
    await app.close();
  });
});

describe("/metrics access (#14)", () => {
  it("without METRICS_TOKEN, a non-loopback caller gets the ordinary 404", async () => {
    const { app } = build({});
    const hidden = await app.inject({ url: "/metrics", remoteAddress: REMOTE });
    const unknown = await app.inject({ url: "/definitely-not-a-route", remoteAddress: REMOTE });
    expect(hidden.statusCode).toBe(404);
    // Indistinguishable from a route that does not exist, apart from the path it echoes.
    expect(hidden.headers["content-type"]).toBe(unknown.headers["content-type"]);
    expect(hidden.json()).toEqual({ ...unknown.json(), message: "Route GET:/metrics not found" });
    expect(hidden.body).not.toContain("edgecoder_");
    // A token in the request does not help when none is configured.
    const guess = await app.inject({ url: "/metrics", remoteAddress: REMOTE, headers: { authorization: "Bearer " } });
    expect(guess.statusCode).toBe(404);
    await app.close();
  });

  it("with METRICS_TOKEN, a non-loopback caller needs the right bearer token", async () => {
    const { app } = build({ METRICS_TOKEN: TOKEN });
    const none = await app.inject({ url: "/metrics", remoteAddress: REMOTE });
    expect(none.statusCode).toBe(401);
    expect(none.headers["www-authenticate"]).toBe("Bearer");
    expect(none.body).not.toContain("edgecoder_");

    for (const authorization of ["Bearer wrong", `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, `Basic ${TOKEN}`, TOKEN, "Bearer "]) {
      const res = await app.inject({ url: "/metrics", remoteAddress: REMOTE, headers: { authorization } });
      expect(res.statusCode, authorization).toBe(401);
      expect(res.body).not.toContain("edgecoder_");
    }
    // The token is not accepted anywhere but the Authorization header.
    expect((await app.inject({ url: `/metrics?token=${TOKEN}`, remoteAddress: REMOTE })).statusCode).toBe(401);
    expect((await app.inject({ url: "/metrics", remoteAddress: REMOTE, headers: { "x-metrics-token": TOKEN } })).statusCode).toBe(401);

    const ok = await app.inject({ url: "/metrics", remoteAddress: REMOTE, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("edgecoder_http_requests_total");
    await app.close();
  });

  it("serves a loopback caller without a token", async () => {
    for (const env of [{}, { METRICS_TOKEN: TOKEN }]) {
      const { app } = build(env);
      for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
        expect((await app.inject({ url: "/metrics", remoteAddress })).statusCode, remoteAddress).toBe(200);
      }
      await app.close();
    }
  });

  it("does not treat a request relayed by a local proxy as loopback", async () => {
    const { app } = build({});
    for (const headers of [
      { "x-forwarded-for": "198.51.100.7" },
      { "cf-connecting-ip": "198.51.100.7" },
      { "fly-client-ip": "198.51.100.7" },
      { forwarded: "for=198.51.100.7" },
      { via: "1.1 edge" },
      // DNS rebinding: a loopback connection made under a public name.
      { host: "metrics.example.com" }
    ]) {
      const res = await app.inject({ url: "/metrics", remoteAddress: "127.0.0.1", headers });
      expect(res.statusCode, JSON.stringify(headers)).toBe(404);
    }
    await app.close();
  });

  it("does not trust a forwarded address to claim loopback", async () => {
    // trustProxy makes req.ip client-controlled; the check uses the socket's peer address.
    const app = Fastify({ trustProxy: true });
    registerMetrics(app, "test-svc", { env: {} });
    const res = await app.inject({ url: "/metrics", remoteAddress: REMOTE, headers: { "x-forwarded-for": "127.0.0.1" } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("classifies callers", () => {
    const req = (remoteAddress: string | undefined, headers: Record<string, string>) =>
      ({ headers, socket: { remoteAddress } }) as unknown as Parameters<typeof metricsAccess>[0];
    expect(isLoopbackCaller(req("127.0.0.1", { host: "127.0.0.1:4301" }))).toBe(true);
    expect(isLoopbackCaller(req("::1", { host: "[::1]:4301" }))).toBe(true);
    expect(isLoopbackCaller(req("127.0.0.1", { host: "localhost" }))).toBe(true);
    expect(isLoopbackCaller(req("127.0.0.1", {}))).toBe(false);
    expect(isLoopbackCaller(req("10.0.0.4", { host: "localhost" }))).toBe(false);
    expect(isLoopbackCaller(req("1127.0.0.1", { host: "localhost" }))).toBe(false);
    expect(isLoopbackCaller(req(undefined, { host: "localhost" }))).toBe(false);
    expect(metricsAccess(req("10.0.0.4", { host: "x" }), "")).toBe("hidden");
    expect(metricsAccess(req("10.0.0.4", { host: "x" }), TOKEN)).toBe("unauthorized");
    expect(metricsAccess(req("10.0.0.4", { host: "x", authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe("allowed");
  });
});

describe("domain gauges (#14)", () => {
  it("reads gauges from existing state at scrape time", async () => {
    const { metrics } = build();
    let depth = 3;
    metrics.gauge("edgecoder_test_depth", "Test depth.", () => depth);
    metrics.gauge("edgecoder_test_broken", "Throws.", () => {
      throw new Error("state not ready");
    });
    expect(await metrics.render()).toMatch(/^edgecoder_test_depth\{service="test-svc"\} 3$/m);
    depth = 7;
    const body = await metrics.render();
    expect(body).toMatch(/^edgecoder_test_depth\{service="test-svc"\} 7$/m);
    // A failing source must not fail the scrape.
    expect(body).toMatch(/^edgecoder_test_broken\{service="test-svc"\} Nan$/im);
  });

  it("exports coordinator queue depth, connected agents and payout reconciliation status", async () => {
    const { metrics } = build();
    let last: { status: string; atMs: number } | null = null;
    registerCoordinatorMetrics(metrics, {
      queue: () => ({ queued: 4, agents: 2, results: 9 }),
      connectedAgents: () => 5,
      payoutReconcile: () => last as never
    });
    let body = await metrics.render();
    expect(body).toMatch(/^edgecoder_queue_depth\{service="test-svc"\} 4$/m);
    expect(body).toMatch(/^edgecoder_queue_results\{service="test-svc"\} 9$/m);
    expect(body).toMatch(/^edgecoder_connected_agents\{service="test-svc"\} 5$/m);
    expect(sample(body, "edgecoder_payout_reconcile_status", { status: "never_run" })).toMatch(/ 1$/);
    expect(sample(body, "edgecoder_payout_reconcile_status", { status: "ok" })).toMatch(/ 0$/);

    last = { status: "tripped", atMs: 1_700_000_000_000 };
    body = await metrics.render();
    expect(sample(body, "edgecoder_payout_reconcile_status", { status: "tripped" })).toMatch(/ 1$/);
    expect(sample(body, "edgecoder_payout_reconcile_status", { status: "never_run" })).toMatch(/ 0$/);
    expect(body).toMatch(/^edgecoder_payout_reconcile_last_run_timestamp_seconds\{service="test-svc"\} 1700000000$/m);
  });
});
