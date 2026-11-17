import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseSigningKey, publicKeyBase64, signPortalAction, type PortalAction } from "../../src/security/portal-action.js";
import { encodeTestBolt11 } from "../economy/helpers/bolt11-encode.js";

/*
 * The coordinator's money routes for a portal user, with REQUIRE_PORTAL_ACTION_SIGNATURE on: the
 * portal service token alone is refused; a portal assertion bound to the account, the action and
 * its parameters gets through, once.
 */

const PORTAL = "portal-service-secret-action";
const MESH = "mesh-secret-action";
const key = parseSigningKey(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString());
let app: any;
let auth: typeof import("../../src/swarm/coordinator/auth.js");

beforeAll(async () => {
  Object.assign(process.env, {
    PORTAL_SERVICE_TOKEN: PORTAL,
    MESH_AUTH_TOKEN: MESH,
    ADMIN_API_TOKEN: "admin-secret-action",
    PORTAL_ACTION_VERIFY_KEYS: publicKeyBase64(key),
    REQUIRE_PORTAL_ACTION_SIGNATURE: "true",
    BITCOIN_NETWORK: "signet",
    LIGHTNING_PROVIDER: "mock"
  });
  delete process.env.DATABASE_URL;
  app = (await import("../../src/swarm/coordinator.js")).coordinatorServer;
  auth = await import("../../src/swarm/coordinator/auth.js");
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  for (const k of ["PORTAL_ACTION_VERIFY_KEYS", "REQUIRE_PORTAL_ACTION_SIGNATURE", "PORTAL_SERVICE_TOKEN"]) delete process.env[k];
});

const invoice = (sats: number) => encodeTestBolt11({ network: "tbs", amountMsat: sats * 1000, paymentHashHex: createHash("sha256").update(randomBytes(32)).digest("hex") });
const sign = (accountId: string, action: PortalAction, body: Record<string, unknown>) => signPortalAction(key, { accountId, action, body });
const post = (url: string, body: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/json", "x-portal-service-token": PORTAL, ...extra }, payload: JSON.stringify(body) });

describe("withdraw and payout destination need a portal assertion", () => {
  test("the service token alone is refused", async () => {
    const res = await post("/economy/payouts/withdraw", { accountId: "acct-alice", bolt11: invoice(1_000) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("portal_action_signature_required");
    expect((await post("/economy/payouts/address", { accountId: "acct-alice", lightningAddress: "alice@wallet.example" })).statusCode).toBe(401);
    expect((await post("/economy/payouts/onchain-address", { accountId: "acct-alice", address: null })).statusCode).toBe(401);
    expect((await post("/economy/payouts/callback/confirm", { accountId: "acct-alice", destination: "alice@wallet.example", newOrigin: "https://pay.example" })).statusCode).toBe(401);
  });

  test("without the service token an assertion alone is not enough either", async () => {
    const bolt11 = invoice(1_000);
    const res = await app.inject({ method: "POST", url: "/economy/payouts/withdraw", headers: { "content-type": "application/json", "x-portal-action": sign("acct-alice", "payout.withdraw", { bolt11 }) }, payload: JSON.stringify({ accountId: "acct-alice", bolt11 }) });
    expect(res.statusCode).toBe(401);
  });

  test("a valid assertion gets through to the payout service, once", async () => {
    const bolt11 = invoice(1_000);
    const header = { "x-portal-action": sign("acct-alice", "payout.withdraw", { bolt11 }) };
    const first = await post("/economy/payouts/withdraw", { accountId: "acct-alice", bolt11 }, header);
    // Past the gate: the payout service answers (alice has nothing to withdraw), not the assertion check.
    expect(first.statusCode).not.toBe(401);
    expect(String(first.json().error ?? "")).not.toMatch(/portal_action/);
    const replay = await post("/economy/payouts/withdraw", { accountId: "acct-alice", bolt11 }, header);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: "portal_action_invalid", reason: "replayed" });
  });

  test("another account or another invoice (amount) is refused", async () => {
    const bolt11 = invoice(1_000);
    const forAlice = { "x-portal-action": sign("acct-alice", "payout.withdraw", { bolt11 }) };
    expect((await post("/economy/payouts/withdraw", { accountId: "acct-mallory", bolt11 }, forAlice)).json()).toMatchObject({ reason: "wrong_account" });
    expect((await post("/economy/payouts/withdraw", { accountId: "acct-alice", bolt11: invoice(90_000) }, forAlice)).json()).toMatchObject({ reason: "wrong_parameters" });
  });

  test("a signed destination change is applied; a different destination under the same assertion is not", async () => {
    const body = { accountId: "acct-alice", lightningAddress: "alice@wallet.example" };
    const ok = await post("/economy/payouts/address", body, { "x-portal-action": sign("acct-alice", "payout.lightning_address", { lightningAddress: body.lightningAddress }) });
    expect(ok.statusCode, ok.body).toBe(200);
    const swapped = await post("/economy/payouts/address", { accountId: "acct-alice", lightningAddress: "mallory@evil.example" }, { "x-portal-action": sign("acct-alice", "payout.lightning_address", { lightningAddress: body.lightningAddress }) });
    expect(swapped.json()).toMatchObject({ reason: "wrong_parameters" });
  });
});

describe("transition window (REQUIRE_PORTAL_ACTION_SIGNATURE off)", () => {
  const reply = () => {
    const r: any = { statusCode: 200, body: undefined };
    r.code = (n: number) => ((r.statusCode = n), r);
    r.send = (b: unknown) => ((r.body = b), r);
    return r;
  };
  test("unsigned is accepted; a present but invalid assertion is still refused", async () => {
    const bolt11 = invoice(1_000);
    const expected = { accountId: "acct-alice", action: "payout.withdraw" as const, body: { bolt11 } };
    expect(await auth.requirePortalMoneyAction({ headers: {} }, reply(), expected, { require: false })).toBe(true);
    const r = reply();
    const bad = { headers: { "x-portal-action": sign("acct-bob", "payout.withdraw", { bolt11 }) } };
    expect(await auth.requirePortalMoneyAction(bad, r, expected, { require: false })).toBe(false);
    expect(r.statusCode).toBe(401);
    const r2 = reply();
    expect(await auth.requirePortalMoneyAction({ headers: {} }, r2, expected, { require: true })).toBe(false);
    expect(r2.body).toMatchObject({ error: "portal_action_signature_required" });
  });

  test("required but no verify keys configured: 503, never open", async () => {
    const r = reply();
    const bolt11 = invoice(1_000);
    const h = { headers: { "x-portal-action": sign("acct-alice", "payout.withdraw", { bolt11 }) } };
    expect(await auth.requirePortalMoneyAction(h, r, { accountId: "acct-alice", action: "payout.withdraw", body: { bolt11 } }, { require: true, keys: [] })).toBe(false);
    expect(r.statusCode).toBe(503);
  });
});
