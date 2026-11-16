// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * NIP-04 encryption (legacy, still the NIP-47 default when a wallet doesn't advertise nip44_v2):
 * AES-256-CBC keyed by the raw ECDH x-coordinate; content = base64(ciphertext) + "?iv=" + base64(iv).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { sharedX } from "./nip44.js";

export function nip04Encrypt(plaintext: string, secretKey: Uint8Array, pubkeyXOnlyHex: string, iv: Buffer = randomBytes(16)): string {
  const cipher = createCipheriv("aes-256-cbc", sharedX(secretKey, pubkeyXOnlyHex), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${ct.toString("base64")}?iv=${iv.toString("base64")}`;
}

export function nip04Decrypt(content: string, secretKey: Uint8Array, pubkeyXOnlyHex: string): string {
  const m = /^([A-Za-z0-9+/=]+)\?iv=([A-Za-z0-9+/=]+)$/.exec(content.trim());
  if (!m) throw new Error("nip04_malformed");
  const iv = Buffer.from(m[2], "base64");
  if (iv.length !== 16) throw new Error("nip04_bad_iv");
  const decipher = createDecipheriv("aes-256-cbc", sharedX(secretKey, pubkeyXOnlyHex), iv);
  return Buffer.concat([decipher.update(Buffer.from(m[1], "base64")), decipher.final()]).toString("utf8");
}
