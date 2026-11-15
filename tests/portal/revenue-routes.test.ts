import Fastify, { type FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRevenueRoutes, revenueChallengeUser } from "../../src/portal/routes/revenue.js";
import type { WithdrawStore } from "../../src/portal/routes/payouts.js";
import type { WithdrawChallenge } from "../../src/portal/store.js";
import { encodeTestBolt11 } from "../economy/helpers/bolt11-encode.js";

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
const secureCompare = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const INVOICE_TS = Math.floor(Date.now() / 1000);
const invoice = (amountMsat: number | undefined) => encodeTestBolt11({ network: "bcrt", amountMsat, paymentHashHex: "cd".repeat(32), timestamp: INVOICE_TS, expirySeconds: 3600 });

function memoryStore() {
  const rows = new Map<string, WithdrawChallenge & { createdAtMs: number; consumed?: boolean }>();
  const calls: string[] = [];
  const store: WithdrawStore = {
    async createWithdrawChallenge(i) { calls.push("create"); rows.set(i.challengeId, { ...i, createdAtMs: Date.now() }); },
    async countWithdrawChallengesSince(userId, sinceMs) { calls.push("count"); return [...rows.values()].filter((r) => r.userId === userId && r.createdAtMs > sinceMs).length; },
    async consumeWithdrawChallenge(id) { calls.push("consume"); const r = rows.get(id); if (!r || r.consumed) return null; r.consumed = true; return r; },
    async withdrawnMsatSince() { calls.push("withdrawn"); return 0; },
    async approveWithdrawChallenge() { calls.push("approve"); return true; },
    async releaseWithdrawChallenge() { calls.push("release"); }
  };
  return { store, rows, calls };
}

/** Settings > Revenue's APIs: system admins only; the coordinator admin token stays server-side. */
describe("portal revenue routes", () => {
  const seen: Array<{ method: string; url: string; adminToken: unknown; body: any }> = [];
  const coordinator = Fastify();
  let base = "";
  let user: { userId: string; email: string; emailVerified: boolean } | null;
  let isAdmin = true;
  let mem: ReturnType<typeof memoryStore>;
  const sent: Array<{ email: string; code: string; amountSats: number }> = [];

  beforeAll(async () => {
    coordinator.get("/admin/revenue", async (req) => {
      seen.push({ method: "GET", url: req.url, adminToken: req.headers["x-admin-token"], body: undefined });
      return { accountId: "network:fee_pool", feeIncome: { totalMsat: 6_000_000, payments: 2 }, balance: { payableMsat: 6_000_000 } };
    });
    coordinator.post("/admin/revenue/withdraw", async (req) => {
      seen.push({ method: "POST", url: req.url, adminToken: req.headers["x-admin-token"], body: req.body });
      return { ok: true, payout: { accountId: "network:fee_pool", amountMsat: 2_000_000, status: "paid" } };
    });
    await coordinator.listen({ port: 0, host: "127.0.0.1" });
    const addr = coordinator.server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(async () => { await coordinator.close(); });

  const build = (token = "coord-admin-token"): FastifyInstance => {
    const app = Fastify();
    let code = 300000;
    registerRevenueRoutes(
      app,
      {
        coordinatorAdminToken: token,
        EXTERNAL_HTTP_TIMEOUT_MS: 3000,
        discoverCoordinatorUrlsForPortal: async () => [base + "/"],
        getCurrentUser: async () => user,
        buildAccessContext: async () => ({ isSystemAdmin: isAdmin })
      },
      { store: mem.store, emailConfigured: true, codeTtlMs: 600_000, sendCode: async (i) => { sent.push(i); }, generateSixDigitCode: () => String(code++), sha256Hex, secureCompare }
    );
    return app;
  };

  beforeEach(() => {
    seen.length = 0;
    sent.length = 0;
    mem = memoryStore();
    user = { userId: "u-root", email: "root@example.com", emailVerified: true };
    isAdmin = true;
  });

  it("refuses anyone who is not a system admin, before any coordinator call or store use", async () => {
    const app = build();
    user = null;
    expect((await app.inject({ method: "GET", url: "/portal/api/admin/revenue" })).statusCode).toBe(401);
    user = { userId: "u-user", email: "user@example.com", emailVerified: true };
    isAdmin = false;
    expect((await app.inject({ method: "GET", url: "/portal/api/admin/revenue" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/revenue/withdraw", payload: { bolt11: invoice(2_000_000) } })).statusCode).toBe(403);
    expect(seen).toEqual([]);
    expect(mem.calls).toEqual([]);
  });

  it("relays the coordinator's revenue report, sending the coordinator admin token server-side", async () => {
    const res = await build().inject({ method: "GET", url: "/portal/api/admin/revenue" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accountId: "network:fee_pool", feeIncome: { totalMsat: 6_000_000 } });
    expect(seen).toEqual([{ method: "GET", url: "/admin/revenue", adminToken: "coord-admin-token", body: undefined }]);
    expect(res.body).not.toContain("coord-admin-token");
  });

  it("without COORDINATOR_ADMIN_TOKEN the page is told it is not configured, and nothing is called", async () => {
    const res = await build("").inject({ method: "GET", url: "/portal/api/admin/revenue" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "coordinator_admin_token_not_configured" });
    expect(seen).toEqual([]);
  });

  it("a withdrawal needs the emailed code, bound to the invoice; then the coordinator pays from the fee pool", async () => {
    const app = build();
    const bolt11 = invoice(2_000_000);
    const first = await app.inject({ method: "POST", url: "/portal/api/admin/revenue/withdraw", payload: { bolt11 } });
    expect(first.statusCode).toBe(202);
    expect(sent).toEqual([{ email: "root@example.com", code: "300000", amountSats: 2_000 }]);
    expect(seen).toEqual([]);
    const { challengeId } = first.json();
    // The challenge is kept apart from the admin's own wallet withdrawals.
    expect(mem.rows.get(challengeId)?.userId).toBe(revenueChallengeUser("u-root"));

    // A different invoice with the right code is refused (and uses the challenge up).
    const other = await app.inject({ method: "POST", url: "/portal/api/admin/revenue/withdraw", payload: { bolt11: invoice(3_000_000), challengeId, emailCode: "300000" } });
    expect(other.statusCode).toBe(400);
    expect(seen).toEqual([]);

    const again = (await app.inject({ method: "POST", url: "/portal/api/admin/revenue/withdraw", payload: { bolt11 } })).json();
    const wrong = await app.inject({ method: "POST", url: "/portal/api/admin/revenue/withdraw", payload: { bolt11, challengeId: again.challengeId, emailCode: "999999" } });
    expect(wrong.statusCode).toBe(401);
    expect(seen).toEqual([]);

    const third = (await app.inject({ method: "POST", url: "/portal/api/admin/revenue/withdraw", payload: { bolt11 } })).json();
    const ok = await app.inject({ method: "POST", url: "/portal/api/admin/revenue/withdraw", payload: { bolt11, challengeId: third.challengeId, emailCode: sent.at(-1)!.code } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, payout: { accountId: "network:fee_pool" } });
    expect(seen).toEqual([{ method: "POST", url: "/admin/revenue/withdraw", adminToken: "coord-admin-token", body: { bolt11, actor: "root@example.com" } }]);
  });

  it("refuses an amountless invoice", async () => {
    const res = await build().inject({ method: "POST", url: "/portal/api/admin/revenue/withdraw", payload: { bolt11: invoice(undefined) } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "amountless_invoice" });
  });
});
