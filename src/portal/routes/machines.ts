// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Settings > Nodes > Machines: the owner's view and control of each machine's models.
 *
 *   GET  /portal/api/machines                       the signed-in account's machines (state + audit)
 *   POST /portal/api/machines/:agentId/commands     { action, args } for one of the account's machines
 *
 * The account is always acct-<session user> (never from the request). The portal checks the agent
 * is one of the user's enrolled nodes, then asks the coordinators with the service token; each
 * coordinator checks the agent's verified ownership row again and signs the command for the agent
 * (src/swarm/coordinator/model-control.ts, src/model/remote-control/protocol.ts).
 */

import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { z } from "zod";
import { MODEL_CATALOG } from "../../model/catalog.js";
import { modelControlRequestSchema, MODEL_CONTROL_ACTIONS } from "../../model/remote-control/protocol.js";
import { registerBotRoutes } from "./bots.js";

export interface MachineRoutesDeps {
  PORTAL_SERVICE_TOKEN: string;
  EXTERNAL_HTTP_TIMEOUT_MS: number;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string } | null | undefined>;
  store: { listNodesByOwner(userId: string): Promise<Array<{ nodeId: string; nodeKind: string; active?: boolean; lastSeenMs?: number }>> } | null | undefined;
}

interface CoordinatorMachine {
  agentId: string;
  connected: boolean;
  state: Record<string, unknown> | null;
  stateAtMs: number | null;
  lastSeenMs: number | null;
  coordinatorId: string;
  audit: Array<{ commandId: string; requestedAtMs: number } & Record<string, unknown>>;
}

const MAX_COORDINATORS = 8;

export function registerMachineRoutes(app: FastifyInstance, deps: MachineRoutesDeps): void {
  // The same machines' bots, shown and driven from the web (Bots in the sidebar), with the same owner checks.
  registerBotRoutes(app, deps);
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(deps.PORTAL_SERVICE_TOKEN ? { "x-portal-service-token": deps.PORTAL_SERVICE_TOKEN } : {})
  });
  async function coordinators(): Promise<string[]> {
    return [...new Set((await deps.discoverCoordinatorUrlsForPortal()).map((u) => u.replace(/\/$/, "")))].slice(0, MAX_COORDINATORS);
  }
  async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await request(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      headersTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS,
      bodyTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS
    });
    return { status: res.statusCode, body: await res.body.json().catch(() => ({})) };
  }
  async function agentNodes(userId: string): Promise<Array<{ nodeId: string; active?: boolean; lastSeenMs?: number }>> {
    if (!deps.store) return [];
    return (await deps.store.listNodesByOwner(userId)).filter((n) => n.nodeKind === "agent");
  }

  app.get("/portal/api/machines", async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const accountId = `acct-${user.userId}`;
    const nodes = await agentNodes(user.userId);
    const agentIds = nodes.map((n) => n.nodeId).slice(0, 100);
    const answers = await Promise.all(
      (await coordinators()).map(async (base) => {
        try {
          const r = await postJson(`${base}/agent-control/machines`, { accountId, agentIds });
          return r.status === 200 && Array.isArray(r.body?.machines) ? (r.body.machines as CoordinatorMachine[]) : [];
        } catch {
          return [];
        }
      })
    );
    // One entry per machine: the coordinator it is connected to wins, else the latest state.
    const merged = new Map<string, CoordinatorMachine>();
    const audits = new Map<string, Map<string, CoordinatorMachine["audit"][number]>>();
    for (const m of answers.flat()) {
      if (typeof m?.agentId !== "string") continue;
      const prev = merged.get(m.agentId);
      if (!prev || (m.connected && !prev.connected) || (m.connected === prev.connected && (m.stateAtMs ?? 0) > (prev.stateAtMs ?? 0))) merged.set(m.agentId, m);
      const a = audits.get(m.agentId) ?? new Map();
      for (const e of m.audit ?? []) if (typeof e?.commandId === "string") a.set(e.commandId, e);
      audits.set(m.agentId, a);
    }
    const ids = new Set([...agentIds, ...merged.keys()]);
    const machines = [...ids].map((agentId) => {
      const m = merged.get(agentId);
      const node = nodes.find((n) => n.nodeId === agentId);
      return {
        agentId,
        enrolled: Boolean(node),
        connected: m?.connected ?? false,
        state: m?.state ?? null,
        stateAtMs: m?.stateAtMs ?? null,
        lastSeenMs: m?.lastSeenMs ?? node?.lastSeenMs ?? null,
        audit: [...(audits.get(agentId)?.values() ?? [])].sort((x, y) => y.requestedAtMs - x.requestedAtMs).slice(0, 25)
      };
    });
    return reply.send({
      accountId,
      machines,
      actions: MODEL_CONTROL_ACTIONS,
      catalog: MODEL_CATALOG.map((m) => ({ modelId: m.modelId, name: m.name, diskSize: m.diskSize, minMemoryGb: m.minMemoryGb, category: m.category }))
    });
  });

  app.post("/portal/api/machines/:agentId/commands", async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const params = z.object({ agentId: z.string().min(1).max(128) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_agent" });
    const parsed = modelControlRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_command", detail: parsed.error.issues[0]?.message });
    // First check here (enrolled to this user); the coordinator checks the verified ownership row again.
    const nodes = await agentNodes(user.userId);
    if (!nodes.some((n) => n.nodeId === params.data.agentId)) return reply.code(403).send({ error: "not_your_machine" });
    const accountId = `acct-${user.userId}`;
    let last: { status: number; body: any } = { status: 409, body: { error: "agent_not_connected" } };
    for (const base of await coordinators()) {
      try {
        const r = await postJson(`${base}/agent-control/agents/${encodeURIComponent(params.data.agentId)}/commands`, { accountId, ...parsed.data });
        // Another coordinator may hold the machine's connection.
        if (r.status === 409 && r.body?.error === "agent_not_connected") {
          last = r;
          continue;
        }
        return reply.code(r.status).send(r.body);
      } catch {
        last = { status: 502, body: { error: "coordinator_unreachable" } };
      }
    }
    return reply.code(last.status).send(last.body);
  });
}
