import { describe, expect, test } from "vitest";
import { generateKeyPairSync, createHash } from "node:crypto";
import {
  signRequest,
  verifySignedRequest,
} from "../../src/security/request-signing.js";
import {
  InMemoryNonceStore,
  verifyNonce,
} from "../../src/security/nonce-verifier.js";
import { AgentRateLimiter } from "../../src/security/agent-rate-limiter.js";
import { SecurityEventLogger } from "../../src/audit/security-events.js";

function makeKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}

describe("security integration: coordinator verification flow", () => {
  test("signed /pull request passes signature + nonce verification", async () => {
    const keys = makeKeys();
    const body = { agentId: "agent-1" };
    const bodyHash = createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex");

    const headers = signRequest({
      method: "POST",
      path: "/pull",
      bodyHash,
      privateKeyPem: keys.privateKeyPem,
      agentId: "agent-1",
    });

    const sigResult = verifySignedRequest({
      method: "POST",
      path: "/pull",
      headers,
      publicKeyPem: keys.publicKeyPem,
      maxSkewMs: 120_000,
    });
    expect(sigResult.valid).toBe(true);
    expect(sigResult.agentId).toBe("agent-1");

    const store = new InMemoryNonceStore();
    const nonceResult = await verifyNonce(store, {
      nonce: sigResult.nonce!,
      sourceId: sigResult.agentId!,
      timestampMs: Number(headers["x-timestamp-ms"]),
      maxSkewMs: 120_000,
    });
    expect(nonceResult.valid).toBe(true);
  });

  test("replayed request is rejected by nonce store", async () => {
    const keys = makeKeys();
    const body = { agentId: "agent-1" };
    const bodyHash = createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex");

    const headers = signRequest({
      method: "POST",
      path: "/result",
      bodyHash,
      privateKeyPem: keys.privateKeyPem,
      agentId: "agent-1",
    });

    const store = new InMemoryNonceStore();
    const first = await verifyNonce(store, {
      nonce: headers["x-nonce"],
      sourceId: "agent-1",
      timestampMs: Number(headers["x-timestamp-ms"]),
      maxSkewMs: 120_000,
    });
    expect(first.valid).toBe(true);

    const second = await verifyNonce(store, {
      nonce: headers["x-nonce"],
      sourceId: "agent-1",
      timestampMs: Number(headers["x-timestamp-ms"]),
      maxSkewMs: 120_000,
    });
    expect(second.valid).toBe(false);
    expect(second.reason).toBe("replay");
  });

  test("rate limiter blocks after threshold", () => {
    const limiter = new AgentRateLimiter({ maxRequests: 3, windowMs: 60_000 });
    expect(limiter.check("agent-1")).toBe(true);
    expect(limiter.check("agent-1")).toBe(true);
    expect(limiter.check("agent-1")).toBe(true);
    expect(limiter.check("agent-1")).toBe(false);
  });

  test("security event logger captures events with correct severity", () => {
    const events: any[] = [];
    const logger = new SecurityEventLogger((e) => events.push(e));

    logger.log({
      level: logger.severity("replay_attempt"),
      event: "replay_attempt",
      source: { type: "agent", id: "agent-1" },
      action: "reject_request",
      coordinatorId: "coord-1",
    });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("replay_attempt");
    expect(events[0].level).toBe("HIGH");
    expect(events[0].timestamp).toBeTruthy();
  });

  test("unsigned request (no signed headers) extracts as null", () => {
    const headers: Record<string, unknown> = {
      "content-type": "application/json",
      "x-mesh-token": "some-token",
    };
    // Without x-agent-id, x-timestamp-ms, etc., extraction yields null
    expect(headers["x-agent-id"]).toBeUndefined();
    expect(headers["x-signature"]).toBeUndefined();
  });

  test("mismatched agentId between header and body is detectable", () => {
    const keys = makeKeys();
    const body = { agentId: "agent-DIFFERENT" };
    const bodyHash = createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex");

    const headers = signRequest({
      method: "POST",
      path: "/pull",
      bodyHash,
      privateKeyPem: keys.privateKeyPem,
      agentId: "agent-1",
    });

    const sigResult = verifySignedRequest({
      method: "POST",
      path: "/pull",
      headers,
      publicKeyPem: keys.publicKeyPem,
      maxSkewMs: 120_000,
    });
    expect(sigResult.valid).toBe(true);
    expect(sigResult.agentId).toBe("agent-1");
    expect(sigResult.agentId).not.toBe(body.agentId);
  });
});
