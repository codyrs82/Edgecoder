import { describe, expect, test } from "vitest";
import { InMemoryNonceStore, verifyNonce } from "../../src/security/nonce-verifier.js";

describe("nonce-verifier", () => {
  test("accepts fresh nonce", async () => {
    const store = new InMemoryNonceStore();
    const result = await verifyNonce(store, {
      nonce: "unique-nonce-1",
      sourceId: "agent-123",
      timestampMs: Date.now(),
      maxSkewMs: 120_000,
    });
    expect(result.valid).toBe(true);
  });

  test("rejects duplicate nonce", async () => {
    const store = new InMemoryNonceStore();
    await verifyNonce(store, {
      nonce: "duplicate-nonce",
      sourceId: "agent-123",
      timestampMs: Date.now(),
      maxSkewMs: 120_000,
    });
    const result = await verifyNonce(store, {
      nonce: "duplicate-nonce",
      sourceId: "agent-123",
      timestampMs: Date.now(),
      maxSkewMs: 120_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("replay");
  });

  test("rejects timestamp outside skew window", async () => {
    const store = new InMemoryNonceStore();
    const result = await verifyNonce(store, {
      nonce: "nonce-old",
      sourceId: "agent-123",
      timestampMs: Date.now() - 300_000, // 5 minutes ago
      maxSkewMs: 120_000,                // 2 minute window
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("timestamp_skew");
  });

  test("rejects future timestamp outside skew window", async () => {
    const store = new InMemoryNonceStore();
    const result = await verifyNonce(store, {
      nonce: "nonce-future",
      sourceId: "agent-123",
      timestampMs: Date.now() + 300_000,
      maxSkewMs: 120_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("timestamp_skew");
  });

  test("prune removes expired entries", async () => {
    const store = new InMemoryNonceStore();
    // Insert with very short TTL (already expired)
    await store.insert("old-nonce", "agent-1", Date.now() - 10_000);
    await store.prune();
    // Should be pruned, so re-inserting same nonce succeeds
    const result = await verifyNonce(store, {
      nonce: "old-nonce",
      sourceId: "agent-1",
      timestampMs: Date.now(),
      maxSkewMs: 120_000,
    });
    expect(result.valid).toBe(true);
  });
});
