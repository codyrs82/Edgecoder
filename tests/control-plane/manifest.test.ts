import { describe, expect, test } from "vitest";
import { verifyManifest, checksumText } from "../../src/control-plane/manifest.js";
import type { LocalModelManifest } from "../../src/common/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validManifest(overrides: Partial<LocalModelManifest> = {}): LocalModelManifest {
  return {
    modelId: "qwen2.5-coder-7b",
    sourceUrl: "https://models.edgecoder.local/qwen2.5-coder-7b.gguf",
    checksumSha256: "a".repeat(64),
    signature: "valid-signature-at-least-16-chars",
    provider: "edgecoder-local",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// verifyManifest
// ---------------------------------------------------------------------------

describe("verifyManifest", () => {
  // ---- Happy path ----

  test("accepts a valid manifest with edgecoder-local source", () => {
    const result = verifyManifest(validManifest());
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("accepts a valid manifest with huggingface source", () => {
    const result = verifyManifest(
      validManifest({ sourceUrl: "https://huggingface.co/models/qwen2.5-coder-7b" })
    );
    expect(result.ok).toBe(true);
  });

  test("accepts manifest with ollama-local provider", () => {
    const result = verifyManifest(
      validManifest({ provider: "ollama-local" })
    );
    expect(result.ok).toBe(true);
  });

  // ---- Source URL validation ----

  test("rejects manifest with disallowed source URL", () => {
    const result = verifyManifest(
      validManifest({ sourceUrl: "https://evil.com/malware.bin" })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("source_not_allowed");
  });

  test("rejects manifest with HTTP (non-HTTPS) source", () => {
    const result = verifyManifest(
      validManifest({ sourceUrl: "http://models.edgecoder.local/model.gguf" })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("source_not_allowed");
  });

  test("rejects manifest with a subdomain impersonation attempt", () => {
    const result = verifyManifest(
      validManifest({ sourceUrl: "https://models.edgecoder.local.evil.com/model.gguf" })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("source_not_allowed");
  });

  test("rejects manifest with empty source URL prefix match", () => {
    const result = verifyManifest(
      validManifest({ sourceUrl: "https://example.com/models.edgecoder.local/model.gguf" })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("source_not_allowed");
  });

  // ---- Checksum validation ----

  test("rejects manifest with too-short checksum", () => {
    const result = verifyManifest(validManifest({ checksumSha256: "abc123" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_checksum_format");
  });

  test("rejects manifest with too-long checksum", () => {
    const result = verifyManifest(validManifest({ checksumSha256: "a".repeat(65) }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_checksum_format");
  });

  test("rejects manifest with non-hex checksum characters", () => {
    const result = verifyManifest(
      validManifest({ checksumSha256: "g".repeat(64) })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_checksum_format");
  });

  test("accepts checksum with uppercase hex", () => {
    const result = verifyManifest(
      validManifest({ checksumSha256: "ABCDEF0123456789".repeat(4) })
    );
    expect(result.ok).toBe(true);
  });

  test("accepts checksum with mixed-case hex", () => {
    const result = verifyManifest(
      validManifest({ checksumSha256: "aAbBcCdDeEfF0123456789012345678901234567890123456789012345678901" })
    );
    expect(result.ok).toBe(true);
  });

  // ---- Signature validation ----

  test("rejects manifest with signature shorter than 16 characters", () => {
    const result = verifyManifest(validManifest({ signature: "short" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  test("rejects manifest with empty signature", () => {
    const result = verifyManifest(validManifest({ signature: "" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  test("rejects manifest with 15-character signature (boundary)", () => {
    const result = verifyManifest(validManifest({ signature: "a".repeat(15) }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  test("accepts manifest with exactly 16-character signature (boundary)", () => {
    const result = verifyManifest(validManifest({ signature: "a".repeat(16) }));
    expect(result.ok).toBe(true);
  });

  // ---- Validation priority ----

  test("source check runs before checksum check", () => {
    const result = verifyManifest(
      validManifest({
        sourceUrl: "https://evil.com/model.bin",
        checksumSha256: "bad",
      })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("source_not_allowed");
  });

  test("checksum check runs before signature check", () => {
    const result = verifyManifest(
      validManifest({
        checksumSha256: "invalid-hex",
        signature: "short",
      })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_checksum_format");
  });
});

// ---------------------------------------------------------------------------
// checksumText
// ---------------------------------------------------------------------------

describe("checksumText", () => {
  test("returns the known SHA-256 hex digest for 'hello'", () => {
    expect(checksumText("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  test("returns a 64-character hex string", () => {
    const result = checksumText("test data");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  test("different inputs produce different checksums", () => {
    const a = checksumText("input-a");
    const b = checksumText("input-b");
    expect(a).not.toBe(b);
  });

  test("same input produces deterministic output", () => {
    const first = checksumText("deterministic");
    const second = checksumText("deterministic");
    expect(first).toBe(second);
  });

  test("handles empty string", () => {
    const result = checksumText("");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  test("handles unicode content", () => {
    const result = checksumText("Hello, World!");
    expect(result).toHaveLength(64);
  });
});
