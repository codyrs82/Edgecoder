// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Compute for a signed-in portal user, through a coordinator (portal service token, the account
 * named in the body): cSats balance and recent activity, reserved-capacity leases (reserve, list,
 * cancel), and the places a web chat can run (network model + class, your own machines, a lease).
 */

import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { z } from "zod";
import {
  cancelReservation,
  computeOverview,
  createReservation,
  listReservations,
  type NetworkDeps,
  type NetworkTarget,
  type Transport,
} from "../../apps/ide/network-inference.js";
import type { PortalStore } from "../store.js";

export interface ComputeRoutesDeps {
  store: PortalStore | undefined | null;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string } | null>;
  PORTAL_SERVICE_TOKEN: string | undefined;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
}

export const accountIdFor = (userId: string) => `acct-${userId}`;

/** Reach the coordinator as the portal; /account/* calls carry the account in the body. */
export function portalCoordinatorTransport(deps: Pick<ComputeRoutesDeps, "PORTAL_SERVICE_TOKEN" | "discoverCoordinatorUrlsForPortal">, accountId: string): Transport {
  return async (method, path, body, signal) => {
    const [base] = await deps.discoverCoordinatorUrlsForPortal();
    if (!base) return { status: 503, json: { error: "no_coordinator" } };
    const payload = body !== undefined && path.startsWith("/account/") ? { ...(body as object), accountId } : body;
    const res = await request(`${base.replace(/\/$/, "")}${path}`, {
      method,
      headers: { ...(deps.PORTAL_SERVICE_TOKEN ? { "x-portal-service-token": deps.PORTAL_SERVICE_TOKEN } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
      headersTimeout: 70_000,
      bodyTimeout: 70_000,
      signal,
    });
    const text = await res.body.text();
    try {
      return { status: res.statusCode, json: JSON.parse(text) };
    } catch {
      // A non-JSON body (a proxy error page, a stack trace) is logged, not passed to the client.
      console.warn(`[portal] coordinator ${method} ${path} returned non-JSON (${res.statusCode}): ${text.slice(0, 200)}`);
      return { status: res.statusCode, json: { error: "coordinator_bad_response" } };
    }
  };
}

/** Network deps that bill the given account (requests go through the coordinator as the portal). */
export function portalNetworkDeps(deps: Pick<ComputeRoutesDeps, "PORTAL_SERVICE_TOKEN" | "discoverCoordinatorUrlsForPortal">, accountId: string): NetworkDeps {
  return { forwarder: "", token: () => "", agentId: accountId, transport: portalCoordinatorTransport(deps, accountId) };
}

// ── Where a web chat runs ──

export const COMPUTE_CLASSES = ["cpu", "apple", "gpu", "gpu.dc"] as const;
const CLASS_LABELS: Record<string, string> = { cpu: "CPU", apple: "Apple", gpu: "GPU", "gpu.dc": "Datacenter GPU" };
export const classLabel = (cls: string | undefined) => (cls && cls !== "any" ? CLASS_LABELS[cls] ?? cls : "Any machine");

export const chatComputeSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("network"), model: z.string().min(1).max(200), computeClass: z.enum(["any", ...COMPUTE_CLASSES]).optional() }),
  z.object({ target: z.literal("mine"), model: z.string().min(1).max(200) }),
  z.object({ target: z.literal("reserved"), model: z.string().min(1).max(200), reservationId: z.string().min(1).max(100), computeClass: z.enum(COMPUTE_CLASSES).optional() }),
]);
export type ChatCompute = z.infer<typeof chatComputeSchema>;

/** What networkBackend takes for a chosen compute. */
export function networkTargetFor(c: ChatCompute): { model: string; computeClass?: string } & NetworkTarget {
  if (c.target === "mine") return { model: c.model, target: "mine" };
  if (c.target === "reserved") return { model: c.model, reservationId: c.reservationId };
  return { model: c.model, computeClass: c.computeClass ?? "any" };
}

/** "Network · qwen3.5:9b · GPU", "My machines · qwen2.5-coder:7b", "Reserved GPU · qwen2.5-coder:32b". */
export function computeLabel(c: ChatCompute): string {
  if (c.target === "mine") return `My machines · ${c.model}`;
  if (c.target === "reserved") return `Reserved ${c.computeClass ? classLabel(c.computeClass) : "machine"} · ${c.model}`;
  return c.computeClass && c.computeClass !== "any" ? `Network · ${c.model} · ${classLabel(c.computeClass)}` : `Network · ${c.model}`;
}

/** "42 min left", "1 h 5 min left", "ending". */
export function timeLeft(endMs: number, nowMs: number): string {
  const min = Math.floor((endMs - nowMs) / 60_000);
  if (min < 1) return "ending";
  if (min < 60) return `${min} min left`;
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""} left`;
}

const fmtRate = (n: number) => (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toPrecision(2));

export interface NetworkModelEntry { model: string; agents: number; classes: string[] }
export interface ReservationEntry { id: string; computeClass: string; model?: string; status: string; endMs: number; cSatsPerSecond?: number; models?: string[] }
export interface ComputeOption { id: string; group: "network" | "mine" | "reserved"; label: string; detail: string; compute: ChatCompute }

/** The compute picker's options: active leases first, then the network per model (any class and each class), then your own machines. */
export function computeOptions(
  models: NetworkModelEntry[],
  classes: Record<string, { label?: string; cSatsPerSecondBaseTier?: number }>,
  reservations: ReservationEntry[],
  nowMs: number,
): ComputeOption[] {
  const out: ComputeOption[] = [];
  const add = (group: ComputeOption["group"], compute: ChatCompute, detail: string) =>
    out.push({ id: `${group}:${compute.model}:${"computeClass" in compute ? compute.computeClass ?? "any" : ""}:${"reservationId" in compute ? compute.reservationId : ""}`, group, label: computeLabel(compute), detail, compute });
  for (const r of reservations) {
    if (r.status !== "active" || r.endMs <= nowMs) continue;
    const ms = r.model ? [r.model] : r.models ?? [];
    const cls = (COMPUTE_CLASSES as readonly string[]).includes(r.computeClass) ? (r.computeClass as (typeof COMPUTE_CLASSES)[number]) : undefined;
    for (const m of ms) add("reserved", { target: "reserved", model: m, reservationId: r.id, ...(cls ? { computeClass: cls } : {}) }, `${timeLeft(r.endMs, nowMs)} · prepaid`);
  }
  const rate = (cls: string) => classes[cls]?.cSatsPerSecondBaseTier;
  for (const m of models) {
    const agents = `${m.agents} machine${m.agents === 1 ? "" : "s"}`;
    const cheapest = m.classes.map(rate).filter((n): n is number => typeof n === "number").sort((a, b) => a - b)[0];
    add("network", { target: "network", model: m.model, computeClass: "any" }, `${agents}${cheapest !== undefined ? ` · from ${fmtRate(cheapest)} cSats/s` : ""}`);
    for (const cls of m.classes) {
      if (!(COMPUTE_CLASSES as readonly string[]).includes(cls)) continue;
      const r = rate(cls);
      add("network", { target: "network", model: m.model, computeClass: cls as (typeof COMPUTE_CLASSES)[number] }, r !== undefined ? `${fmtRate(r)} cSats/s` : classLabel(cls));
    }
  }
  for (const m of models) add("mine", { target: "mine", model: m.model }, "Free · runs only on your own machines");
  return out;
}

export function registerComputeRoutes(app: FastifyInstance, deps: ComputeRoutesDeps): void {
  const { store } = deps;
  const userOf = async (req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!store) {
      reply.code(503).send({ error: "portal_database_not_configured" });
      return null;
    }
    const user = await deps.getCurrentUser(req as { headers: Record<string, unknown> });
    if (!user) reply.code(401).send({ error: "not_authenticated" });
    return user;
  };
  const net = (userId: string) => portalNetworkDeps(deps, accountIdFor(userId));
  const relay = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, r: { status: number; json: unknown }) => reply.code(r.status === 0 ? 502 : r.status).send(r.json);

  /** Balance (cSats), earnings and recent activity; also the price per class. */
  app.get("/portal/api/compute/summary", async (req, reply) => {
    const user = await userOf(req, reply);
    if (!user) return reply;
    const o = await computeOverview(net(user.userId)).catch(() => ({ connected: false as const }));
    if (!o.connected || !("account" in o) || !o.account) return reply.send({ connected: false, ...("classes" in o ? { classes: o.classes } : {}) });
    return reply.send({ connected: true, cSats: o.account.cSats, earnedSats: o.account.earnedSats, recent: o.account.recent ?? [], classes: o.classes ?? {} });
  });

  app.get("/portal/api/compute/reservations", async (req, reply) => {
    const user = await userOf(req, reply);
    if (!user) return reply;
    return relay(reply, await listReservations(net(user.userId)).catch(() => ({ status: 502, json: { error: "coordinator_unreachable" } })));
  });

  app.post("/portal/api/compute/reservations", async (req, reply) => {
    const user = await userOf(req, reply);
    if (!user) return reply;
    const parsed = z
      .object({ computeClass: z.enum(COMPUTE_CLASSES), minutes: z.number().int().min(1).max(24 * 60), model: z.string().trim().min(1).max(200).optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_reservation" });
    return relay(reply, await createReservation(net(user.userId), parsed.data).catch(() => ({ status: 502, json: { error: "coordinator_unreachable" } })));
  });

  app.post("/portal/api/compute/reservations/cancel", async (req, reply) => {
    const user = await userOf(req, reply);
    if (!user) return reply;
    const parsed = z.object({ reservationId: z.string().min(1).max(100) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "reservation_required" });
    return relay(reply, await cancelReservation(net(user.userId), parsed.data.reservationId).catch(() => ({ status: 502, json: { error: "coordinator_unreachable" } })));
  });

  /** Where a web chat can run now (the chat page's compute picker). */
  app.get("/portal/api/compute/options", async (req, reply) => {
    const user = await userOf(req, reply);
    if (!user) return reply;
    const d = net(user.userId);
    const t = d.transport!;
    const [cat, leases] = await Promise.all([
      t("GET", "/inference/models").catch(() => ({ status: 0, json: {} as Record<string, unknown> })),
      t("POST", "/account/reservations/list", {}).catch(() => ({ status: 0, json: {} as Record<string, unknown> })),
    ]);
    const models = cat.status === 200 ? ((cat.json.models as NetworkModelEntry[]) ?? []) : [];
    const classes = cat.status === 200 ? ((cat.json.classes as Record<string, { cSatsPerSecondBaseTier?: number }>) ?? {}) : {};
    const reservations = leases.status === 200 ? ((leases.json.reservations as ReservationEntry[]) ?? []) : [];
    return reply.send({ connected: cat.status === 200, options: computeOptions(models, classes, reservations, Date.now()) });
  });
}
