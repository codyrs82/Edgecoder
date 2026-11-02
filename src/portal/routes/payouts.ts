// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { z } from "zod";
import type { MarketRoutesDeps } from "../server.js";

/**
 * Sats payouts for the logged-in user (docs/economy-math.md "Payouts"): balance and history,
 * withdraw to a BOLT11 invoice, and the Lightning address for automatic payouts. Proxies the
 * coordinator's /economy/payouts/* for the user's credit account with the portal service token.
 */
export function registerPayoutRoutes(
  app: FastifyInstance,
  { EXTERNAL_HTTP_TIMEOUT_MS, PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal, getCurrentUser }: MarketRoutesDeps
): void {
  const headers = (): Record<string, string> => ({ "content-type": "application/json", ...(PORTAL_SERVICE_TOKEN ? { "x-portal-service-token": PORTAL_SERVICE_TOKEN } : {}) });
  async function coordinator(): Promise<string | null> {
    const urls = await discoverCoordinatorUrlsForPortal();
    return urls.length ? urls[0].replace(/\/$/, "") : null;
  }
  async function call(method: "GET" | "POST", path: string, reply: any, body?: unknown): Promise<unknown> {
    const base = await coordinator();
    if (!base) return reply.code(503).send({ error: "no_coordinator" });
    try {
      const res = await request(`${base}${path}`, {
        method,
        headers: headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
        bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
      });
      const text = await res.body.text();
      reply.code(res.statusCode).type("application/json");
      return text || "{}";
    } catch (error) {
      return reply.code(502).send({ error: "coordinator_unreachable", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  app.get("/wallet/payouts", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    return call("GET", `/economy/payouts/${encodeURIComponent(`acct-${user.userId}`)}`, reply);
  });

  app.post("/wallet/payouts/withdraw", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const body = z.object({ bolt11: z.string().min(20).max(4096) }).parse(req.body ?? {});
    return call("POST", "/economy/payouts/withdraw", reply, { accountId: `acct-${user.userId}`, bolt11: body.bolt11.trim() });
  });

  app.post("/wallet/payouts/address", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const body = z.object({ lightningAddress: z.string().max(256).nullable() }).parse(req.body ?? {});
    return call("POST", "/economy/payouts/address", reply, { accountId: `acct-${user.userId}`, lightningAddress: body.lightningAddress });
  });
}
