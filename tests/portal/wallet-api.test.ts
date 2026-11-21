import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWalletApiRoutes, walletOverviewView } from "../../src/portal/routes/wallet-api.js";

const BOLT11_FAKE = "lnbcrt200u1pnz8kq0pp5qy7d3xw6r0mnt9vxk2c8a0l4ghs3e5u7wqzq3jf2ky6v8s0n9pxsdqqcqzzsxqyz5vqsp5h7e2d9k6c0w3m8xr5qv4n2t7l9s6f3a7g8j0p5q2z4y7x6c3";

/** A coordinator that answers like the real one for the routes the wallet calls. */
async function fakeCoordinator(opts: { payouts?: boolean } = {}) {
  const seen: Array<{ method: string; path: string; body: any; token: unknown }> = [];
  const co = Fastify();
  const note = (req: any) => seen.push({ method: req.method, path: req.url, body: req.body, token: req.headers["x-portal-service-token"] });
  co.post("/account/summary", async (req) => (note(req), { accountId: (req.body as any).accountId, cSats: 19700, earnedSats: 1234, recent: [{ type: "earn", cSats: 19700, reason: "credit_purchase:pi-1", atMs: 1 }] }));
  co.get("/inference/models", async (req) => (note(req), { models: [{ model: "qwen3.5:9b", agents: 2, classes: ["gpu"], cSatsPerMTokens: { input: 40, output: 100 } }], classes: { gpu: { label: "GPU", cSatsPerSecondBaseTier: 0.05 } } }));
  co.get("/economy/rates/current", async (req) => (note(req), { epoch: { btcUsd: 100000, createdAtMs: 5 }, stale: false }));
  co.get("/economy/market/book", async (req) => (note(req), { books: [], networkFeeBps: 500, purchaseFeeBps: 150 }));
  co.get("/economy/payouts/:accountId", async (req, reply) => {
    note(req);
    if (opts.payouts === false) return reply.code(503).send({ error: "nope" });
    return { accountId: (req.params as any).accountId, balance: { earnedMsat: 1_234_000, heldMsat: 234_000, maturesAtMs: 99, paidMsat: 0, pendingMsat: 0, payableMsat: 1_000_000, capacityMsat: 5e9 }, payouts: [], policy: { network: "regtest", minPayoutSats: 1000, maxFeeBps: 100, lightningEnabled: true, paused: false, limits: { maxSingleSats: 100000 } } };
  });
  co.post("/account/buy", async (req) => {
    note(req);
    const amountSats = (req.body as any).amountSats;
    const feeSats = Math.floor((amountSats * 150) / 10000);
    return { intentId: "pi-1", invoice: BOLT11_FAKE, amountSats, cSats: amountSats - feeSats, feeSats, network: "regtest", expiresInSeconds: 900 };
  });
  co.post("/account/intent", async (req, reply) => {
    note(req);
    if ((req.body as any).intentId !== "pi-1") return reply.code(404).send({ error: "unknown_intent" });
    return { intentId: "pi-1", status: "settled", cSats: 19700 };
  });
  const ADDR = "bcrt1pqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsxs0cuf";
  co.post("/account/onchain/address", async (req) => (note(req), { enabled: true, network: "regtest", address: ADDR, uri: `bitcoin:${ADDR.toUpperCase()}`, confirmationsRequired: 1, minSats: 10000, deposits: [] }));
  co.post("/account/onchain/deposits", async (req) => (note(req), { enabled: true, network: "regtest", address: ADDR, confirmationsRequired: 1, minSats: 10000, deposits: [{ txid: "aa".repeat(32), vout: 0, amountSats: 50000, confirmations: 0, requiredConfirmations: 1, status: "pending" }] }));
  await co.listen({ port: 0, host: "127.0.0.1" });
  const addr = co.server.address() as { port: number };
  return { co, seen, url: `http://127.0.0.1:${addr.port}` };
}

async function portal(coordUrl: string | null) {
  const app = Fastify();
  registerWalletApiRoutes(app, {
    store: {} as never,
    getCurrentUser: async (req: { headers: Record<string, unknown> }) => (req.headers.cookie === "session" ? ({ userId: "u1" } as never) : null),
    PORTAL_SERVICE_TOKEN: "svc",
    discoverCoordinatorUrlsForPortal: async () => (coordUrl ? [coordUrl] : []),
    fallbackNetwork: "signet",
  });
  return app;
}

describe("portal wallet API", () => {
  let coord: Awaited<ReturnType<typeof fakeCoordinator>>;
  let app: FastifyInstance;
  const auth = { cookie: "session" };
  beforeAll(async () => {
    coord = await fakeCoordinator();
    app = await portal(coord.url);
  });
  afterAll(async () => {
    await app.close();
    await coord.co.close();
  });

  it("needs a signed-in user", async () => {
    for (const [method, url] of [["GET", "/portal/api/wallet/overview"], ["POST", "/portal/api/wallet/topup"], ["GET", "/portal/api/wallet/topup/pi-1"]] as const) {
      expect((await app.inject({ method, url, payload: method === "POST" ? { amountSats: 20000 } : undefined })).statusCode, url).toBe(401);
    }
  });

  it("gathers balance, network, rate, fees, prices and payouts for the session's account", async () => {
    const r = await app.inject({ url: "/portal/api/wallet/overview", headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      connected: true,
      network: "regtest",
      networkSource: "coordinator",
      accountId: "acct-u1",
      cSats: 19700,
      earnedSats: 1234,
      btcUsd: 100000,
      fees: { purchaseFeeBps: 150, networkFeeBps: 500 },
      topup: { minSats: 100, maxSats: 1_000_000 },
      models: [{ model: "qwen3.5:9b", cSatsPerMTokens: { input: 40, output: 100 } }],
      payouts: { balance: { heldMsat: 234_000, maturesAtMs: 99, payableMsat: 1_000_000 }, policy: { paused: false, network: "regtest" } },
    });
    expect(coord.seen.find((s) => s.path === "/economy/payouts/acct-u1")).toMatchObject({ method: "GET", token: "svc" });
    expect(coord.seen.find((s) => s.path === "/account/summary")).toMatchObject({ body: { accountId: "acct-u1" } });
  });

  it("creates a top-up invoice through /account/buy for the session's account and passes the coordinator's pricing through", async () => {
    const r = await app.inject({ method: "POST", url: "/portal/api/wallet/topup", headers: auth, payload: { amountSats: 20000, accountId: "acct-someone-else" } });
    expect(r.statusCode).toBe(200);
    const { qrSvg, ...rest } = r.json();
    expect(rest).toEqual({ intentId: "pi-1", invoice: BOLT11_FAKE, amountSats: 20000, cSats: 19700, feeSats: 300, network: "regtest", expiresInSeconds: 900 });
    // The invoice's QR code, drawn by the portal from the BOLT11 string.
    expect(qrSvg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    const call = coord.seen.filter((s) => s.path === "/account/buy").at(-1);
    expect(call).toMatchObject({ body: { amountSats: 20000, accountId: "acct-u1" }, token: "svc" });
  });

  it("refuses amounts outside 100 to 1,000,000 whole sats", async () => {
    for (const amountSats of [99, 1_000_001, 10.5, "20000"]) {
      const r = await app.inject({ method: "POST", url: "/portal/api/wallet/topup", headers: auth, payload: { amountSats } });
      expect(r.statusCode, String(amountSats)).toBe(400);
    }
  });

  it("reports whether a top-up was paid, and relays unknown intents", async () => {
    expect((await app.inject({ url: "/portal/api/wallet/topup/pi-1", headers: auth })).json()).toEqual({ intentId: "pi-1", status: "settled", cSats: 19700 });
    expect((await app.inject({ url: "/portal/api/wallet/topup/pi-2", headers: auth })).statusCode).toBe(404);
    expect(coord.seen.filter((s) => s.path === "/account/intent").at(-1)).toMatchObject({ body: { intentId: "pi-2", accountId: "acct-u1" } });
  });

  it("without a coordinator: not connected, the portal's network, and a 503 for top-ups", async () => {
    const offline = await portal(null);
    const r = (await offline.inject({ url: "/portal/api/wallet/overview", headers: auth })).json();
    expect(r).toMatchObject({ connected: false, network: "signet", networkSource: "portal", cSats: null, btcUsd: null, payouts: null, fees: { purchaseFeeBps: null, networkFeeBps: null } });
    expect((await offline.inject({ method: "POST", url: "/portal/api/wallet/topup", headers: auth, payload: { amountSats: 20000 } })).statusCode).toBe(503);
    await offline.close();
  });
});

describe("Fund with Bitcoin", () => {
  it("gets the session account's deposit address with a bitcoin: QR, and lists its deposits", async () => {
    const coord = await fakeCoordinator();
    const app = await portal(coord.url);
    expect((await app.inject({ method: "POST", url: "/portal/api/wallet/onchain/address" })).statusCode).toBe(401);
    const r = await app.inject({ method: "POST", url: "/portal/api/wallet/onchain/address", headers: { cookie: "session" }, payload: { accountId: "acct-other" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ enabled: true, address: expect.stringMatching(/^bcrt1p/), confirmationsRequired: 1 });
    expect(r.json().qrSvg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(coord.seen.find((s) => s.path === "/account/onchain/address")).toMatchObject({ body: { accountId: "acct-u1" }, token: "svc" });
    const d = await app.inject({ url: "/portal/api/wallet/onchain", headers: { cookie: "session" } });
    expect(d.json().deposits).toEqual([expect.objectContaining({ amountSats: 50000, confirmations: 0, status: "pending" })]);
    await app.close();
    await coord.co.close();
  });

  it("shares the top-up rate limit (an address can come from the node)", async () => {
    const { rateLimitFor, TOPUP_RATE_LIMIT } = await import("../../src/portal/security.js");
    expect(rateLimitFor("/portal/api/wallet/onchain/address", "POST")).toEqual(TOPUP_RATE_LIMIT);
  });
});

describe("walletOverviewView", () => {
  it("never reports a network the coordinator did not state as coming from it", () => {
    const v = walletOverviewView({ fallbackNetwork: "bitcoin", overview: { connected: true, account: { cSats: 1 } }, rates: null, book: null, payouts: { policy: {} } });
    expect(v).toMatchObject({ network: "bitcoin", networkSource: "portal", connected: true, btcUsd: null });
  });

  it("keeps `launch` as null for shipped clients that still decode it (the soft-launch caps are gone)", () => {
    const launch = { mode: "invite", maxBuySatsPerDay: 50000, maxBalanceSats: 200000, maxPayoutSatsPerDay: 50000, boughtWindowSats: 1200 };
    const v = walletOverviewView({ fallbackNetwork: "bitcoin", overview: null, rates: null, book: null, payouts: { policy: { launch } } });
    expect(v).toHaveProperty("launch", null);
    expect(walletOverviewView({ fallbackNetwork: "bitcoin", overview: null, rates: null, book: null, payouts: null })).toHaveProperty("launch", null);
  });
});

describe("wallet top-up rate limit", () => {
  it("the session top-up carries the same limit as the API top-up (each one creates a Lightning invoice)", async () => {
    const { rateLimitFor, TOPUP_RATE_LIMIT } = await import("../../src/portal/security.js");
    expect(rateLimitFor("/portal/api/wallet/topup", "POST")).toEqual(TOPUP_RATE_LIMIT);
    expect(rateLimitFor("/v1/account/topup", "POST")).toEqual(TOPUP_RATE_LIMIT);
    expect(rateLimitFor("/portal/api/wallet/topup/abc", "GET")).toBeUndefined();
  });
});

describe("wallet page: purchase limits", () => {
  it("ships the shared limit and error helpers to the browser, and uses them for presets, the custom range and refusals", async () => {
    const { WALLET_PRICE_LIB, WALLET_SCRIPT, WALLET_CONTENT } = await import("../../src/portal/pages/wallet.js");
    const lib = new Function(`${WALLET_PRICE_LIB}; return { buyLimit, buyRangeLabel, buyLimitText, buyErrorText, buyAmountFits };`)();
    const l = lib.buyLimit({ globalMin: 100, globalMax: 1000000 });
    expect(l.maxSats).toBe(1000000);
    expect(lib.buyRangeLabel(l)).toBe("100 to 1M");
    expect(lib.buyAmountFits(5000000, l)).toBe(false);
    expect(lib.buyLimitText(5000000, l)).toBe("The most you can buy at once is 1,000,000 sats.");
    expect(lib.buyErrorText("payments_disabled")).toBe("Buying cSats is turned off on this coordinator.");
    expect(WALLET_SCRIPT).not.toContain("launch");
    // Presets over the limit are disabled with a tooltip; the custom label and input follow the limit.
    expect(WALLET_SCRIPT).toContain("b.disabled = off");
    expect(WALLET_SCRIPT).toContain('$("customRange").textContent = range');
    expect(WALLET_SCRIPT).toContain("buyErrorText(");
    expect(WALLET_SCRIPT).not.toContain("Could not start the payment (");
    expect(WALLET_CONTENT).toContain('id="overLimit"');
  });
});
