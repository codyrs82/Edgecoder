import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { taprootAddressFor } from "../../src/economy/onchain.js";

/*
 * Coordinator on-chain routes with ONCHAIN_ENABLED and the mock wallet (in-memory stores):
 * deposit address, deposits credited after confirmations, the on-chain payout address and the
 * policy the wallets read, and the operator routes.
 */
const PORTAL = "portal-token-onchain";
const ADMIN = "admin-token-onchain";
let app: any;
let oc: typeof import("../../src/swarm/coordinator/onchain.js");
const portal = { "x-portal-service-token": PORTAL, "content-type": "application/json" };

beforeAll(async () => {
  process.env.ONCHAIN_ENABLED = "1";
  process.env.ONCHAIN_DEPOSIT_CONFIRMATIONS = "2";
  process.env.ONCHAIN_DEPOSIT_MIN_SATS = "1000";
  process.env.ONCHAIN_DEPOSIT_MAX_SATS = "30000";
  process.env.PORTAL_SERVICE_TOKEN = PORTAL;
  process.env.ADMIN_API_TOKEN = ADMIN;
  process.env.MESH_AUTH_TOKEN = "mesh-onchain";
  process.env.BITCOIN_NETWORK = "regtest";
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  oc = await import("../../src/swarm/coordinator/onchain.js");
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  for (const k of ["ONCHAIN_ENABLED", "ONCHAIN_DEPOSIT_CONFIRMATIONS", "ONCHAIN_DEPOSIT_MIN_SATS", "ONCHAIN_DEPOSIT_MAX_SATS"]) delete process.env[k];
});

const post = (url: string, payload: unknown, headers: Record<string, string> = portal) => app.inject({ method: "POST", url, headers, payload: JSON.stringify(payload) });

describe("Fund with Bitcoin", () => {
  test("needs a caller: an unsigned request without the portal token is refused", async () => {
    const r = await app.inject({ method: "POST", url: "/account/onchain/address", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  test("gives a deposit address, shows the deposit while it confirms, and credits it once", async () => {
    expect(oc.ONCHAIN_ENABLED).toBe(true);
    const r = await post("/account/onchain/address", { accountId: "acct-chain" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ enabled: true, network: "regtest", confirmationsRequired: 2, minSats: 1000, deposits: [] });
    expect(body.address).toMatch(/^bcrt1p/);
    expect(body.uri).toBe(`bitcoin:${body.address.toUpperCase()}`);
    // Asking again before anything arrives: same address.
    expect((await post("/account/onchain/address", { accountId: "acct-chain" })).json().address).toBe(body.address);

    const wallet = oc.onchainMockWallet!;
    const txid = wallet.receive(body.address, 25_000, 0);
    await oc.depositWatcher!.tick();
    let d = (await post("/account/onchain/deposits", { accountId: "acct-chain" })).json();
    expect(d.deposits).toEqual([expect.objectContaining({ txid, amountSats: 25_000, confirmations: 0, requiredConfirmations: 2, status: "pending" })]);
    wallet.mine(2);
    await oc.depositWatcher!.tick();
    await oc.depositWatcher!.tick();
    d = (await post("/account/onchain/deposits", { accountId: "acct-chain" })).json();
    expect(d.deposits[0]).toMatchObject({ status: "credited", confirmations: 2 });
    const summary = (await post("/account/summary", { accountId: "acct-chain" })).json();
    expect(summary.cSats).toBe(25_000);
    // The used address is retired from display: the next request gives a fresh one.
    const next = (await post("/account/onchain/address", { accountId: "acct-chain" })).json().address;
    expect(next).not.toBe(body.address);

    // Over the per-deposit cap (ONCHAIN_DEPOSIT_MAX_SATS): held for an operator, not credited.
    const over = wallet.receive(next, 40_000, 2);
    await oc.depositWatcher!.tick();
    d = (await post("/account/onchain/deposits", { accountId: "acct-chain" })).json();
    expect(d.deposits.find((x: { txid: string }) => x.txid === over)).toMatchObject({ status: "held", detail: expect.stringMatching(/per-deposit cap/) });
    expect((await post("/account/summary", { accountId: "acct-chain" })).json().cSats).toBe(25_000);
  });
});

describe("routing-fee earnings in the account summary", () => {
  test("a routing_fee:<task> earn row is listed, totalled apart, and counted in the earnings", async () => {
    const { creditEngine } = await import("../../src/credits/store.js");
    creditEngine.record({ txId: "rf-1", accountId: "acct-operator-rf", type: "earn", credits: 2.4, reason: "routing_fee:task-rf", relatedTaskId: "task-rf", timestampMs: Date.now(), msat: 2_400 });
    const summary = (await post("/account/summary", { accountId: "acct-operator-rf" })).json();
    expect(summary).toMatchObject({ earnedSats: 2, routingFeeSats: 2.4, cSats: 2.4 });
    expect(summary.recent).toEqual([expect.objectContaining({ type: "earn", cSats: 2.4, reason: "routing_fee:task-rf", taskId: "task-rf" })]);
  });
});

describe("on-chain payout destination", () => {
  test("validates the address for the network, stores it and replaces a Lightning address", async () => {
    const good = taprootAddressFor("regtest", new Uint8Array(32).fill(9));
    expect((await post("/economy/payouts/address", { accountId: "acct-pay", lightningAddress: "alice@getalby.com" })).statusCode).toBe(200);
    const bad = await post("/economy/payouts/onchain-address", { accountId: "acct-pay", address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("address_network_mismatch");
    const r = await post("/economy/payouts/onchain-address", { accountId: "acct-pay", address: good });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ address: good, policy: { enabled: true, payoutFeePayer: "host" } });
    const view = (await app.inject({ method: "GET", url: "/economy/payouts/acct-pay", headers: { "x-portal-service-token": PORTAL } })).json();
    expect(view.onchainDestination).toMatchObject({ address: good });
    expect(view.policy.onchain).toMatchObject({ enabled: true, depositConfirmations: 2 });
    // A Lightning address set afterwards replaces it.
    await post("/economy/payouts/address", { accountId: "acct-pay", lightningAddress: "alice@getalby.com" });
    expect((await app.inject({ method: "GET", url: "/economy/payouts/acct-pay", headers: { "x-portal-service-token": PORTAL } })).json().onchainDestination).toBeNull();
  });

  test("needs the portal service token", async () => {
    const r = await post("/economy/payouts/onchain-address", { accountId: "acct-pay", address: null }, { "content-type": "application/json" });
    expect(r.statusCode).toBe(401);
  });
});

describe("operator routes", () => {
  test("need the admin token and show batches and totals", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/onchain" })).statusCode).toBe(401);
    const r = await app.inject({ method: "GET", url: "/admin/onchain", headers: { "x-admin-token": ADMIN } });
    expect(r.statusCode).toBe(200);
    // The over-cap deposit held above is waiting for review.
    expect(r.json()).toMatchObject({ enabled: true, batches: [], heldDeposits: [expect.objectContaining({ accountId: "acct-chain", amountSats: 40_000, status: "held" })] });
    const bad = await app.inject({ method: "POST", url: "/admin/onchain/deposits/nothex/0/credit", headers: { "x-admin-token": ADMIN } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: `/admin/onchain/deposits/${"ab".repeat(32)}/0/credit`, headers: { "x-admin-token": ADMIN } });
    expect(missing.statusCode).toBe(404);
  });
});
