// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Bots on the web: the bots on the signed-in account's desktop machines (src/common/bot-relay.ts).
 *
 *   GET  /portal/api/bots                                     every bot on the account's machines (no conversation)
 *   GET  /portal/api/bots/:agentId/:botId                     one bot, with its latest messages
 *   POST /portal/api/bots/:agentId/:botId/commands            { action, args } for one of the account's machines
 *   GET  /portal/api/bots/:agentId/commands/:commandId        that command's result (polled)
 *
 * The account is always acct-<session user> (never from the request). The portal asks only about
 * the user's enrolled agent nodes; each coordinator checks the agent's verified ownership row again
 * before it shows anything or signs a command for the agent. Nothing here is cached across users.
 */

import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { z } from "zod";
import { BOT_CONTROL_ACTIONS, botControlRequestSchema, botIdSchema, type BotsSnapshot, type RemoteBotSummary } from "../../common/bot-relay.js";

export interface BotRoutesDeps {
  PORTAL_SERVICE_TOKEN: string;
  EXTERNAL_HTTP_TIMEOUT_MS: number;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string } | null | undefined>;
  store: { listNodesByOwner(userId: string): Promise<Array<{ nodeId: string; nodeKind: string; active?: boolean; lastSeenMs?: number }>> } | null | undefined;
}

interface CoordinatorBotMachine {
  agentId: string;
  connected: boolean;
  snapshot: BotsSnapshot | null;
  reportedAtMs: number | null;
  lastSeenMs: number | null;
}

/** A machine whose last report is older than this is shown offline (it reports at least every 2 minutes). */
export const BOTS_STALE_MS = 5 * 60_000;
const MAX_COORDINATORS = 8;
const agentIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export interface MachineInfo {
  agentId: string;
  machineName: string;
  online: boolean;
  /** "on": commands and approvals from the web; "view": read-only (approve on the Mac). Offline is always read-only. */
  controls: "on" | "view";
  reportedAtMs: number | null;
}

/** One entry per machine from every coordinator's answer: a connected one wins, else the latest report. */
export function mergeMachines(answers: CoordinatorBotMachine[][], nowMs = Date.now()): Array<{ machine: MachineInfo; bots: RemoteBotSummary[] }> {
  const merged = new Map<string, CoordinatorBotMachine>();
  for (const m of answers.flat()) {
    if (typeof m?.agentId !== "string") continue;
    const prev = merged.get(m.agentId);
    if (!prev || (m.connected && !prev.connected) || (m.connected === prev.connected && (m.reportedAtMs ?? 0) > (prev.reportedAtMs ?? 0))) merged.set(m.agentId, m);
  }
  return [...merged.values()]
    .filter((m) => m.snapshot && Array.isArray(m.snapshot.bots))
    .map((m) => {
      const s = m.snapshot!;
      const online = m.connected && m.reportedAtMs !== null && nowMs - m.reportedAtMs < BOTS_STALE_MS;
      return {
        machine: { agentId: m.agentId, machineName: String(s.machineName || m.agentId), online, controls: online && s.controls === "on" ? "on" : "view", reportedAtMs: m.reportedAtMs },
        bots: s.bots,
      };
    });
}

export function registerBotRoutes(app: FastifyInstance, deps: BotRoutesDeps): void {
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(deps.PORTAL_SERVICE_TOKEN ? { "x-portal-service-token": deps.PORTAL_SERVICE_TOKEN } : {}),
  });
  async function coordinators(): Promise<string[]> {
    return [...new Set((await deps.discoverCoordinatorUrlsForPortal()).map((u) => u.replace(/\/$/, "")))].slice(0, MAX_COORDINATORS);
  }
  async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await request(url, { method: "POST", headers: headers(), body: JSON.stringify(body), headersTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS, bodyTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS });
    return { status: res.statusCode, body: await res.body.json().catch(() => ({})) };
  }
  async function agentNodes(userId: string): Promise<string[]> {
    if (!deps.store) return [];
    return (await deps.store.listNodesByOwner(userId)).filter((n) => n.nodeKind === "agent").map((n) => n.nodeId).slice(0, 100);
  }
  async function machinesFor(userId: string) {
    const accountId = `acct-${userId}`;
    const agentIds = await agentNodes(userId);
    if (!agentIds.length) return [];
    const answers = await Promise.all(
      (await coordinators()).map(async (base) => {
        try {
          const r = await postJson(`${base}/agent-control/bots`, { accountId, agentIds });
          return r.status === 200 && Array.isArray(r.body?.machines) ? (r.body.machines as CoordinatorBotMachine[]) : [];
        } catch {
          return [];
        }
      }),
    );
    // Only the user's own enrolled machines, whatever a coordinator answered.
    const mine = new Set(agentIds);
    return mergeMachines(answers.map((list) => list.filter((m) => mine.has(m.agentId))));
  }

  app.get("/portal/api/bots", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const machines = await machinesFor(user.userId);
    reply.header("cache-control", "no-store");
    return reply.send({
      machines: machines.map((m) => m.machine),
      bots: machines.flatMap((m) => m.bots.map(({ tail: _tail, instructions: _i, ...b }) => ({ ...b, machine: m.machine }))),
    });
  });

  app.get("/portal/api/bots/:agentId/:botId", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const p = z.object({ agentId: agentIdSchema, botId: botIdSchema }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_bot" });
    const m = (await machinesFor(user.userId)).find((x) => x.machine.agentId === p.data.agentId);
    const bot = m?.bots.find((b) => b.id === p.data.botId);
    // Someone else's machine, or no such bot: the same answer.
    if (!m || !bot) return reply.code(404).send({ error: "no_such_bot" });
    reply.header("cache-control", "no-store");
    return reply.send({ bot, machine: m.machine });
  });

  app.post("/portal/api/bots/:agentId/:botId/commands", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const p = z.object({ agentId: agentIdSchema, botId: botIdSchema }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_bot" });
    const body = z.object({ action: z.enum(BOT_CONTROL_ACTIONS), args: z.record(z.string(), z.unknown()).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_command" });
    const parsed = botControlRequestSchema.safeParse({ action: body.data.action, args: body.data.args ?? {} });
    if (!parsed.success) return reply.code(400).send({ error: "invalid_command", detail: parsed.error.issues[0]?.message });
    // First check here (enrolled to this user); the coordinator checks the verified ownership row again.
    if (!(await agentNodes(user.userId)).includes(p.data.agentId)) return reply.code(403).send({ error: "not_your_machine" });
    const accountId = `acct-${user.userId}`;
    let last: { status: number; body: any } = { status: 409, body: { error: "agent_not_connected" } };
    for (const base of await coordinators()) {
      try {
        const r = await postJson(`${base}/agent-control/agents/${encodeURIComponent(p.data.agentId)}/bot-commands`, { accountId, botId: p.data.botId, ...parsed.data });
        // Another coordinator may hold the machine's connection.
        if (r.status === 409 && r.body?.error === "agent_not_connected") {
          last = r;
          continue;
        }
        if (r.status !== 200) return reply.code(r.status).send({ error: r.body?.error ?? "command_failed", message: r.body?.message });
        return reply.send({ ok: true, commandId: r.body.commandId });
      } catch {
        last = { status: 502, body: { error: "coordinator_unreachable" } };
      }
    }
    return reply.code(last.status).send({ error: last.body?.error ?? "agent_not_connected" });
  });

  app.get("/portal/api/bots/:agentId/commands/:commandId", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const p = z.object({ agentId: agentIdSchema, commandId: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/) }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_command" });
    const accountId = `acct-${user.userId}`;
    reply.header("cache-control", "no-store");
    for (const base of await coordinators()) {
      try {
        const r = await postJson(`${base}/agent-control/bot-commands/${encodeURIComponent(p.data.commandId)}`, { accountId });
        // The coordinator answers only the account that sent it.
        if (r.status === 200 && r.body?.agentId === p.data.agentId) return reply.send(r.body);
      } catch {
        /* try the next coordinator */
      }
    }
    return reply.code(404).send({ error: "unknown_command" });
  });
}
