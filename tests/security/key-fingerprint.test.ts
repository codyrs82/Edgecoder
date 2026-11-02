import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fingerprintMatches, legacyPemFingerprints, publicKeyFingerprint, tryPublicKeyFingerprint } from "../../src/security/key-fingerprint.js";
import { isAllowlistedKey, parsePeerAllowlist, publicKeyFingerprint as meshFingerprint } from "../../src/mesh/peer-trust.js";
import { pinMatchesKey, publicKeyFingerprint as discoveryFingerprint } from "../../src/discovery/types.js";
import { PinnedKeyStore, fingerprint as trustFingerprint } from "../../src/trust/pinned-keys.js";

function pem(): string {
  return generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) as string;
}

describe("one public-key fingerprint (pentest LOW)", () => {
  it("is sha256 of the SPKI DER and the same function in mesh, discovery and agent trust", () => {
    const key = pem();
    const fp = publicKeyFingerprint(key);
    const der = createHash("sha256").update(Buffer.from(key.replace(/-----[^-]+-----|\s/g, ""), "base64")).digest("hex");
    expect(fp).toBe(der);
    expect(meshFingerprint(key)).toBe(fp);
    expect(discoveryFingerprint(key)).toBe(fp);
    expect(trustFingerprint(key)).toBe(fp);
  });

  it("identifies the key, not its text: CRLF, padding and re-wrapping give the same value", () => {
    const key = pem();
    const fp = publicKeyFingerprint(key);
    expect(publicKeyFingerprint(key.replace(/\n/g, "\r\n"))).toBe(fp);
    expect(publicKeyFingerprint(`  ${key}\n\n`)).toBe(fp);
    expect(publicKeyFingerprint(pem())).not.toBe(fp);
    expect(tryPublicKeyFingerprint("not a key")).toBeNull();
  });

  it("pins written by older builds (sha256 of the PEM text) still match everywhere", () => {
    const key = pem();
    const oldTrustFile = createHash("sha256").update(key.trim() + "\n").digest("hex");
    const oldDiscovery = createHash("sha256").update(key.replace(/\r/g, "").trim()).digest("hex");
    expect(legacyPemFingerprints(key)).toEqual(expect.arrayContaining([oldTrustFile, oldDiscovery]));
    for (const fp of [oldTrustFile, oldDiscovery, publicKeyFingerprint(key), publicKeyFingerprint(key).toUpperCase()]) {
      expect(fingerprintMatches(fp, key)).toBe(true);
      expect(pinMatchesKey(fp, key)).toBe(true);
    }
    expect(fingerprintMatches(oldTrustFile, pem())).toBe(false);
    expect(fingerprintMatches("zz", key)).toBe(false);

    const store = new PinnedKeyStore({ mode: "strict", entries: `coord-a:${oldTrustFile}`, pinFile: null });
    expect(store.isTrusted("coord-a", key)).toMatchObject({ trusted: true, reason: "pinned_match" });
    expect(store.isTrusted("coord-a", pem())).toMatchObject({ trusted: false, reason: "pinned_mismatch" });

    expect(isAllowlistedKey(parsePeerAllowlist(`coord-a:${publicKeyFingerprint(key)}`), "coord-a", key)).toBe(true);
    expect(isAllowlistedKey(parsePeerAllowlist(`coord-a:${publicKeyFingerprint(key)}`), "coord-a", "garbage")).toBe(false);
  });

  it("tofu pins new keys in the canonical form", () => {
    const key = pem();
    const store = new PinnedKeyStore({ mode: "tofu", pinFile: null });
    expect(store.isTrusted("coord-new", key)).toMatchObject({ trusted: true, reason: "tofu_pinned", fingerprint: publicKeyFingerprint(key) });
    expect(store.knownFingerprint("coord-new")).toBe(publicKeyFingerprint(key));
  });
});
