import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  otpauthUri,
  totp,
  verifyTotp
} from "../../src/portal/totp.js";

// RFC 6238 Appendix B: the seeds are the ASCII string "12345678901234567890" repeated to the hash's block of key.
const SEED_SHA1 = Buffer.from("12345678901234567890", "ascii");
const SEED_SHA256 = Buffer.from("12345678901234567890123456789012", "ascii");
const SEED_SHA512 = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234", "ascii");

const RFC6238: Array<[number, string, string, string]> = [
  // [time (s), SHA1, SHA256, SHA512] — 8 digits
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"]
];

describe("RFC 6238 TOTP (node:crypto only)", () => {
  it.each(RFC6238)("matches the RFC test vectors at T=%i", (t, sha1, sha256, sha512) => {
    expect(totp(SEED_SHA1, t * 1000, { digits: 8, algorithm: "sha1" })).toBe(sha1);
    expect(totp(SEED_SHA256, t * 1000, { digits: 8, algorithm: "sha256" })).toBe(sha256);
    expect(totp(SEED_SHA512, t * 1000, { digits: 8, algorithm: "sha512" })).toBe(sha512);
  });

  it("matches the RFC 4226 HOTP vectors (6 digits, counters 0-9)", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expect(expected.map((_, c) => hotp(SEED_SHA1, c))).toEqual(expected);
  });

  it("base32 round-trips and decodes the way authenticator apps write it", () => {
    for (let i = 0; i < 20; i++) {
      const secret = generateTotpSecret();
      expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    }
    expect(base32Encode(SEED_SHA1)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq====").equals(SEED_SHA1)).toBe(true);
    expect(() => base32Decode("not!base32")).toThrow();
  });

  it("accepts ±1 step of clock skew and nothing further", () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30000);
    const codeAt = (s: number) => hotp(SEED_SHA1, s);
    expect(verifyTotp(SEED_SHA1, codeAt(step), now)).toBe(step);
    expect(verifyTotp(SEED_SHA1, codeAt(step - 1), now)).toBe(step - 1);
    expect(verifyTotp(SEED_SHA1, codeAt(step + 1), now)).toBe(step + 1);
    expect(verifyTotp(SEED_SHA1, codeAt(step - 2), now)).toBeNull();
    expect(verifyTotp(SEED_SHA1, codeAt(step + 2), now)).toBeNull();
  });

  it("a step at or before the last used one never matches again (replay)", () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30000);
    expect(verifyTotp(SEED_SHA1, hotp(SEED_SHA1, step), now, { lastUsedStep: step })).toBeNull();
    expect(verifyTotp(SEED_SHA1, hotp(SEED_SHA1, step - 1), now, { lastUsedStep: step - 1 })).toBeNull();
    expect(verifyTotp(SEED_SHA1, hotp(SEED_SHA1, step + 1), now, { lastUsedStep: step })).toBe(step + 1);
  });

  it("refuses malformed codes", () => {
    const now = 1_700_000_000_000;
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5x"]) expect(verifyTotp(SEED_SHA1, bad, now)).toBeNull();
    // Spaces inside a right code are fine.
    const code = totp(SEED_SHA1, now);
    expect(verifyTotp(SEED_SHA1, `${code.slice(0, 3)} ${code.slice(3)}`, now)).not.toBeNull();
  });

  it("builds an otpauth:// URI with the issuer, account and base32 secret", () => {
    const uri = otpauthUri({ secret: SEED_SHA1, account: "ana@example.com", issuer: "EdgeCoder" });
    expect(uri).toMatch(/^otpauth:\/\/totp\/EdgeCoder%3Aana%40example\.com\?/);
    const params = new URL(uri).searchParams;
    expect(params.get("secret")).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(params.get("issuer")).toBe("EdgeCoder");
    expect(params.get("digits")).toBe("6");
    expect(params.get("period")).toBe("30");
  });

  it("recovery codes are distinct, readable, and hash the same however they are typed", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(hashRecoveryCode(codes[0])).toBe(hashRecoveryCode(` ${codes[0].toUpperCase().replace(/-/g, "")} `));
    expect(hashRecoveryCode(codes[0])).not.toBe(hashRecoveryCode(codes[1]));
  });
});
