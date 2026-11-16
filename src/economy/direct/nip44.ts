// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * NIP-44 v2 encryption (Nostr), used by Nostr Wallet Connect (NIP-47) requests and responses.
 *
 *   conversation_key = HKDF-extract(sha256, ikm = ECDH x-coordinate, salt = "nip44-v2")
 *   (chacha_key 32 | chacha_nonce 12 | hmac_key 32) = HKDF-expand(conversation_key, info = nonce, 76)
 *   payload = base64(0x02 | nonce 32 | chacha20(padded plaintext) | hmac-sha256(hmac_key, nonce | ciphertext))
 *
 * ChaCha20, HMAC and HKDF come from node:crypto; the secp256k1 ECDH from @noble/curves (already a
 * dependency, also used for the Schnorr signatures in src/discovery/nostr.ts).
 */

import { createCipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const VERSION = 2;
const MIN_PLAINTEXT = 1;
const MAX_PLAINTEXT = 65535;

/** x-coordinate of secret·(x-only pubkey lifted to even y). */
export function sharedX(secretKey: Uint8Array, pubkeyXOnlyHex: string): Buffer {
  const point = secp256k1.getSharedSecret(secretKey, Buffer.from("02" + pubkeyXOnlyHex, "hex"), true);
  return Buffer.from(point.subarray(1, 33));
}

export function nip44ConversationKey(secretKey: Uint8Array, pubkeyXOnlyHex: string): Buffer {
  return createHmac("sha256", Buffer.from("nip44-v2", "utf8")).update(sharedX(secretKey, pubkeyXOnlyHex)).digest();
}

/** HKDF-expand only (RFC 5869 section 2.3), as NIP-44 specifies. */
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const out: Buffer[] = [];
  let prev = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(out).length < length; i++) {
    prev = createHmac("sha256", prk).update(Buffer.concat([prev, info, Buffer.from([i])])).digest();
    out.push(prev);
  }
  return Buffer.concat(out).subarray(0, length);
}

export function nip44PaddedLength(len: number): number {
  if (len <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

function pad(plaintext: string): Buffer {
  const bytes = Buffer.from(plaintext, "utf8");
  if (bytes.length < MIN_PLAINTEXT || bytes.length > MAX_PLAINTEXT) throw new Error("nip44_invalid_plaintext_length");
  const out = Buffer.alloc(2 + nip44PaddedLength(bytes.length));
  out.writeUInt16BE(bytes.length, 0);
  bytes.copy(out, 2);
  return out;
}

function unpad(padded: Buffer): string {
  const len = padded.readUInt16BE(0);
  if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT || padded.length !== 2 + nip44PaddedLength(len)) throw new Error("nip44_invalid_padding");
  return padded.subarray(2, 2 + len).toString("utf8");
}

function chacha20(key: Buffer, nonce12: Buffer, data: Buffer): Buffer {
  // Node's chacha20 IV is 16 bytes: a 32-bit little-endian block counter (0) then the 96-bit nonce.
  const cipher = createCipheriv("chacha20", key, Buffer.concat([Buffer.alloc(4), nonce12]));
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function nip44Encrypt(plaintext: string, conversationKey: Buffer, nonce: Buffer = randomBytes(32)): string {
  if (nonce.length !== 32) throw new Error("nip44_invalid_nonce");
  const keys = hkdfExpand(conversationKey, nonce, 76);
  const ciphertext = chacha20(keys.subarray(0, 32), keys.subarray(32, 44), pad(plaintext));
  const mac = createHmac("sha256", keys.subarray(44, 76)).update(Buffer.concat([nonce, ciphertext])).digest();
  return Buffer.concat([Buffer.from([VERSION]), nonce, ciphertext, mac]).toString("base64");
}

export function nip44Decrypt(payload: string, conversationKey: Buffer): string {
  if (!payload || payload[0] === "#") throw new Error("nip44_unsupported_version");
  const data = Buffer.from(payload, "base64");
  if (data.length < 99 || data.length > 65603) throw new Error("nip44_invalid_payload_size");
  if (data[0] !== VERSION) throw new Error("nip44_unsupported_version");
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const keys = hkdfExpand(conversationKey, nonce, 76);
  const expected = createHmac("sha256", keys.subarray(44, 76)).update(Buffer.concat([nonce, ciphertext])).digest();
  if (!timingSafeEqual(expected, mac)) throw new Error("nip44_invalid_mac");
  return unpad(chacha20(keys.subarray(0, 32), keys.subarray(32, 44), ciphertext));
}
