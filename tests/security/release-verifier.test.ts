import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { TRUSTED_RELEASE_KEYS } from "../../src/security/release-keys.js";
import { verifyBinaryIntegrity } from "../../src/security/release-verifier.js";
import type { ReleaseManifest } from "../../src/security/release-integrity.js";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const manifest = { version: "1.4.38", artifacts: [{ name: "a.tgz", sha256: "ab".repeat(32) }], distTreeHash: "cd".repeat(32), timestamp: "2026-01-01T00:00:00Z" } as unknown as ReleaseManifest;
const fields = { version: manifest.version, artifacts: manifest.artifacts, distTreeHash: manifest.distTreeHash, timestamp: manifest.timestamp };
const cache = new Map([[manifest.version, manifest]]);
const sigOf = (text: string) => sign(null, Buffer.from(text), keys.privateKey).toString("base64");

describe("verifyBinaryIntegrity (Ed25519)", () => {
  afterEach(() => {
    TRUSTED_RELEASE_KEYS.splice(0);
  });

  it("verifies a manifest signed by an active release key (compact and jq-indented forms)", () => {
    TRUSTED_RELEASE_KEYS.push({ publicKeyPem, activatedAtMs: 0 });
    for (const text of [JSON.stringify(fields), JSON.stringify(fields, null, 2)]) {
      const r = verifyBinaryIntegrity({ distHash: manifest.distTreeHash, releaseVersion: manifest.version, releaseSignature: sigOf(text), distributionChannel: "npm" }, cache);
      expect(r).toEqual({ status: "verified" });
    }
  });

  it("refuses a signature over other bytes, by another key, or a different dist hash", () => {
    TRUSTED_RELEASE_KEYS.push({ publicKeyPem, activatedAtMs: 0 });
    const good = sigOf(JSON.stringify(fields));
    expect(verifyBinaryIntegrity({ distHash: manifest.distTreeHash, releaseVersion: manifest.version, releaseSignature: sigOf(JSON.stringify({ ...fields, version: "9.9.9" })), distributionChannel: "npm" }, cache).status).toBe("signature_mismatch");
    const other = generateKeyPairSync("ed25519");
    const foreign = sign(null, Buffer.from(JSON.stringify(fields)), other.privateKey).toString("base64");
    expect(verifyBinaryIntegrity({ distHash: manifest.distTreeHash, releaseVersion: manifest.version, releaseSignature: foreign, distributionChannel: "npm" }, cache).status).toBe("signature_mismatch");
    expect(verifyBinaryIntegrity({ distHash: "ee".repeat(32), releaseVersion: manifest.version, releaseSignature: good, distributionChannel: "npm" }, cache).status).toBe("hash_mismatch");
  });

  it("stays unverified without keys, a signature or a cached manifest", () => {
    const good = sigOf(JSON.stringify(fields));
    expect(verifyBinaryIntegrity({ distHash: manifest.distTreeHash, releaseVersion: manifest.version, releaseSignature: good, distributionChannel: "npm" }, cache).status).toBe("unverified");
    TRUSTED_RELEASE_KEYS.push({ publicKeyPem, activatedAtMs: 0 });
    expect(verifyBinaryIntegrity({ distHash: manifest.distTreeHash, releaseVersion: manifest.version, releaseSignature: "", distributionChannel: "npm" }, cache).status).toBe("unverified");
    expect(verifyBinaryIntegrity({ distHash: manifest.distTreeHash, releaseVersion: "0.0.1", releaseSignature: good, distributionChannel: "npm" }, cache).status).toBe("unverified");
  });
});
