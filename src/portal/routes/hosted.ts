// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Hosted model endpoint: https://edgecoder.io/v1 (OpenAI and Anthropic APIs) for tools that can't
 * reach a local port (Cursor calls models from its own servers) or machines without the app. An API
 * key from the portal names the account; requests run on the network through a coordinator (portal
 * service token) and are billed to that account in cSats, like requests from the app.
 *
 * Also: API key management and profile editing for signed-in users.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { computeOverview, listNetworkModels, listReservations, parseNetworkModel, type NetworkDeps } from "../../apps/ide/network-inference.js";
import { autoBackend, networkBackend } from "../../inference-api/backends.js";
import { AUTO_MODEL_ID, routeInputsFrom } from "../../inference-api/auto-route.js";
import { apiKeyOf, registerCompatRoutes } from "../../inference-api/routes.js";
import type { PortalStore } from "../store.js";
import { portalNetworkDeps, registerComputeRoutes } from "./compute.js";

export const API_KEY_PREFIX = "eck_";
const MAX_KEYS = 20;
export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

export interface HostedRoutesDeps {
  store: PortalStore | undefined | null;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string } | null>;
  PORTAL_SERVICE_TOKEN: string | undefined;
  EXTERNAL_HTTP_TIMEOUT_MS: number;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
}

/** Where a hosted request runs, from the model the tool named: network/<m>[@class] (or a bare model), mine/<m>, reserved/<lease>/<m>. */
export function hostedTarget(model: string | undefined) {
  if (!model) return null;
  return parseNetworkModel(model.startsWith("network/") || model.startsWith("mine/") || model.startsWith("reserved/") ? model : `network/${model}`);
}

export function registerHostedRoutes(app: FastifyInstance, deps: HostedRoutesDeps): void {
  const { store } = deps;

  const networkFor = (accountId: string): NetworkDeps => portalNetworkDeps(deps, accountId);
  // Balance, reservations and the chat compute picker for signed-in users.
  registerComputeRoutes(app, deps);

  // ── The endpoint ──
  registerCompatRoutes(app, {
    authenticate: async (req) => {
      const key = apiKeyOf(req);
      if (!store || !key.startsWith(API_KEY_PREFIX)) return null;
      const userId = await store.userForApiKeyHash(hashApiKey(key));
      return userId ? { accountId: `acct-${userId}` } : null;
    },
    models: async (ctx) => [AUTO_MODEL_ID, ...(await listNetworkModels(networkFor(ctx.accountId)).catch(() => [])).map((m) => m.id)],
    resolve: async (ctx, model) => {
      // "auto": the cheapest place that fits each request: a reservation you hold, your own machines (free), then the network.
      if (model === AUTO_MODEL_ID) {
        const d = networkFor(ctx.accountId);
        const backend = autoBackend({
          inputs: async () => {
            const [ov, leases] = await Promise.all([computeOverview(d).catch(() => null), listReservations(d).then((r) => (r.status === 200 ? ((r.json.reservations as never[]) ?? []) : [])).catch(() => [])]);
            return routeInputsFrom({ localModels: [], machines: ov?.account?.machines, networkModels: ov?.models, classes: ov?.classes, leases });
          },
          run: (r) =>
            networkBackend(d, {
              model: r.model,
              computeClass: r.placement === "network" ? r.computeClass ?? "any" : "any",
              ...(r.placement === "mine" ? { target: "mine" as const } : {}),
              ...(r.placement === "reserved" ? { reservationId: r.reservationId } : {}),
            }),
        });
        return { backend, model: AUTO_MODEL_ID };
      }
      const target = hostedTarget(model);
      if (!target) return { status: 400, error: "Name a model: auto (cheapest place that fits), network/<model>[@cpu|apple|gpu|gpu.dc], mine/<model> or reserved/<reservation>/<model>. GET /v1/models lists them." };
      return { backend: networkBackend(networkFor(ctx.accountId), target), model: model! };
    },
  });

  // ── API keys ──
  app.get("/portal/api/keys", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await deps.getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    return reply.send({ keys: await store.listApiKeys(user.userId) });
  });

  app.post("/portal/api/keys", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await deps.getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body ?? {});
    if ((await store.countApiKeys(user.userId)) >= MAX_KEYS) return reply.code(409).send({ error: "too_many_keys", max: MAX_KEYS });
    const key = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    const keyId = randomUUID();
    await store.createApiKey({ keyId, userId: user.userId, name, keyHash: hashApiKey(key), prefix: key.slice(0, 10) });
    // The only time the key is shown.
    return reply.send({ keyId, name, key });
  });

  app.delete("/portal/api/keys/:keyId", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await deps.getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { keyId } = z.object({ keyId: z.string().uuid() }).parse(req.params);
    return (await store.revokeApiKey(user.userId, keyId)) ? reply.send({ ok: true }) : reply.code(404).send({ error: "unknown_key" });
  });

  // ── Profile ──
  app.post("/me/profile", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await deps.getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { displayName } = z.object({ displayName: z.string().trim().max(80) }).parse(req.body ?? {});
    // Plain text only: no markup or control characters.
    if (/[<>\u0000-\u001f]/.test(displayName)) return reply.code(400).send({ error: "invalid_display_name" });
    await store.setDisplayName(user.userId, displayName || null);
    return reply.send({ ok: true, displayName: displayName || null });
  });
}
