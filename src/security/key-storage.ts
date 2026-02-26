// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import {
  generateKeyPairSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  randomUUID,
} from "node:crypto";

export interface KeyEntry {
  privateKeyPem: string;
  publicKeyPem: string;
  activatedAt: number;
  expiresAt?: number;
  deactivatedAt?: number;
}

export interface KeyBundle {
  currentKey: KeyEntry & { expiresAt: number };
  previousKey: (KeyEntry & { deactivatedAt: number }) | null;
  keyId: string;
}

export interface EncryptedKeyBundle {
  ciphertext: string; // base64
  salt: string;       // hex
  nonce: string;      // hex
  tag: string;        // hex
}

const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32; // AES-256
const NONCE_LENGTH = 12; // GCM

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
}

export function generateKeyBundle(rotationDays: number): KeyBundle {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  return {
    currentKey: {
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
      activatedAt: now,
      expiresAt: now + rotationDays * 86_400_000,
    },
    previousKey: null,
    keyId: randomUUID(),
  };
}

export function encryptKeyBundle(
  bundle: KeyBundle,
  passphrase: string
): EncryptedKeyBundle {
  const salt = randomBytes(32);
  const key = deriveKey(passphrase, salt);
  const nonce = randomBytes(NONCE_LENGTH);
  const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    salt: salt.toString("hex"),
    nonce: nonce.toString("hex"),
    tag: tag.toString("hex"),
  };
}

export function decryptKeyBundle(
  encrypted: EncryptedKeyBundle,
  passphrase: string
): KeyBundle {
  const salt = Buffer.from(encrypted.salt, "hex");
  const nonce = Buffer.from(encrypted.nonce, "hex");
  const tag = Buffer.from(encrypted.tag, "hex");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const key = deriveKey(passphrase, salt);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as KeyBundle;
}
