// Copyright (c) 2025 EdgeCoder
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

import { createChatCapacityDirectory, promptTokensOf, type ChatCapacityDirectory, type ChatNeed, type PickContext } from "../chat-capacity.js";
import { clientRegionOf, coordinatorHost, type CoordinatorChoice } from "../../common/coordinator-choice.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SecondFactorGate } from "./account-security.js";
import { z } from "zod";
import { RESERVATION_MAX_MINUTES, RESERVATION_MIN_MINUTES } from "../../economy/reservations.js";
import {
  cancelReservation,
  computeOverview,
  createReservation,
  listNetworkModels,
  listReservations,
  NETWORK_PREFIX,
  parseNetworkModel,
  type NetworkDeps,
  type Transport,
} from "../../apps/ide/network-inference.js";
import { autoBackend, coordinatorAutoBackend, drainFailoverBackend, networkBackend, redirectingNetworkBackend, type CoordinatorDraining } from "../../inference-api/backends.js";
import { AUTO_MODEL_ID, isUnpinnedModel, planRoutes, routeInputsFrom, sizeWorkload } from "../../inference-api/auto-route.js";
import { apiKeyOf, registerCompatRoutes, wholeKeepaliveFromEnv, type CallOutcome, type WholeKeepalive } from "../../inference-api/routes.js";
import type { PortalStore } from "../store.js";
import { withInvoiceQr } from "../invoice-qr.js";
import { registerAgentRoutes } from "./agents.js";
import { cancelOnClose } from "../cancel-on-close.js";
import { COMPUTE_CLASSES, portalCoordinatorTransport, portalNetworkDeps, registerComputeRoutes } from "./compute.js";

export const API_KEY_PREFIX = "eck_";
const MAX_KEYS = 20;
export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

export interface HostedRoutesDeps {
  store: PortalStore | undefined | null;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string; emailVerified?: boolean } | null>;
  PORTAL_SERVICE_TOKEN: string | undefined;
  EXTERNAL_HTTP_TIMEOUT_MS: number;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
  /** Every coordinator, for lookups of live machines (coordinator-fanout.ts). */
  everyCoordinatorUrl?: () => Promise<string[]>;
  /** Opens the credit account of a new (agent) user; server.ts's ensureCreditAccountForUser. */
  ensureCreditAccountForUser?: (user: { userId: string; email: string }) => Promise<void>;
  /** Where network calls go (shared with portal chat); built from discoverCoordinatorUrlsForPortal when absent. */
  chatCapacity?: ChatCapacityDirectory;
  /** With 2FA on, creating an API key needs the second factor (routes/account-security.ts). */
  secondFactor?: SecondFactorGate;
  /** Keepalive for long non-streamed calls (Cloudflare's 100 s first-byte limit); from the env when absent, null = off. */
  wholeKeepalive?: WholeKeepalive | null;
}

/**
 * What the portal saw of one hosted call upstream, for its log line (hosted_call): the task ids it
 * submitted, the coordinators, and the last status and error code of each kind of request. No prompt
 * or reply text, no error message (an agent's can quote the call), no credential.
 */
export interface CallTrace {
  taskIds: string[];
  coordinators: string[];
  submitStatus?: number;
  /** The coordinator's error code when the submit was refused. */
  submitError?: string;
  /** Stream reads (long polls) made, and the last one's status. */
  reads: number;
  streamStatus?: number;
  /** The coordinator's error code when a read was refused. */
  streamError?: string;
  /** The coordinator said the reply was done, and whether it ended with an error. */
  done: boolean;
  doneWithError?: boolean;
  /** The portal sent the coordinator a cancel for it (the reader went away before the reply ended). */
  cancelled: boolean;
  /** A request to the coordinator that failed in the portal (the connection, a timeout): path and error code. */
  upstreamError?: string;
  /**
   * What answered: from the done read of the attempt that answered (the coordinator's servedModel and
   * served-by). A new submit (a failover or a redirect) clears it, so it never names an earlier attempt.
   */
  served?: ServedLabel;
}

/** The served label on a hosted_call line: the model, class and (masked) host of the attempt that answered. */
export interface ServedLabel {
  /** "qwen2.5-coder:1.5b on cpu · lin-•••3f2a (syd)". */
  label: string;
  model: string | null;
  computeClass: string | null;
  /** The coordinator's masked host label (served-by.ts), never an agent id. */
  host: string | null;
  region: string | null;
  /** The coordinator that answered. */
  coordinator: string;
}

/** The served label from a done stream read, or undefined when it names nothing that ran. */
export function servedLabelOf(json: Record<string, unknown>, coordinator: string): ServedLabel | undefined {
  const str = (v: unknown, n = 120) => (typeof v === "string" && v ? v.slice(0, n) : null);
  const s = json.served && typeof json.served === "object" ? (json.served as Record<string, unknown>) : {};
  const model = str(json.servedModel);
  const computeClass = str(s.computeClass, 40);
  const host = str(s.label, 60);
  const region = str(s.region, 12);
  if (!model && !computeClass && !host) return undefined;
  const label = `${model ?? "?"}${computeClass ? ` on ${computeClass}` : ""}${host ? ` · ${host}` : ""}${region ? ` (${region})` : ""}`;
  return { label, model, computeClass, host, region, coordinator };
}

export const newCallTrace = (): CallTrace => ({ taskIds: [], coordinators: [], reads: 0, done: false, cancelled: false });

/**
 * `d` with its coordinator requests noted in `trace`, and its calls cancelled on the coordinator the
 * moment the buyer's connection closes before the reply ended (cancel-on-close.ts).
 */
export function tracedNetworkDeps(d: NetworkDeps, trace: CallTrace, url?: string): NetworkDeps {
  const inner = d.transport;
  if (!inner) return d;
  const traced: Transport = async (method, path, body, signal) => {
    const code = (v: unknown) => (typeof v === "string" ? v.slice(0, 60) : undefined);
    if (path === "/inference/submit") {
      trace.served = undefined;
      const taskId = code((body as { taskId?: unknown } | undefined)?.taskId);
      if (taskId && !trace.taskIds.includes(taskId) && trace.taskIds.length < 4) trace.taskIds.push(taskId);
      const where = url ? coordinatorHost(url) : "default";
      if (!trace.coordinators.includes(where) && trace.coordinators.length < 4) trace.coordinators.push(where);
    }
    // Noted when sent: the call's log line is written as the connection closes, before the answer.
    if (path === "/inference/cancel") trace.cancelled = true;
    try {
      const r = await inner(method, path, body, signal);
      if (path === "/inference/submit") {
        trace.submitStatus = r.status;
        trace.submitError = r.status === 200 ? undefined : code(r.json.error);
      } else if (path === "/inference/stream") {
        trace.reads++;
        trace.streamStatus = r.status;
        if (r.status !== 200) trace.streamError = code(r.json.error);
        if (r.json.done === true) {
          trace.done = true;
          trace.doneWithError = Boolean(r.json.error);
          trace.served = servedLabelOf(r.json, url ? coordinatorHost(url) : "default");
        }
      }
      return r;
    } catch (err) {
      const e = err as { code?: unknown; name?: unknown } | null;
      trace.upstreamError = `${path} ${code(e?.code) ?? code(e?.name) ?? "error"}`;
      throw err;
    }
  };
  return { ...d, transport: cancelOnClose(traced, url ? coordinatorHost(url) : undefined) };
}

/** Where a hosted request runs, from the model the tool named: network/<m>[@class] (or a bare model), mine/<m>, reserved/<lease>/<m>. */
export function hostedTarget(model: string | undefined) {
  if (!model) return null;
  return parseNetworkModel(model.startsWith("network/") || model.startsWith("mine/") || model.startsWith("reserved/") ? model : `network/${model}`);
}

/**
 * Run 6: a /v1 call's size (prompt tokens as the coordinator estimates them, and max_tokens), so the
 * coordinator choice compares free hosts by their time for this call (chat-capacity.ts PickContext).
 */
export function callSizeOf(body: unknown): PickContext["call"] {
  const b = (body ?? {}) as { messages?: unknown; tools?: unknown; system?: unknown; max_tokens?: unknown; max_completion_tokens?: unknown };
  const max = [b.max_tokens, b.max_completion_tokens].find((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  return { promptTokens: promptTokensOf(b.system !== undefined ? [b.system, b.messages] : b.messages, b.tools), ...(max !== undefined ? { maxTokens: max } : {}) };
}

export function registerHostedRoutes(app: FastifyInstance, deps: HostedRoutesDeps): void {
  const { store } = deps;

  const networkForAccount = (accountId: string): NetworkDeps => portalNetworkDeps(deps, accountId);
  const networkFor = networkForAccount;
  const capacity: ChatCapacityDirectory =
    deps.chatCapacity ?? createChatCapacityDirectory({ candidates: deps.discoverCoordinatorUrlsForPortal, allowed: () => true, serviceToken: deps.PORTAL_SERVICE_TOKEN });
  /**
   * A plain network call goes to the coordinator with the most free agents for its model
   * (chat-capacity.ts); inference runs where it is submitted, so this is what spreads API traffic
   * across seeds. Calls on your own machines or a lease stay with the default coordinator.
   */
  const pinnedDepsFor = (url: string, accountId: string) => portalNetworkDeps({ PORTAL_SERVICE_TOKEN: deps.PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal: async () => [url] }, accountId);
  const pinnedDeps = pinnedDepsFor;
  const networkForCall = async (
    accountId: string,
    target: { model: string; computeClass?: string; target?: "mine"; reservationId?: string },
    clientRegion: string | null,
    call?: PickContext["call"],
  ): Promise<{ deps: NetworkDeps; url?: string; choice?: CoordinatorChoice }> => {
    if (target.target === "mine" || target.reservationId) return { deps: networkFor(accountId) };
    // A classed call (network/<model>@<class>) goes to a coordinator with an agent of that class;
    // among those, the latency-aware choice (coordinator-latency.ts), recorded with the call.
    const { url, choice } = await capacity.pick({ kind: "network", model: target.model, computeClass: target.computeClass }, [], { clientRegion, ...(call ? { call } : {}) }).catch(() => ({ url: null, choice: undefined }));
    return url ? { deps: pinnedDeps(url, accountId), url, ...(choice ? { choice } : {}) } : { deps: networkFor(accountId) };
  };
  /**
   * Where a call a restarting coordinator (`from`) refused goes now: the peer its refusal names when
   * that is a vetted coordinator, else the best other one for `need` (network calls), else any other
   * vetted coordinator. Null when there is none. `from` is passed over for a while either way.
   */
  const drainPeer = async (from: string | undefined, refusal: CoordinatorDraining, need: ChatNeed | null, clientRegion: string | null, call?: PickContext["call"]): Promise<string | null> => {
    const self = from?.replace(/\/+$/, "");
    if (self) capacity.markFailed(self);
    const named = refusal.peerUrl?.replace(/\/+$/, "");
    if (named && named !== self && (await capacity.isKnown(named).catch(() => false))) return named;
    if (need) {
      const { url } = await capacity.pick(need, self ? [self] : [], { clientRegion, ...(call ? { call } : {}) }).catch(() => ({ url: null }));
      if (url && url !== self) return url;
    }
    for (const raw of await deps.discoverCoordinatorUrlsForPortal().catch(() => [] as string[])) {
      const url = raw.replace(/\/+$/, "");
      if (url && url !== self && (await capacity.isKnown(url).catch(() => false))) return url;
    }
    return null;
  };
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
    return userId ? { accountId: `acct-${userId}`, clientRegion: clientRegionOf(req.headers as Record<string, unknown>), trace: newCallTrace(), call: callSizeOf(req.body) } : null;
  };

  // ── The endpoint ──
  registerCompatRoutes(app, {
    authenticate,
    // What online agents hold on every coordinator, and @class only for classes some agent holds the
    // model in (calls are routed across seeds, so one coordinator's list is not what can run).
    models: async (ctx) => {
      const all = await capacity.networkModels().catch(() => []);
      if (all.length === 0) return [AUTO_MODEL_ID, ...(await listNetworkModels(networkFor(ctx.accountId)).catch(() => [])).map((m) => m.id)];
      return [AUTO_MODEL_ID, ...all.flatMap((m) => [`${NETWORK_PREFIX}${m.model}`, ...m.classes.map((c) => `${NETWORK_PREFIX}${m.model}@${c}`)])];
    },
    resolve: async (ctx, model) => {
      // Every coordinator request this call makes is noted for its log line (onCallDone).
      const networkFor = (accountId: string) => tracedNetworkDeps(networkForAccount(accountId), ctx.trace);
      const pinnedDeps = (url: string, accountId: string) => tracedNetworkDeps(pinnedDepsFor(url, accountId), ctx.trace, url);
      // "auto" (also no model, or "default"): the cheapest place that fits each request: a reservation
      // you hold, your own machines (free), then the network's best fit (the coordinator picks).
      if (isUnpinnedModel(model)) {
        const d = networkFor(ctx.accountId);
        const inputs = async () => {
          const [ov, leases] = await Promise.all([computeOverview(d).catch(() => null), listReservations(d).then((r) => (r.status === 200 ? ((r.json.reservations as never[]) ?? []) : [])).catch(() => [])]);
          return routeInputsFrom({ localModels: [], machines: ov?.account?.machines, networkModels: ov?.models?.filter((m) => !m.restricted), classes: ov?.classes, leases });
        };
        // The client-side plan: free places (a lease you hold, your own machines), and the fallback
        // for coordinators that do not route "auto" themselves.
        const clientSide = autoBackend({
          inputs,
          run: (r) =>
            networkBackend(d, {
              model: r.model,
              computeClass: r.placement === "network" ? r.computeClass ?? "any" : "any",
              ...(r.placement === "mine" ? { target: "mine" as const } : {}),
              ...(r.placement === "reserved" ? { reservationId: r.reservationId } : {}),
            }),
        });
        // Network calls: the coordinator picks model, class and agent (best-fit routing).
        let autoChoice: CoordinatorChoice | undefined;
        /** The coordinator the routed call was last sent to (a refusal from it while restarting goes to a peer). */
        let autoUrl: string | undefined;
        const routed = coordinatorAutoBackend({
          useClientSide: async (req) => {
            const first = planRoutes(sizeWorkload(req), await inputs(), "auto")[0];
            return !!first && first.placement !== "network";
          },
          clientSide,
          pick: async () => {
            const r = capacity.pickAutoChoice ? await capacity.pickAutoChoice({ clientRegion: ctx.clientRegion }) : { url: (await capacity.pickAuto?.()) ?? null, choice: undefined };
            autoChoice = r.choice;
            return r.url;
          },
          allowed: (url) => capacity.isKnown(url),
          run: (url, routeRedirect) => {
            autoUrl = url;
            return networkBackend(pinnedDeps(url, ctx.accountId), {
              model: AUTO_MODEL_ID,
              computeClass: "any",
              routeRedirect,
              drainFailover: true,
              ...(ctx.clientRegion ? { clientRegion: ctx.clientRegion } : {}),
              // The portal's choice goes with the call it made (not with a route_elsewhere follow-up).
              ...(autoChoice && routeRedirect ? { coordinatorChoice: autoChoice } : {}),
            });
          },
        });
        // Refused by a coordinator restarting for an update (nothing reserved): once, at once, on a peer.
        const backend = drainFailoverBackend(routed, async (refusal) => {
          const peer = await drainPeer(autoUrl, refusal, null, ctx.clientRegion);
          return peer ? networkBackend(pinnedDeps(peer, ctx.accountId), { model: AUTO_MODEL_ID, computeClass: "any", drainFailover: true, ...(ctx.clientRegion ? { clientRegion: ctx.clientRegion } : {}) }) : null;
        });
        return { backend, model: AUTO_MODEL_ID };
      }
      const target = hostedTarget(model);
      if (!target) return { status: 400, error: "Unknown model. Leave it out (or auto) for the cheapest place that fits, or name one: network/<model>[@cpu|apple|gpu|gpu.dc|cloud], mine/<model> or reserved/<reservation>/<model>. GET /v1/models lists them." };
      const placedFor = await networkForCall(ctx.accountId, target, ctx.clientRegion, ctx.call);
      const placed = { ...placedFor, deps: tracedNetworkDeps(placedFor.deps, ctx.trace, placedFor.url) };
      const region = ctx.clientRegion ? { clientRegion: ctx.clientRegion } : {};
      // #526: a named network call on a chosen coordinator may be sent on to a peer with a free slot for it (once).
      // A plain network call refused by a coordinator restarting for an update (nothing reserved, nothing
      // streamed) goes once, at once, to a peer; a second refusal is a 503 with Retry-After.
      const need: ChatNeed = { kind: "network", model: target.model, computeClass: target.computeClass };
      const onPeer = (url: string) => networkBackend(pinnedDeps(url, ctx.accountId), { ...target, ...region, drainFailover: true });
      if (placed.url && !target.target && !target.reservationId) {
        const first = placed.url;
        let sentTo = first;
        const redirecting = redirectingNetworkBackend({
          url: first,
          allowed: (url) => capacity.isKnown(url),
          run: (url, routeRedirect) => {
            sentTo = url;
            return networkBackend(url === first ? placed.deps : pinnedDeps(url, ctx.accountId), { ...target, ...region, routeRedirect, drainFailover: true, ...(placed.choice && url === first ? { coordinatorChoice: placed.choice } : {}) });
          },
        });
        const backend = drainFailoverBackend(redirecting, async (refusal) => {
          const peer = await drainPeer(sentTo, refusal, need, ctx.clientRegion, ctx.call);
          return peer ? onPeer(peer) : null;
        });
        return { backend, model: model! };
      }
      if (!target.target && !target.reservationId) {
        // No coordinator reported room for it: the default one (the first discovered) is asked.
        const backend = drainFailoverBackend(networkBackend(placed.deps, { ...target, ...region, drainFailover: true }), async (refusal) => {
          const [from] = await deps.discoverCoordinatorUrlsForPortal().catch(() => [] as string[]);
          const peer = await drainPeer(from, refusal, need, ctx.clientRegion, ctx.call);
          return peer ? onPeer(peer) : null;
        });
        return { backend, model: model! };
      }
      return { backend: networkBackend(placed.deps, { ...target, ...region, ...(placed.choice ? { coordinatorChoice: placed.choice } : {}) }), model: model! };
    },
    // Long `stream: false` calls: commit 200 and send whitespace before Cloudflare's 100 s cut (524).
    wholeKeepalive: (deps.wholeKeepalive === undefined ? wholeKeepaliveFromEnv() : deps.wholeKeepalive) ?? undefined,
    // One line per chat call: task id, coordinator, upstream statuses, timing and who closed it
    // (run 5: a connection cut at 50 s could not be explained once the logs had rotated).
    onCallDone: (ctx, outcome, req) => {
      const model = String((req.body as { model?: unknown } | undefined)?.model ?? "auto").slice(0, 120);
      // The served label (model, class, host of the attempt that answered) on every line; null when nothing served.
      const { served, ...upstream } = ctx.trace;
      const line = { accountId: ctx.accountId, model, clientRegion: ctx.clientRegion, ...outcome, served: served ?? null, upstream };
      if (outcome.closedBy !== "server" || outcome.error || ctx.trace.upstreamError) req.log.warn({ hostedCall: line }, "hosted_call");
      else req.log.info({ hostedCall: line }, "hosted_call");
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
    const r = await coord(ctx.accountId, "/account/buy", { amountSats: parsed.data.amountSats });
    // Optional qrSvg: the invoice as an SVG QR code, for clients that show one.
    return relay(reply, { status: r.status, json: withInvoiceQr(r.status, r.json) });
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
      .object({ computeClass: z.enum(COMPUTE_CLASSES), minutes: z.number().int().min(RESERVATION_MIN_MINUTES).max(RESERVATION_MAX_MINUTES), model: z.string().trim().min(1).max(200).optional() })
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

  // ── The web tool (docs/web-tool.md): for the IDE server on a machine without an enrolled agent ──
  // The search and the page fetch run on the coordinator; the key's account is billed per call.
  for (const tool of ["status", "search", "read"] as const) {
    app.post(`/v1/tools/web/${tool}`, async (req, reply) => {
      const ctx = await keyAccount(req, reply);
      if (!ctx) return reply;
      // A client's own `ownMachine` claim is dropped: the portal's service token vouches for what it
      // relays, and an API key caller can't show where its model runs, so these calls are paid.
      const { ownMachine: _claimed, ...body } = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      return relay(reply, await coord(ctx.accountId, `/v1/tools/web/${tool}`, { ...body, accountId: ctx.accountId }));
    });
  }

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
    // An unverified account holds no long-lived credentials (routes/auth.ts, verify-email).
    if (user.emailVerified === false) return reply.code(403).send({ error: "email_not_verified" });
    const { name } = z.object({ name: z.string().trim().min(1).max(60), twoFactorCode: z.string().max(32).optional() }).parse(req.body ?? {});
    if (deps.secondFactor) {
      const check = await deps.secondFactor(req, user);
      if (!check.ok) return reply.code(check.status).send(check.body);
    }
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
