// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { z } from "zod";
import type { BitcoinNetwork } from "../../common/types.js";
import { payableDestinationKinds, validatePayoutDestination } from "../../economy/payout-destination.js";
import { validateOnchainPayoutAddress } from "../../economy/onchain.js";
import type { PayoutDestinationChallenge, PayoutDestinationRecord } from "../store.js";
import type { AccountSecurity, PendingDestination } from "../account-security.js";
import type { SecondFactorGate } from "./account-security.js";
import type { CallbackChange } from "./payout-callback.js";

/**
 * "Where should we pay you?" (/wallet/payout-destination). The user gives a Lightning address
 * or, with ONCHAIN_ENABLED, a Bitcoin address (bech32/bech32m on the portal's network) from their
 * own wallet; the portal never creates or holds wallet keys. The destination is saved in the
 * portal and registered as the account's payout address with the control plane
 * (/economy/wallets/register) and the coordinator that runs payouts: /economy/payouts/address for
 * a Lightning address (automatic LNURL payouts), /economy/payouts/onchain-address for a Bitcoin
 * address (batched on-chain payouts). An account has one destination; setting one clears the other.
 *
 * Adding or changing a destination (src/portal/account-security.ts) needs, with 2FA on, the second
 * factor; then a confirmation from the account's email: PUT returns 202 and emails a link (and the
 * same confirmation as a code: PUT again with { challengeId, emailCode } from the app). A confirmed
 * destination waits out a cooling-off (PAYOUT_DEST_COOLDOWN_HOURS, or PAYOUT_DEST_FIRST_COOLDOWN_HOURS
 * for an account's first one) before it is saved and registered; until then the old destination
 * keeps receiving automatic payouts, manual withdrawals are refused, and the owner is emailed a
 * one-click cancel link. A locked account cannot change its destination.
 */

export type PayoutDestinationStore = {
  getPayoutDestination(userId: string): Promise<PayoutDestinationRecord | null>;
  upsertPayoutDestination(input: { userId: string; accountId: string; kind: string; destination: string; network: string }): Promise<void>;
  /** Emailed-code challenges (used by routes/payout-callback.ts for the payment-server change). */
  createPayoutDestinationChallenge(input: { challengeId: string; userId: string; kind: string; destination: string; emailCodeHash: string; expiresAtMs: number }): Promise<void>;
  consumePayoutDestinationChallenge(challengeId: string): Promise<PayoutDestinationChallenge | null>;
  getWalletOnboardingByUserId(userId: string): Promise<{ invalidatedAtMs?: number; derivedAddress?: string } | null>;
};

export type RegistrationStatus = "ok" | "failed" | "not_configured";
export type PayoutRegistration = { controlPlane: RegistrationStatus; coordinator: RegistrationStatus };
export type PayoutRegistrar = (input: { accountId: string; kind: string; destination: string; network: BitcoinNetwork }) => Promise<PayoutRegistration>;

/**
 * Saves a change whose cooling-off is over and registers it. Called by the sweep (server.ts) and
 * on the account's own requests, so a due change never waits long. Returns what was activated.
 */
export function createDestinationActivator(d: {
  store: Pick<PayoutDestinationStore, "upsertPayoutDestination"> | null | undefined;
  security: AccountSecurity | null;
  register: PayoutRegistrar;
  log?: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
}): (userId: string) => Promise<PendingDestination | null> {
  return async (userId) => {
    if (!d.store || !d.security) return null;
    const p = await d.security.takeDueDestination(userId);
    if (!p) return null;
    const accountId = `acct-${userId}`;
    try {
      await d.store.upsertPayoutDestination({ userId, accountId, kind: p.kind, destination: p.destination, network: p.network });
    } catch (error) {
      // Put it back for the next sweep.
      await d.security.update(userId, (s) => (s.payout ? { write: false, result: undefined } : ((s.payout = p), { write: true, result: undefined }))).catch(() => undefined);
      d.log?.error({ userId, error: String(error) }, "payout_destination_activate_failed");
      return null;
    }
    const registration = await d.register({ accountId, kind: p.kind, destination: p.destination, network: p.network as BitcoinNetwork });
    d.log?.info({ accountId, kind: p.kind, registration }, "payout_destination_activated");
    return p;
  };
}

export interface PayoutDestinationRouteDeps {
  store: PayoutDestinationStore | null | undefined;
  getCurrentUser: (req: any) => Promise<{ userId: string; email: string; emailVerified?: boolean } | null>;
  network: BitcoinNetwork;
  emailConfigured: boolean;
  register: PayoutRegistrar;
  /** Pending changes, cooling-off and lock (src/portal/account-security.ts). */
  security: AccountSecurity | null;
  /** 2FA for the change (routes/account-security.ts). */
  secondFactor: SecondFactorGate;
  /** The confirmation email: link token and code. */
  sendConfirm: (input: { email: string; destination: string; token: string; code: string; ttlMinutes: number; cooldownHours: number }) => Promise<void>;
  /** Sent once a change is confirmed: when it takes effect, and the cancel link. */
  sendAdded: (input: { email: string; destination: string; activatesAtMs: number; cancelToken: string }) => Promise<unknown>;
  /** ONCHAIN_ENABLED: Bitcoin addresses can be saved as the payout destination. */
  onchainEnabled?: boolean;
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
}): PayoutRegistrar & { clear: (accountId: string) => Promise<RegistrationStatus> } {
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
  const register: PayoutRegistrar = async ({ accountId, kind, destination, network }) => {
    const walletType = kind === "onchain" ? "onchain" : "lightning";
    const controlPlane: Promise<RegistrationStatus> =
      cfg.controlPlaneUrl && cfg.controlPlaneAdminToken
        ? post(`${cfg.controlPlaneUrl.replace(/\/$/, "")}/economy/wallets/register`, { authorization: `Bearer ${cfg.controlPlaneAdminToken}` }, { accountId, walletType, network, payoutAddress: destination })
        : Promise.resolve("not_configured");
    const coordinator: Promise<RegistrationStatus> = (async () => {
      if ((kind !== "lightning_address" && kind !== "onchain") || !cfg.portalServiceToken) return "not_configured";
      const urls = await cfg.discoverCoordinatorUrls().catch(() => [] as string[]);
      if (!urls.length) return "not_configured";
      const base = urls[0].replace(/\/$/, "");
      const headers = { "x-portal-service-token": cfg.portalServiceToken };
      return kind === "onchain"
        ? post(`${base}/economy/payouts/onchain-address`, headers, { accountId, address: destination })
        : post(`${base}/economy/payouts/address`, headers, { accountId, lightningAddress: destination });
    })();
    return { controlPlane: await controlPlane, coordinator: await coordinator };
  };
  /**
   * Lock (routes/account-security.ts): clears the account's Lightning and on-chain payout address at
   * the coordinator, so automatic payouts stop. The portal keeps the saved destination; unlocking
   * registers it again.
   */
  const clear = async (accountId: string): Promise<RegistrationStatus> => {
    if (!cfg.portalServiceToken) return "not_configured";
    const urls = await cfg.discoverCoordinatorUrls().catch(() => [] as string[]);
    if (!urls.length) return "not_configured";
    const base = urls[0].replace(/\/$/, "");
    const headers = { "x-portal-service-token": cfg.portalServiceToken };
    const [ln, chain] = await Promise.all([
      post(`${base}/economy/payouts/address`, headers, { accountId, lightningAddress: null }),
      post(`${base}/economy/payouts/onchain-address`, headers, { accountId, address: null })
    ]);
    return ln === "ok" && chain === "ok" ? "ok" : "failed";
  };
  return Object.assign(register, { clear });
}

const putBody = z.object({
  destination: z.string().max(512),
  challengeId: z.string().min(10).max(64).optional(),
  emailCode: z.string().min(6).max(8).optional(),
  twoFactorCode: z.string().max(32).optional()
});

const HOUR_MS = 60 * 60 * 1000;

export function registerPayoutDestinationRoutes(app: FastifyInstance, d: PayoutDestinationRouteDeps): void {
  const payable = payableDestinationKinds(d.onchainEnabled === true);
  const sec = d.security;
  const cooldownHours = (sec?.cfg.cooldownMs ?? 0) / HOUR_MS;
  const firstCooldownHours = (sec?.cfg.firstCooldownMs ?? 0) / HOUR_MS;
  const activate = createDestinationActivator({ store: d.store, security: sec, register: d.register, log: app.log });

  const view = async (userId: string, sec: AccountSecurity) => {
    const store = d.store!;
    await activate(userId).catch(() => null);
    const [current, legacy, state] = await Promise.all([store.getPayoutDestination(userId), store.getWalletOnboardingByUserId(userId), sec.load(userId)]);
    const change = current && current.kind === "lightning_address" && d.callbackChange ? await d.callbackChange(`acct-${userId}`, current.destination).catch(() => undefined) : null;
    const p = state.payout;
    return {
      accountId: `acct-${userId}`,
      network: d.network,
      destination: current ? { kind: current.kind, destination: current.destination, updatedAtMs: current.updatedAtMs } : null,
      needsDestination: !current && !p?.confirmedAtMs,
      /** The account had a server-generated address from the removed seed flow; it is never paid. */
      legacyAddressRetired: Boolean(legacy),
      supportedKinds: [...payable],
      onchainSupported: payable.has("onchain"),
      changeRequiresEmailCode: true,
      /** A requested change: waiting for the email confirmation, or confirmed and cooling off until activatesAtMs. */
      pendingDestination: p
        ? { kind: p.kind, destination: p.destination, first: p.first, confirmed: Boolean(p.confirmedAtMs), confirmExpiresAtMs: p.confirmExpiresAtMs, activatesAtMs: p.activatesAtMs ?? null }
        : null,
      cooldownHours,
      firstCooldownHours,
      locked: Boolean(state.lock),
      /** The wallet's payment server (LNURL callback host) changed; payouts are held until confirmed with an email code. */
      callbackChange: change ? { previousOrigin: change.previousOrigin, newOrigin: change.newOrigin, changedAtMs: change.changedAtMs ?? null } : null
    };
  };

  app.get("/wallet/payout-destination", async (req, reply) => {
    if (!d.store || !sec) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await d.getCurrentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    return reply.send(await view(user.userId, sec));
  });

  app.put("/wallet/payout-destination", async (req, reply) => {
    const store = d.store;
    if (!store || !sec) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await d.getCurrentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const parsed = putBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: "Send { destination } as JSON." });
    const body = parsed.data;

    const v = validatePayoutDestination(body.destination, d.network);
    if (!v.ok) return reply.code(400).send({ error: v.error, detail: v.detail });
    if (!payable.has(v.kind)) {
      return reply.code(422).send({
        error: "onchain_payouts_not_supported",
        detail: "That address is valid, but on-chain payouts are not supported yet. Use a Lightning address (name@domain) from your wallet."
      });
    }
    if (v.kind === "onchain") {
      // Batched payouts pay SegWit and Taproot outputs only (bc1 / tb1 / bcrt1).
      const chain = validateOnchainPayoutAddress(v.destination, d.network);
      if (!chain.ok) return reply.code(400).send({ error: chain.error, detail: chain.detail });
    }

    const state = await sec.load(user.userId);
    if (state.lock) return reply.code(423).send({ error: "account_locked", detail: "This account is locked: payouts and payout address changes are paused. Contact support to unlock it." });
    await activate(user.userId).catch(() => null);
    const current = await store.getPayoutDestination(user.userId);

    // The emailed code, typed in the app (the link in the same email does the same).
    if (body.challengeId && body.emailCode) {
      const r = await sec.confirmDestinationByCode(user.userId, body.challengeId, body.emailCode, v.destination);
      if (!r) return reply.code(400).send({ error: "payout_destination_challenge_invalid", detail: "That code has expired, was already used, is not right, or was for a different address. Save again to get a new one." });
      await d.sendAdded({ email: user.email, destination: r.pending.destination, activatesAtMs: r.pending.activatesAtMs!, cancelToken: r.cancelToken }).catch((e) => req.log.warn({ error: String(e) }, "payout_destination_notice_failed"));
      req.log.info({ accountId: `acct-${user.userId}`, activatesAtMs: r.pending.activatesAtMs }, "payout_destination_confirmed");
      return reply.send({ ok: true, ...(await view(user.userId, sec)) });
    }

    if (current && current.destination === v.destination) {
      // Back to the address already in use: drop any pending change.
      if (state.payout) await sec.cancelDestination(user.userId);
      return reply.send({ ok: true, ...(await view(user.userId, sec)) });
    }

    const check = await d.secondFactor(req, user);
    if (!check.ok) return reply.code(check.status).send(check.body);
    if (user.emailVerified === false) return reply.code(403).send({ error: "email_not_verified", detail: "Verify your email first: payout addresses are confirmed by email." });
    if (!d.emailConfigured) return reply.code(503).send({ error: "email_mfa_not_configured", detail: "Payout addresses are confirmed by email, and email is not configured on this portal." });

    const first = !current;
    const request = await sec.requestDestination(user.userId, { kind: v.kind, destination: v.destination, network: v.network, first });
    const hours = first ? firstCooldownHours : cooldownHours;
    await d.sendConfirm({ email: user.email, destination: v.destination, token: request.token, code: request.code, ttlMinutes: Math.round(sec.cfg.confirmTtlMs / 60000), cooldownHours: hours });
    req.log.info({ accountId: `acct-${user.userId}`, kind: v.kind, first }, "payout_destination_requested");
    return reply.code(202).send({
      verificationRequired: true,
      confirmation: "email_link",
      challengeId: request.id,
      expiresAtMs: request.expiresAtMs,
      cooldownHours: hours,
      detail: `We emailed a confirmation link (and code) to ${user.email}. After you confirm, payouts go to this address in ${hours} ${hours === 1 ? "hour" : "hours"}.`
    });
  });

  /** Cancel a requested or cooling-off change from the signed-in Wallet page. */
  app.post("/wallet/payout-destination/cancel", async (req, reply) => {
    if (!d.store || !sec) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await d.getCurrentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const p = await sec.cancelDestination(user.userId);
    if (!p) return reply.code(409).send({ error: "no_pending_destination" });
    req.log.info({ accountId: `acct-${user.userId}` }, "payout_destination_cancelled");
    return reply.send({ ok: true, ...(await view(user.userId, sec)) });
  });
}
