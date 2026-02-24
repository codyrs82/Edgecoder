import { describe, expect, test } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  signModelManifest,
  verifyModelManifest,
  ALLOWED_MODEL_EXTENSIONS,
} from "../../src/security/manifest-verifier.js";

function makeKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}

const validManifest = {
  modelId: "codellama-7b",
  version: "1.0.3",
  source: "https://models.edgecoder.io/codellama-7b-v1.0.3.gguf",
  sha256: "a".repeat(64),
};

describe("manifest-verifier", () => {
  test("signModelManifest produces valid signature", () => {
    const keys = makeKeys();
    const signed = signModelManifest(validManifest, keys.privateKeyPem, "coord-1");
    expect(signed.signature).toBeTruthy();
    expect(signed.signerPeerId).toBe("coord-1");
  });

  test("verifyModelManifest accepts valid signed manifest", () => {
    const keys = makeKeys();
    const signed = signModelManifest(validManifest, keys.privateKeyPem, "coord-1");
    const result = verifyModelManifest(signed, {
      trustedPeerIds: ["coord-1"],
      trustedPublicKeys: { "coord-1": keys.publicKeyPem },
    });
    expect(result.valid).toBe(true);
  });

  test("rejects manifest from untrusted peer", () => {
    const keys = makeKeys();
    const signed = signModelManifest(validManifest, keys.privateKeyPem, "coord-evil");
    const result = verifyModelManifest(signed, {
      trustedPeerIds: ["coord-1"],
      trustedPublicKeys: { "coord-1": keys.publicKeyPem },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("untrusted_peer");
  });

  test("rejects manifest with non-allowlisted source domain", () => {
    const keys = makeKeys();
    const badManifest = { ...validManifest, source: "https://evil.com/model.gguf" };
    const signed = signModelManifest(badManifest, keys.privateKeyPem, "coord-1");
    const result = verifyModelManifest(signed, {
      trustedPeerIds: ["coord-1"],
      trustedPublicKeys: { "coord-1": keys.publicKeyPem },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("source_not_allowlisted");
  });

  test("rejects manifest with disallowed file extension", () => {
    const keys = makeKeys();
    const badManifest = { ...validManifest, source: "https://models.edgecoder.io/payload.exe" };
    const signed = signModelManifest(badManifest, keys.privateKeyPem, "coord-1");
    const result = verifyModelManifest(signed, {
      trustedPeerIds: ["coord-1"],
      trustedPublicKeys: { "coord-1": keys.publicKeyPem },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("disallowed_file_extension");
  });

  test("rejects manifest with invalid signature", () => {
    const keys = makeKeys();
    const otherKeys = makeKeys();
    const signed = signModelManifest(validManifest, keys.privateKeyPem, "coord-1");
    const result = verifyModelManifest(signed, {
      trustedPeerIds: ["coord-1"],
      trustedPublicKeys: { "coord-1": otherKeys.publicKeyPem },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  test("ALLOWED_MODEL_EXTENSIONS contains expected formats", () => {
    expect(ALLOWED_MODEL_EXTENSIONS).toContain(".gguf");
    expect(ALLOWED_MODEL_EXTENSIONS).toContain(".bin");
    expect(ALLOWED_MODEL_EXTENSIONS).toContain(".safetensors");
    expect(ALLOWED_MODEL_EXTENSIONS).not.toContain(".exe");
    expect(ALLOWED_MODEL_EXTENSIONS).not.toContain(".sh");
  });
});
