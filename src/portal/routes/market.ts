// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "undici";
import { z } from "zod";
import type { MarketRoutesDeps } from "../server.js";
import { registerHostedRoutes } from "./hosted.js";

/**
 * Compute market API for the portal's /portal/market page: proxies the coordinator's
 * /economy/market/* routes for the logged-in user (portal service token on the way out) and
 * places standing orders on the user's credit account. Also serves the chart library from
 * node_modules so the page stays within the portal's script-src 'self' CSP.
 */
export function registerMarketRoutes(app: FastifyInstance, deps: MarketRoutesDeps): void {
  const { EXTERNAL_HTTP_TIMEOUT_MS, PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal, getCurrentUser } = deps;
  // Buying compute from your tools: the hosted model endpoint and its API keys.
  registerHostedRoutes(app, deps);
  const require = createRequire(import.meta.url);
  let chartLib: string | null = null;
  const chartLibCandidates = (): string[] => {
    const rel = "lightweight-charts/dist/lightweight-charts.standalone.production.js";
    const out: string[] = [];
    try {
      out.push(require.resolve(rel));
    } catch {
      // the package's "exports" map doesn't list dist/, so resolve the package root instead
    }
    try {
      out.push(resolve(dirname(require.resolve("lightweight-charts")), "dist", "lightweight-charts.standalone.production.js"));
    } catch {
      // not installed via the main entry either
    }
    out.push(resolve(fileURLToPath(new URL("../../../node_modules/" + rel, import.meta.url))));
    out.push(resolve(process.cwd(), "node_modules", rel));
    return out;
  };
  app.get("/portal/vendor/lightweight-charts.js", async (_req, reply) => {
    if (chartLib === null) {
      chartLib = "";
      for (const candidate of chartLibCandidates()) {
        try {
          chartLib = readFileSync(candidate, "utf8");
          break;
        } catch {
          // try the next location
        }
      }
    }
    if (!chartLib) return reply.code(404).send("lightweight-charts not installed");
    return reply.header("content-type", "application/javascript; charset=utf-8").header("cache-control", "public, max-age=86400").send(chartLib);
  });

  async function coordinator(): Promise<string | null> {
    const urls = await discoverCoordinatorUrlsForPortal();
    return urls.length ? urls[0].replace(/\/$/, "") : null;
  }
  const headers = (): Record<string, string> => (PORTAL_SERVICE_TOKEN ? { "x-portal-service-token": PORTAL_SERVICE_TOKEN } : {});

  async function proxyGet(path: string, reply: any): Promise<unknown> {
    const base = await coordinator();
    if (!base) return reply.code(503).send({ error: "no_coordinator" });
    const res = await request(`${base}${path}`, { method: "GET", headers: headers(), headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS, bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS });
    const body = await res.body.json().catch(() => ({}));
    return reply.code(res.statusCode).send(body);
  }

  const classQuery = z.object({ computeClass: z.string().regex(/^[a-z0-9.]+$/).optional(), interval: z.string().regex(/^[0-9]+[mhd]$/).optional(), limit: z.coerce.number().int().min(1).max(2000).optional() });
  const qs = (q: Record<string, string | number | undefined>) =>
    Object.entries(q)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");

  for (const [route, target] of [
    ["/portal/api/market/candles", "/economy/market/candles"],
    ["/portal/api/market/book", "/economy/market/book"],
    ["/portal/api/market/depth", "/economy/market/depth"],
    ["/portal/api/market/trades", "/economy/market/trades"],
    ["/portal/api/market/classes", "/economy/market/classes"],
    ["/portal/api/market/rates", "/economy/rates/current"]
  ] as const) {
    app.get(route, async (req, reply) => {
      const user = await getCurrentUser(req as any);
      if (!user) return reply.code(401).send({ error: "not_authenticated" });
      const q = classQuery.parse(req.query ?? {});
      const query = qs(q);
      return proxyGet(`${target}${query ? `?${query}` : ""}`, reply);
    });
  }

  app.get("/portal/api/market/orders", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    return proxyGet(`/economy/market/orders/${encodeURIComponent(`acct-${user.userId}`)}`, reply);
  });

  app.post("/portal/api/market/orders", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const body = z
      .object({ side: z.enum(["buy", "sell"]), computeClass: z.string().regex(/^[a-z0-9.]+$/).default("any"), msatPerCredit: z.number().min(0).max(1e9) })
      .parse(req.body);
    const base = await coordinator();
    if (!base) return reply.code(503).send({ error: "no_coordinator" });
    const res = await request(`${base}/economy/market/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers() },
      headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
      bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
      body: JSON.stringify({ accountId: `acct-${user.userId}`, ...body })
    });
    return reply.code(res.statusCode).send(await res.body.json().catch(() => ({})));
  });
}
