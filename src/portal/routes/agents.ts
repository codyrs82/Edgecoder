// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI agents as users: an agent signs up with a public key instead of an email.
 *
 *   POST /agents/challenge { keyType, publicKey }                          -> { nonce, challenge, expiresAtMs }
 *   POST /agents/signup    { keyType, publicKey, nonce, signature, name? } -> { accountId, apiKey, created }
 *
 * The agent signs sha256(utf8(challenge)): BIP-340 Schnorr for "secp256k1" (a Nostr key, 32-byte
 * x-only public key hex) or Ed25519 for "ed25519". A challenge lives 5 minutes, is bound to the
 * key it was issued for and is used once. The first signup creates an agent account (no email, no
 * password); signing up again with the same key rotates its API key: every earlier key is revoked
 * and a new one is returned (shown once). Both routes share the auth rate limit (security.ts).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PortalStore } from "../store.js";

export const AGENT_CHALLENGE_TTL_MS = 5 * 60_000;
export const AGENT_KEY_TYPES = ["secp256k1", "ed25519"] as const;
export type AgentKeyType = (typeof AGENT_KEY_TYPES)[number];

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest();
const hex = (n: number) =>
  z
    .string()
    .regex(new RegExp(`^[0-9a-fA-F]{${n}}$`))
    .transform((s) => s.toLowerCase());

/** The text an agent signs (sha256 of its UTF-8 bytes). Names the key so a signature can't be moved to another. */
export function agentChallengeText(nonce: string, keyType: string, publicKey: string, expiresAtMs: number): string {
  return `EdgeCoder agent signup\nkey: ${keyType}:${publicKey}\nnonce: ${nonce}\nexpires: ${new Date(expiresAtMs).toISOString()}`;
}

/** Checks a signature over sha256(challenge); false for malformed input rather than throwing. */
export function verifyAgentSignature(keyType: AgentKeyType, publicKeyHex: string, challenge: string, signatureHex: string): boolean {
  try {
    const msg = new Uint8Array(sha256(challenge));
    const sig = Uint8Array.from(Buffer.from(signatureHex, "hex"));
    const pub = Uint8Array.from(Buffer.from(publicKeyHex, "hex"));
    return keyType === "secp256k1" ? schnorr.verify(sig, msg, pub) : ed25519.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

export type AgentStore = Pick<PortalStore, "createAgentChallenge" | "consumeAgentChallenge" | "userForAgentKey" | "createAgentAccount" | "revokeAllApiKeys">;

export interface AgentRoutesDeps {
  store: AgentStore | undefined | null;
  /** Mints a hosted API key for a user (hosted.ts); returns the key, shown once. */
  issueApiKey: (userId: string, name: string) => Promise<string>;
  /** Called once for a new agent account (e.g. to open its credit account). */
  onAgentCreated?: (user: { userId: string; email: string }) => Promise<void>;
  /** New agent accounts allowed per hour on this instance (on top of the per-IP rate limit). */
  maxNewAccountsPerHour?: number;
  now?: () => number;
}

const keySchema = z.object({ keyType: z.enum(AGENT_KEY_TYPES), publicKey: hex(64) });

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRoutesDeps): void {
  const now = deps.now ?? Date.now;
  const maxPerHour = deps.maxNewAccountsPerHour ?? (Number(process.env.AGENT_SIGNUPS_PER_HOUR) || 500);
  let windowStart = 0;
  let createdInWindow = 0;

  app.post("/agents/challenge", async (req, reply) => {
    const { store } = deps;
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const parsed = keySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_key", detail: "keyType: secp256k1 (x-only, 32-byte hex) or ed25519 (32-byte hex); publicKey: hex" });
    const { keyType, publicKey } = parsed.data;
    const nonce = randomBytes(32).toString("hex");
    const expiresAtMs = now() + AGENT_CHALLENGE_TTL_MS;
    await store.createAgentChallenge({ nonceHash: sha256(nonce).toString("hex"), keyType, publicKey, expiresAtMs });
    return reply.send({ nonce, challenge: agentChallengeText(nonce, keyType, publicKey, expiresAtMs), expiresAtMs, sign: "sha256(utf8(challenge))" });
  });

  app.post("/agents/signup", async (req, reply) => {
    const { store } = deps;
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const parsed = keySchema
      .extend({
        nonce: hex(64),
        signature: hex(128),
        name: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .regex(/^[^<>\u0000-\u001f]*$/)
          .optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_signup" });
    const { keyType, publicKey, nonce, signature, name } = parsed.data;
    // Single use: taken out before anything else, so a replay finds nothing whatever the outcome.
    const challenge = await store.consumeAgentChallenge(sha256(nonce).toString("hex"));
    if (!challenge) return reply.code(401).send({ error: "unknown_challenge" });
    if (challenge.expiresAtMs <= now()) return reply.code(401).send({ error: "challenge_expired" });
    if (challenge.keyType !== keyType || challenge.publicKey !== publicKey) return reply.code(401).send({ error: "challenge_key_mismatch" });
    if (!verifyAgentSignature(keyType, publicKey, agentChallengeText(nonce, keyType, publicKey, challenge.expiresAtMs), signature)) {
      return reply.code(401).send({ error: "signature_invalid" });
    }

    let userId = await store.userForAgentKey(keyType, publicKey);
    let created = false;
    if (!userId) {
      if (now() - windowStart > 3_600_000) {
        windowStart = now();
        createdInWindow = 0;
      }
      if (createdInWindow >= maxPerHour) return reply.code(429).send({ error: "agent_signups_paused", retryAfter: "1 hour" });
      createdInWindow++;
      const fresh = randomUUID();
      userId = await store.createAgentAccount({ userId: fresh, keyType, publicKey, displayName: name });
      created = userId === fresh;
      if (created) await deps.onAgentCreated?.({ userId, email: name ?? `agent ${publicKey.slice(0, 12)}` }).catch(() => undefined);
    }
    // Rotation: a signed re-signup replaces every earlier key of this account.
    const revokedKeys = created ? 0 : await store.revokeAllApiKeys(userId);
    const apiKey = await deps.issueApiKey(userId, name ?? "agent");
    return reply.send({ accountId: `acct-${userId}`, apiKey, created, revokedKeys });
  });
}
