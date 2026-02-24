import { describe, expect, test } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { signPayload, verifyPayload } from "../../src/mesh/peer.js";
import type { PaymentReceipt } from "../../src/common/types.js";
import { AgentRateLimiter } from "../../src/security/agent-rate-limiter.js";

describe("payment receipts", () => {
  test("settled intent produces a verifiable receipt", () => {
    const keys = generateKeyPairSync("ed25519");
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

    const receiptPayload = JSON.stringify({
      intentId: "intent-1",
      accountId: "acct-user",
      creditsMinted: 100,
      timestampMs: Date.now()
    });
    const signature = signPayload(receiptPayload, privateKeyPem);

    const receipt: PaymentReceipt = {
      intentId: "intent-1",
      accountId: "acct-user",
      creditsMinted: 100,
      coordinatorSignature: signature,
      timestampMs: Date.now()
    };

    expect(receipt.coordinatorSignature).toBeTruthy();
    expect(receipt.creditsMinted).toBe(100);
  });

  test("receipt signature matches coordinator public key", () => {
    const keys = generateKeyPairSync("ed25519");
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

    const receiptPayload = JSON.stringify({
      intentId: "intent-2",
      accountId: "acct-user",
      creditsMinted: 50,
      timestampMs: 1700000000000
    });
    const signature = signPayload(receiptPayload, privateKeyPem);
    expect(verifyPayload(receiptPayload, signature, publicKeyPem)).toBe(true);

    // Tampered payload should fail verification
    const tamperedPayload = JSON.stringify({
      intentId: "intent-2",
      accountId: "acct-user",
      creditsMinted: 999,
      timestampMs: 1700000000000
    });
    expect(verifyPayload(tamperedPayload, signature, publicKeyPem)).toBe(false);
  });

  test("receipt with different coordinator key fails verification", () => {
    const keys1 = generateKeyPairSync("ed25519");
    const keys2 = generateKeyPairSync("ed25519");
    const privateKeyPem1 = keys1.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem2 = keys2.publicKey.export({ type: "spki", format: "pem" }).toString();

    const payload = JSON.stringify({
      intentId: "intent-3",
      accountId: "acct-user",
      creditsMinted: 25,
      timestampMs: Date.now()
    });
    const signature = signPayload(payload, privateKeyPem1);
    // Verify against wrong key
    expect(verifyPayload(payload, signature, publicKeyPem2)).toBe(false);
  });

  test("rate limiter blocks excessive intent creation", () => {
    const limiter = new AgentRateLimiter({ maxRequests: 5, windowMs: 15 * 60 * 1000 });
    const accountId = "acct-rate-test";

    for (let i = 0; i < 5; i++) {
      expect(limiter.check(accountId)).toBe(true);
    }
    // 6th attempt should be blocked
    expect(limiter.check(accountId)).toBe(false);
    expect(limiter.check(accountId)).toBe(false);

    // Different account should not be affected
    expect(limiter.check("acct-other")).toBe(true);
  });
});
