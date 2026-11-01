// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PasskeyRoutesDeps } from "../server.js";

/** #16: Passkey registration and login (/auth/passkey/*). Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerPasskeyRoutes(app: FastifyInstance, { PASSKEY_ALLOWED_ORIGINS, PASSKEY_CHALLENGE_TTL_MS, PASSKEY_RP_ID, PASSKEY_RP_NAME, base64UrlFromBuffer, createSessionForUser, deriveCredentialIdFromVerifyBody, generateAuthenticationOptions, generateRegistrationOptions, getCurrentUser, normalizeEmail, normalizePasskeyResponsePayload, store, uint8ArrayFromBase64Url, verifyAuthenticationResponse, verifyRegistrationResponse }: PasskeyRoutesDeps): void {
  app.post("/auth/passkey/register/options", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const existing = await store.listPasskeysByUserId(user.userId);
    const webauthnUserId = createHash("sha256").update(user.userId).digest().subarray(0, 16);
    const options = await generateRegistrationOptions({
      rpName: PASSKEY_RP_NAME,
      rpID: PASSKEY_RP_ID,
      userName: user.email,
      userID: webauthnUserId,
      attestationType: "none",
      timeout: 60000,
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred"
      },
      excludeCredentials: existing.map((item) => ({
        id: item.credentialId,
        transports: item.transports as any
      }))
    });
    const challengeId = randomUUID();
    await store.createPasskeyChallenge({
      challengeId,
      userId: user.userId,
      email: user.email,
      challenge: options.challenge,
      flowType: "registration",
      expiresAtMs: Date.now() + PASSKEY_CHALLENGE_TTL_MS
    });
    return reply.send({ challengeId, options });
  });

  app.post("/auth/passkey/register/verify", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const body = z
      .object({
        challengeId: z.string().min(10),
        response: z.unknown()
      })
      .parse(req.body);
    const challenge = await store.consumePasskeyChallenge(body.challengeId);
    if (!challenge || challenge.flowType !== "registration" || challenge.userId !== user.userId) {
      return reply.code(400).send({ error: "passkey_challenge_invalid" });
    }
    const normalizedResponse = normalizePasskeyResponsePayload(body.response);
    const verification = await verifyRegistrationResponse({
      response: normalizedResponse as any,
      expectedChallenge: challenge.challenge,
      expectedOrigin: PASSKEY_ALLOWED_ORIGINS,
      expectedRPID: PASSKEY_RP_ID,
      requireUserVerification: false
    }).catch(() => null);
    if (!verification?.verified || !verification.registrationInfo) {
      return reply.code(400).send({ error: "passkey_registration_failed" });
    }
    const reg = verification.registrationInfo;
    const webauthnUserId = base64UrlFromBuffer(createHash("sha256").update(user.userId).digest().subarray(0, 16));
    await store.upsertPasskeyCredential({
      credentialId: reg.credential.id,
      userId: user.userId,
      webauthnUserId,
      publicKeyB64Url: base64UrlFromBuffer(reg.credential.publicKey),
      counter: Number(reg.credential.counter ?? 0),
      deviceType: reg.credentialDeviceType,
      backedUp: reg.credentialBackedUp === true,
      transports: reg.credential.transports as string[] | undefined
    });
    return reply.send({ ok: true });
  });

  app.post("/auth/passkey/login/options", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const body = z.object({ email: z.string().email().optional() }).parse(req.body);
    const normalizedEmail = body.email ? normalizeEmail(body.email) : undefined;
    const user = normalizedEmail ? await store.getUserByEmail(normalizedEmail) : null;
    const credentials = user ? await store.listPasskeysByUserId(user.userId) : [];
    if (normalizedEmail && !user) return reply.code(404).send({ error: "user_not_found" });
    if (normalizedEmail && credentials.length === 0) return reply.code(404).send({ error: "passkey_not_registered" });
    const options = await generateAuthenticationOptions(
      credentials.length > 0
        ? {
            rpID: PASSKEY_RP_ID,
            timeout: 60000,
            userVerification: "preferred",
            allowCredentials: credentials.map((item) => ({
              id: item.credentialId,
              transports: item.transports as any
            }))
          }
        : {
            // Discoverable/passkey-first login when email is not provided.
            rpID: PASSKEY_RP_ID,
            timeout: 60000,
            userVerification: "preferred"
          }
    );
    const challengeId = randomUUID();
    await store.createPasskeyChallenge({
      challengeId,
      userId: user?.userId,
      email: user?.email,
      challenge: options.challenge,
      flowType: "authentication",
      expiresAtMs: Date.now() + PASSKEY_CHALLENGE_TTL_MS
    });
    return reply.send({ challengeId, options });
  });

  app.post("/auth/passkey/login/verify", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const body = z
      .object({
        challengeId: z.string().min(10),
        credentialId: z.string().min(10).optional(),
        response: z.unknown()
      })
      .parse(req.body);
    const challenge = await store.consumePasskeyChallenge(body.challengeId);
    if (!challenge || challenge.flowType !== "authentication") {
      return reply.code(400).send({ error: "passkey_challenge_invalid" });
    }
    const credentialId = deriveCredentialIdFromVerifyBody(body);
    if (!credentialId) return reply.code(400).send({ error: "passkey_credential_id_missing" });
    const credential = await store.findPasskeyByCredentialId(credentialId);
    if (!credential) return reply.code(404).send({ error: "passkey_credential_not_found" });
    const normalizedResponse = normalizePasskeyResponsePayload(body.response);
    const verification = await verifyAuthenticationResponse({
      response: normalizedResponse as any,
      expectedChallenge: challenge.challenge,
      expectedOrigin: PASSKEY_ALLOWED_ORIGINS,
      expectedRPID: PASSKEY_RP_ID,
      requireUserVerification: false,
      credential: {
        id: credential.credentialId,
        publicKey: uint8ArrayFromBase64Url(credential.publicKeyB64Url),
        counter: Number(credential.counter),
        transports: credential.transports as any
      }
    }).catch(() => null);
    if (!verification?.verified) return reply.code(401).send({ error: "passkey_login_failed" });
    await store.updatePasskeyCounter(credential.credentialId, Number(verification.authenticationInfo.newCounter ?? credential.counter));
    await createSessionForUser(credential.userId, reply);
    const user = await store.getUserById(credential.userId);
    return reply.send({ ok: true, user: user ? { userId: user.userId, email: user.email, emailVerified: user.emailVerified } : null });
  });
}
