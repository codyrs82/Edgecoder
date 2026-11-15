// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import { decodeBolt11 } from "../../economy/bolt11.js";
import { moduleLogger } from "../../common/logger.js";
import type { WithdrawStepUpDeps } from "./payouts.js";

const logger = moduleLogger("portal-revenue");

export interface RevenueRoutesDeps {
  /** The coordinators' ADMIN_API_TOKEN (portal COORDINATOR_ADMIN_TOKEN); unset = the page says so (503). */
  coordinatorAdminToken: string;
  EXTERNAL_HTTP_TIMEOUT_MS: number;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean } | null>;
  buildAccessContext: (user: { userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean }) => Promise<{ isSystemAdmin: boolean }>;
}

/** Withdrawal challenges for revenue live apart from the admin's own wallet withdrawals (their daily cap). */
export const revenueChallengeUser = (userId: string) => `revenue:${userId}`;

const withdrawBody = z.object({
  bolt11: z.string().min(20).max(4096),
  challengeId: z.string().min(10).max(64).optional(),
  emailCode: z.string().min(6).max(8).optional()
});

/**
 * EdgeCoder's revenue for system admins (docs/going-to-mainnet.md, "Withdrawing EdgeCoder revenue"):
 * the network fee pool as the coordinator reports it (GET /admin/revenue), and withdrawing it to a
 * BOLT11 invoice (POST /admin/revenue/withdraw). Both go to the coordinator server-side with the
 * coordinator admin token, which never reaches the browser.
 *
 * A withdrawal needs a one-time code emailed to the admin, bound to the invoice and its amount,
 * exactly like a wallet withdrawal. There is no portal daily cap on revenue: the coordinator's
 * hot-wallet caps, pause switch and earnings hold apply.
 */
export function registerRevenueRoutes(app: FastifyInstance, deps: RevenueRoutesDeps, step: Omit<WithdrawStepUpDeps, "dailyCapSats">): void {
  async function systemAdmin(req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    const user = await deps.getCurrentUser(req as never);
    if (!user) {
      reply.code(401).send({ error: "not_authenticated" });
      return null;
    }
    if (!(await deps.buildAccessContext(user)).isSystemAdmin) {
      reply.code(403).send({ error: "admin_only" });
      return null;
    }
    return user;
  }

  async function coordinator(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; text: string }> {
    if (!deps.coordinatorAdminToken) return { status: 503, text: JSON.stringify({ error: "coordinator_admin_token_not_configured", detail: "Set COORDINATOR_ADMIN_TOKEN on the portal (the coordinators' ADMIN_API_TOKEN)." }) };
    const urls = await deps.discoverCoordinatorUrlsForPortal();
    const base = urls[0]?.replace(/\/$/, "");
    if (!base) return { status: 503, text: JSON.stringify({ error: "no_coordinator" }) };
    try {
      const res = await request(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-admin-token": deps.coordinatorAdminToken },
        body: body === undefined ? undefined : JSON.stringify(body),
        headersTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS,
        bodyTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS
      });
      return { status: res.statusCode, text: await res.body.text() };
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, "coordinator revenue request failed");
      return { status: 502, text: JSON.stringify({ error: "coordinator_unreachable" }) };
    }
  }

  app.get("/portal/api/admin/revenue", async (req, reply) => {
    if (!(await systemAdmin(req, reply))) return reply;
    const r = await coordinator("GET", "/admin/revenue");
    return reply.code(r.status).type("application/json").send(r.text || "{}");
  });

  app.post("/portal/api/admin/revenue/withdraw", async (req, reply) => {
    const user = await systemAdmin(req, reply);
    if (!user) return reply;
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
    if (!amountMsat || amountMsat <= 0) return reply.code(400).send({ ok: false, code: "amountless_invoice", detail: "Create the invoice with the amount you want to withdraw." });
    const challengeUser = revenueChallengeUser(user.userId);
    const bolt11Hash = step.sha256Hex(bolt11.toLowerCase());

    if (!body.challengeId || !body.emailCode) {
      if (!step.emailConfigured) return reply.code(503).send({ error: "email_mfa_not_configured", detail: "Withdrawals need an email code, and email is not configured on this portal." });
      if ((await store.countWithdrawChallengesSince(challengeUser, Date.now() - 60 * 60 * 1000)) >= 10) {
        return reply.code(429).send({ ok: false, code: "withdraw_codes_rate_limited", detail: "Too many withdrawal codes requested. Try again in an hour." });
      }
      const challengeId = randomUUID();
      const code = step.generateSixDigitCode();
      const expiresAtMs = Date.now() + step.codeTtlMs;
      await store.createWithdrawChallenge({ challengeId, userId: challengeUser, bolt11Hash, amountMsat, emailCodeHash: step.sha256Hex(`${challengeId}:${code}`), expiresAtMs });
      await step.sendCode({ email: user.email, code, amountSats: Math.ceil(amountMsat / 1000) });
      return reply.code(202).send({ verificationRequired: true, challengeId, amountMsat, expiresAtMs, detail: `We emailed a code to ${user.email}. Enter it to confirm the revenue withdrawal.` });
    }

    const challenge = await store.consumeWithdrawChallenge(body.challengeId);
    if (!challenge || challenge.userId !== challengeUser || !step.secureCompare(challenge.bolt11Hash, bolt11Hash) || challenge.amountMsat !== amountMsat) {
      return reply.code(400).send({ ok: false, code: "withdraw_challenge_invalid", detail: "That code has expired, was already used or was for a different invoice. Withdraw again to get a new code." });
    }
    if (!step.secureCompare(challenge.emailCodeHash, step.sha256Hex(`${challenge.challengeId}:${body.emailCode.trim()}`))) {
      return reply.code(401).send({ ok: false, code: "withdraw_code_invalid", detail: "The code is not right. Withdraw again to get a new code." });
    }
    const r = await coordinator("POST", "/admin/revenue/withdraw", { bolt11, actor: user.email });
    req.log.info({ userId: user.userId, amountMsat, status: r.status }, "revenue_withdraw_confirmed");
    return reply.code(r.status).type("application/json").send(r.text || "{}");
  });
}
