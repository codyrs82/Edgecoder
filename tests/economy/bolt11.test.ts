import { describe, expect, it } from "vitest";
import { bolt11IsExpired, decodeBolt11 } from "../../src/economy/bolt11.js";
import { encodeTestBolt11 } from "./helpers/bolt11-encode.js";

// Test vectors from BOLT 11 (lightning/bolts, 11-payment-encoding.md).
const V_NOAMOUNT =
  "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql";
const V_2500U =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";

describe("decodeBolt11 (BOLT 11 vectors)", () => {
  it("decodes an amountless mainnet invoice with payment hash and timestamp", () => {
    const d = decodeBolt11(V_NOAMOUNT);
    expect(d.network).toBe("bitcoin");
    expect(d.amountMsat).toBeUndefined();
    expect(d.paymentHash).toBe("0001020304050607080900010203040506070809000102030405060708090102");
    expect(d.timestamp).toBe(1496314658);
    expect(d.expirySeconds).toBe(3600);
    expect(d.description).toBe("Please consider supporting this project");
  });

  it("decodes amount multipliers and explicit expiry", () => {
    const d = decodeBolt11(V_2500U);
    expect(d.amountMsat).toBe(250_000_000); // 2500 µBTC = 250,000 sats
    expect(d.expirySeconds).toBe(60);
    expect(d.description).toBe("1 cup coffee");
  });

  it("round-trips synthetic invoices on every network and amount multiplier", () => {
    const hash = "ab".repeat(32);
    for (const [network, expected] of [["bc", "bitcoin"], ["tb", "testnet"], ["tbs", "signet"], ["bcrt", "regtest"]] as const) {
      const d = decodeBolt11(encodeTestBolt11({ network, amountMsat: 2_000_000_000, paymentHashHex: hash, timestamp: 1_700_000_000, expirySeconds: 600 }));
      expect(d.network).toBe(expected);
      expect(d.amountMsat).toBe(2_000_000_000);
      expect(d.paymentHash).toBe(hash);
      expect(d.timestamp).toBe(1_700_000_000);
      expect(d.expirySeconds).toBe(600);
    }
    expect(decodeBolt11(encodeTestBolt11({ amountMsat: 1_000, paymentHashHex: hash })).amountMsat).toBe(1_000);
    expect(decodeBolt11(encodeTestBolt11({ amountMsat: 1_234_000, paymentHashHex: hash })).amountMsat).toBe(1_234_000);
    expect(decodeBolt11(encodeTestBolt11({ amountMsat: 12_300, paymentHashHex: hash })).amountMsat).toBe(12_300);
    expect(decodeBolt11(encodeTestBolt11({ paymentHashHex: hash, description: "payout" })).amountMsat).toBeUndefined();
  });

  it("accepts upper-case and rejects mixed case, bad checksum, and bad hrp", () => {
    expect(decodeBolt11(V_2500U.toUpperCase()).amountMsat).toBe(250_000_000);
    expect(() => decodeBolt11(V_2500U.slice(0, 10) + V_2500U.slice(10).toUpperCase())).toThrow(/mixed_case/);
    expect(() => decodeBolt11(V_2500U.slice(0, -1) + (V_2500U.endsWith("h") ? "q" : "h"))).toThrow(/checksum/);
    expect(() => decodeBolt11("lnxx1" + V_2500U.slice(9))).toThrow();
  });

  it("expiry check uses timestamp + expiry with a safety margin", () => {
    const d = decodeBolt11(V_2500U);
    expect(bolt11IsExpired(d, (d.timestamp + 10) * 1000)).toBe(true); // 60 s expiry, 60 s margin
    expect(bolt11IsExpired(d, (d.timestamp - 10) * 1000, 0)).toBe(false);
    expect(bolt11IsExpired(d, (d.timestamp + 61) * 1000, 0)).toBe(true);
  });
});
