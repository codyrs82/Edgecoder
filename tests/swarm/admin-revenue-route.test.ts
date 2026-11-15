import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { encodeTestBolt11 } from "../economy/helpers/bolt11-encode.js";

/*
 * EdgeCoder's revenue (real coordinator app, in-memory ledger, mock Lightning): GET /admin/revenue
 * reports the network fee pool, POST /admin/revenue/withdraw pays from it through PayoutService,
 * so the pause switch and the payable check apply. Both need the admin token.
 */

const ADMIN = "admin-secret-revenue";
const MESH = "mesh-secret-revenue";
let app: any;
let creditEngine: typeof import("../../src/credits/store.js").creditEngine;
let memoryPayoutStore: NonNullable<typeof import("../../src/swarm/coordinator/payouts.js").memoryPayoutStore>;

beforeAll(async () => {
  Object.assign(process.env, { ADMIN_API_TOKEN: ADMIN, MESH_AUTH_TOKEN: MESH, BITCOIN_NETWORK: "signet", LIGHTNING_PROVIDER: "mock" });
  delete process.env.DATABASE_URL;
  delete process.env.ECONOMY_PAYMENTS_ENABLED;
  ({ creditEngine } = await import("../../src/credits/store.js"));
  const payouts = await import("../../src/swarm/coordinator/payouts.js");
  memoryPayoutStore = payouts.memoryPayoutStore!;
  app = (await import("../../src/swarm/coordinator.js")).coordinatorServer;
  await app.ready();
  // Sats bought on this coordinator back what it can pay out (payout capacity).
  memoryPayoutStore.received = 1_000_000_000;
  // Fee income: two compute payments' network fees today (5 000 + 1 000 sats).
  for (const sats of [5_000, 1_000]) {
    creditEngine.record({ txId: randomUUID(), accountId: "network:fee_pool", type: "earn", credits: sats, reason: `network_fee:task-${sats}`, relatedTaskId: `task-${sats}`, timestampMs: Date.now(), msat: sats * 1000 });
  }
}, 60_000);

afterAll(async () => {
  await app?.close();
  delete process.env.ADMIN_API_TOKEN;
});

function invoice(amountSats: number) {
  const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
  return encodeTestBolt11({ network: "tbs", amountMsat: amountSats * 1000, paymentHashHex: hash });
}
const admin = (method: "GET" | "POST", url: string, body?: unknown, token: string | null = ADMIN) =>
  app.inject({ method, url, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...(token ? { "x-admin-token": token } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });

describe("EdgeCoder revenue (admin)", () => {
  test("both routes need the admin token; the mesh token is not enough", async () => {
    expect((await admin("GET", "/admin/revenue", undefined, null)).statusCode).toBe(401);
    expect((await admin("GET", "/admin/revenue", undefined, "wrong-token")).statusCode).toBe(401);
    expect((await admin("POST", "/admin/revenue/withdraw", { bolt11: invoice(1_000) }, null)).statusCode).toBe(401);
  });

  test("the report shows the fee pool: income, payable, 30 days by day", async () => {
    const res = await admin("GET", "/admin/revenue");
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ accountId: "network:fee_pool", feeBps: 500, hostDistribution: false, feeIncome: { totalMsat: 6_000_000, payments: 2 }, payoutsPaused: false, payouts: [] });
    expect(r.balance).toMatchObject({ earnedMsat: 6_000_000, heldMsat: 0, payableMsat: 6_000_000, paidMsat: 0 });
    expect(r.byDay).toHaveLength(30);
    expect(r.byDay.at(-1)).toEqual({ date: new Date().toISOString().slice(0, 10), msat: 6_000_000, payments: 2 });
    expect(r.byDay.slice(0, 29).every((d: { msat: number }) => d.msat === 0)).toBe(true);
  });

  test("a withdrawal pays from the pool through PayoutService and is reported", async () => {
    const res = await admin("POST", "/admin/revenue/withdraw", { bolt11: invoice(2_000), actor: "owner" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, payout: { accountId: "network:fee_pool", amountMsat: 2_000_000, status: "paid", kind: "withdraw" } });
    const r = (await admin("GET", "/admin/revenue")).json();
    expect(r.balance.paidMsat).toBe(2_000_000);
    expect(r.balance.payableMsat).toBe(4_000_000);
    expect(r.payouts).toHaveLength(1);
    // Income is what was earned; it does not go down with a withdrawal.
    expect(r.feeIncome.totalMsat).toBe(6_000_000);
  });

  test("more than is payable is refused; so is anything while payouts are paused", async () => {
    const over = await admin("POST", "/admin/revenue/withdraw", { bolt11: invoice(4_500) });
    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({ ok: false, code: "insufficient_payable" });

    expect((await admin("POST", "/admin/payouts/pause", { paused: true, reason: "test" })).statusCode).toBe(200);
    const paused = await admin("POST", "/admin/revenue/withdraw", { bolt11: invoice(1_000) });
    expect(paused.statusCode).toBe(503);
    expect(paused.json()).toMatchObject({ ok: false, code: "payouts_paused" });
    expect((await admin("GET", "/admin/revenue")).json()).toMatchObject({ payoutsPaused: true, balance: { paidMsat: 2_000_000 } });
    expect((await admin("POST", "/admin/payouts/pause", { paused: false, reason: "test done" })).statusCode).toBe(200);
  });

  test("a malformed body is 400", async () => {
    expect((await admin("POST", "/admin/revenue/withdraw", { bolt11: "x" })).statusCode).toBe(400);
  });
});
