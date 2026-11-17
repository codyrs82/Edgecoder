import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { actionDigest, parseSigningKey, parseVerifyKeys, publicKeyBase64, signPortalAction, verifyPortalAction, MAX_ASSERTION_LIFETIME_MS } from "../../src/security/portal-action.js";
import { encodeTestBolt11 } from "../economy/helpers/bolt11-encode.js";

const { privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const key = parseSigningKey(pem);
const keys = parseVerifyKeys(publicKeyBase64(key));
const NOW = 1_800_000_000_000;
const invoice = (sats: number) => encodeTestBolt11({ network: "tbs", amountMsat: sats * 1000, paymentHashHex: "11".repeat(32) });

function nonceStore() {
  const seen = new Set<string>();
  return async (n: string) => (seen.has(n) ? false : (seen.add(n), true));
}
const expected = (body: Record<string, unknown>, accountId = "acct-alice") => ({ accountId, action: "payout.withdraw" as const, body });

describe("portal action assertions", () => {
  test("valid: signed for this account, action and invoice", async () => {
    const bolt11 = invoice(1_000);
    const h = signPortalAction(key, { accountId: "acct-alice", action: "payout.withdraw", body: { bolt11 }, nowMs: NOW });
    const r = await verifyPortalAction(h, expected({ bolt11: `  ${bolt11} ` }), { keys, nowMs: NOW + 1_000, nonceOnce: nonceStore() });
    expect(r.ok).toBe(true);
  });

  test("expired", async () => {
    const bolt11 = invoice(1_000);
    const h = signPortalAction(key, { accountId: "acct-alice", action: "payout.withdraw", body: { bolt11 }, nowMs: NOW, ttlMs: 30_000 });
    expect(await verifyPortalAction(h, expected({ bolt11 }), { keys, nowMs: NOW + 30_001, nonceOnce: nonceStore() })).toEqual({ ok: false, reason: "expired" });
  });

  test("replayed: a nonce works once", async () => {
    const bolt11 = invoice(1_000);
    const once = nonceStore();
    const h = signPortalAction(key, { accountId: "acct-alice", action: "payout.withdraw", body: { bolt11 }, nowMs: NOW });
    expect((await verifyPortalAction(h, expected({ bolt11 }), { keys, nowMs: NOW, nonceOnce: once })).ok).toBe(true);
    expect(await verifyPortalAction(h, expected({ bolt11 }), { keys, nowMs: NOW, nonceOnce: once })).toEqual({ ok: false, reason: "replayed" });
  });

  test("wrong account", async () => {
    const bolt11 = invoice(1_000);
    const h = signPortalAction(key, { accountId: "acct-alice", action: "payout.withdraw", body: { bolt11 }, nowMs: NOW });
    expect(await verifyPortalAction(h, expected({ bolt11 }, "acct-mallory"), { keys, nowMs: NOW, nonceOnce: nonceStore() })).toEqual({ ok: false, reason: "wrong_account" });
  });

  test("wrong amount: an assertion for one invoice does not cover a larger one", async () => {
    const h = signPortalAction(key, { accountId: "acct-alice", action: "payout.withdraw", body: { bolt11: invoice(1_000) }, nowMs: NOW });
    expect(await verifyPortalAction(h, expected({ bolt11: invoice(90_000) }), { keys, nowMs: NOW, nonceOnce: nonceStore() })).toEqual({ ok: false, reason: "wrong_parameters" });
  });

  test("wrong action and wrong destination", async () => {
    const h = signPortalAction(key, { accountId: "acct-alice", action: "payout.lightning_address", body: { lightningAddress: "alice@wallet.example" }, nowMs: NOW });
    expect((await verifyPortalAction(h, { accountId: "acct-alice", action: "payout.onchain_address", body: { address: "x" } }, { keys, nowMs: NOW, nonceOnce: nonceStore() })).ok).toBe(false);
    expect(await verifyPortalAction(h, { accountId: "acct-alice", action: "payout.lightning_address", body: { lightningAddress: "mallory@evil.example" } }, { keys, nowMs: NOW, nonceOnce: nonceStore() })).toEqual({ ok: false, reason: "wrong_parameters" });
  });

  test("a refused assertion does not burn its nonce", async () => {
    const bolt11 = invoice(1_000);
    const once = nonceStore();
    const h = signPortalAction(key, { accountId: "acct-alice", action: "payout.withdraw", body: { bolt11 }, nowMs: NOW });
    expect((await verifyPortalAction(h, expected({ bolt11 }, "acct-mallory"), { keys, nowMs: NOW, nonceOnce: once })).ok).toBe(false);
    expect((await verifyPortalAction(h, expected({ bolt11 }), { keys, nowMs: NOW, nonceOnce: once })).ok).toBe(true);
  });

  test("another key, a tampered payload, garbage and an over-long lifetime are refused", async () => {
    const bolt11 = invoice(1_000);
    const other = parseSigningKey(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    const forged = signPortalAction(other, { accountId: "acct-alice", action: "payout.withdraw", body: { bolt11 }, nowMs: NOW });
    expect(await verifyPortalAction(forged, expected({ bolt11 }), { keys, nowMs: NOW, nonceOnce: nonceStore() })).toEqual({ ok: false, reason: "bad_signature" });
    const good = signPortalAction(key, { accountId: "acct-alice", action: "payout.withdraw", body: { bolt11 }, nowMs: NOW });
    const [p, s] = good.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    const tampered = `${Buffer.from(JSON.stringify({ ...payload, accountId: "acct-mallory" })).toString("base64url")}.${s}`;
    expect(await verifyPortalAction(tampered, expected({ bolt11 }, "acct-mallory"), { keys, nowMs: NOW, nonceOnce: nonceStore() })).toEqual({ ok: false, reason: "bad_signature" });
    expect((await verifyPortalAction("not-an-assertion", expected({ bolt11 }), { keys, nowMs: NOW, nonceOnce: nonceStore() })).reason).toBe("malformed");
    const long = signPortalAction(key, { accountId: "acct-alice", action: "payout.withdraw", body: { bolt11 }, nowMs: NOW, ttlMs: 10 * MAX_ASSERTION_LIFETIME_MS });
    // The signer caps the lifetime itself.
    expect(JSON.parse(Buffer.from(long.split(".")[0], "base64url").toString()).exp - NOW).toBe(MAX_ASSERTION_LIFETIME_MS);
  });

  test("key formats: PEM, raw seed (base64 / hex) and raw public keys", () => {
    const seed = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
    expect(publicKeyBase64(parseSigningKey(seed.toString("base64")))).toBe(publicKeyBase64(key));
    expect(publicKeyBase64(parseSigningKey(seed.toString("hex")))).toBe(publicKeyBase64(key));
    const pubPem = (keys[0].export({ format: "pem", type: "spki" }) as string);
    expect(parseVerifyKeys(`${pubPem}\n${pubPem}`)).toHaveLength(2);
    expect(parseVerifyKeys(`${publicKeyBase64(key)}, ${publicKeyBase64(other())}`)).toHaveLength(2);
    expect(() => parseVerifyKeys("bm90LWEta2V5")).toThrow();
    expect(actionDigest("payout.withdraw", { bolt11: "a" })).not.toBe(actionDigest("payout.withdraw", { bolt11: "b" }));
  });
});

function other() {
  return parseSigningKey(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString());
}
