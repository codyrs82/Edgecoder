import Fastify, { type FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerPayoutRoutes, WITHDRAW_CODES_PER_HOUR, type WithdrawStepUpDeps, type WithdrawStore } from "../../src/portal/routes/payouts.js";
import { rateLimitFor, registerPortalSecurity, WALLET_RATE_LIMIT } from "../../src/portal/security.js";
import type { WithdrawChallenge } from "../../src/portal/store.js";
import { encodeTestBolt11 } from "../economy/helpers/bolt11-encode.js";

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
const secureCompare = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// A fixed timestamp, so the same arguments always give the same invoice string (the code is bound to it).
const INVOICE_TS = Math.floor(Date.now() / 1000);
const invoice = (amountMsat: number | undefined, hashByte = "ab") =>
  encodeTestBolt11({ network: "bcrt", amountMsat, paymentHashHex: hashByte.repeat(32), timestamp: INVOICE_TS, expirySeconds: 3600 });

type Row = WithdrawChallenge & { consumed?: boolean; createdAtMs: number; approvedAtMs?: number; released?: boolean };
function memoryWithdrawStore() {
  const rows = new Map<string, Row>();
  const withdrawn = (userId: string, sinceMs: number) =>
    [...rows.values()].filter((r) => r.userId === userId && r.approvedAtMs && r.approvedAtMs > sinceMs && !r.released).reduce((n, r) => n + r.amountMsat, 0);
  const store: WithdrawStore = {
    async createWithdrawChallenge(i) {
      rows.set(i.challengeId, { ...i, createdAtMs: Date.now() });
    },
    async countWithdrawChallengesSince(userId, sinceMs) {
      return [...rows.values()].filter((r) => r.userId === userId && r.createdAtMs > sinceMs).length;
    },
    async consumeWithdrawChallenge(id) {
      const r = rows.get(id);
      if (!r || r.consumed || r.expiresAtMs <= Date.now()) return null;
      r.consumed = true;
      return r;
    },
    async withdrawnMsatSince(userId, sinceMs) {
      return withdrawn(userId, sinceMs);
    },
    async approveWithdrawChallenge({ challengeId, userId, capMsat, sinceMs }) {
      const r = rows.get(challengeId);
      if (!r || r.userId !== userId || r.approvedAtMs) return false;
      if (capMsat > 0 && withdrawn(userId, sinceMs) + r.amountMsat > capMsat) return false;
      r.approvedAtMs = Date.now();
      return true;
    },
    async releaseWithdrawChallenge(id) {
      const r = rows.get(id);
      if (r) r.released = true;
    }
  };
  return { store, rows };
}

/** The portal's /wallet/payouts routes proxy the coordinator for the user's own account with the service token. */
describe("portal payout routes", () => {
  const seen: Array<{ method: string; url: string; token: unknown; body: any }> = [];
  const coordinator = Fastify();
  let base = "";
  let portal: FastifyInstance;
  let user: { userId: string; email: string } | null;
  let mem: ReturnType<typeof memoryWithdrawStore>;
  const sent: Array<{ email: string; code: string; amountSats: number }> = [];
  let coordinatorStatus = 200;

  beforeAll(async () => {
    coordinator.get("/economy/payouts/:accountId", async (req) => {
      seen.push({ method: "GET", url: req.url, token: req.headers["x-portal-service-token"], body: undefined });
      return { accountId: (req.params as { accountId: string }).accountId, balance: { earnedMsat: 5000, paidMsat: 0, pendingMsat: 0, payableMsat: 5000, capacityMsat: 1e9 }, payouts: [], policy: { minPayoutSats: 1000 } };
    });
    coordinator.post("/economy/payouts/withdraw", async (req, reply) => {
      seen.push({ method: "POST", url: req.url, token: req.headers["x-portal-service-token"], body: req.body });
      if (coordinatorStatus !== 200) return reply.code(coordinatorStatus).send({ ok: false, code: "below_minimum" });
      return { ok: true, payout: { amountMsat: 2_000_000, status: "paid" } };
    });
    await coordinator.listen({ port: 0, host: "127.0.0.1" });
    const addr = coordinator.server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    await coordinator.close();
  });

  const build = async (overrides: Partial<WithdrawStepUpDeps> = {}, withSecurity = false) => {
    const app = Fastify();
    if (withSecurity) await registerPortalSecurity(app, { publicOrigin: "http://localhost", trustedOrigins: [] });
    let code = 100000;
    registerPayoutRoutes(
      app,
      {
        EXTERNAL_HTTP_TIMEOUT_MS: 3000,
        PORTAL_SERVICE_TOKEN: "svc-token",
        discoverCoordinatorUrlsForPortal: async () => [base + "/"],
        getCurrentUser: async () => user as any
      },
      {
        store: mem.store,
        emailConfigured: true,
        codeTtlMs: 600_000,
        dailyCapSats: 5_000,
        sendCode: async (i) => {
          sent.push(i);
        },
        generateSixDigitCode: () => String(code++),
        sha256Hex,
        secureCompare,
        ...overrides
      }
    );
    await app.ready();
    return app;
  };

  beforeEach(async () => {
    seen.length = 0;
    sent.length = 0;
    coordinatorStatus = 200;
    user = { userId: "u1", email: "u@example.test" };
    mem = memoryWithdrawStore();
    portal = await build();
  });

  const withdraw = (payload: Record<string, unknown>, app = portal) => app.inject({ method: "POST", url: "/wallet/payouts/withdraw", payload });
  const coordinatorWithdrawals = () => seen.filter((s) => s.url === "/economy/payouts/withdraw");

  it("maps the user to acct-<userId> and forwards the service token", async () => {
    const r = await portal.inject({ method: "GET", url: "/wallet/payouts" });
    expect(r.statusCode).toBe(200);
    expect(r.json().accountId).toBe("acct-u1");
    expect(seen[0]).toMatchObject({ url: "/economy/payouts/acct-u1", token: "svc-token" });
    // The address for automatic payouts moved to PUT /wallet/payout-destination (email code on change).
    expect((await portal.inject({ method: "POST", url: "/wallet/payouts/address", payload: { lightningAddress: "cody@example.com" } })).statusCode).toBe(404);
  });

  it("does not pay without a code: it emails one bound to the invoice amount", async () => {
    const bolt11 = invoice(2_000_000);
    const r = await withdraw({ bolt11 });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ verificationRequired: true, amountMsat: 2_000_000 });
    expect(sent).toEqual([{ email: "u@example.test", code: "100000", amountSats: 2000 }]);
    expect(coordinatorWithdrawals()).toHaveLength(0);
    // An emailCode without a challengeId is the same as no code.
    expect((await withdraw({ bolt11, emailCode: "100000" })).statusCode).toBe(202);
    expect(coordinatorWithdrawals()).toHaveLength(0);
  });

  it("pays once with the right code for the same invoice", async () => {
    const bolt11 = invoice(2_000_000);
    const { challengeId } = (await withdraw({ bolt11 })).json();
    const ok = await withdraw({ bolt11, challengeId, emailCode: "100000" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true });
    expect(coordinatorWithdrawals()).toHaveLength(1);
    expect(coordinatorWithdrawals()[0]).toMatchObject({ token: "svc-token", body: { accountId: "acct-u1", bolt11 } });
    // Single use.
    const again = await withdraw({ bolt11, challengeId, emailCode: "100000" });
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe("withdraw_challenge_invalid");
    expect(coordinatorWithdrawals()).toHaveLength(1);
  });

  it("refuses a wrong code, and the challenge is used up by it", async () => {
    const bolt11 = invoice(2_000_000);
    const { challengeId } = (await withdraw({ bolt11 })).json();
    const bad = await withdraw({ bolt11, challengeId, emailCode: "999999" });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe("withdraw_code_invalid");
    expect((await withdraw({ bolt11, challengeId, emailCode: "100000" })).statusCode).toBe(400);
    expect(coordinatorWithdrawals()).toHaveLength(0);
  });

  it("refuses a code issued for a different invoice or a different user", async () => {
    const { challengeId } = (await withdraw({ bolt11: invoice(1_000_000, "ab") })).json();
    const swapped = await withdraw({ bolt11: invoice(1_000_000, "cd"), challengeId, emailCode: "100000" });
    expect(swapped.statusCode).toBe(400);
    expect(swapped.json().code).toBe("withdraw_challenge_invalid");

    const { challengeId: other } = (await withdraw({ bolt11: invoice(1_000_000) })).json();
    user = { userId: "u2", email: "x@example.test" };
    expect((await withdraw({ bolt11: invoice(1_000_000), challengeId: other, emailCode: "100001" })).statusCode).toBe(400);
    expect(coordinatorWithdrawals()).toHaveLength(0);
  });

  it("refuses amountless and malformed invoices, and needs a session and email", async () => {
    expect((await withdraw({ bolt11: invoice(undefined) })).json().code).toBe("amountless_invoice");
    expect((await withdraw({ bolt11: "lnbc10u1p0000000000000000000000000000" })).json().code).toBe("invalid_invoice");
    const noMail = await build({ emailConfigured: false });
    expect((await withdraw({ bolt11: invoice(1_000_000) }, noMail)).statusCode).toBe(503);
    user = null;
    expect((await withdraw({ bolt11: invoice(1_000_000) })).statusCode).toBe(401);
    expect((await portal.inject({ method: "GET", url: "/wallet/payouts" })).statusCode).toBe(401);
    expect(coordinatorWithdrawals()).toHaveLength(0);
  });

  it("enforces the per-account daily cap; refused payouts do not count", async () => {
    // Cap is 5,000 sats. Over the cap up front: no code is sent.
    expect((await withdraw({ bolt11: invoice(6_000_000) })).statusCode).toBe(429);
    expect(sent).toHaveLength(0);

    // A payout the coordinator refuses is released.
    coordinatorStatus = 400;
    let c = (await withdraw({ bolt11: invoice(4_000_000, "01") })).json();
    expect((await withdraw({ bolt11: invoice(4_000_000, "01"), challengeId: c.challengeId, emailCode: sent.at(-1)!.code })).statusCode).toBe(400);

    coordinatorStatus = 200;
    c = (await withdraw({ bolt11: invoice(4_000_000, "02") })).json();
    expect((await withdraw({ bolt11: invoice(4_000_000, "02"), challengeId: c.challengeId, emailCode: sent.at(-1)!.code })).statusCode).toBe(200);

    // 4,000 paid today; another 2,000 would pass 5,000.
    expect((await withdraw({ bolt11: invoice(2_000_000, "03") })).json().code).toBe("withdraw_daily_cap");
    // Two codes issued while under the cap: only the first confirmation fits.
    mem = memoryWithdrawStore();
    portal = await build();
    const a = (await withdraw({ bolt11: invoice(3_000_000, "04") })).json();
    const codeA = sent.at(-1)!.code;
    const b = (await withdraw({ bolt11: invoice(3_000_000, "05") })).json();
    const codeB = sent.at(-1)!.code;
    expect((await withdraw({ bolt11: invoice(3_000_000, "04"), challengeId: a.challengeId, emailCode: codeA })).statusCode).toBe(200);
    expect((await withdraw({ bolt11: invoice(3_000_000, "05"), challengeId: b.challengeId, emailCode: codeB })).statusCode).toBe(429);
  });

  it("caps how many codes one account can request per hour", async () => {
    for (let i = 0; i < WITHDRAW_CODES_PER_HOUR; i++) expect((await withdraw({ bolt11: invoice(1_000) })).statusCode).toBe(202);
    const r = await withdraw({ bolt11: invoice(1_000) });
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe("withdraw_codes_rate_limited");
  });

  it("is rate limited per client like the wallet send routes", async () => {
    expect(rateLimitFor("/wallet/payouts/withdraw", "POST")).toEqual(WALLET_RATE_LIMIT);
    const limited = await build({}, true);
    const codes: number[] = [];
    for (let i = 0; i <= WALLET_RATE_LIMIT.max; i++) codes.push((await withdraw({ bolt11: invoice(1_000) }, limited)).statusCode);
    expect(codes.slice(0, WALLET_RATE_LIMIT.max).every((c) => c === 202)).toBe(true);
    expect(codes[WALLET_RATE_LIMIT.max]).toBe(429);
    await limited.close();
  });
});
