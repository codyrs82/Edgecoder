import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerPayoutRoutes } from "../../src/portal/routes/payouts.js";

/** The portal's /wallet/payouts routes proxy the coordinator for the user's own account with the service token. */
describe("portal payout routes", () => {
  const seen: Array<{ method: string; url: string; token: unknown; body: unknown }> = [];
  const coordinator = Fastify();
  let base = "";
  const portal = Fastify();

  beforeAll(async () => {
    coordinator.get("/economy/payouts/:accountId", async (req) => {
      seen.push({ method: "GET", url: req.url, token: req.headers["x-portal-service-token"], body: undefined });
      return { accountId: (req.params as { accountId: string }).accountId, balance: { earnedMsat: 5000, paidMsat: 0, pendingMsat: 0, payableMsat: 5000, capacityMsat: 1e9 }, payouts: [], policy: { minPayoutSats: 1000 } };
    });
    coordinator.post("/economy/payouts/withdraw", async (req, reply) => {
      seen.push({ method: "POST", url: req.url, token: req.headers["x-portal-service-token"], body: req.body });
      return reply.code(400).send({ ok: false, code: "below_minimum" });
    });
    coordinator.post("/economy/payouts/address", async (req) => {
      seen.push({ method: "POST", url: req.url, token: req.headers["x-portal-service-token"], body: req.body });
      return { accountId: (req.body as { accountId: string }).accountId, lightningAddress: (req.body as { lightningAddress: string }).lightningAddress };
    });
    await coordinator.listen({ port: 0, host: "127.0.0.1" });
    const addr = coordinator.server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    let authed = true;
    registerPayoutRoutes(portal, {
      EXTERNAL_HTTP_TIMEOUT_MS: 3000,
      PORTAL_SERVICE_TOKEN: "svc-token",
      discoverCoordinatorUrlsForPortal: async () => [base + "/"],
      getCurrentUser: async () => (authed ? ({ userId: "u1", email: "u@example.test" } as any) : null)
    } as any);
    portal.post("/__logout", async () => { authed = false; return {}; });
    await portal.ready();
  });
  afterAll(async () => {
    await portal.close();
    await coordinator.close();
  });

  it("maps the user to acct-<userId>, forwards the service token and passes the coordinator's status through", async () => {
    const r = await portal.inject({ method: "GET", url: "/wallet/payouts" });
    expect(r.statusCode).toBe(200);
    expect(r.json().accountId).toBe("acct-u1");
    expect(seen[0]).toMatchObject({ url: "/economy/payouts/acct-u1", token: "svc-token" });

    const w = await portal.inject({ method: "POST", url: "/wallet/payouts/withdraw", payload: { bolt11: "lnbc10u1p0000000000000000000000000000" } });
    expect(w.statusCode).toBe(400);
    expect(w.json()).toMatchObject({ ok: false, code: "below_minimum" });
    expect(seen[1].body).toMatchObject({ accountId: "acct-u1", bolt11: "lnbc10u1p0000000000000000000000000000" });

    // The address for automatic payouts moved to PUT /wallet/payout-destination (email code on change).
    const a = await portal.inject({ method: "POST", url: "/wallet/payouts/address", payload: { lightningAddress: "cody@example.com" } });
    expect(a.statusCode).toBe(404);
  });

  it("requires a session", async () => {
    await portal.inject({ method: "POST", url: "/__logout" });
    expect((await portal.inject({ method: "GET", url: "/wallet/payouts" })).statusCode).toBe(401);
  });
});
