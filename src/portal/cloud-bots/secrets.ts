// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Cloud bot secrets (a bot's GitHub token) encrypted at rest: AES-256-GCM with a key from
 * PORTAL_BOT_SECRETS_KEY (32 bytes, as 64 hex characters or base64). A fresh 12-byte IV per value;
 * the bot id is bound as additional data, so a ciphertext copied onto another bot's row won't open.
 *
 * Without the key the GitHub features are off (BotSecrets.enabled false, with a message for the
 * page). A plaintext secret is never returned to a client, logged or put in an error message: it
 * leaves this module only towards api.github.com (cloud-bots/github.ts).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const BOT_SECRETS_DISABLED_MESSAGE = "GitHub for cloud bits isn't set up on this server yet (PORTAL_BOT_SECRETS_KEY).";
const VERSION = "v1";

/** The 32-byte key from PORTAL_BOT_SECRETS_KEY, or null when unset or malformed. */
export function parseBotSecretsKey(raw: string | undefined): Buffer | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  try {
    const b = Buffer.from(v, "base64");
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

export class BotSecrets {
  private readonly key: Buffer | null;

  constructor(key: Buffer | null) {
    this.key = key && key.length === 32 ? Buffer.from(key) : null;
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): BotSecrets {
    return new BotSecrets(parseBotSecretsKey(env.PORTAL_BOT_SECRETS_KEY));
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  /** "v1.<iv>.<tag>.<ciphertext>" (base64url). Throws when the key isn't set. */
  encrypt(plaintext: string, boundTo: string): string {
    if (!this.key) throw new Error("bot_secrets_disabled");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(`edgecoder-cloud-bot:${boundTo}`));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return [VERSION, iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
  }

  /** The plaintext, or null when the key is unset, the value was tampered with or belongs to another bot. */
  decrypt(sealed: string | null | undefined, boundTo: string): string | null {
    if (!this.key || !sealed) return null;
    const parts = sealed.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) return null;
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(parts[1], "base64url"));
      d.setAAD(Buffer.from(`edgecoder-cloud-bot:${boundTo}`));
      d.setAuthTag(Buffer.from(parts[2], "base64url"));
      return Buffer.concat([d.update(Buffer.from(parts[3], "base64url")), d.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  /** Never print the key. */
  toJSON(): string {
    return "[BotSecrets]";
  }
}
