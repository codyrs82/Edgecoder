// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";

/** Same rule as sign-up (/auth/signup); both routes use this schema. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
/** Per-email limit: at most this many reset links per account per window (on top of the per-IP route limit). */
export const PASSWORD_RESET_MAX_PER_EMAIL = 3;
export const PASSWORD_RESET_EMAIL_WINDOW_MS = 60 * 60 * 1000;

/** The only answer /auth/password/forgot gives, whether or not the address has an account. */
export const FORGOT_PASSWORD_RESPONSE = {
  ok: true,
  message: "If an account exists for that email, we sent a link to reset its password. Check your inbox."
} as const;
export const RESET_LINK_INVALID = "reset_link_invalid";

export interface PasswordResetStore {
  getUserByEmail(email: string): Promise<{ userId: string; email: string; passwordHash?: string | null } | null>;
  createPasswordReset(input: { tokenHash: string; userId: string; expiresAtMs: number }): Promise<void>;
  consumePasswordReset(tokenHash: string): Promise<{ userId: string } | null>;
  invalidatePasswordResets(userId: string): Promise<void>;
  countRecentPasswordResets(userId: string, sinceMs: number): Promise<number>;
  setUserPassword(userId: string, passwordHash: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<void>;
  markUserEmailVerified(userId: string): Promise<void>;
}

export interface PasswordResetDeps {
  store: PasswordResetStore | null | undefined;
  hashPassword: (password: string) => string;
  normalizeEmail: (email: string) => string;
  sha256Hex: (value: string) => string;
  sendPasswordResetEmail: (email: string, resetToken: string, ttlMinutes: number) => Promise<void>;
  sendPasswordResetSsoNoticeEmail: (email: string) => Promise<void>;
}

/**
 * Forgot / reset password (/auth/password/*). Per-IP rate limits come from security.ts rateLimitFor.
 * Accounts without a password (OAuth- or passkey-only) get an email pointing them at their SSO
 * provider instead of a link, so a reset can never add a password to an SSO account.
 */
export function registerPasswordResetRoutes(app: FastifyInstance, deps: PasswordResetDeps): void {
  const { store, hashPassword, normalizeEmail, sha256Hex } = deps;

  async function handleForgot(email: string): Promise<void> {
    if (!store) return;
    const user = await store.getUserByEmail(email);
    if (!user) return;
    const recent = await store.countRecentPasswordResets(user.userId, Date.now() - PASSWORD_RESET_EMAIL_WINDOW_MS);
    if (recent >= PASSWORD_RESET_MAX_PER_EMAIL) return;
    if (!user.passwordHash) {
      // Recorded as an (unusable) row so the per-email limit also covers these notices.
      await store.createPasswordReset({ tokenHash: sha256Hex(randomBytes(32).toString("hex")), userId: user.userId, expiresAtMs: Date.now() });
      await deps.sendPasswordResetSsoNoticeEmail(user.email);
      return;
    }
    const token = randomBytes(32).toString("base64url");
    await store.createPasswordReset({ tokenHash: sha256Hex(token), userId: user.userId, expiresAtMs: Date.now() + PASSWORD_RESET_TTL_MS });
    await deps.sendPasswordResetEmail(user.email, token, Math.round(PASSWORD_RESET_TTL_MS / 60000));
  }

  app.post("/auth/password/forgot", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const parsed = z.object({ email: z.string().email().max(320) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_email" });
    // Not awaited: the reply must not take longer for an address that has an account.
    handleForgot(normalizeEmail(parsed.data.email)).catch((err) => req.log.error({ err }, "password reset request failed"));
    return reply.send(FORGOT_PASSWORD_RESPONSE);
  });

  app.post("/auth/password/reset", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const parsed = z.object({ token: z.string().min(16).max(256), password: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: RESET_LINK_INVALID, message: "This reset link has expired or was already used." });
    const password = passwordSchema.safeParse(parsed.data.password);
    if (!password.success) {
      return reply.code(400).send({ error: "weak_password", message: `Use ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.` });
    }
    const consumed = await store.consumePasswordReset(sha256Hex(parsed.data.token));
    if (!consumed) return reply.code(400).send({ error: RESET_LINK_INVALID, message: "This reset link has expired or was already used." });
    await store.setUserPassword(consumed.userId, hashPassword(password.data));
    await store.invalidatePasswordResets(consumed.userId);
    await store.deleteSessionsForUser(consumed.userId);
    // The link was delivered to the inbox, so the address is proven.
    await store.markUserEmailVerified(consumed.userId);
    return reply.send({ ok: true });
  });
}
