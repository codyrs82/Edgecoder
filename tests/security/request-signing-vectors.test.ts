import { afterEach, describe, expect, test } from "vitest";
import { vi } from "vitest";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, signRequest, verifySignedRequest } from "../../src/security/request-signing.js";
import { InMemoryNonceStore, verifyNonce } from "../../src/security/nonce-verifier.js";

// #64: these vectors are shared with the iOS app
// (ios/EdgeCoderIOS/EdgeCoderIOSTests/RequestSigningVectorsTests.swift). They pin the canonical
// string, the hex/base64 encodings and the Ed25519 key derivation so a Swift signer that reproduces
// them is accepted by the coordinator's verifier. Regenerate only when the scheme changes, and then
// update both test suites.

interface Vector {
  name: string;
  privateKeySeedHex: string;
  publicKeyHex: string;
  publicKeyPem: string;
  agentId: string;
  method: string;
  path: string;
  timestampMs: string;
  nonce: string;
  body: string;
  expected: { canonicalString: string; bodySha256: string; signatureBase64: string };
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/request-signing-vectors.json", import.meta.url)), "utf8")
) as { headers: Record<string, string>; vectors: Vector[] };

// PKCS#8 DER prefix for an Ed25519 private key (RFC 8410): the 32-byte seed follows it.
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";

function keysFromSeed(seedHex: string) {
  const privateKey = createPrivateKey({
    key: Buffer.from(PKCS8_ED25519_PREFIX + seedHex, "hex"),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    publicKeyRawHex: (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex"),
  };
}

const MAX_SKEW_MS = 120_000;

describe("request-signing cross-platform vectors (#64)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("fixture declares the header names the coordinator reads", () => {
    expect(fixture.headers).toEqual({
      agentId: "x-agent-id",
      timestampMs: "x-timestamp-ms",
      nonce: "x-nonce",
      bodySha256: "x-body-sha256",
      signature: "x-signature",
    });
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(3);
  });

  for (const vector of fixture.vectors) {
    describe(vector.name, () => {
      test("seed derives the published public key (raw + SPKI PEM)", () => {
        const keys = keysFromSeed(vector.privateKeySeedHex);
        expect(keys.publicKeyRawHex).toBe(vector.publicKeyHex);
        expect(keys.publicKeyPem).toBe(vector.publicKeyPem);
      });

      test("TS signer reproduces body hash, canonical string and signature", () => {
        const keys = keysFromSeed(vector.privateKeySeedHex);
        const bodyHash = createHash("sha256").update(Buffer.from(vector.body, "utf8")).digest("hex");
        expect(bodyHash).toBe(vector.expected.bodySha256);
        expect(canonicalize(vector.timestampMs, vector.nonce, vector.method, vector.path, bodyHash)).toBe(
          vector.expected.canonicalString
        );
        const headers = signRequest({
          method: vector.method,
          path: vector.path,
          bodyHash,
          privateKeyPem: keys.privateKeyPem,
          agentId: vector.agentId,
          timestampMs: vector.timestampMs,
          nonce: vector.nonce,
        });
        expect(headers).toEqual({
          "x-agent-id": vector.agentId,
          "x-timestamp-ms": vector.timestampMs,
          "x-nonce": vector.nonce,
          "x-body-sha256": vector.expected.bodySha256,
          "x-signature": vector.expected.signatureBase64,
        });
        // Ed25519 is deterministic, so signing the canonical string directly must agree too.
        const direct = sign(null, Buffer.from(vector.expected.canonicalString, "utf8"), keys.privateKeyPem);
        expect(direct.toString("base64")).toBe(vector.expected.signatureBase64);
      });

      test("verifier accepts the vector headers with the registered public key", async () => {
        vi.useFakeTimers({ now: Number(vector.timestampMs) + 1_000 });
        const headers = {
          "x-agent-id": vector.agentId,
          "x-timestamp-ms": vector.timestampMs,
          "x-nonce": vector.nonce,
          "x-body-sha256": vector.expected.bodySha256,
          "x-signature": vector.expected.signatureBase64,
        };
        const result = verifySignedRequest({
          method: vector.method,
          path: vector.path,
          headers,
          publicKeyPem: vector.publicKeyPem,
          maxSkewMs: MAX_SKEW_MS,
        });
        expect(result).toEqual({ valid: true, agentId: vector.agentId, nonce: vector.nonce });

        const store = new InMemoryNonceStore();
        const first = await verifyNonce(store, {
          nonce: vector.nonce,
          sourceId: vector.agentId,
          timestampMs: Number(vector.timestampMs),
          maxSkewMs: MAX_SKEW_MS,
        });
        expect(first).toEqual({ valid: true });
      });

      test("tampered body changes the hash and fails verification", () => {
        vi.useFakeTimers({ now: Number(vector.timestampMs) + 1_000 });
        const tamperedBody = vector.body.replace(vector.agentId, "someone-else");
        expect(tamperedBody).not.toBe(vector.body);
        const tamperedHash = createHash("sha256").update(Buffer.from(tamperedBody, "utf8")).digest("hex");
        expect(tamperedHash).not.toBe(vector.expected.bodySha256);
        // The coordinator recomputes sha256(rawBody) and compares it with x-body-sha256 before the
        // nonce check; a header set re-used on another body is therefore caught either there or here.
        const result = verifySignedRequest({
          method: vector.method,
          path: vector.path,
          headers: {
            "x-agent-id": vector.agentId,
            "x-timestamp-ms": vector.timestampMs,
            "x-nonce": vector.nonce,
            "x-body-sha256": tamperedHash,
            "x-signature": vector.expected.signatureBase64,
          },
          publicKeyPem: vector.publicKeyPem,
          maxSkewMs: MAX_SKEW_MS,
        });
        expect(result).toEqual({ valid: false, reason: "invalid_signature" });
      });

      test("reused nonce is rejected as a replay", async () => {
        vi.useFakeTimers({ now: Number(vector.timestampMs) + 1_000 });
        const store = new InMemoryNonceStore();
        const params = {
          nonce: vector.nonce,
          sourceId: vector.agentId,
          timestampMs: Number(vector.timestampMs),
          maxSkewMs: MAX_SKEW_MS,
        };
        expect(await verifyNonce(store, params)).toEqual({ valid: true });
        expect(await verifyNonce(store, params)).toEqual({ valid: false, reason: "replay" });
      });

      test("signature from a different key is rejected", () => {
        vi.useFakeTimers({ now: Number(vector.timestampMs) + 1_000 });
        const other = fixture.vectors.find((v) => v.name !== vector.name)!;
        const result = verifySignedRequest({
          method: vector.method,
          path: vector.path,
          headers: {
            "x-agent-id": vector.agentId,
            "x-timestamp-ms": vector.timestampMs,
            "x-nonce": vector.nonce,
            "x-body-sha256": vector.expected.bodySha256,
            "x-signature": vector.expected.signatureBase64,
          },
          publicKeyPem: other.publicKeyPem,
          maxSkewMs: MAX_SKEW_MS,
        });
        expect(result).toEqual({ valid: false, reason: "invalid_signature" });
      });
    });
  }
});
