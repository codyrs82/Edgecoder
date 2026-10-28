import { describe, expect, test } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  signModelManifest,
  verifyModelManifest,
  ALLOWED_MODEL_EXTENSIONS,
  MANIFEST_VERSION,
  modelFileMatches,
  sourceProblem,
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

  describe("#144: signature covers source, https only", () => {
    const trust = (pem: string) => ({ trustedPeerIds: ["coord-1"], trustedPublicKeys: { "coord-1": pem } });

    test("swapping source on a signed manifest invalidates it", () => {
      const keys = makeKeys();
      const signed = signModelManifest(validManifest, keys.privateKeyPem, "coord-1");
      expect(signed.manifestVersion).toBe(MANIFEST_VERSION);
      const swapped = { ...signed, source: "https://huggingface.co/attacker/other.gguf" };
      expect(verifyModelManifest(swapped, trust(keys.publicKeyPem))).toEqual({ valid: false, reason: "invalid_signature" });
    });

    test("a v1 manifest (signature without source) is rejected", () => {
      const keys = makeKeys();
      const v1Payload = `${validManifest.modelId}\n${validManifest.version}\n${validManifest.sha256}`;
      const signature = sign(null, Buffer.from(v1Payload), keys.privateKeyPem).toString("base64");
      const v1 = { ...validManifest, signature, signerPeerId: "coord-1" } as unknown as Parameters<typeof verifyModelManifest>[0];
      expect(verifyModelManifest(v1, trust(keys.publicKeyPem)).reason).toBe("unsupported_manifest_version");
    });

    test.each([
      ["http://models.edgecoder.io/m.gguf", "source_not_https"],
      ["https://u:p@models.edgecoder.io/m.gguf", "source_has_credentials"],
      ["https://models.edgecoder.io:8443/m.gguf", "source_has_port"],
      ["https://models.edgecoder.io/m.gguf#x", "source_has_fragment"],
      ["https://models.edgecoder.io/payload.exe?f=.gguf", "disallowed_file_extension"],
      ["https://models.edgecoder.io/x.gguf/payload", "disallowed_file_extension"],
      ["https://models.edgecoder.io/payload", "disallowed_file_extension"],
      ["https://models.edgecoder.io.evil.org/m.gguf", "source_not_allowlisted"],
      ["ftp://models.edgecoder.io/m.gguf", "source_not_https"],
      ["not a url", "invalid_source_url"],
      ["https://models.edgecoder.io/%E0%A4%A.gguf", "invalid_source_url"]
    ])("sourceProblem(%s) = %s", (source, reason) => {
      expect(sourceProblem(source)).toBe(reason);
    });

    test("accepts a clean https source, with a query string, extension case-insensitive", () => {
      expect(sourceProblem("https://huggingface.co/org/repo/resolve/main/model.Q4.GGUF?download=true")).toBeNull();
    });

    test("signing rejects newline injection and non-hex sha256", () => {
      const keys = makeKeys();
      expect(() => signModelManifest({ ...validManifest, version: "1\nx" }, keys.privateKeyPem, "coord-1")).toThrow("newline");
      expect(() => signModelManifest({ ...validManifest, sha256: "Z".repeat(64) }, keys.privateKeyPem, "coord-1")).toThrow("sha256");
    });

    test("modelFileMatches checks the downloaded bytes against the signed sha256", () => {
      const data = Buffer.from("model bytes");
      const sha256 = createHash("sha256").update(data).digest("hex");
      expect(modelFileMatches({ sha256 }, data)).toBe(true);
      expect(modelFileMatches({ sha256 }, Buffer.from("tampered"))).toBe(false);
      expect(modelFileMatches({ sha256: "abc" }, data)).toBe(false);
    });
  });
});
