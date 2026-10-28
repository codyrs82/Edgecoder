// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WalletRoutesDeps } from "../server.js";

/** #16: Wallet onboarding and send MFA (/wallet/*). Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerWalletRoutes(app: FastifyInstance, { PASSKEY_ALLOWED_ORIGINS, PASSKEY_RP_ID, RESEND_API_KEY, RESEND_FROM_EMAIL, WALLET_SEND_MFA_TTL_MS, ensureCreditAccountForUser, generateAuthenticationOptions, generateSixDigitCode, getCurrentUser, secureCompare, sendWalletSendMfaCodeEmail, setupWalletSeedForUser, sha256Hex, store, uint8ArrayFromBase64Url, verifyAuthenticationResponse }: WalletRoutesDeps): void {
  app.get("/wallet/onboarding", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const onboarding = await store.getWalletOnboardingByUserId(user.userId);
    if (!onboarding) return reply.code(404).send({ error: "wallet_onboarding_not_found" });
    return reply.send({
      accountId: onboarding.accountId,
      network: onboarding.network,
      derivedAddress: onboarding.derivedAddress,
      createdAtMs: onboarding.createdAtMs,
      acknowledgedAtMs: onboarding.acknowledgedAtMs
    });
  });

  app.post("/wallet/onboarding/setup-seed", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    await ensureCreditAccountForUser(user);
    const setup = await setupWalletSeedForUser(user);
    return reply.send({
      ok: true,
      accountId: setup.accountId,
      network: setup.network,
      derivedAddress: setup.derivedAddress,
      guidance: setup.guidance
    });
  });

  app.post("/wallet/onboarding/acknowledge", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    await store.acknowledgeWalletOnboarding(user.userId);
    return reply.send({ ok: true });
  });

  app.get("/wallet/send/requests", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const requests = await store.listWalletSendRequestsByUser(user.userId, 25);
    return reply.send({ requests });
  });

  app.post("/wallet/send/mfa/start", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const body = z
      .object({
        destination: z.string().min(10).max(220),
        amountSats: z.number().int().positive().max(100_000_000),
        note: z.string().max(280).optional()
      })
      .parse(req.body);

    const walletOnboarding = await store.getWalletOnboardingByUserId(user.userId);
    if (!walletOnboarding) return reply.code(409).send({ error: "wallet_onboarding_required" });
    const passkeys = await store.listPasskeysByUserId(user.userId);
    if (passkeys.length === 0) {
      return reply.code(409).send({ error: "passkey_required_for_wallet_send" });
    }
    if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
      return reply.code(503).send({ error: "email_mfa_not_configured" });
    }

    const passkeyOptions = await generateAuthenticationOptions({
      rpID: PASSKEY_RP_ID,
      timeout: 60000,
      userVerification: "required",
      allowCredentials: passkeys.map((item) => ({
        id: item.credentialId,
        transports: item.transports as any
      }))
    });

    const challengeId = randomUUID();
    const code = generateSixDigitCode();
    await store.createWalletSendMfaChallenge({
      challengeId,
      userId: user.userId,
      accountId: walletOnboarding.accountId,
      destination: body.destination.trim(),
      amountSats: body.amountSats,
      note: body.note?.trim() || undefined,
      emailCodeHash: sha256Hex(`${challengeId}:${code}`),
      passkeyChallenge: passkeyOptions.challenge,
      expiresAtMs: Date.now() + WALLET_SEND_MFA_TTL_MS
    });

    await sendWalletSendMfaCodeEmail({
      email: user.email,
      code,
      amountSats: body.amountSats,
      destination: body.destination.trim()
    });

    return reply.send({
      ok: true,
      challengeId,
      expiresAtMs: Date.now() + WALLET_SEND_MFA_TTL_MS,
      passkeyOptions
    });
  });

  app.post("/wallet/send/mfa/confirm", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const body = z
      .object({
        challengeId: z.string().min(10),
        emailCode: z.string().min(6).max(8),
        credentialId: z.string().min(10),
        response: z.unknown()
      })
      .parse(req.body);

    const challenge = await store.consumeWalletSendMfaChallenge(body.challengeId);
    if (!challenge || challenge.userId !== user.userId) {
      return reply.code(400).send({ error: "wallet_send_mfa_challenge_invalid" });
    }
    const expectedCodeHash = sha256Hex(`${challenge.challengeId}:${body.emailCode.trim()}`);
    if (!secureCompare(challenge.emailCodeHash, expectedCodeHash)) {
      return reply.code(401).send({ error: "wallet_send_email_code_invalid" });
    }

    const credential = await store.findPasskeyByCredentialId(body.credentialId);
    if (!credential || credential.userId !== user.userId) {
      return reply.code(404).send({ error: "passkey_credential_not_found" });
    }
    const verification = await verifyAuthenticationResponse({
      response: body.response as any,
      expectedChallenge: challenge.passkeyChallenge,
      expectedOrigin: PASSKEY_ALLOWED_ORIGINS,
      expectedRPID: PASSKEY_RP_ID,
      requireUserVerification: true,
      credential: {
        id: credential.credentialId,
        publicKey: uint8ArrayFromBase64Url(credential.publicKeyB64Url),
        counter: Number(credential.counter),
        transports: credential.transports as any
      }
    }).catch(() => null);
    if (!verification?.verified) {
      return reply.code(401).send({ error: "wallet_send_passkey_verification_failed" });
    }
    await store.updatePasskeyCounter(credential.credentialId, Number(verification.authenticationInfo.newCounter ?? credential.counter));

    const requestId = randomUUID();
    await store.createWalletSendRequest({
      requestId,
      userId: user.userId,
      accountId: challenge.accountId,
      destination: challenge.destination,
      amountSats: challenge.amountSats,
      note: challenge.note,
      status: "pending_manual_review",
      mfaChallengeId: challenge.challengeId
    });

    return reply.send({
      ok: true,
      request: {
        requestId,
        accountId: challenge.accountId,
        destination: challenge.destination,
        amountSats: challenge.amountSats,
        note: challenge.note,
        status: "pending_manual_review"
      }
    });
  });
}
