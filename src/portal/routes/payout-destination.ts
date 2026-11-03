// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import type { BitcoinNetwork } from "../../common/types.js";
import { PAYABLE_DESTINATION_KINDS, validatePayoutDestination } from "../../economy/payout-destination.js";
import type { PayoutDestinationChallenge, PayoutDestinationRecord } from "../store.js";
import type { CallbackChange } from "./payout-callback.js";

/**
 * "Where should we pay you?" (/wallet/payout-destination). The user gives a Lightning address
 * (or, once on-chain payouts exist, an address) from their own wallet; the portal never creates
 * or holds wallet keys. The destination is saved in the portal and registered as the account's
 * payout address with the control plane (/economy/wallets/register) and the coordinator that
 * runs automatic payouts (/economy/payouts/address). On the seeds both write the same
 * wallet_accounts row that listAutoPayoutAccounts reads.
 *
 * Setting the first destination needs only the session. Changing an existing one needs a
 * one-time code sent to the account's email: PUT without a code returns 202 with a challengeId,
 * PUT again with { challengeId, emailCode } applies it.
 */

export type PayoutDestinationStore = {
  getPayoutDestination(userId: string): Promise<PayoutDestinationRecord | null>;
  upsertPayoutDestination(input: { userId: string; accountId: string; kind: string; destination: string; network: string }): Promise<void>;
  createPayoutDestinationChallenge(input: { challengeId: string; userId: string; kind: string; destination: string; emailCodeHash: string; expiresAtMs: number }): Promise<void>;
  consumePayoutDestinationChallenge(challengeId: string): Promise<PayoutDestinationChallenge | null>;
  getWalletOnboardingByUserId(userId: string): Promise<{ invalidatedAtMs?: number; derivedAddress?: string } | null>;
};

export type RegistrationStatus = "ok" | "failed" | "not_configured";
export type PayoutRegistration = { controlPlane: RegistrationStatus; coordinator: RegistrationStatus };
export type PayoutRegistrar = (input: { accountId: string; kind: string; destination: string; network: BitcoinNetwork }) => Promise<PayoutRegistration>;

export interface PayoutDestinationRouteDeps {
  store: PayoutDestinationStore | null | undefined;
  getCurrentUser: (req: any) => Promise<{ userId: string; email: string } | null>;
  network: BitcoinNetwork;
  codeTtlMs: number;
  emailConfigured: boolean;
  sendCode: (input: { email: string; code: string; destination: string }) => Promise<void>;
  register: PayoutRegistrar;
  generateSixDigitCode: () => string;
  sha256Hex: (v: string) => string;
  secureCompare: (a: string, b: string) => boolean;
  /** The destination's pending payment-server change (routes/payout-callback.ts); omitted = not shown. */
  callbackChange?: (accountId: string, destination: string) => Promise<CallbackChange | null | undefined>;
}

/** Registers the destination with the control plane and the coordinator. Best effort: failures are reported, not thrown. */
export function createPayoutRegistrar(cfg: {
  controlPlaneUrl?: string;
  controlPlaneAdminToken?: string;
  portalServiceToken?: string;
  timeoutMs: number;
  discoverCoordinatorUrls: () => Promise<string[]>;
}): PayoutRegistrar {
  async function post(url: string, headers: Record<string, string>, body: unknown): Promise<RegistrationStatus> {
    try {
      const res = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        headersTimeout: cfg.timeoutMs,
        bodyTimeout: cfg.timeoutMs
      });
      await res.body.text().catch(() => "");
      return res.statusCode >= 200 && res.statusCode < 300 ? "ok" : "failed";
    } catch {
      return "failed";
    }
  }
  return async ({ accountId, kind, destination, network }) => {
    const walletType = kind === "onchain" ? "onchain" : "lightning";
    const controlPlane: Promise<RegistrationStatus> =
      cfg.controlPlaneUrl && cfg.controlPlaneAdminToken
        ? post(`${cfg.controlPlaneUrl.replace(/\/$/, "")}/economy/wallets/register`, { authorization: `Bearer ${cfg.controlPlaneAdminToken}` }, { accountId, walletType, network, payoutAddress: destination })
        : Promise.resolve("not_configured");
    const coordinator: Promise<RegistrationStatus> = (async () => {
      if (kind !== "lightning_address" || !cfg.portalServiceToken) return "not_configured";
      const urls = await cfg.discoverCoordinatorUrls().catch(() => [] as string[]);
      if (!urls.length) return "not_configured";
      return post(`${urls[0].replace(/\/$/, "")}/economy/payouts/address`, { "x-portal-service-token": cfg.portalServiceToken }, { accountId, lightningAddress: destination });
    })();
    return { controlPlane: await controlPlane, coordinator: await coordinator };
  };
}

const putBody = z.object({
  destination: z.string().max(512),
  challengeId: z.string().min(10).max(64).optional(),
  emailCode: z.string().min(6).max(8).optional()
});

export function registerPayoutDestinationRoutes(app: FastifyInstance, d: PayoutDestinationRouteDeps): void {
  const view = async (userId: string) => {
    const store = d.store!;
    const [current, legacy] = await Promise.all([store.getPayoutDestination(userId), store.getWalletOnboardingByUserId(userId)]);
    const change = current && current.kind === "lightning_address" && d.callbackChange ? await d.callbackChange(`acct-${userId}`, current.destination).catch(() => undefined) : null;
    return {
      accountId: `acct-${userId}`,
      network: d.network,
      destination: current ? { kind: current.kind, destination: current.destination, updatedAtMs: current.updatedAtMs } : null,
      needsDestination: !current,
      /** The account had a server-generated address from the removed seed flow; it is never paid. */
      legacyAddressRetired: Boolean(legacy),
      supportedKinds: [...PAYABLE_DESTINATION_KINDS],
      onchainSupported: PAYABLE_DESTINATION_KINDS.has("onchain"),
      changeRequiresEmailCode: true,
      /** The wallet's payment server (LNURL callback host) changed; payouts are held until confirmed with an email code. */
      callbackChange: change ? { previousOrigin: change.previousOrigin, newOrigin: change.newOrigin, changedAtMs: change.changedAtMs ?? null } : null
    };
  };

  app.get("/wallet/payout-destination", async (req, reply) => {
    if (!d.store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await d.getCurrentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    return reply.send(await view(user.userId));
  });

  app.put("/wallet/payout-destination", async (req, reply) => {
    const store = d.store;
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await d.getCurrentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const parsed = putBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: "Send { destination } as JSON." });
    const body = parsed.data;

    const v = validatePayoutDestination(body.destination, d.network);
    if (!v.ok) return reply.code(400).send({ error: v.error, detail: v.detail });
    if (!PAYABLE_DESTINATION_KINDS.has(v.kind)) {
      return reply.code(422).send({
        error: "onchain_payouts_not_supported",
        detail: "That address is valid, but on-chain payouts are not supported yet. Use a Lightning address (name@domain) from your wallet."
      });
    }

    const accountId = `acct-${user.userId}`;
    const current = await store.getPayoutDestination(user.userId);
    const changing = current !== null && current.destination !== v.destination;
    if (changing) {
      if (!body.challengeId || !body.emailCode) {
        if (!d.emailConfigured) return reply.code(503).send({ error: "email_mfa_not_configured", detail: "Changing a payout destination needs an email code, and email is not configured on this portal." });
        const challengeId = randomUUID();
        const code = d.generateSixDigitCode();
        const expiresAtMs = Date.now() + d.codeTtlMs;
        await store.createPayoutDestinationChallenge({ challengeId, userId: user.userId, kind: v.kind, destination: v.destination, emailCodeHash: d.sha256Hex(`${challengeId}:${code}`), expiresAtMs });
        await d.sendCode({ email: user.email, code, destination: v.destination });
        return reply.code(202).send({ verificationRequired: true, challengeId, expiresAtMs, detail: `We emailed a code to ${user.email}. Enter it to confirm the change.` });
      }
      const challenge = await store.consumePayoutDestinationChallenge(body.challengeId);
      if (!challenge || challenge.userId !== user.userId || challenge.destination !== v.destination) {
        return reply.code(400).send({ error: "payout_destination_challenge_invalid", detail: "That code has expired or was for a different address. Save again to get a new code." });
      }
      if (!d.secureCompare(challenge.emailCodeHash, d.sha256Hex(`${challenge.challengeId}:${body.emailCode.trim()}`))) {
        return reply.code(401).send({ error: "payout_destination_code_invalid", detail: "The code is not right. Save again to get a new code." });
      }
    }

    await store.upsertPayoutDestination({ userId: user.userId, accountId, kind: v.kind, destination: v.destination, network: v.network });
    const registration = await d.register({ accountId, kind: v.kind, destination: v.destination, network: v.network });
    req.log.info({ accountId, kind: v.kind, changed: changing, registration }, "payout_destination_saved");
    return reply.send({ ok: true, ...(await view(user.userId)), registration });
  });
}
