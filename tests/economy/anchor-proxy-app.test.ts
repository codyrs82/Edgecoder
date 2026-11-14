import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAnchorProxyApp, registerAnchorProxyMetrics, type AnchorProxyOptions, type AnchorProxyStats } from "../../src/economy/anchor-proxy-app.js";
import { registerMetrics } from "../../src/common/metrics.js";

// #116 review: route-level tests for the anchor proxy.
const TXID = "ab".repeat(32);
const AUTH = { authorization: "Bearer secret-token" };

function provider(overrides: Partial<AnchorProxyOptions["provider"]> = {}): AnchorProxyOptions["provider"] {
  return {
    async broadcastOpReturn() { return { txid: TXID }; },
    async getConfirmations() { return { confirmed: false, confirmations: 0 }; },
    async healthCheck() { return { reachable: true, provider: "test" }; },
    async sendToMany() { throw new Error("n/a"); },
    async findCheckpointTx() { return TXID; },
    async isInMempool() { return true; },
    async abandonTx() { return undefined; },
    ...overrides
  } as AnchorProxyOptions["provider"];
}

const app = (p = provider(), extra: Partial<AnchorProxyOptions> = {}) =>
  buildAnchorProxyApp({ token: "secret-token", provider: p, network: "signet", ...extra });

const routes = [
  { method: "GET" as const, url: `/anchor/find/6a20ff` },
  { method: "GET" as const, url: `/anchor/mempool/${TXID}` },
  { method: "POST" as const, url: `/anchor/abandon`, payload: { txid: TXID } }
];

describe("anchor proxy reconciliation routes (#103/#116)", () => {
  it("require the bearer token", async () => {
    const a = app();
    for (const r of routes) {
      expect((await a.inject(r)).statusCode).toBe(401);
      expect((await a.inject({ ...r, headers: { authorization: "Bearer wrong-token!" } })).statusCode).toBe(401);
    }
  });

  it("happy paths", async () => {
    const a = app();
    expect((await a.inject({ ...routes[0], headers: AUTH })).json()).toEqual({ ok: true, txid: TXID });
    // A full 80-byte payload fits in the path parameter.
    expect((await a.inject({ method: "GET", url: `/anchor/find/${"ab".repeat(80)}`, headers: AUTH })).statusCode).toBe(200);
    expect((await a.inject({ ...routes[1], headers: AUTH })).json()).toEqual({ ok: true, inMempool: true });
    expect((await a.inject({ ...routes[2], headers: AUTH })).json()).toEqual({ ok: true });
  });

  it("reject bad input with 400, including odd-length and oversize hex", async () => {
    const a = app();
    for (const url of ["/anchor/find/6a2", "/anchor/find/zz", `/anchor/find/${"a".repeat(162)}`, "/anchor/mempool/abc", `/anchor/mempool/${"g".repeat(64)}`]) {
      expect((await a.inject({ method: "GET", url, headers: AUTH })).statusCode).toBe(400);
    }
    for (const payload of [{}, { txid: "abc" }, { txid: 5 }]) {
      expect((await a.inject({ method: "POST", url: "/anchor/abandon", headers: AUTH, payload })).statusCode).toBe(400);
    }
  });

  it("return 502 with only an error code when the node fails", async () => {
    const boom = async () => { throw new Error("rpc password=hunter2 refused"); };
    const a = app(provider({ findCheckpointTx: boom, isInMempool: boom, abandonTx: boom }));
    const codes = ["find_failed", "mempool_check_failed", "abandon_failed"];
    for (const [i, r] of routes.entries()) {
      const res = await a.inject({ ...r, headers: AUTH });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: codes[i] });
    }
  });

  it("rate-limits the reconciliation routes", async () => {
    let t = 0;
    const a = app(provider(), { maxReconcileCallsPerMinute: 2, now: () => t });
    expect((await a.inject({ ...routes[0], headers: AUTH })).statusCode).toBe(200);
    expect((await a.inject({ ...routes[1], headers: AUTH })).statusCode).toBe(200);
    expect((await a.inject({ ...routes[2], headers: AUTH })).statusCode).toBe(429);
    t = 60_001;
    expect((await a.inject({ ...routes[2], headers: AUTH })).statusCode).toBe(200);
  });
});

describe("anchor proxy /health (#14)", () => {
  it("is unauthenticated and reports the node", async () => {
    const stats = {};
    const a = app(provider({ async healthCheck() { return { reachable: true, provider: "test", chain: "signet", blocks: 7 }; } }), { stats, now: () => 5_000 });
    const res = await a.inject({ url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, network: "signet", blocks: 7 });
    expect(stats).toEqual({ bitcoindReachable: true, blocks: 7, lastHealthCheckMs: 5_000 });
  });

  it("fails the check with 503 when bitcoind is unreachable or the probe throws", async () => {
    const stats: { bitcoindReachable?: boolean } = {};
    const down = app(provider({ async healthCheck() { return { reachable: false, provider: "test" }; } }), { stats });
    const res = await down.inject({ url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, error: "bitcoind_unreachable" });
    expect(stats.bitcoindReachable).toBe(false);

    const broken = app(provider({ async healthCheck() { throw new Error("rpc http://user:pass@node:8332 refused"); } }));
    const res2 = await broken.inject({ url: "/health" });
    expect(res2.statusCode).toBe(503);
    expect(res2.body).not.toContain("pass");
  });
});

describe("anchor proxy /metrics (#14)", () => {
  function metered(env: NodeJS.ProcessEnv, healthy = true) {
    const stats: AnchorProxyStats = {};
    const a = app(provider({ async healthCheck() { return healthy ? { reachable: true, provider: "test", blocks: 812 } : { reachable: false, provider: "test" }; } }), { stats, now: () => 9_000 });
    registerAnchorProxyMetrics(registerMetrics(a, "anchor-proxy", { env }), stats);
    return a;
  }
  const REMOTE = "203.0.113.5";

  it("reports the anchor node's state as last seen by the health check", async () => {
    const a = metered({});
    expect((await a.inject({ url: "/metrics" })).body).toMatch(/^edgecoder_anchor_proxy_bitcoind_reachable\{service="anchor-proxy"\} Nan$/im);
    await a.inject({ url: "/health" });
    const body = (await a.inject({ url: "/metrics" })).body;
    expect(body).toMatch(/^edgecoder_anchor_proxy_bitcoind_reachable\{service="anchor-proxy"\} 1$/m);
    expect(body).toMatch(/^edgecoder_anchor_proxy_block_height\{service="anchor-proxy"\} 812$/m);
    expect(body).toMatch(/^edgecoder_anchor_proxy_last_health_check_timestamp_seconds\{service="anchor-proxy"\} 9$/m);

    const down = metered({}, false);
    await down.inject({ url: "/health" });
    expect((await down.inject({ url: "/metrics" })).body).toMatch(/^edgecoder_anchor_proxy_bitcoind_reachable\{service="anchor-proxy"\} 0$/m);
  });

  it("is not public, and the proxy's own token is not a metrics credential", async () => {
    const hidden = metered({});
    expect((await hidden.inject({ url: "/metrics", remoteAddress: REMOTE })).statusCode).toBe(404);
    expect((await hidden.inject({ url: "/metrics", remoteAddress: REMOTE, headers: AUTH })).statusCode).toBe(404);

    const tokened = metered({ METRICS_TOKEN: "m".repeat(32) });
    expect((await tokened.inject({ url: "/metrics", remoteAddress: REMOTE })).statusCode).toBe(401);
    expect((await tokened.inject({ url: "/metrics", remoteAddress: REMOTE, headers: AUTH })).statusCode).toBe(401);
    expect((await tokened.inject({ url: "/metrics", remoteAddress: REMOTE, headers: { authorization: `Bearer ${"m".repeat(32)}` } })).statusCode).toBe(200);
    // The health check Fly runs stays open either way.
    expect((await tokened.inject({ url: "/health", remoteAddress: REMOTE })).statusCode).toBe(200);
  });
});

describe("anchor proxy startup log", () => {
  it("logs the bitcoind RPC host only, never the raw URL (which may carry user:pass)", () => {
    const src = readFileSync(new URL("../../src/economy/anchor-proxy-service.ts", import.meta.url), "utf8");
    const startup = src.split("\n").filter((l) => l.includes("app.log.info") && l.includes("rpc:"));
    expect(startup).toHaveLength(1);
    expect(startup[0]).toContain("rpc: rpcHostForLog(BITCOIND_RPC_URL)");
    expect(src).not.toMatch(/\$\{BITCOIND_RPC_URL\}/);
    expect(src).not.toMatch(/console\./);
  });
});
