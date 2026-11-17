// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Time-based one-time passwords (RFC 6238, on HOTP from RFC 4226) for portal two-factor
 * authentication, with node:crypto only. Authenticator apps use SHA-1, 6 digits and 30 s steps,
 * which is what the portal issues; SHA-256/512 and 8 digits exist for the RFC test vectors.
 */

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding (what otpauth:// URIs carry). */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32, ignoring case, spaces, dashes and padding. Throws on any other character. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid_base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP: dynamic truncation of HMAC(secret, counter). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS, algorithm: TotpAlgorithm = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The time step for a moment (RFC 6238 T = floor((now - T0) / X), T0 = 0). */
export function totpStep(nowMs: number, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(nowMs / 1000 / stepSeconds);
}

export function totp(secret: Buffer, nowMs: number, opts: { digits?: number; algorithm?: TotpAlgorithm; stepSeconds?: number } = {}): string {
  return hotp(secret, totpStep(nowMs, opts.stepSeconds), opts.digits ?? TOTP_DIGITS, opts.algorithm ?? "sha1");
}

/**
 * Checks a code against the current step and `window` steps either side (clock skew; 1 = ±30 s).
 * Returns the matching step, or null. A step at or before `lastUsedStep` never matches, so a code
 * (and any older one) works once.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, opts: { window?: number; lastUsedStep?: number; digits?: number } = {}): number | null {
  const digits = opts.digits ?? TOTP_DIGITS;
  const clean = code.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return null;
  const window = opts.window ?? 1;
  const current = totpStep(nowMs);
  let matched: number | null = null;
  // Compare every candidate (constant work regardless of which one matches).
  for (let step = current - window; step <= current + window; step++) {
    const ok = timingSafeEqual(Buffer.from(hotp(secret, step, digits)), Buffer.from(clean));
    if (ok && matched === null && (opts.lastUsedStep === undefined || step > opts.lastUsedStep)) matched = step;
  }
  return matched;
}

/** A new 160-bit secret (RFC 4226 recommends at least 128; authenticator apps expect 160). */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/** otpauth://totp/ URI for authenticator apps (and the QR code that carries it). */
export function otpauthUri(input: { secret: Buffer; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({ secret: base32Encode(input.secret), issuer: input.issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Recovery codes: `count` single-use codes like `k3m9-x2p7-q8wd` (60 bits each), shown once. */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(12);
    let s = "";
    for (const b of bytes) s += alphabet[b % alphabet.length];
    codes.push(`${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`);
  }
  return codes;
}

/** Recovery codes are stored hashed; matching ignores case, spaces and dashes. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(`edgecoder-recovery:${normalizeRecoveryCode(code)}`).digest("hex");
}
