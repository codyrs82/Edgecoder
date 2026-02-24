import { describe, expect, test } from "vitest";
import { encryptKeyBundle, decryptKeyBundle, generateKeyBundle } from "../../src/security/key-storage.js";

describe("key-storage", () => {
  const passphrase = "test-passphrase-for-unit-tests";

  test("generateKeyBundle creates valid ed25519 bundle with expiry", () => {
    const bundle = generateKeyBundle(90);
    expect(bundle.currentKey.privateKeyPem).toContain("PRIVATE KEY");
    expect(bundle.currentKey.publicKeyPem).toContain("PUBLIC KEY");
    expect(bundle.currentKey.activatedAt).toBeLessThanOrEqual(Date.now());
    expect(bundle.currentKey.expiresAt).toBeGreaterThan(Date.now());
    expect(bundle.keyId).toBeTruthy();
    expect(bundle.previousKey).toBeNull();
  });

  test("encrypt then decrypt round-trips key bundle", () => {
    const bundle = generateKeyBundle(90);
    const encrypted = encryptKeyBundle(bundle, passphrase);
    expect(encrypted.ciphertext).toBeTruthy();
    expect(encrypted.salt).toBeTruthy();
    expect(encrypted.nonce).toBeTruthy();
    expect(encrypted.tag).toBeTruthy();

    const decrypted = decryptKeyBundle(encrypted, passphrase);
    expect(decrypted.currentKey.privateKeyPem).toBe(bundle.currentKey.privateKeyPem);
    expect(decrypted.currentKey.publicKeyPem).toBe(bundle.currentKey.publicKeyPem);
    expect(decrypted.keyId).toBe(bundle.keyId);
  });

  test("decrypt with wrong passphrase throws", () => {
    const bundle = generateKeyBundle(90);
    const encrypted = encryptKeyBundle(bundle, passphrase);
    expect(() => decryptKeyBundle(encrypted, "wrong-passphrase")).toThrow();
  });

  test("bundle with previousKey preserves both keys", () => {
    const bundle = generateKeyBundle(90);
    bundle.previousKey = {
      privateKeyPem: bundle.currentKey.privateKeyPem,
      publicKeyPem: bundle.currentKey.publicKeyPem,
      activatedAt: bundle.currentKey.activatedAt - 86400000 * 90,
      deactivatedAt: bundle.currentKey.activatedAt,
    };
    const encrypted = encryptKeyBundle(bundle, passphrase);
    const decrypted = decryptKeyBundle(encrypted, passphrase);
    expect(decrypted.previousKey).not.toBeNull();
    expect(decrypted.previousKey!.deactivatedAt).toBe(bundle.currentKey.activatedAt);
  });
});
