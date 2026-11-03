// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import { decodeBolt11 } from "../../economy/bolt11.js";
import type { MarketRoutesDeps } from "../server.js";
import type { WithdrawChallenge } from "../store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Withdrawal codes one account can request per hour (each one sends an email). */
export const WITHDRAW_CODES_PER_HOUR = 10;

export type WithdrawStore = {
  createWithdrawChallenge(input: { challengeId: string; userId: string; bolt11Hash: string; amountMsat: number; emailCodeHash: string; expiresAtMs: number }): Promise<void>;
  countWithdrawChallengesSince(userId: string, sinceMs: number): Promise<number>;
  consumeWithdrawChallenge(challengeId: string): Promise<WithdrawChallenge | null>;
  withdrawnMsatSince(userId: string, sinceMs: number): Promise<number>;
  approveWithdrawChallenge(input: { challengeId: string; userId: string; capMsat: number; sinceMs: number }): Promise<boolean>;
  releaseWithdrawChallenge(challengeId: string): Promise<void>;
};

/** Step-up for withdrawals: an emailed one-time code bound to the invoice and amount, plus a daily cap. */
export interface WithdrawStepUpDeps {
  store: WithdrawStore | null | undefined;
  emailConfigured: boolean;
  codeTtlMs: number;
  /** 0 = no portal cap (the coordinator's own payout limits still apply). */
  dailyCapSats: number;
  sendCode: (input: { email: string; code: string; amountSats: number }) => Promise<void>;
  generateSixDigitCode: () => string;
  sha256Hex: (v: string) => string;
  secureCompare: (a: string, b: string) => boolean;
}

const withdrawBody = z.object({
  bolt11: z.string().min(20).max(4096),
  challengeId: z.string().min(10).max(64).optional(),
  emailCode: z.string().min(6).max(8).optional()
});

/**
 * Sats payouts for the logged-in user (docs/economy-math.md "Payouts"): balance and history,
 * and withdraw to a BOLT11 invoice. Proxies the
 * coordinator's /economy/payouts/* for the user's credit account with the portal service token.
 *
 * Withdrawing needs a one-time code sent to the account's email. POST { bolt11 } returns 202 with
 * a challengeId; POST again with { bolt11, challengeId, emailCode } pays it. The code is bound to
 * that invoice and its amount and works once (a wrong code also uses it up). Amountless invoices
 * are refused. Per account, at most dailyCapSats can be withdrawn per rolling 24 h.
 */
export function registerPayoutRoutes(
  app: FastifyInstance,
  { EXTERNAL_HTTP_TIMEOUT_MS, PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal, getCurrentUser }: Pick<MarketRoutesDeps, "EXTERNAL_HTTP_TIMEOUT_MS" | "PORTAL_SERVICE_TOKEN" | "discoverCoordinatorUrlsForPortal" | "getCurrentUser">,
  step: WithdrawStepUpDeps
): void {
  const headers = (): Record<string, string> => ({ "content-type": "application/json", ...(PORTAL_SERVICE_TOKEN ? { "x-portal-service-token": PORTAL_SERVICE_TOKEN } : {}) });
  async function coordinator(): Promise<string | null> {
    const urls = await discoverCoordinatorUrlsForPortal();
    return urls.length ? urls[0].replace(/\/$/, "") : null;
  }
  async function forward(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; text: string } | { error: { status: number; body: unknown } }> {
    const base = await coordinator();
    if (!base) return { error: { status: 503, body: { error: "no_coordinator" } } };
    try {
      const res = await request(`${base}${path}`, {
        method,
        headers: headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
        bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
      });
      return { status: res.statusCode, text: await res.body.text() };
    } catch (error) {
      console.warn(`[portal] payouts: coordinator request failed: ${error instanceof Error ? error.message : String(error)}`);
      return { error: { status: 502, body: { error: "coordinator_unreachable" } } };
    }
  }
  async function call(method: "GET" | "POST", path: string, reply: any, body?: unknown): Promise<unknown> {
    const r = await forward(method, path, body);
    if ("error" in r) return reply.code(r.error.status).send(r.error.body);
    reply.code(r.status).type("application/json");
    return r.text || "{}";
  }

  app.get("/wallet/payouts", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    return call("GET", `/economy/payouts/${encodeURIComponent(`acct-${user.userId}`)}`, reply);
  });

  app.post("/wallet/payouts/withdraw", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const store = step.store;
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const parsed = withdrawBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: "Send { bolt11 } as JSON." });
    const body = parsed.data;
    const bolt11 = body.bolt11.trim();
    let amountMsat: number | undefined;
    try {
      amountMsat = decodeBolt11(bolt11).amountMsat;
    } catch {
      return reply.code(400).send({ ok: false, code: "invalid_invoice", detail: "That is not a valid BOLT11 invoice." });
    }
    if (!amountMsat || amountMsat <= 0) {
      return reply.code(400).send({ ok: false, code: "amountless_invoice", detail: "Create the invoice with the amount you want to withdraw." });
    }
    const amount = amountMsat;
    const bolt11Hash = step.sha256Hex(bolt11.toLowerCase());
    const capMsat = step.dailyCapSats * 1000;
    const sinceMs = Date.now() - DAY_MS;
    const capReply = () =>
      reply.code(429).send({ ok: false, code: "withdraw_daily_cap", detail: `At most ${step.dailyCapSats.toLocaleString("en-US")} sats can be withdrawn per 24 hours.` });

    if (!body.challengeId || !body.emailCode) {
      if (!step.emailConfigured) return reply.code(503).send({ error: "email_mfa_not_configured", detail: "Withdrawals need an email code, and email is not configured on this portal." });
      if (capMsat > 0 && (await store.withdrawnMsatSince(user.userId, sinceMs)) + amount > capMsat) return capReply();
      if ((await store.countWithdrawChallengesSince(user.userId, Date.now() - 60 * 60 * 1000)) >= WITHDRAW_CODES_PER_HOUR) {
        return reply.code(429).send({ ok: false, code: "withdraw_codes_rate_limited", detail: "Too many withdrawal codes requested. Try again in an hour." });
      }
      const challengeId = randomUUID();
      const code = step.generateSixDigitCode();
      const expiresAtMs = Date.now() + step.codeTtlMs;
      await store.createWithdrawChallenge({ challengeId, userId: user.userId, bolt11Hash, amountMsat: amount, emailCodeHash: step.sha256Hex(`${challengeId}:${code}`), expiresAtMs });
      await step.sendCode({ email: user.email, code, amountSats: Math.ceil(amount / 1000) });
      return reply.code(202).send({ verificationRequired: true, challengeId, amountMsat: amount, expiresAtMs, detail: `We emailed a code to ${user.email}. Enter it to confirm the withdrawal.` });
    }

    const challenge = await store.consumeWithdrawChallenge(body.challengeId);
    if (!challenge || challenge.userId !== user.userId || !step.secureCompare(challenge.bolt11Hash, bolt11Hash) || challenge.amountMsat !== amount) {
      return reply.code(400).send({ ok: false, code: "withdraw_challenge_invalid", detail: "That code has expired, was already used or was for a different invoice. Withdraw again to get a new code." });
    }
    if (!step.secureCompare(challenge.emailCodeHash, step.sha256Hex(`${challenge.challengeId}:${body.emailCode.trim()}`))) {
      return reply.code(401).send({ ok: false, code: "withdraw_code_invalid", detail: "The code is not right. Withdraw again to get a new code." });
    }
    if (!(await store.approveWithdrawChallenge({ challengeId: challenge.challengeId, userId: user.userId, capMsat, sinceMs }))) return capReply();

    const accountId = `acct-${user.userId}`;
    const r = await forward("POST", "/economy/payouts/withdraw", { accountId, bolt11 });
    // Refused outright (not 2xx, so not the 202 "unconfirmed" either): it no longer counts against the cap.
    if ("error" in r || r.status >= 300) await store.releaseWithdrawChallenge(challenge.challengeId).catch(() => undefined);
    req.log.info({ accountId, amountMsat: amount, status: "error" in r ? r.error.status : r.status }, "payout_withdraw_confirmed");
    if ("error" in r) return reply.code(r.error.status).send(r.error.body);
    reply.code(r.status).type("application/json");
    return r.text || "{}";
  });
  // The Lightning address for automatic payouts is set through PUT /wallet/payout-destination
  // (routes/payout-destination.ts), which validates it and asks for an email code on change.
}
