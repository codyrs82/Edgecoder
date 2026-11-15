// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Payment routes: intents, credit purchase, the provider webhook and reconciliation.
 */
import { z } from "zod";
import type { WalletType } from "../../../common/types.js";
import { pgStore } from "../../../db/store.js";
import { verifyPaymentWebhookSignature } from "../../../economy/payment-settlement.js";
import type { CoordinatorApp } from "../app.js";
import { PAYMENT_INTENT_TTL_MS, PAYMENT_WEBHOOK_SECRET } from "../context.js";
import { authorizeAdmin, callerAccount, requireMeshToken } from "../auth.js";
import { paymentIntents } from "../economy.js";
import { ECONOMY_PAYMENTS_ENABLED } from "../payouts.js";
import { createPaymentIntent, createPaymentIntentWithinLaunchCaps, reconcileIntent, settleIfPaid, openIntentCount, MAX_OPEN_INTENTS_PER_ACCOUNT } from "../payments.js";

export function registerPaymentRoutes(app: CoordinatorApp): void {
  app.post("/economy/payments/intents", async (req, reply) => {
    // Operator: an invoice for any named account. Owners buy through /account/buy (callerAccount).
    if (!authorizeAdmin(req, reply)) return;
    const body = z
      .object({
        accountId: z.string(),
        walletType: z.enum(["lightning", "onchain"]).default("lightning"),
        amountSats: z.number().int().positive().max(100000000)
      })
      .parse(req.body);
    return { ok: true, intent: await createPaymentIntent(body.accountId, body.amountSats, body.walletType as WalletType) };
  });

  /** Buy cSats for the signing agent's owner: returns the invoice to pay. */
  app.post("/account/buy", async (req, reply) => {
    const { amountSats, accountId: requested } = z.object({ amountSats: z.number().int().min(100).max(1_000_000), accountId: z.string().max(200).optional() }).parse(req.body);
    const caller = await callerAccount(req, "/account/buy", requested);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    if (!ECONOMY_PAYMENTS_ENABLED) return reply.code(503).send({ error: "payments_disabled" });
    const accountId = caller.accountId;
    if (openIntentCount(accountId) >= MAX_OPEN_INTENTS_PER_ACCOUNT) return reply.code(429).send({ error: "too_many_open_invoices" });
    // Soft launch (LAUNCH_MODE=invite): every purchase path ends here, so the caps hold for all of them.
    const created = await createPaymentIntentWithinLaunchCaps(accountId, amountSats);
    if ("violation" in created) return reply.code(429).send(created.violation);
    const intent = created.intent;
    return reply.send({ intentId: intent.intentId, invoice: intent.invoiceRef, amountSats: intent.amountSats, cSats: intent.quotedCredits, feeSats: intent.coordinatorFeeSats, network: intent.network, expiresInSeconds: Math.floor(PAYMENT_INTENT_TTL_MS / 1000) });
  });

  /** State of one of the owner's purchases; checks with the Lightning node while it is unpaid. */
  app.post("/account/intent", async (req, reply) => {
    const { intentId, accountId: requested } = z.object({ intentId: z.string().min(1).max(100), accountId: z.string().max(200).optional() }).parse(req.body);
    const caller = await callerAccount(req, "/account/intent", requested);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    const accountId = caller.accountId;
    const intent = paymentIntents.get(intentId) ?? (await pgStore?.getPaymentIntent(intentId)) ?? undefined;
    if (!intent || intent.accountId !== accountId) return reply.code(404).send({ error: "unknown_intent" });
    if (intent.status === "created") await reconcileIntent(intent);
    const now = paymentIntents.get(intentId) ?? (await pgStore?.getPaymentIntent(intentId)) ?? intent;
    return reply.send({ intentId, status: now.status, cSats: now.quotedCredits });
  });

  app.get("/economy/payments/intents/:intentId", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const params = z.object({ intentId: z.string() }).parse(req.params);
    const inMemory = paymentIntents.get(params.intentId);
    const fromDb = await pgStore?.getPaymentIntent(params.intentId);
    const intent = inMemory ?? fromDb;
    if (!intent) return reply.code(404).send({ error: "intent_not_found" });
    return { intent };
  });

  // #42: admin-only; caller-supplied txRef is ignored and the node is always asked.
  app.post("/economy/payments/intents/:intentId/confirm", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    const params = z.object({ intentId: z.string() }).parse(req.params);
    const intent = paymentIntents.get(params.intentId) ?? (await pgStore?.getPaymentIntent(params.intentId));
    if (!intent) return reply.code(404).send({ error: "intent_not_found" });
    if (intent.status === "settled") return { ok: true, intent };
    if (intent.status === "expired") return reply.code(409).send({ error: "intent_expired" });
    const outcome = await settleIfPaid(intent);
    if (outcome.status === "unpaid") return reply.code(402).send({ error: "invoice_unpaid", status: "unpaid" });
    return { ok: true, status: outcome.status, intent: outcome.intent };
  });

  // #42: the webhook body is a hint only. Authenticity is an HMAC of the raw body
  // (`x-payment-signature: sha256=<hex>`); settlement is decided by the Lightning node.
  app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      (req as unknown as { rawBody?: string }).rawBody = body as string;
      try {
        done(null, (body as string).length > 0 ? JSON.parse(body as string) : {});
      } catch (error) {
        (error as { statusCode?: number }).statusCode = 400;
        done(error as Error, undefined);
      }
    });
    scope.post("/economy/payments/webhook", async (req, reply) => {
      if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
      if (!PAYMENT_WEBHOOK_SECRET) {
        return reply.code(503).send({ error: "payment_webhook_not_configured" });
      }
      const rawBody = (req as unknown as { rawBody?: string }).rawBody;
      const signature = (req.headers as Record<string, unknown>)["x-payment-signature"];
      if (!verifyPaymentWebhookSignature(rawBody, signature, PAYMENT_WEBHOOK_SECRET)) {
        return reply.code(401).send({ error: "webhook_signature_required" });
      }
      const body = z.object({ invoiceRef: z.string().min(8) }).passthrough().parse(req.body);
      const match =
        [...paymentIntents.values()].find((intent) => intent.invoiceRef === body.invoiceRef) ??
        (await (async () => {
          const pending = await pgStore?.listPendingPaymentIntents(500);
          return (pending ?? []).find((intent) => intent.invoiceRef === body.invoiceRef);
        })());
      if (!match) return reply.code(404).send({ error: "intent_not_found" });
      if (match.status === "settled") return reply.send({ ok: true, alreadySettled: true });
      const outcome = await settleIfPaid(match);
      if (outcome.status === "unpaid") return reply.send({ ok: true, ignored: true, status: "unpaid" });
      if (outcome.status === "already") return reply.send({ ok: true, alreadySettled: true });
      return reply.send({ ok: true, intent: outcome.intent });
    });
  });

  app.post("/economy/payments/reconcile", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return; // operator
    const pending = pgStore ? await pgStore.listPendingPaymentIntents(500) : [...paymentIntents.values()];
    let settledCount = 0;
    let expiredCount = 0;
    for (const intent of pending) {
      if (intent.status !== "created") continue;
      const result = await reconcileIntent(intent);
      if (result === "settled") settledCount += 1;
      if (result === "expired") expiredCount += 1;
    }
    return reply.send({ ok: true, scanned: pending.length, settledCount, expiredCount });
  });
}
