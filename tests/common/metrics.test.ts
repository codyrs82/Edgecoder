import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerMetrics } from "../../src/common/metrics.js";

function build(env: NodeJS.ProcessEnv, path?: string) {
  const app = Fastify();
  registerMetrics(app, "test-svc", { env, path });
  app.get("/nodes/:nodeId", async () => ({ ok: true }));
  return app;
}

describe("Prometheus /metrics (#14)", () => {
  it("counts requests by route pattern, not raw URL", async () => {
    const app = build({ NODE_ENV: "development" });
    await app.inject({ url: "/nodes/abc?token=secret" });
    await app.inject({ url: "/nodes/def" });
    await app.inject({ url: "/nope" });
    const res = await app.inject({ url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain; version=0.0.4");
    expect(res.body).toContain('edgecoder_http_requests_total{service="test-svc",method="GET",route="/nodes/:nodeId",status="200"} 2');
    expect(res.body).toContain('route="unmatched",status="404"} 1');
    expect(res.body).toContain('edgecoder_http_request_duration_seconds_bucket{service="test-svc",method="GET",route="/nodes/:nodeId",le="+Inf"} 2');
    expect(res.body).toContain("# TYPE edgecoder_process_resident_memory_bytes gauge");
    expect(res.body).not.toContain("abc");
    expect(res.body).not.toContain("secret");
    expect(res.body).not.toContain('route="/metrics"');
  });

  it("requires the bearer token when METRICS_TOKEN is set", async () => {
    const app = build({ NODE_ENV: "production", METRICS_TOKEN: "m".repeat(32) });
    expect((await app.inject({ url: "/metrics" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/metrics", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    const ok = await app.inject({ url: "/metrics", headers: { authorization: `Bearer ${"m".repeat(32)}` } });
    expect(ok.statusCode).toBe(200);
  });

  it("is not served in production without METRICS_TOKEN", async () => {
    const app = build({ NODE_ENV: "production" });
    expect((await app.inject({ url: "/metrics" })).statusCode).toBe(404);
  });

  it("supports a custom path", async () => {
    const app = build({}, "/metrics/prometheus");
    expect((await app.inject({ url: "/metrics/prometheus" })).statusCode).toBe(200);
  });
});
