import { describe, expect, it } from "vitest";
import { buildAnchorProxyApp, type AnchorProxyOptions } from "../../src/economy/anchor-proxy-app.js";

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
