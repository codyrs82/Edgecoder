// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Hosted model endpoint: https://edgecoder.io/v1 (OpenAI and Anthropic APIs) for tools that can't
 * reach a local port (Cursor calls models from its own servers) or machines without the app. An API
 * key from the portal names the account; requests run on the network through a coordinator (portal
 * service token) and are billed to that account in cSats, like requests from the app.
 *
 * Also: the account behind a key (/v1/account: balance, usage, Lightning top-up, reservations) for
 * AI agents and scripts, agent signup by public key (agents.ts), and API key management and profile
 * editing for signed-in users.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  cancelReservation,
  computeOverview,
  createReservation,
  listNetworkModels,
  listReservations,
  parseNetworkModel,
  type NetworkDeps,
} from "../../apps/ide/network-inference.js";
import { autoBackend, networkBackend } from "../../inference-api/backends.js";
import { AUTO_MODEL_ID, routeInputsFrom } from "../../inference-api/auto-route.js";
import { apiKeyOf, registerCompatRoutes } from "../../inference-api/routes.js";
import type { PortalStore } from "../store.js";
import { registerAgentRoutes } from "./agents.js";
import { COMPUTE_CLASSES, portalCoordinatorTransport, portalNetworkDeps, registerComputeRoutes } from "./compute.js";

export const API_KEY_PREFIX = "eck_";
const MAX_KEYS = 20;
export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

export interface HostedRoutesDeps {
  store: PortalStore | undefined | null;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string } | null>;
  PORTAL_SERVICE_TOKEN: string | undefined;
  EXTERNAL_HTTP_TIMEOUT_MS: number;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
  /** Opens the credit account of a new (agent) user; server.ts's ensureCreditAccountForUser. */
  ensureCreditAccountForUser?: (user: { userId: string; email: string }) => Promise<void>;
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

  const issueApiKey = async (userId: string, name: string) => {
    if (!store) throw new Error("portal_database_not_configured");
    const key = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    await store.createApiKey({ keyId: randomUUID(), userId, name, keyHash: hashApiKey(key), prefix: key.slice(0, 10) });
    return key;
  };
  // AI agents: signup with a public key, returns an API key for the endpoint below.
  registerAgentRoutes(app, { store, issueApiKey, onAgentCreated: deps.ensureCreditAccountForUser });

  const authenticate = async (req: FastifyRequest) => {
    const key = apiKeyOf(req);
    if (!store || !key.startsWith(API_KEY_PREFIX)) return null;
    const userId = await store.userForApiKeyHash(hashApiKey(key));
    return userId ? { accountId: `acct-${userId}` } : null;
  };

  // ── The endpoint ──
  registerCompatRoutes(app, {
    authenticate,
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

  // ── The account behind a key (agents, scripts): balance, usage, top-up, reservations ──
  const keyAccount = async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = await authenticate(req);
    if (!ctx) reply.code(401).send({ error: { message: "Invalid API key.", type: "invalid_api_key", code: 401 } });
    return ctx;
  };
  const relay = (reply: FastifyReply, r: { status: number; json: unknown }) => reply.code(r.status === 0 ? 502 : r.status).send(r.json);
  const unreachable = () => ({ status: 502, json: { error: "coordinator_unreachable" } as Record<string, unknown> });
  const coord = (accountId: string, path: string, body: object) => portalCoordinatorTransport(deps, accountId)("POST", path, body).catch(unreachable);

  /** Balance (cSats) with recent ledger entries and the last 30 days' usage. */
  app.get("/v1/account", async (req, reply) => {
    const ctx = await keyAccount(req, reply);
    if (!ctx) return reply;
    const [summary, usage] = await Promise.all([coord(ctx.accountId, "/account/summary", {}), coord(ctx.accountId, "/account/usage", { days: 30 })]);
    if (summary.status !== 200) return relay(reply, summary);
    const s = summary.json as Record<string, unknown>;
    const u = usage.status === 200 ? (usage.json as { totals?: unknown; records?: unknown[] }) : null;
    return reply.send({
      accountId: ctx.accountId,
      cSats: s.cSats ?? s.balance ?? 0,
      earnedSats: s.earnedSats,
      recent: s.recent ?? [],
      usage: u ? { days: 30, totals: u.totals, recent: (u.records ?? []).slice(0, 20) } : null,
    });
  });

  app.get("/v1/account/usage", async (req, reply) => {
    const ctx = await keyAccount(req, reply);
    if (!ctx) return reply;
    const days = z.coerce.number().int().min(1).max(90).catch(30).parse((req.query as { days?: unknown })?.days ?? 30);
    return relay(reply, await coord(ctx.accountId, "/account/usage", { days }));
  });

  /** A Lightning invoice that credits this account once paid (the coordinator's /account/buy). */
  app.post("/v1/account/topup", async (req, reply) => {
    const ctx = await keyAccount(req, reply);
    if (!ctx) return reply;
    const parsed = z.object({ amountSats: z.number().int().min(100).max(1_000_000) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_amount", detail: "amountSats: whole sats, 100 to 1,000,000" });
    return relay(reply, await coord(ctx.accountId, "/account/buy", { amountSats: parsed.data.amountSats }));
  });

  /** Whether a top-up was paid (the coordinator asks its Lightning node while unpaid). */
  app.get("/v1/account/topup/:intentId", async (req, reply) => {
    const ctx = await keyAccount(req, reply);
    if (!ctx) return reply;
    const { intentId } = z.object({ intentId: z.string().min(1).max(100) }).parse(req.params);
    return relay(reply, await coord(ctx.accountId, "/account/intent", { intentId }));
  });

  app.get("/v1/account/reservations", async (req, reply) => {
    const ctx = await keyAccount(req, reply);
    if (!ctx) return reply;
    return relay(reply, await listReservations(networkFor(ctx.accountId)).catch(unreachable));
  });

  app.post("/v1/account/reservations", async (req, reply) => {
    const ctx = await keyAccount(req, reply);
    if (!ctx) return reply;
    const parsed = z
      .object({ computeClass: z.enum(COMPUTE_CLASSES), minutes: z.number().int().min(1).max(24 * 60), model: z.string().trim().min(1).max(200).optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_reservation" });
    return relay(reply, await createReservation(networkFor(ctx.accountId), parsed.data).catch(unreachable));
  });

  app.post("/v1/account/reservations/cancel", async (req, reply) => {
    const ctx = await keyAccount(req, reply);
    if (!ctx) return reply;
    const parsed = z.object({ reservationId: z.string().min(1).max(100) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "reservation_required" });
    return relay(reply, await cancelReservation(networkFor(ctx.accountId), parsed.data.reservationId).catch(unreachable));
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
