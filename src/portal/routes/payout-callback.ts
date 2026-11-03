// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import type { PayoutDestinationStore } from "./payout-destination.js";

/**
 * Lightning callback pinning, portal side (src/economy/lnurl-callback-pin.ts has the rules).
 *
 * The coordinator pins the LNURL callback origin of each payout destination on first use. When a
 * payout finds a different origin it holds the payout, marks the destination `callback_changed`,
 * and calls POST /internal/payouts/callback-changed once. That handler does not trust the hosts in
 * the request: it re-reads the state from a coordinator with the portal's own service token and
 * emails the owner what it found. The Plan & usage card (and the desktop Credits page) read the
 * same state through GET /wallet/payout-destination (`callbackChange`), and the owner confirms the
 * new server with an emailed one-time code at POST /wallet/payout-destination/callback/confirm,
 * which re-pins on the coordinator and resumes payouts.
 */

export type CallbackChange = { destination: string; previousOrigin: string; newOrigin: string; changedAtMs?: number };

export interface PayoutCallbackClient {
  /** The destination's pending change, null when there is none, undefined when no coordinator answered. */
  pendingChange(accountId: string, destination: string): Promise<CallbackChange | null | undefined>;
  confirm(accountId: string, destination: string, newOrigin: string): Promise<"ok" | "not_pending" | "failed">;
}

type PinStatus = { destination: string; origin: string; state: string; changedOrigin?: string; changedAtMs?: number };

/** Talks to the coordinator that runs payouts (same discovery and token as the destination registrar). */
export function createPayoutCallbackClient(cfg: { portalServiceToken?: string; timeoutMs: number; discoverCoordinatorUrls: () => Promise<string[]> }): PayoutCallbackClient {
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: any } | null> {
    if (!cfg.portalServiceToken) return null;
    const urls = await cfg.discoverCoordinatorUrls().catch(() => [] as string[]);
    if (!urls.length) return null;
    try {
      const res = await request(`${urls[0].replace(/\/$/, "")}${path}`, {
        method,
        headers: { "x-portal-service-token": cfg.portalServiceToken, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        headersTimeout: cfg.timeoutMs,
        bodyTimeout: cfg.timeoutMs
      });
      const json = await res.body.json().catch(() => ({}));
      return { status: res.statusCode, json };
    } catch {
      return null;
    }
  }
  return {
    async pendingChange(accountId, destination) {
      const r = await call("GET", `/economy/payouts/${encodeURIComponent(accountId)}`);
      if (!r || r.status < 200 || r.status >= 300) return undefined;
      const pins: PinStatus[] = Array.isArray(r.json?.callbackPins) ? r.json.callbackPins : [];
      const p = pins.find((x) => x.destination === destination && x.state === "callback_changed" && typeof x.changedOrigin === "string");
      return p ? { destination, previousOrigin: p.origin, newOrigin: p.changedOrigin!, changedAtMs: p.changedAtMs } : null;
    },
    async confirm(accountId, destination, newOrigin) {
      const r = await call("POST", "/economy/payouts/callback/confirm", { accountId, destination, newOrigin });
      if (!r) return "failed";
      if (r.status === 409) return "not_pending";
      return r.status >= 200 && r.status < 300 ? "ok" : "failed";
    }
  };
}

/** Host part of an origin for display ("https://pay.example.com:8443" -> "pay.example.com:8443"). */
export function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export interface PayoutCallbackRouteDeps {
  store: PayoutDestinationStore | null | undefined;
  getCurrentUser: (req: any) => Promise<{ userId: string; email: string } | null>;
  client: PayoutCallbackClient;
  codeTtlMs: number;
  emailConfigured: boolean;
  sendCode: (input: { email: string; code: string; destination: string; previousHost: string; newHost: string }) => Promise<void>;
  generateSixDigitCode: () => string;
  sha256Hex: (v: string) => string;
  secureCompare: (a: string, b: string) => boolean;
}

/** Challenge rows are shared with destination changes; this prefix keeps the two from being swapped. */
const challengeDestination = (destination: string, newOrigin: string) => `callback:${destination}|${newOrigin}`;

const confirmBody = z.object({ challengeId: z.string().min(10).max(64).optional(), emailCode: z.string().min(6).max(8).optional() });

export function registerPayoutCallbackRoutes(app: FastifyInstance, d: PayoutCallbackRouteDeps): void {
  app.post("/wallet/payout-destination/callback/confirm", async (req, reply) => {
    const store = d.store;
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await d.getCurrentUser(req);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const parsed = confirmBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const body = parsed.data;
    const accountId = `acct-${user.userId}`;
    const current = await store.getPayoutDestination(user.userId);
    if (!current) return reply.code(409).send({ error: "no_payout_destination" });
    const change = await d.client.pendingChange(accountId, current.destination);
    if (change === undefined) return reply.code(503).send({ error: "payout_service_unreachable", detail: "The payout service could not be reached. Try again in a minute." });
    if (!change) return reply.code(409).send({ error: "callback_change_not_pending", detail: "There is no payment server change to confirm." });
    const bound = challengeDestination(current.destination, change.newOrigin);

    if (!body.challengeId || !body.emailCode) {
      if (!d.emailConfigured) return reply.code(503).send({ error: "email_mfa_not_configured", detail: "Confirming needs an email code, and email is not configured on this portal." });
      const challengeId = randomUUID();
      const code = d.generateSixDigitCode();
      const expiresAtMs = Date.now() + d.codeTtlMs;
      await store.createPayoutDestinationChallenge({ challengeId, userId: user.userId, kind: "callback_confirm", destination: bound, emailCodeHash: d.sha256Hex(`${challengeId}:${code}`), expiresAtMs });
      await d.sendCode({ email: user.email, code, destination: current.destination, previousHost: originHost(change.previousOrigin), newHost: originHost(change.newOrigin) });
      return reply.code(202).send({ verificationRequired: true, challengeId, expiresAtMs, detail: `We emailed a code to ${user.email}. Enter it to confirm the new payment server.` });
    }
    const challenge = await store.consumePayoutDestinationChallenge(body.challengeId);
    if (!challenge || challenge.userId !== user.userId || challenge.kind !== "callback_confirm" || challenge.destination !== bound) {
      return reply.code(400).send({ error: "payout_callback_challenge_invalid", detail: "That code has expired or was for a different change. Ask for a new code." });
    }
    if (!d.secureCompare(challenge.emailCodeHash, d.sha256Hex(`${challenge.challengeId}:${body.emailCode.trim()}`))) {
      return reply.code(401).send({ error: "payout_callback_code_invalid", detail: "The code is not right. Ask for a new code." });
    }
    const result = await d.client.confirm(accountId, current.destination, change.newOrigin);
    if (result === "not_pending") return reply.code(409).send({ error: "callback_change_not_pending", detail: "The payment server changed again. Reload and confirm the new one." });
    if (result !== "ok") return reply.code(502).send({ error: "payout_service_unreachable", detail: "The payout service could not be reached. Try again in a minute." });
    req.log.info({ accountId, newOrigin: change.newOrigin }, "payout_callback_change_confirmed");
    return reply.send({ ok: true, destination: current.destination, origin: change.newOrigin });
  });
}

export interface PayoutCallbackNotifyDeps {
  store: (PayoutDestinationStore & { getUserById(userId: string): Promise<{ email: string } | null> }) | null | undefined;
  client: PayoutCallbackClient;
  /** Resolves false when email is not configured; throws when sending failed. */
  sendNotice: (input: { email: string; destination: string; previousHost: string; newHost: string }) => Promise<boolean>;
}

/**
 * POST /internal/payouts/callback-changed { accountId }: registered inside the token-checked
 * /internal plugin. The coordinator calls it once per change; a non-2xx reply makes it retry on
 * its next payout cycle. Hosts are re-read from the coordinator, never taken from the request.
 */
export function registerPayoutCallbackNotifyRoute(internal: FastifyInstance, d: PayoutCallbackNotifyDeps): void {
  internal.post("/internal/payouts/callback-changed", async (req, reply) => {
    const store = d.store;
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const parsed = z.object({ accountId: z.string().min(6).max(140) }).passthrough().safeParse(req.body ?? {});
    if (!parsed.success || !parsed.data.accountId.startsWith("acct-")) return reply.code(400).send({ error: "invalid_request" });
    const userId = parsed.data.accountId.slice(5);
    const [user, current] = await Promise.all([store.getUserById(userId), store.getPayoutDestination(userId)]);
    // Nothing to tell (not a portal account, or its destination is no longer the one paid): done.
    if (!user || !current) return reply.send({ ok: true, emailed: false, reason: "no_portal_destination" });
    const change = await d.client.pendingChange(parsed.data.accountId, current.destination);
    if (change === undefined) return reply.code(503).send({ error: "payout_service_unreachable" });
    if (!change) return reply.send({ ok: true, emailed: false, reason: "no_pending_change" });
    let sent: boolean;
    try {
      sent = await d.sendNotice({ email: user.email, destination: current.destination, previousHost: originHost(change.previousOrigin), newHost: originHost(change.newOrigin) });
    } catch {
      return reply.code(502).send({ error: "email_not_sent" }); // retried next cycle
    }
    // Email not configured on this portal: the Plan & usage banner is the notice; do not retry.
    if (!sent) return reply.send({ ok: true, emailed: false, reason: "email_not_configured" });
    req.log.info({ accountId: parsed.data.accountId }, "payout_callback_change_notified");
    return reply.send({ ok: true, emailed: true });
  });
}
