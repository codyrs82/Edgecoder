// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Web chat text encrypted at rest: portal_messages.content and portal_conversations.title.
 *
 * AES-256-GCM with a key from PORTAL_CHAT_KEY (32 bytes, as 64 hex characters or base64, the same
 * format as PORTAL_BOT_SECRETS_KEY). A fresh 12-byte IV per value. Stored form:
 *
 *   enc:v1:<base64(iv[12] | tag[16] | ciphertext)>
 *
 * The row is bound as additional data (a message to its conversation and message id, a title to its
 * conversation id), so a ciphertext copied onto another row does not open.
 *
 * Reads accept values without the `enc:` prefix as plaintext (rows written before the key was set,
 * until scripts/ops/encrypt-chat-backfill.mjs seals them). Without the key, writes stay plaintext
 * and a one-time warning is logged (local dev and tests run without it).
 *
 * scripts/ops/encrypt-chat-backfill.mjs carries its own copy of seal() and the AAD strings (the
 * portal image ships dist/ only); tests/portal/chat-crypto.test.ts checks the two stay compatible.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { parseBotSecretsKey } from "./cloud-bots/secrets.js";
import { moduleLogger } from "../common/logger.js";

export const CHAT_ENC_PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Shown in place of a message or title that can't be opened (key missing or wrong, row tampered with). */
export const CHAT_UNREADABLE = "[This message can't be decrypted]";

/** The 32-byte key from PORTAL_CHAT_KEY, or null when unset or malformed (same format as PORTAL_BOT_SECRETS_KEY). */
export const parseChatKey = parseBotSecretsKey;

/** Additional data for a message's content. */
export function messageAad(conversationId: string, messageId: string): string {
  return `edgecoder-chat:message:${conversationId}:${messageId}`;
}

/** Additional data for a conversation's title. */
export function titleAad(conversationId: string): string {
  return `edgecoder-chat:title:${conversationId}`;
}

/** True for any value in the encrypted form (any `enc:` version). */
export function isSealed(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith("enc:");
}

export class ChatDecryptError extends Error {
  constructor(readonly reason: "no_key" | "bad_format" | "auth_failed") {
    super(`chat_decrypt_failed:${reason}`);
  }
}

type Warn = (msg: string) => void;
const defaultWarn: Warn = (msg) => moduleLogger("portal-chat-crypto").warn(msg);

export class ChatCipher {
  private readonly key: Buffer | null;
  private warnedPlaintext = false;

  constructor(key: Buffer | null, private readonly warn: Warn = defaultWarn) {
    this.key = key && key.length === 32 ? Buffer.from(key) : null;
  }

  static fromEnv(env: Record<string, string | undefined> = process.env, warn: Warn = defaultWarn): ChatCipher {
    const raw = env.PORTAL_CHAT_KEY;
    const key = parseChatKey(raw);
    if (!key && (raw ?? "").trim()) warn("PORTAL_CHAT_KEY is malformed (need 64 hex characters or base64 of 32 bytes): treated as unset");
    return new ChatCipher(key, warn);
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  /** `enc:v1:…` bound to `aad`; the plaintext unchanged (with a one-time warning) when no key is set. */
  seal(plaintext: string, aad: string): string {
    if (!this.key) {
      if (!this.warnedPlaintext) {
        this.warnedPlaintext = true;
        this.warn("PORTAL_CHAT_KEY is not set: web chat messages and titles are stored as plaintext");
      }
      return plaintext;
    }
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return CHAT_ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  }

  /** The plaintext. A value without the `enc:` prefix is returned as-is. Throws ChatDecryptError. */
  open(stored: string, aad: string): string {
    if (!isSealed(stored)) return stored;
    if (!stored.startsWith(CHAT_ENC_PREFIX)) throw new ChatDecryptError("bad_format");
    if (!this.key) throw new ChatDecryptError("no_key");
    const raw = Buffer.from(stored.slice(CHAT_ENC_PREFIX.length), "base64");
    if (raw.length < IV_BYTES + TAG_BYTES) throw new ChatDecryptError("bad_format");
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, IV_BYTES));
      d.setAAD(Buffer.from(aad, "utf8"));
      d.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([d.update(raw.subarray(IV_BYTES + TAG_BYTES)), d.final()]).toString("utf8");
    } catch {
      throw new ChatDecryptError("auth_failed");
    }
  }

  /** open(), or CHAT_UNREADABLE (logged without the value) so one bad row doesn't break a chat page. */
  openOrPlaceholder(stored: string, aad: string): string {
    try {
      return this.open(stored, aad);
    } catch (err) {
      this.warn(`chat value could not be decrypted (${err instanceof ChatDecryptError ? err.reason : "error"})`);
      return CHAT_UNREADABLE;
    }
  }

  /** Never print the key. */
  toJSON(): string {
    return "[ChatCipher]";
  }
}
