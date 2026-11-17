// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import type { BitcoinNetwork } from "../common/types.js";
import { AccountSecurity, twoFactorCodecFromEnv } from "./account-security.js";
import { createSecondFactorGate, registerAccountSecurityRoutes, registerAdminTwoFactorHook, type AccountSecurityRouteDeps, type PasskeyStepUpDeps } from "./routes/account-security.js";
import { createDestinationActivator, createPayoutRegistrar } from "./routes/payout-destination.js";
import type { PortalStore } from "./store.js";

const HOUR_MS = 60 * 60 * 1000;
/** How often confirmed payout destinations whose cooling-off is over are saved and registered. */
export const DESTINATION_SWEEP_MS = 5 * 60 * 1000;

/**
 * The portal's account security (src/portal/account-security.ts), wired once from server.ts: the
 * engine, the second-factor gate the protected routes call, the payout registrar (also used to
 * pause and resume a locked account's payouts), the admin 2FA hook, the 2FA / emailed-link / unlock
 * routes, and the sweep that activates destinations after their cooling-off.
 */
export function setupAccountSecurity(
  app: FastifyInstance,
  d: {
    store: PortalStore | null | undefined;
    config: {
      PAYOUT_DEST_COOLDOWN_HOURS: number;
      PAYOUT_DEST_FIRST_COOLDOWN_HOURS: number;
      PAYOUT_DEST_CONFIRM_TTL_MINUTES: number;
      TWO_FACTOR_STEP_UP_MINUTES: number;
      ADMIN_2FA_GRACE_DAYS: number;
      PORTAL_2FA_KEY?: string;
      OAUTH_STATE_SECRET?: string;
    };
    getCurrentUser: AccountSecurityRouteDeps["getCurrentUser"];
    buildAccessContext: AccountSecurityRouteDeps["buildAccessContext"];
    registrar: Parameters<typeof createPayoutRegistrar>[0];
    passkey: PasskeyStepUpDeps;
    mail: Pick<AccountSecurityRouteDeps, "sendDestinationAdded" | "sendAccountLocked" | "sendTwoFactorChanged">;
  }
) {
  const { store, config: c } = d;
  const accountSecurity = store
    ? new AccountSecurity({
        store,
        codec: twoFactorCodecFromEnv(c),
        cooldownMs: c.PAYOUT_DEST_COOLDOWN_HOURS * HOUR_MS,
        firstCooldownMs: c.PAYOUT_DEST_FIRST_COOLDOWN_HOURS * HOUR_MS,
        confirmTtlMs: c.PAYOUT_DEST_CONFIRM_TTL_MINUTES * 60_000,
        stepUpTtlMs: c.TWO_FACTOR_STEP_UP_MINUTES * 60_000,
        adminGraceMs: c.ADMIN_2FA_GRACE_DAYS * 24 * HOUR_MS
      })
    : null;
  const secondFactor = createSecondFactorGate(accountSecurity, store);
  const payoutRegistrar = createPayoutRegistrar(d.registrar);
  const activateDueDestination = createDestinationActivator({ store, security: accountSecurity, register: payoutRegistrar, log: app.log });

  // Admin changes need the second factor (and system admins must enable it after ADMIN_2FA_GRACE_DAYS).
  registerAdminTwoFactorHook(app, { security: accountSecurity, store, getCurrentUser: d.getCurrentUser, buildAccessContext: d.buildAccessContext });
  registerAccountSecurityRoutes(app, {
    security: accountSecurity,
    store,
    getCurrentUser: d.getCurrentUser,
    buildAccessContext: d.buildAccessContext,
    passkey: d.passkey,
    ...d.mail,
    pausePayouts: (userId) => payoutRegistrar.clear(`acct-${userId}`),
    resumePayouts: async (userId) => {
      const current = await store?.getPayoutDestination(userId);
      if (current) await payoutRegistrar({ accountId: current.accountId, kind: current.kind, destination: current.destination, network: current.network as BitcoinNetwork });
      await activateDueDestination(userId);
    }
  });

  const sweep = setInterval(() => {
    if (!accountSecurity) return;
    void accountSecurity
      .listPendingUserIds()
      .then(async (ids) => {
        for (const id of ids) await activateDueDestination(id).catch(() => null);
      })
      .catch((error) => app.log.warn({ error: String(error) }, "payout_destination_sweep_failed"));
  }, DESTINATION_SWEEP_MS);
  sweep.unref();
  app.addHook("onClose", async () => clearInterval(sweep));

  return { accountSecurity, secondFactor, payoutRegistrar };
}
