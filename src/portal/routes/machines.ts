// Copyright (c) 2025 EdgeCoder
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
import { agentUpdateAvailable } from "../agent-release.js";
export { createLatestAgentVersion } from "../agent-release.js";

export interface MachineRoutesDeps {
  PORTAL_SERVICE_TOKEN: string;
  EXTERNAL_HTTP_TIMEOUT_MS: number;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string } | null | undefined>;
  store: { listNodesByOwner(userId: string): Promise<Array<{ nodeId: string; nodeKind: string; active?: boolean; lastSeenMs?: number }>> } | null | undefined;
  /** Cloud bots on the bots API (routes/cloud-bots.ts). */
  cloud?: import("./cloud-bots.js").CloudBotService | null;
  /** The newest agent release version (agent-release.ts), or null when unknown. */
  latestAgentVersion?: () => string | null;
}

interface CoordinatorMachine {
  agentId: string;
  connected: boolean;
  state: Record<string, unknown> | null;
  stateAtMs: number | null;
  lastSeenMs: number | null;
  coordinatorId: string;
  audit: Array<{ commandId: string; requestedAtMs: number } & Record<string, unknown>>;
  /** Newer coordinators: the models a `target: "mine"` call can run on this machine there, and its active model. */
  models?: unknown;
  activeModel?: unknown;
  /** Newer coordinators: served on the network vs only for the owner (kept off the network: too big to share). */
  networkModels?: unknown;
  ownerModels?: unknown;
  /** Newer coordinators: the agent's memory budget and the estimated bytes of its models. */
  memory?: unknown;
  /** Newer coordinators: the agent's software version from its last registration. */
  version?: unknown;
}

const MAX_COORDINATORS = 8;

/** The longest the chat waits to learn which models your own machines have (Auto asks them first). */
const OWN_MODELS_TIMEOUT_MS = 3_000;

/**
 * Models on the signed-in account's connected machines, best first: loaded (warm), then the
 * configured active model, then the rest the machine serves. Auto in the web chat runs on these
 * first, free (routes/chat.ts).
 *
 * A coordinator lists `models` per machine: what it would route a `target: "mine"` call to there
 * (the machine's reported catalog). That is the answer when present. The machine's own state is
 * Ollama's view, so a vLLM or MLX host (the Lambda A100) reports `ollamaReachable: false` and no
 * installed models while serving its active model; it used to be skipped, and Auto went to the
 * paid network instead. Without `models` (an older coordinator), such a machine's active model
 * is still offered, last: the coordinator refuses a `mine` call it can't place before anything
 * runs, and Auto then moves on.
 *
 * A machine's `ownerModels` (newer coordinators) are installed models it keeps off the network
 * (too big for its memory budget to share): a `mine` call still runs them, so they are listed too.
 */
export async function ownMachineModels(deps: Omit<MachineRoutesDeps, "getCurrentUser">, userId: string): Promise<string[]> {
  if (!deps.store) return [];
  const agentIds = (await deps.store.listNodesByOwner(userId)).filter((n) => n.nodeKind === "agent").map((n) => n.nodeId).slice(0, 100);
  if (agentIds.length === 0) return [];
  const timeout = Math.min(deps.EXTERNAL_HTTP_TIMEOUT_MS, OWN_MODELS_TIMEOUT_MS);
  const urls = [...new Set((await deps.discoverCoordinatorUrlsForPortal()).map((u) => u.replace(/\/$/, "")))].slice(0, MAX_COORDINATORS);
  const answers = await Promise.all(
    urls.map(async (base) => {
      try {
        const res = await request(`${base}/agent-control/machines`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(deps.PORTAL_SERVICE_TOKEN ? { "x-portal-service-token": deps.PORTAL_SERVICE_TOKEN } : {}) },
          body: JSON.stringify({ accountId: `acct-${userId}`, agentIds }),
          headersTimeout: timeout,
          bodyTimeout: timeout,
        });
        const body = (await res.body.json().catch(() => ({}))) as { machines?: CoordinatorMachine[] };
        return res.statusCode === 200 && Array.isArray(body.machines) ? body.machines : [];
      } catch {
        return [];
      }
    }),
  );
  const names = (xs: unknown): string[] =>
    Array.isArray(xs) ? xs.map((x) => (typeof x === "string" ? x : (x as { name?: unknown } | null)?.name)).filter((n): n is string => typeof n === "string" && n.length > 0) : [];
  const loaded: string[] = [];
  const active: string[] = [];
  const rest: string[] = [];
  const unreachableActive: string[] = [];
  for (const m of answers.flat()) {
    if (!m?.connected) continue;
    const st = (m.state ?? {}) as { ollamaReachable?: unknown; activeModel?: unknown; loaded?: unknown; installed?: unknown };
    const warm = names(st.loaded);
    const activeModel = typeof m.activeModel === "string" && m.activeModel ? m.activeModel : typeof st.activeModel === "string" && st.activeModel ? st.activeModel : undefined;
    if (Array.isArray(m.models)) {
      // The coordinator's routable list: exactly what a `mine` call can run on this machine.
      const serves = [...new Set([...names(m.models), ...names(m.ownerModels)])];
      loaded.push(...warm.filter((n) => serves.includes(n)));
      if (activeModel && serves.includes(activeModel)) active.push(activeModel);
      rest.push(...serves);
      continue;
    }
    if (!m.state) continue;
    if (st.ollamaReachable === false) {
      if (activeModel) unreachableActive.push(activeModel);
      continue;
    }
    const installed = names(st.installed);
    loaded.push(...warm);
    if (activeModel && (installed.length === 0 || installed.includes(activeModel))) active.push(activeModel);
  }
  return [...new Set([...loaded, ...active, ...rest, ...unreachableActive])];
}

/** The memory figures a coordinator reports for a machine, checked (agent-supplied numbers). */
export function machineMemory(raw: unknown): { budgetBytes: number; models: Array<{ name: string; bytes: number }> } | undefined {
  const r = raw as { budgetBytes?: unknown; ownerModels?: unknown; models?: unknown } | null | undefined;
  if (!r || typeof r.budgetBytes !== "number" || !Number.isFinite(r.budgetBytes) || r.budgetBytes <= 0) return undefined;
  const list = (xs: unknown) =>
    (Array.isArray(xs) ? xs : [])
      .filter((x): x is { name: string; bytes: number } => typeof x?.name === "string" && typeof x?.bytes === "number" && Number.isFinite(x.bytes) && x.bytes >= 0)
      .slice(0, 64)
      .map((x) => ({ name: x.name.slice(0, 200), bytes: x.bytes }));
  return { budgetBytes: r.budgetBytes, models: [...list(r.ownerModels), ...list(r.models)] };
}

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
    const latestAgentVersion = deps.latestAgentVersion?.() ?? null;
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
        // Newer coordinators: which models are shared on the network and which run for you only.
        ...(Array.isArray(m?.networkModels) ? { networkModels: (m!.networkModels as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 200) } : {}),
        ...(Array.isArray(m?.ownerModels) ? { ownerModels: (m!.ownerModels as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 200) } : {}),
        ...(machineMemory(m?.memory) ? { memory: machineMemory(m?.memory) } : {}),
        version: typeof m?.version === "string" ? m.version.slice(0, 40) : null,
        updateAvailable: agentUpdateAvailable(m?.version, latestAgentVersion),
        audit: [...(audits.get(agentId)?.values() ?? [])].sort((x, y) => y.requestedAtMs - x.requestedAtMs).slice(0, 25)
      };
    });
    return reply.send({
      accountId,
      latestAgentVersion,
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
