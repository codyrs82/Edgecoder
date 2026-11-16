import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { paymentFlags, tallyLimitsFromEnv } from "../../../src/economy/direct/flags.js";
import { openSecret, sealSecret, secretBoxKey } from "../../../src/economy/direct/secret-box.js";
import { ReceiptSigner, verifyReceipt } from "../../../src/economy/direct/receipts.js";

describe("payment path flags", () => {
  it("prepaid stays on and NWC off by default; nothing live changes without env", () => {
    expect(paymentFlags({ NODE_ENV: "production" })).toEqual({ prepaid: true, directReservations: false, nwc: false });
    expect(paymentFlags({})).toEqual({ prepaid: true, directReservations: false, nwc: false });
  });
  it("direct reservations default on under tests; each path can be set", () => {
    expect(paymentFlags({ NODE_ENV: "test" })).toEqual({ prepaid: true, directReservations: true, nwc: false });
    expect(paymentFlags({ PAYMENTS_DIRECT_RESERVATIONS: "1", PAYMENTS_NWC: "on", PAYMENTS_PREPAID: "0" })).toEqual({ prepaid: false, directReservations: true, nwc: true });
    expect(paymentFlags({ NODE_ENV: "test", PAYMENTS_DIRECT_RESERVATIONS: "off" }).directReservations).toBe(false);
  });
  it("tally limits default to 200 / 500 sats, hourly, 3 failures", () => {
    expect(tallyLimitsFromEnv({})).toEqual({ settleMinSats: 200, maxUnsettledSats: 500, settleIntervalMs: 3_600_000, maxFailures: 3 });
    expect(tallyLimitsFromEnv({ SETTLE_MIN_SATS: "50", MAX_UNSETTLED_SATS: "x" })).toMatchObject({ settleMinSats: 50, maxUnsettledSats: 500 });
  });
});

describe("secret box (NWC strings at rest)", () => {
  const key = randomBytes(32);
  const nwc = `nostr+walletconnect://${"a".repeat(64)}?relay=wss://r&secret=${"b".repeat(64)}`;
  it("round-trips and the sealed form doesn't contain the secret", () => {
    const sealed = sealSecret(nwc, key, "nwc:acct-1");
    expect(sealed).not.toContain("b".repeat(16));
    expect(openSecret(sealed, key, "nwc:acct-1")).toBe(nwc);
  });
  it("can't be opened for another account or with another key", () => {
    const sealed = sealSecret(nwc, key, "nwc:acct-1");
    expect(() => openSecret(sealed, key, "nwc:acct-2")).toThrow();
    expect(() => openSecret(sealed, randomBytes(32), "nwc:acct-1")).toThrow();
  });
  it("needs a 32-byte key", () => {
    expect(() => secretBoxKey("")).toThrow(/NONCUSTODIAL_SECRET_KEY/);
    expect(secretBoxKey("00".repeat(32))).toHaveLength(32);
  });
});

describe("receipts", () => {
  it("detects tampering", () => {
    const s = ReceiptSigner.generate();
    const r = s.sign({ id: "x", rail: "onchain", purpose: "reservation", buyerAccountId: "b", payeeKind: "host", payeeAccountId: "h", destination: "tb1q", amountMsat: 1000, txid: "a".repeat(64), vout: 0, settledAtMs: 1 });
    expect(verifyReceipt(r)).toEqual({ ok: true });
    expect(verifyReceipt({ ...r, amountMsat: 2000 })).toEqual({ ok: false, reason: "bad_signature" });
  });
});
