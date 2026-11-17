import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/*
 * GET /economy/reserves on the real coordinator app (in-memory ledger, mock Lightning node with a
 * 50 000-sat balance): public without any token, aggregate totals that match the ledger fixture,
 * no account ids, rate limited per client IP, and the portal's service token is not limited.
 */
const MESH = "mesh-secret-reserves";
const PORTAL = "p".repeat(40);
let app: any;

beforeAll(async () => {
  Object.assign(process.env, {
    MESH_AUTH_TOKEN: MESH,
    PORTAL_SERVICE_TOKEN: PORTAL,
    BITCOIN_NETWORK: "signet",
    LIGHTNING_PROVIDER: "mock",
    MOCK_LIGHTNING_BALANCE_SATS: "50000",
    RESERVES_RATE_LIMIT_PER_MIN: "3"
  });
  delete process.env.DATABASE_URL;
  delete process.env.ECONOMY_PAYMENTS_ENABLED;
  const { creditEngine } = await import("../../src/credits/store.js");
  const tx = (accountId: string, type: "earn" | "spend", credits: number, reason: string, msat?: number) =>
    creditEngine.record({ txId: randomUUID(), accountId, type, credits, reason, timestampMs: Date.now(), ...(msat !== undefined ? { msat } : {}) });
  // A buyer with 1 000 cSats bought, 250 spent; a host with 300.5 earned; the fee pool with 12 sats.
  tx("acct-buyer-secret", "earn", 1_000, "credit_purchase:i1");
  tx("acct-buyer-secret", "spend", 250, "task_reserve");
  tx("acct-host-secret", "earn", 300.5, "compute_contribution", 300_500);
  tx("network:fee_pool", "earn", 12, "network_fee:t1", 12_000);
  app = (await import("../../src/swarm/coordinator.js")).coordinatorServer;
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  delete process.env.RESERVES_RATE_LIMIT_PER_MIN;
  delete process.env.MOCK_LIGHTNING_BALANCE_SATS;
});

describe("GET /economy/reserves", () => {
  test("public: no mesh token needed; aggregates match the ledger and the node", async () => {
    const res = await app.inject({ method: "GET", url: "/economy/reserves", remoteAddress: "203.0.113.1" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    const r = res.json();
    expect(r.network).toBe("signet");
    expect(r.liabilities).toEqual({ available: true, accountBalancesSats: 1_051, feePoolSats: 12, heldForJobsSats: 0, totalSats: 1_063 });
    expect(r.reserves).toEqual({ available: true, channelLocalSats: 50_000, onchainConfirmedSats: 0, totalSats: 50_000, pendingSats: 0 });
    expect(r.ratio).toBe(Math.floor((50_000 / 1_063) * 10_000) / 10_000);
    expect(r.anchor).toBeNull();
    expect(r.anchoring).toBe("disabled");
    expect(res.body).not.toContain("acct-");
  });

  test("rate limited per client IP; the portal's service token is not", async () => {
    const hit = (ip: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url: "/economy/reserves", remoteAddress: ip, headers });
    for (let i = 0; i < 3; i++) expect((await hit("198.51.100.7")).statusCode).toBe(200);
    const limited = await hit("198.51.100.7");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await hit("198.51.100.8")).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await hit("198.51.100.7", { "x-portal-service-token": PORTAL })).statusCode).toBe(200);
  });

  test("other /economy routes still need the mesh token", async () => {
    expect((await app.inject({ method: "GET", url: "/economy/price/current" })).statusCode).toBe(401);
  });
});
