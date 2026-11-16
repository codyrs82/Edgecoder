// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Encryption at rest for wallet secrets (NWC connection strings, viewing keys): AES-256-GCM under a
 * 32-byte key from NONCUSTODIAL_SECRET_KEY (hex or base64), with the record's owner and purpose as
 * associated data so a sealed value cannot be moved to another account. Sealed form:
 * `v1.<iv b64url>.<ciphertext b64url>.<tag b64url>`. The plaintext is never logged.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function secretBoxKey(raw: string | undefined = process.env.NONCUSTODIAL_SECRET_KEY): Buffer {
  const v = (raw ?? "").trim();
  const key = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error("secret_box_key_missing: set NONCUSTODIAL_SECRET_KEY to 32 bytes (hex or base64)");
  return key;
}

export function sealSecret(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), ct.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
}

export function openSecret(sealed: string, key: Buffer, aad: string): string {
  const [v, iv, ct, tag] = sealed.split(".");
  if (v !== "v1" || !iv || !ct || !tag) throw new Error("secret_box_malformed");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
