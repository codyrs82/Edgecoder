import { afterAll, beforeAll, describe, expect, test } from "vitest";

/*
 * Soft launch on the coordinator (src/economy/launch-gate.ts): in LAUNCH_MODE=invite every
 * purchase path (/account/buy: portal, hosted API, signed agents) is held to the per-account
 * caps, the payout caps get the launch cap layered under them, and the wallet sees the caps.
 */
const PORTAL = "portal-secret-launch";
let app: any;

beforeAll(async () => {
  process.env.PORTAL_SERVICE_TOKEN = PORTAL;
  process.env.LAUNCH_MODE = "invite";
  process.env.LAUNCH_MAX_BUY_SATS_PER_DAY = "3000";
  process.env.LAUNCH_MAX_BALANCE_SATS = "2500";
  process.env.LAUNCH_MAX_PAYOUT_SATS_PER_DAY = "700";
  process.env.PAYOUT_MAX_ACCOUNT_DAILY_SATS = "900";
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  for (const k of ["LAUNCH_MODE", "LAUNCH_MAX_BUY_SATS_PER_DAY", "LAUNCH_MAX_BALANCE_SATS", "LAUNCH_MAX_PAYOUT_SATS_PER_DAY", "PAYOUT_MAX_ACCOUNT_DAILY_SATS"]) delete process.env[k];
});

const buy = (accountId: string, amountSats: number) =>
  app.inject({ method: "POST", url: "/account/buy", headers: { "content-type": "application/json", "x-portal-service-token": PORTAL }, payload: { accountId, amountSats } });

describe("invite-mode caps on the coordinator", () => {
  test("open invoices count toward the balance cap, and the daily cap holds across invoices", async () => {
    expect((await buy("acct-launch-a", 1000)).statusCode).toBe(200);
    expect((await buy("acct-launch-a", 1000)).statusCode).toBe(200);
    // 2000 cSats pending; 1000 more would make 3000 > 2500.
    const over = await buy("acct-launch-a", 1000);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ error: "launch_balance_cap", limitSats: 2500, remainingSats: 500 });
    expect((await buy("acct-launch-a", 500)).statusCode).toBe(200);
    // 2500 bought today; the daily cap (3000) leaves 500, the balance cap none.
    expect((await buy("acct-launch-a", 600)).json()).toMatchObject({ error: "launch_buy_daily_cap", remainingSats: 500 });
  });

  test("another account has its own allowance", async () => {
    expect((await buy("acct-launch-b", 2000)).statusCode).toBe(200);
  });

  test("the wallet's payout view carries the caps, with the launch payout cap layered under the account cap", async () => {
    const res = await app.inject({ method: "GET", url: "/economy/payouts/acct-launch-a", headers: { "x-portal-service-token": PORTAL } });
    expect(res.statusCode).toBe(200);
    const policy = res.json().policy;
    expect(policy.limits.maxAccountDailySats).toBe(700);
    expect(policy.launch).toEqual({ mode: "invite", maxBuySatsPerDay: 3000, maxBalanceSats: 2500, maxPayoutSatsPerDay: 700, boughtWindowSats: 2500 });
  });
});
