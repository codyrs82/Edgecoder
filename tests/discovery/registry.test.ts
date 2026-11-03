import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REGISTRY_PUBLIC_KEYS,
  loadRegistrySigningKey,
  parseRegistryPublicKey,
  registryPublicKeysFromEnv,
  signRegistry,
  verifySignedRegistry,
  type RegistryPayload
} from "../../src/discovery/registry.js";
import { publicKeyFingerprint } from "../../src/security/key-fingerprint.js";

/** A throwaway registry key per test run (the repo never holds a real one). */
function registryKey() {
  const kp = generateKeyPairSync("ed25519");
  const privatePem = kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return loadRegistrySigningKey(privatePem);
}

const NOW = 1_800_000_000_000;

function payload(over: Partial<RegistryPayload> = {}): RegistryPayload {
  return {
    v: 1,
    network: "edgecoder",
    issuedAtMs: NOW,
    expiresAtMs: NOW + 15 * 60_000,
    coordinators: [
      {
        peerId: "coord-aaa",
        publicKeyFingerprint: "a".repeat(64),
        urls: ["https://coord-a.example"],
        region: "ord",
        operator: { id: "edgecoder", name: "EdgeCoder", kind: "edgecoder" },
        admission: { verifiedOperator: true, publishedKey: true, stakeSats: 0 },
        admittedAtMs: NOW - 1000,
        health: { status: "healthy", checkedAtMs: NOW - 100, latencyMs: 12 }
      }
    ],
    fallbackUrls: ["https://coordinator.edgecoder.io"],
    ...over
  };
}

describe("signed coordinator registry", () => {
  it("ships no built-in registry key until the operator publishes one", () => {
    expect(DEFAULT_REGISTRY_PUBLIC_KEYS).toEqual([]);
  });

  it("verifies a registry signed with the pinned key", () => {
    const key = registryKey();
    const doc = signRegistry(payload(), key);
    const r = verifySignedRegistry(doc, { publicKeys: [key.publicKeyPem], now: () => NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.registry.coordinators[0].peerId).toBe("coord-aaa");
      expect(r.keyId).toBe(publicKeyFingerprint(key.publicKeyPem));
    }
  });

  it("survives a JSON round trip (the payload is signed as exact bytes)", () => {
    const key = registryKey();
    const doc = JSON.parse(JSON.stringify(signRegistry(payload(), key)));
    expect(verifySignedRegistry(doc, { publicKeys: [key.publicKeyPem], now: () => NOW }).ok).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const key = registryKey();
    const doc = signRegistry(payload(), key);
    const tampered = { ...doc, payload: doc.payload.replace("https://coord-a.example", "https://evil.example") };
    expect(verifySignedRegistry(tampered, { publicKeys: [key.publicKeyPem], now: () => NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered signature", () => {
    const key = registryKey();
    const doc = signRegistry(payload(), key);
    const sig = Buffer.from(doc.signature, "base64");
    sig[0] ^= 0xff;
    expect(verifySignedRegistry({ ...doc, signature: sig.toString("base64") }, { publicKeys: [key.publicKeyPem], now: () => NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a registry signed by another key, even one claiming the pinned keyId", () => {
    const pinned = registryKey();
    const attacker = registryKey();
    const own = signRegistry(payload(), attacker);
    expect(verifySignedRegistry(own, { publicKeys: [pinned.publicKeyPem], now: () => NOW })).toEqual({ ok: false, reason: "unknown_key" });
    const spoofed = { ...own, keyId: pinned.keyId };
    expect(verifySignedRegistry(spoofed, { publicKeys: [pinned.publicKeyPem], now: () => NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("accepts any of several pinned keys (rotation)", () => {
    const oldKey = registryKey();
    const newKey = registryKey();
    const doc = signRegistry(payload(), newKey);
    expect(verifySignedRegistry(doc, { publicKeys: [oldKey.publicKeyPem, newKey.publicKeyPem], now: () => NOW }).ok).toBe(true);
  });

  it("rejects an expired registry and one issued in the future", () => {
    const key = registryKey();
    const doc = signRegistry(payload({ issuedAtMs: NOW - 60 * 60_000, expiresAtMs: NOW - 10 * 60_000 }), key);
    expect(verifySignedRegistry(doc, { publicKeys: [key.publicKeyPem], now: () => NOW })).toEqual({ ok: false, reason: "expired" });
    // within the skew allowance it is still fine
    expect(verifySignedRegistry(doc, { publicKeys: [key.publicKeyPem], now: () => NOW - 8 * 60_000 }).ok).toBe(true);
    const future = signRegistry(payload({ issuedAtMs: NOW + 60 * 60_000, expiresAtMs: NOW + 75 * 60_000 }), key);
    expect(verifySignedRegistry(future, { publicKeys: [key.publicKeyPem], now: () => NOW })).toEqual({ ok: false, reason: "future" });
  });

  it("rejects unsigned, malformed and badly shaped documents, and everything when no key is pinned", () => {
    const key = registryKey();
    const opts = { publicKeys: [key.publicKeyPem], now: () => NOW };
    expect(verifySignedRegistry(payload(), opts)).toEqual({ ok: false, reason: "malformed" });
    expect(verifySignedRegistry(null, opts)).toEqual({ ok: false, reason: "malformed" });
    expect(verifySignedRegistry({ format: "edgecoder-registry/1", keyId: key.keyId, payload: JSON.stringify(payload()) }, opts)).toEqual({ ok: false, reason: "malformed" });
    const bad = signRegistry({ ...payload(), coordinators: [{ peerId: "x" }] } as unknown as RegistryPayload, key);
    expect(verifySignedRegistry(bad, opts)).toEqual({ ok: false, reason: "invalid_payload" });
    expect(verifySignedRegistry(signRegistry(payload(), key), { publicKeys: [], now: () => NOW })).toEqual({ ok: false, reason: "no_pinned_key" });
  });

  it("parses pinned keys as PEM, escaped PEM or raw hex, and refuses non-Ed25519 keys", () => {
    const key = registryKey();
    expect(parseRegistryPublicKey(key.publicKeyPem)).toBe(key.publicKeyPem);
    expect(parseRegistryPublicKey(key.publicKeyPem.replace(/\n/g, "\\n"))).toBe(key.publicKeyPem);
    const der = Buffer.from(key.publicKeyPem.replace(/-----[^-]+-----|\s/g, ""), "base64");
    expect(parseRegistryPublicKey(der.subarray(-32).toString("hex"))).toBe(key.publicKeyPem);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(parseRegistryPublicKey(rsa)).toBeNull();
    expect(parseRegistryPublicKey("nonsense")).toBeNull();
  });

  it("reads pinned keys from the environment and dedupes them", () => {
    const a = registryKey();
    const b = registryKey();
    const env = { EDGECODER_REGISTRY_PUBLIC_KEYS: `${a.publicKeyPem.replace(/\n/g, "\\n")};${b.publicKeyPem};garbage` };
    expect(registryPublicKeysFromEnv(env, [a.publicKeyPem])).toEqual([a.publicKeyPem, b.publicKeyPem]);
    expect(registryPublicKeysFromEnv({}, [])).toEqual([]);
  });

  it("refuses a non-Ed25519 signing key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => loadRegistrySigningKey(rsa)).toThrow(/Ed25519/);
  });
});
