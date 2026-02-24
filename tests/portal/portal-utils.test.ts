import { describe, expect, test } from "vitest";
import {
  sha256Hex,
  normalizeEmail,
  parseCookies,
  secureCompare,
  hashPassword,
  verifyPassword,
  decodeJwtPayload,
  claimIsTrue,
  base64UrlFromBuffer,
  bufferFromBase64Url,
  normalizeBase64UrlString,
  deriveWalletSecretRef,
  generateSixDigitCode,
  deriveIosDeviceIdFromNodeId,
  encodeCookie,
  clearCookie,
  normalizePasskeyResponsePayload,
  deriveCredentialIdFromVerifyBody,
} from "../../src/portal/portal-utils.js";

// ---------------------------------------------------------------------------
// sha256Hex
// ---------------------------------------------------------------------------
describe("sha256Hex", () => {
  test("returns the known SHA-256 hex digest for 'hello'", () => {
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeEmail
// ---------------------------------------------------------------------------
describe("normalizeEmail", () => {
  test("converts uppercase to lowercase", () => {
    expect(normalizeEmail("USER@EXAMPLE.COM")).toBe("user@example.com");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalizeEmail("  user@example.com  ")).toBe("user@example.com");
  });

  test("trims and lowercases combined", () => {
    expect(normalizeEmail("  USER@EXAMPLE.COM  ")).toBe("user@example.com");
  });
});

// ---------------------------------------------------------------------------
// parseCookies
// ---------------------------------------------------------------------------
describe("parseCookies", () => {
  test("parses a single cookie", () => {
    expect(parseCookies("foo=bar")).toEqual({ foo: "bar" });
  });

  test("parses multiple cookies", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
  });

  test("returns empty object for undefined header", () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  test("skips malformed segments with no '='", () => {
    expect(parseCookies("good=value; noequals")).toEqual({ good: "value" });
  });

  test("decodes url-encoded values", () => {
    expect(parseCookies("name=hello%20world")).toEqual({ name: "hello world" });
  });
});

// ---------------------------------------------------------------------------
// secureCompare
// ---------------------------------------------------------------------------
describe("secureCompare", () => {
  test("returns true for equal strings", () => {
    expect(secureCompare("abc", "abc")).toBe(true);
  });

  test("returns false for different-length strings", () => {
    expect(secureCompare("abc", "abcd")).toBe(false);
  });

  test("returns false for same-length but different strings", () => {
    expect(secureCompare("abc", "abd")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hashPassword / verifyPassword
// ---------------------------------------------------------------------------
describe("hashPassword / verifyPassword", () => {
  test("round-trip: hashed password verifies with correct password", () => {
    const encoded = hashPassword("mySecret!");
    expect(verifyPassword("mySecret!", encoded)).toBe(true);
  });

  test("wrong password does not verify", () => {
    const encoded = hashPassword("mySecret!");
    expect(verifyPassword("wrongPassword", encoded)).toBe(false);
  });

  test("malformed encoded string returns false", () => {
    expect(verifyPassword("anything", "not-a-valid-hash")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decodeJwtPayload
// ---------------------------------------------------------------------------
describe("decodeJwtPayload", () => {
  test("decodes a valid 3-part JWT payload", () => {
    const payload = { sub: "1234" };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const fakeJwt = `header.${encodedPayload}.signature`;
    expect(decodeJwtPayload(fakeJwt)).toEqual({ sub: "1234" });
  });

  test("returns null when token has too few parts (no dots)", () => {
    expect(decodeJwtPayload("nodots")).toBeNull();
  });

  test("returns null when payload contains invalid base64", () => {
    expect(decodeJwtPayload("h.!!!invalid-base64!!!.s")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// claimIsTrue
// ---------------------------------------------------------------------------
describe("claimIsTrue", () => {
  test("true returns true", () => {
    expect(claimIsTrue(true)).toBe(true);
  });

  test("false returns false", () => {
    expect(claimIsTrue(false)).toBe(false);
  });

  test("1 returns true", () => {
    expect(claimIsTrue(1)).toBe(true);
  });

  test("0 returns false", () => {
    expect(claimIsTrue(0)).toBe(false);
  });

  test("'true' returns true", () => {
    expect(claimIsTrue("true")).toBe(true);
  });

  test("'false' returns false", () => {
    expect(claimIsTrue("false")).toBe(false);
  });

  test("null returns false", () => {
    expect(claimIsTrue(null)).toBe(false);
  });

  test("undefined returns false", () => {
    expect(claimIsTrue(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// base64UrlFromBuffer / bufferFromBase64Url
// ---------------------------------------------------------------------------
describe("base64UrlFromBuffer / bufferFromBase64Url", () => {
  test("round-trip: encode then decode returns original bytes", () => {
    const original = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    const encoded = base64UrlFromBuffer(original);
    const decoded = bufferFromBase64Url(encoded);
    expect(Buffer.compare(decoded, original)).toBe(0);
  });

  test("handles bytes that produce +/= in standard base64", () => {
    // 0xfb, 0xff, 0xfe produces +/= in standard base64
    const buf = Buffer.from([0xfb, 0xff, 0xfe]);
    const encoded = base64UrlFromBuffer(buf);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    const decoded = bufferFromBase64Url(encoded);
    expect(Buffer.compare(decoded, buf)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeBase64UrlString
// ---------------------------------------------------------------------------
describe("normalizeBase64UrlString", () => {
  test("strips trailing padding", () => {
    expect(normalizeBase64UrlString("abc==")).toBe("abc");
  });

  test("replaces + with -", () => {
    expect(normalizeBase64UrlString("a+b")).toBe("a-b");
  });

  test("replaces / with _", () => {
    expect(normalizeBase64UrlString("a/b")).toBe("a_b");
  });

  test("returns undefined for non-string input (number)", () => {
    expect(normalizeBase64UrlString(42)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(normalizeBase64UrlString("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deriveWalletSecretRef
// ---------------------------------------------------------------------------
describe("deriveWalletSecretRef", () => {
  test("deterministic: same inputs produce same output", () => {
    const a = deriveWalletSecretRef("seed", "acct1", "pepper1");
    const b = deriveWalletSecretRef("seed", "acct1", "pepper1");
    expect(a).toBe(b);
  });

  test("output starts with 'seed-sha256:'", () => {
    const ref = deriveWalletSecretRef("seed", "acct1", "pepper1");
    expect(ref.startsWith("seed-sha256:")).toBe(true);
  });

  test("different pepper produces a different result", () => {
    const a = deriveWalletSecretRef("seed", "acct1", "pepper1");
    const b = deriveWalletSecretRef("seed", "acct1", "pepper2");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// generateSixDigitCode
// ---------------------------------------------------------------------------
describe("generateSixDigitCode", () => {
  test("always produces a 6-character string", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateSixDigitCode()).toHaveLength(6);
    }
  });

  test("always produces a numeric string", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateSixDigitCode()).toMatch(/^\d{6}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// deriveIosDeviceIdFromNodeId
// ---------------------------------------------------------------------------
describe("deriveIosDeviceIdFromNodeId", () => {
  test("strips 'ios-' prefix and returns lowercased suffix", () => {
    expect(deriveIosDeviceIdFromNodeId("ios-abc123def456")).toBe("abc123def456");
  });

  test("strips 'iphone-' prefix and lowercases", () => {
    expect(deriveIosDeviceIdFromNodeId("iphone-ABCDEF123456")).toBe("abcdef123456");
  });

  test("returns undefined when suffix is too short (< 6 chars)", () => {
    expect(deriveIosDeviceIdFromNodeId("ios-abc")).toBeUndefined();
  });

  test("returns undefined for non-ios prefix", () => {
    expect(deriveIosDeviceIdFromNodeId("android-abc123def456")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// encodeCookie
// ---------------------------------------------------------------------------
describe("encodeCookie", () => {
  test("includes name=value pair with url-encoded value", () => {
    const cookie = encodeCookie("token", "a b", 3600);
    expect(cookie).toContain("token=a%20b");
  });

  test("includes Max-Age", () => {
    const cookie = encodeCookie("token", "val", 3600);
    expect(cookie).toContain("Max-Age=3600");
  });

  test("does not include Secure flag in non-production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const cookie = encodeCookie("token", "val", 3600);
      expect(cookie).not.toContain("Secure;");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  test("includes Secure flag in production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const cookie = encodeCookie("token", "val", 3600);
      expect(cookie).toContain("Secure;");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// clearCookie
// ---------------------------------------------------------------------------
describe("clearCookie", () => {
  test("sets Max-Age=0", () => {
    const cookie = clearCookie("token");
    expect(cookie).toContain("Max-Age=0");
  });

  test("sets value to empty", () => {
    const cookie = clearCookie("token");
    expect(cookie).toMatch(/^token=;/);
  });
});

// ---------------------------------------------------------------------------
// normalizePasskeyResponsePayload
// ---------------------------------------------------------------------------
describe("normalizePasskeyResponsePayload", () => {
  test("normalizes rawId to base64url format", () => {
    const input = {
      rawId: "abc+/def==",
      response: {},
    };
    const result = normalizePasskeyResponsePayload(input) as Record<string, unknown>;
    expect(result.rawId).toBe("abc-_def");
    expect(result.id).toBe("abc-_def");
  });

  test("normalizes nested response fields", () => {
    const input = {
      rawId: "abc",
      response: {
        clientDataJSON: "data+/x==",
        signature: "sig+y==",
      },
    };
    const result = normalizePasskeyResponsePayload(input) as Record<string, unknown>;
    const resp = result.response as Record<string, unknown>;
    expect(resp.clientDataJSON).toBe("data-_x");
    expect(resp.signature).toBe("sig-y");
  });

  test("returns non-object input as-is", () => {
    expect(normalizePasskeyResponsePayload("string")).toBe("string");
    expect(normalizePasskeyResponsePayload(null)).toBeNull();
    expect(normalizePasskeyResponsePayload(42)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// deriveCredentialIdFromVerifyBody
// ---------------------------------------------------------------------------
describe("deriveCredentialIdFromVerifyBody", () => {
  test("credentialId from body has priority", () => {
    const body = {
      credentialId: "body+id==",
      response: { id: "resp-id", rawId: "resp-raw" },
    };
    expect(deriveCredentialIdFromVerifyBody(body)).toBe("body-id");
  });

  test("falls back to response.id when body.credentialId is absent", () => {
    const body = {
      response: { id: "resp+id==", rawId: "resp-raw" },
    };
    expect(deriveCredentialIdFromVerifyBody(body)).toBe("resp-id");
  });

  test("falls back to response.rawId when response.id is absent", () => {
    const body = {
      response: { rawId: "resp+raw==" },
    };
    expect(deriveCredentialIdFromVerifyBody(body)).toBe("resp-raw");
  });

  test("returns undefined when nothing is provided", () => {
    const body = { response: {} };
    expect(deriveCredentialIdFromVerifyBody(body)).toBeUndefined();
  });
});
