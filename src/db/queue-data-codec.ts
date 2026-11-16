// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, hkdfSync, randomBytes } from "node:crypto";

/*
 * Encryption at rest for task data in Postgres: queue_tasks.payload_json (the subtask, with the
 * user's input) and queue_results.output. AES-256-GCM with a random 96-bit nonce per value; the
 * row's subtask id is bound as associated data, so a ciphertext copied onto another row does not
 * open. Rows written before this (plaintext) still read as before.
 *
 * The key is QUEUE_DATA_KEY (32 bytes, base64 or hex). Every coordinator sharing a database
 * should have the same one. Without it the key is derived from COORDINATOR_PRIVATE_KEY_PEM
 * (HKDF, own label), which is stable per coordinator but differs between coordinators. Values are
 * tagged with a key id, and reads try every key this process knows, so moving from the derived key
 * to QUEUE_DATA_KEY keeps old rows readable as long as COORDINATOR_PRIVATE_KEY_PEM stays set.
 * With neither (dev), values are stored in plaintext as before.
 */

const ALG = "aes-256-gcm";
/** JSONB form of an encrypted payload. */
export const ENCRYPTED_JSON_MARKER = "edgecoder-enc-v1";
/** TEXT form of an encrypted value: enc:v1:<kid>:<nonce>.<tag>.<ciphertext> (base64url). */
const TEXT_PREFIX = "enc:v1:";

export interface EncryptedJson {
  __enc: typeof ENCRYPTED_JSON_MARKER;
  kid: string;
  iv: string;
  tag: string;
  ct: string;
}

interface DataKey {
  kid: string;
  key: Buffer;
}

function keyId(key: Buffer): string {
  return createHash("sha256").update("edgecoder-queue-data-kid").update(key).digest("hex").slice(0, 16);
}

/** QUEUE_DATA_KEY: 32 bytes as 64 hex characters or base64. Anything else is a startup error. */
export function parseQueueDataKey(raw: string): Buffer {
  const v = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error("QUEUE_DATA_KEY must be 32 bytes (64 hex characters or base64)");
  return key;
}

export function queueDataKeyFromPem(privateKeyPem: string): Buffer {
  const der = createPrivateKey(privateKeyPem).export({ type: "pkcs8", format: "der" });
  return Buffer.from(hkdfSync("sha256", der, "edgecoder-queue-data", "edgecoder-queue-data/v1", 32));
}

export class QueueDataCodec {
  private readonly keys: DataKey[];

  /** `keys[0]` encrypts; all of them decrypt. No keys: plaintext. */
  constructor(keys: Buffer[]) {
    this.keys = keys.map((key) => ({ kid: keyId(key), key }));
  }

  static disabled(): QueueDataCodec {
    return new QueueDataCodec([]);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): QueueDataCodec {
    const keys: Buffer[] = [];
    if (env.QUEUE_DATA_KEY) keys.push(parseQueueDataKey(env.QUEUE_DATA_KEY));
    if (env.COORDINATOR_PRIVATE_KEY_PEM) keys.push(queueDataKeyFromPem(env.COORDINATOR_PRIVATE_KEY_PEM));
    return new QueueDataCodec(keys);
  }

  get enabled(): boolean {
    return this.keys.length > 0;
  }

  private seal(plaintext: string, aad: string): { kid: string; iv: Buffer; tag: Buffer; ct: Buffer } {
    const { kid, key } = this.keys[0];
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALG, key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { kid, iv, tag: cipher.getAuthTag(), ct };
  }

  private open(kid: string, iv: Buffer, tag: Buffer, ct: Buffer, aad: string): string {
    const entry = this.keys.find((k) => k.kid === kid);
    if (!entry) throw new Error(`queue_data_key_unknown:${kid}`);
    const decipher = createDecipheriv(ALG, entry.key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }

  /** A JSON value for a JSONB column: encrypted when a key is set, else `value` as JSON text. */
  encodeJson(value: unknown, aad: string): string {
    const json = JSON.stringify(value);
    if (!this.enabled) return json;
    const { kid, iv, tag, ct } = this.seal(json, aad);
    const out: EncryptedJson = { __enc: ENCRYPTED_JSON_MARKER, kid, iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ct.toString("base64") };
    return JSON.stringify(out);
  }

  /** A JSONB column as read (object or JSON text), decrypted when it is an encrypted value. */
  decodeJson<T>(stored: unknown, aad: string): T {
    const value = typeof stored === "string" ? JSON.parse(stored) : stored;
    if (!isEncryptedJson(value)) return value as T;
    return JSON.parse(this.open(value.kid, Buffer.from(value.iv, "base64"), Buffer.from(value.tag, "base64"), Buffer.from(value.ct, "base64"), aad)) as T;
  }

  encodeText(value: string, aad: string): string {
    if (!this.enabled) return value;
    const { kid, iv, tag, ct } = this.seal(value, aad);
    return `${TEXT_PREFIX}${kid}:${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
  }

  decodeText(stored: string, aad: string): string {
    if (!stored.startsWith(TEXT_PREFIX)) return stored;
    const rest = stored.slice(TEXT_PREFIX.length);
    const sep = rest.indexOf(":");
    const parts = rest.slice(sep + 1).split(".");
    if (sep < 0 || parts.length !== 3) return stored;
    const [iv, tag, ct] = parts.map((p) => Buffer.from(p, "base64url"));
    return this.open(rest.slice(0, sep), iv, tag, ct, aad);
  }
}

export function isEncryptedJson(value: unknown): value is EncryptedJson {
  return Boolean(value) && typeof value === "object" && (value as { __enc?: unknown }).__enc === ENCRYPTED_JSON_MARKER;
}
