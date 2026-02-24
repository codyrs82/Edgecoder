import { describe, expect, test } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  signRequest,
  verifySignedRequest,
} from "../../src/security/request-signing.js";

function makeKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}

describe("request-signing", () => {
  test("signRequest produces required headers", () => {
    const keys = makeKeys();
    const headers = signRequest({
      method: "POST",
      path: "/heartbeat",
      bodyHash: "abc123hash",
      privateKeyPem: keys.privateKeyPem,
      agentId: "agent-1",
    });

    expect(headers["x-agent-id"]).toBe("agent-1");
    expect(headers["x-timestamp-ms"]).toBeTruthy();
    expect(headers["x-nonce"]).toBeTruthy();
    expect(headers["x-body-sha256"]).toBe("abc123hash");
    expect(headers["x-signature"]).toBeTruthy();
  });

  test("verifySignedRequest accepts valid signature", () => {
    const keys = makeKeys();
    const headers = signRequest({
      method: "POST",
      path: "/heartbeat",
      bodyHash: "bodyhash",
      privateKeyPem: keys.privateKeyPem,
      agentId: "agent-1",
    });

    const result = verifySignedRequest({
      method: "POST",
      path: "/heartbeat",
      headers,
      publicKeyPem: keys.publicKeyPem,
      maxSkewMs: 120_000,
    });
    expect(result.valid).toBe(true);
    expect(result.agentId).toBe("agent-1");
  });

  test("verifySignedRequest rejects tampered path", () => {
    const keys = makeKeys();
    const headers = signRequest({
      method: "POST",
      path: "/heartbeat",
      bodyHash: "bodyhash",
      privateKeyPem: keys.privateKeyPem,
      agentId: "agent-1",
    });

    const result = verifySignedRequest({
      method: "POST",
      path: "/submit",  // tampered
      headers,
      publicKeyPem: keys.publicKeyPem,
      maxSkewMs: 120_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  test("verifySignedRequest rejects expired timestamp", () => {
    const keys = makeKeys();
    const headers = signRequest({
      method: "POST",
      path: "/heartbeat",
      bodyHash: "hash",
      privateKeyPem: keys.privateKeyPem,
      agentId: "agent-1",
    });
    // Forge old timestamp (signature won't match anyway, but skew is checked first)
    headers["x-timestamp-ms"] = String(Date.now() - 300_000);

    const result = verifySignedRequest({
      method: "POST",
      path: "/heartbeat",
      headers,
      publicKeyPem: keys.publicKeyPem,
      maxSkewMs: 120_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("timestamp_skew");
  });
});
