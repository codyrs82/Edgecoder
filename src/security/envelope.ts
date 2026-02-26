// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import {
  generateKeyPairSync,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
} from "node:crypto";

export interface X25519KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export interface EnvelopeMetadata {
  resourceClass?: string;
  priority?: number;
  language?: string;
  timeoutMs?: number;
}

export interface TaskEnvelope {
  subtaskId: string;
  ephemeralPublicKey: string;        // base64
  encryptedPayload: string;          // base64
  nonce: string;                     // hex
  tag: string;                       // hex
  metadata: EnvelopeMetadata;
}

export interface EncryptedResult {
  subtaskId: string;
  encryptedPayload: string;          // base64
  nonce: string;                     // hex
  tag: string;                       // hex
}

// DER prefixes for wrapping raw 32-byte X25519 keys
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export function generateX25519KeyPair(): X25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(-32),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32),
  };
}

function deriveSharedKey(
  myPrivateRaw: Buffer,
  theirPublicRaw: Buffer,
  salt: string
): Buffer {
  const myPrivate = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, myPrivateRaw]),
    format: "der",
    type: "pkcs8",
  });
  const theirPublic = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, theirPublicRaw]),
    format: "der",
    type: "spki",
  });

  const shared = diffieHellman({ publicKey: theirPublic, privateKey: myPrivate });
  return Buffer.from(hkdfSync("sha256", shared, salt, "edgecoder-envelope", 32));
}

function aesGcmEncrypt(
  key: Buffer,
  plaintext: Buffer
): { ciphertext: Buffer; nonce: Buffer; tag: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

function aesGcmDecrypt(
  key: Buffer,
  ciphertext: Buffer,
  nonce: Buffer,
  tag: Buffer
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Creates an encrypted task envelope. Returns the envelope (to send to agent)
 * and the derived symmetric key (coordinator retains for result decryption).
 */
export function createTaskEnvelope(
  task: { input: string; snapshotRef: string; kind: string },
  agentPublicKey: Buffer,
  subtaskId: string,
  metadata: EnvelopeMetadata = {}
): { envelope: TaskEnvelope; sharedKey: Buffer } {
  const ephemeral = generateX25519KeyPair();
  const symKey = deriveSharedKey(ephemeral.privateKey, agentPublicKey, subtaskId);
  const plaintext = Buffer.from(JSON.stringify(task), "utf8");
  const { ciphertext, nonce, tag } = aesGcmEncrypt(symKey, plaintext);

  return {
    envelope: {
      subtaskId,
      ephemeralPublicKey: ephemeral.publicKey.toString("base64"),
      encryptedPayload: ciphertext.toString("base64"),
      nonce: nonce.toString("hex"),
      tag: tag.toString("hex"),
      metadata,
    },
    sharedKey: symKey,
  };
}

/**
 * Agent-side: decrypt a task envelope using the agent's X25519 private key.
 */
export function decryptTaskEnvelope(
  envelope: TaskEnvelope,
  agentPrivateKey: Buffer
): { input: string; snapshotRef: string; kind: string } {
  const ephPub = Buffer.from(envelope.ephemeralPublicKey, "base64");
  const symKey = deriveSharedKey(agentPrivateKey, ephPub, envelope.subtaskId);
  const plaintext = aesGcmDecrypt(
    symKey,
    Buffer.from(envelope.encryptedPayload, "base64"),
    Buffer.from(envelope.nonce, "hex"),
    Buffer.from(envelope.tag, "hex")
  );
  return JSON.parse(plaintext.toString("utf8"));
}

/**
 * Agent-side: encrypt execution result with the shared key derived from envelope.
 */
export function encryptResult(
  result: { ok: boolean; output: string; error?: string; durationMs: number },
  envelope: TaskEnvelope,
  agentPrivateKey: Buffer
): EncryptedResult {
  const ephPub = Buffer.from(envelope.ephemeralPublicKey, "base64");
  const symKey = deriveSharedKey(agentPrivateKey, ephPub, envelope.subtaskId);
  const plaintext = Buffer.from(JSON.stringify(result), "utf8");
  const { ciphertext, nonce, tag } = aesGcmEncrypt(symKey, plaintext);

  return {
    subtaskId: envelope.subtaskId,
    encryptedPayload: ciphertext.toString("base64"),
    nonce: nonce.toString("hex"),
    tag: tag.toString("hex"),
  };
}

/**
 * Coordinator-side: decrypt result using the cached shared key from envelope creation.
 */
export function decryptResult(
  encResult: EncryptedResult,
  sharedKey: Buffer
): { ok: boolean; output: string; error?: string; durationMs: number } {
  const plaintext = aesGcmDecrypt(
    sharedKey,
    Buffer.from(encResult.encryptedPayload, "base64"),
    Buffer.from(encResult.nonce, "hex"),
    Buffer.from(encResult.tag, "hex")
  );
  return JSON.parse(plaintext.toString("utf8"));
}
