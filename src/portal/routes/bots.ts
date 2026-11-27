// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Bots on the web: the bots on the signed-in account's desktop machines (src/common/bot-relay.ts).
 *
 *   GET  /portal/api/bots                                     every bot on the account's machines (no conversation)
 *   GET  /portal/api/bots/:agentId/:botId                     one bot, with its latest messages
 *   POST /portal/api/bots/:agentId/:botId/commands            { action, args } for one of the account's machines
 *   GET  /portal/api/bots/:agentId/commands/:commandId        that command's result (polled)
 *   POST /portal/api/bots/new                                 { requestId, agentId|null, bot } a new bot (#409)
 *   DELETE /portal/api/bots/pending/:requestId                drop a new bot that hasn't reached a machine
 *
 * Cloud bots (routes/cloud-bots.ts, docs/cloud-bots.md) share these routes with agentId "cloud":
 * they are listed with the machines' bots, made at once by /new, and have their own static
 * /portal/api/bots/cloud/... routes (registered first, so "cloud" is never taken for a machine).
 *
 * New bots from the web: the request is kept (pending) in the portal database until a machine made it.
 * It is sent as the relay's signed "create" command to the machine picked ("Runs on"), or to the
 * first of the account's machines that is online with an app that can take it. The machine makes it
 * without a folder ("Needs folder") and someone there picks the folder. The request id makes it
 * idempotent end to end: the same entry here, the same command at the coordinator, one bot on the machine.
 * Pending requests are checked on each list poll and by a sweep every minute (any portal machine;
 * a duplicate send is harmless for that reason).
 *
 * The account is always acct-<session user> (never from the request). The portal asks only about
 * the user's enrolled agent nodes; each coordinator checks the agent's verified ownership row again
 * before it shows anything or signs a command for the agent. Nothing here is cached across users.
 */

import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { z } from "zod";
import { CLOUD_AGENT_ID, CLOUD_MACHINE, normalizeCompute } from "../cloud-bots/types.js";
import type { CloudBotService } from "./cloud-bots.js";
import { BOT_CONTROL_ACTIONS, botControlRequestSchema, botIdSchema, botRequestIdSchema, remoteBotCreateSchema, webBotId, type BotsSnapshot, type RemoteBotCreate, type RemoteBotSummary } from "../../common/bot-relay.js";

/** A new bot from the web that no machine has made yet (stored per account: PendingBotStore). */
export interface PendingBot {
  requestId: string;
  /** The id it gets on the machine (webBotId). */
  botId: string;
  /** The machine picked in "Runs on"; null: the first of the account's machines that can take it. */
  target: string | null;
  spec: RemoteBotCreate;
  state: "waiting" | "sent" | "failed";
  agentId?: string;
  commandId?: string;
  sentAtMs?: number;
  /** The machine said done; dropped once its snapshot shows the bot. */
  doneAtMs?: number;
  error?: string;
  message?: string;
  createdAtMs: number;
}

/** Where pending new bots live (PortalStore: a row per account in an existing table; no migration). */
export interface PendingBotStore {
  getPendingBots(userId: string): Promise<{ list: PendingBot[]; version: number }>;
  /** Only when the stored version is still `version` (another portal machine may have saved meanwhile). */
  savePendingBots(userId: string, list: PendingBot[], version: number, nowMs: number): Promise<boolean>;
  listPendingBotOwners(limit: number): Promise<string[]>;
}

/** New bots one account may have waiting for a machine. */
export const MAX_PENDING_BOTS = 10;
/** A done create is dropped after this long even if no snapshot showed it yet. */
const DONE_KEEP_MS = 10 * 60_000;
/** A sent create the coordinator lost track of is sent again after this long. */
const SENT_RETRY_MS = 2 * 60_000;

export interface BotRoutesDeps {
  PORTAL_SERVICE_TOKEN: string;
  EXTERNAL_HTTP_TIMEOUT_MS: number;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string } | null | undefined>;
  store: ({ listNodesByOwner(userId: string): Promise<Array<{ nodeId: string; nodeKind: string; active?: boolean; lastSeenMs?: number }>> } & Partial<PendingBotStore>) | null | undefined;
  /** How often pending new bots are retried without anyone on the page (0: never; default 60 s). */
  pendingSweepMs?: number;
  now?: () => number;
  /** Cloud bots (null: not available here, e.g. no portal database). */
  cloud?: CloudBotService | null;
}

/**
 * A new bot for a machine from a client that sends the cloud contract's fields too (the iOS app
 * sends them for every target): what the desktop understands is mapped to its form's fields, the
 * rest is dropped. A GitHub token never goes to a machine (it uses the GitHub account signed in there).
 */
export function machineBotSpec(bot: Record<string, unknown>): Record<string, unknown> {
  const { web: _web, schedule, github, compute, budgetCSatsPerRun: _bpr, maxTurns: _mt, ...rest } = bot;
  const out: Record<string, unknown> = { ...rest };
  if (typeof schedule === "string") out.schedule = schedule;
  else if (schedule && typeof schedule === "object" && typeof (schedule as { everyMinutes?: unknown }).everyMinutes === "number") {
    // "daily at" on a machine is its local time, so a UTC time isn't carried over.
    out.schedule = `every ${Math.max(5, Math.floor((schedule as { everyMinutes: number }).everyMinutes))} minutes`;
  }
  if (compute !== undefined) {
    const c = normalizeCompute(compute);
    if (compute && typeof compute === "object" && !c) out.compute = compute;
    else if (c === "auto") out.compute = { policy: "auto" };
    else if (c?.startsWith("mine:")) out.compute = { policy: "model", model: c.slice(5) };
    else if (c === "network:auto") out.compute = { policy: "network_only" };
    else if (c?.startsWith("network:")) out.compute = { policy: "network_only", model: c.slice(8).startsWith("network/") ? c.slice(8) : `network/${c.slice(8)}` };
  }
  if (github && typeof github === "object") {
    const g = github as { repo?: unknown; triggers?: unknown };
    if (typeof g.repo === "string" && g.repo.trim() && out.repository === undefined) out.repository = g.repo.trim();
    if (Array.isArray(g.triggers) && out.triggers === undefined) {
      const tr: Array<Record<string, unknown>> = [];
      for (const t of g.triggers) {
        const kind = typeof t === "string" ? t : (t as { kind?: unknown; event?: unknown })?.kind ?? (t as { event?: unknown })?.event;
        const label = typeof t === "object" && t && typeof (t as { label?: unknown }).label === "string" ? String((t as { label: string }).label).trim() : "";
        if (kind === "pr_opened" || kind === "pr") tr.push({ kind: "pr", enabled: true, onlyOthers: true });
        else if (kind === "ci_failed") tr.push({ kind: "ci_failed", enabled: true, scope: "any" });
        else if (kind === "issue_labeled") tr.push({ kind: "issue_labeled", enabled: true, label: label || "bot" });
      }
      if (tr.length) out.triggers = tr;
    }
  }
  return out;
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
  /** "on": commands and approvals from the web; "view": read-only (approve on the machine). Offline is always read-only. */
  controls: "on" | "view";
  reportedAtMs: number | null;
  /** Online, takes changes from the web, and its app can make new bots ("create"). */
  canCreate: boolean;
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
        machine: {
          agentId: m.agentId,
          machineName: String(s.machineName || m.agentId),
          online,
          controls: online && s.controls === "on" ? "on" : "view",
          reportedAtMs: m.reportedAtMs,
          canCreate: online && s.controls === "on" && Array.isArray(s.features) && s.features.includes("create"),
        },
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

  /** One command to the coordinator holding the machine's connection (each is tried in turn). */
  async function sendCommand(agentId: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
    let last: { status: number; body: any } = { status: 409, body: { error: "agent_not_connected" } };
    for (const base of await coordinators()) {
      try {
        const r = await postJson(`${base}/agent-control/agents/${encodeURIComponent(agentId)}/bot-commands`, body);
        // Another coordinator may hold the machine's connection.
        if (r.status === 409 && r.body?.error === "agent_not_connected") {
          last = r;
          continue;
        }
        return r;
      } catch {
        last = { status: 502, body: { error: "coordinator_unreachable" } };
      }
    }
    return last;
  }
  async function commandState(accountId: string, agentId: string, commandId: string): Promise<any | null> {
    for (const base of await coordinators()) {
      try {
        const r = await postJson(`${base}/agent-control/bot-commands/${encodeURIComponent(commandId)}`, { accountId });
        // The coordinator answers only the account that sent it.
        if (r.status === 200 && r.body?.agentId === agentId) return r.body;
      } catch {
        /* try the next coordinator */
      }
    }
    return null;
  }

  // ---- New bots from the web (#409) ----
  const now = () => deps.now?.() ?? Date.now();
  const pendingStore = (): PendingBotStore | null =>
    deps.store && typeof deps.store.getPendingBots === "function" && typeof deps.store.savePendingBots === "function" && typeof deps.store.listPendingBotOwners === "function"
      ? (deps.store as unknown as PendingBotStore)
      : null;

  /** What the page shows of a pending new bot (no instructions or other settings). */
  function pendingView(p: PendingBot, machines: MachineInfo[]) {
    const target = p.target ?? p.agentId ?? null;
    const m = machines.find((x) => x.agentId === target);
    return {
      requestId: p.requestId,
      botId: p.botId,
      name: p.spec.name,
      role: p.spec.role ?? "",
      color: p.spec.color ?? "#6e56cf",
      state: p.state,
      target: p.target,
      machineName: m?.machineName ?? null,
      ...(p.error ? { error: p.error } : {}),
      ...(p.message ? { message: p.message } : {}),
      createdAtMs: p.createdAtMs,
    };
  }

  /**
   * Moves each of the account's pending new bots on: dropped once a machine shows it, sent to the
   * machine it waits for (or the first that can take it), settled from the command's result.
   */
  async function reconcile(userId: string, known?: Array<{ machine: MachineInfo; bots: RemoteBotSummary[] }>): Promise<PendingBot[]> {
    const store = pendingStore();
    if (!store) return [];
    const { list, version } = await store.getPendingBots(userId);
    if (!list.length) return [];
    const accountId = `acct-${userId}`;
    const machines = known ?? (await machinesFor(userId));
    const made = new Set(machines.flatMap((m) => m.bots.map((b) => b.id)));
    const t = now();
    let changed = false;
    const next: PendingBot[] = [];
    for (const p0 of list) {
      let p = p0;
      // A machine has it: it shows in the list as a bot now.
      if (made.has(p.botId)) {
        changed = true;
        continue;
      }
      if (p.state === "sent" && p.commandId && p.agentId) {
        const st = await commandState(accountId, p.agentId, p.commandId);
        const r = st?.result;
        if (r?.status === "done") {
          if (!p.doneAtMs) p = { ...p, doneAtMs: t };
        } else if (r && (r.status === "refused" || r.status === "failed") && r.error !== "agent_rate_limited" && r.error !== "provider_unreachable") {
          p = { ...p, state: "failed", error: String(r.error ?? "failed").slice(0, 80), message: String(r.message ?? "").slice(0, 300) };
        } else if (r || st?.status === "expired" || (!st && t - (p.sentAtMs ?? 0) > SENT_RETRY_MS)) {
          // Not answered, lost, or worth another try: wait for a machine again.
          const { agentId: _a, commandId: _c, sentAtMs: _s, ...rest } = p;
          p = { ...rest, state: "waiting" };
        }
        if (p.doneAtMs && t - p.doneAtMs > DONE_KEEP_MS) {
          changed = true;
          continue;
        }
      }
      if (p.state === "waiting") {
        const m = machines.find((x) => x.machine.canCreate && (p.target ? x.machine.agentId === p.target : true));
        if (m) {
          const r = await sendCommand(m.machine.agentId, { accountId, botId: p.botId, action: "create", args: p.spec });
          if (r.status === 200 && typeof r.body?.commandId === "string") p = { ...p, state: "sent", agentId: m.machine.agentId, commandId: r.body.commandId, sentAtMs: t };
          else if (r.status === 400 || r.status === 403) p = { ...p, state: "failed", error: String(r.body?.error ?? "refused").slice(0, 80), message: String(r.body?.detail ?? r.body?.message ?? "").slice(0, 300) };
        }
      }
      if (p !== p0) changed = true;
      next.push(p);
    }
    if (changed) await store.savePendingBots(userId, next, version, t).catch(() => false);
    return next;
  }

  if (pendingStore() && (deps.pendingSweepMs ?? 60_000) > 0) {
    let sweeping = false;
    const timer = setInterval(() => {
      const store = pendingStore();
      if (sweeping || !store) return;
      sweeping = true;
      void (async () => {
        for (const userId of await store.listPendingBotOwners(200)) await reconcile(userId).catch(() => undefined);
      })()
        .catch(() => undefined)
        .finally(() => (sweeping = false));
    }, deps.pendingSweepMs ?? 60_000);
    timer.unref?.();
    app.addHook("onClose", async () => clearInterval(timer));
  }

  /** "Runs on": every enrolled machine, with whether it can take a new bot now. */
  async function targetsFor(userId: string, machines: Array<{ machine: MachineInfo }>) {
    const seenIds = new Set(machines.map((m) => m.machine.agentId));
    const others = (await agentNodes(userId)).filter((id) => !seenIds.has(id)).map((id) => ({ agentId: id, machineName: id, online: false, canCreate: false }));
    return [...machines.map((m) => ({ agentId: m.machine.agentId, machineName: m.machine.machineName, online: m.machine.online, canCreate: m.machine.canCreate })), ...others];
  }

  // ---- Cloud bots: static routes, so they win over /:agentId/... ----
  const cloud = deps.cloud ?? null;
  const botIdParam = z.object({ botId: botIdSchema });
  app.get("/portal/api/bots/cloud/:botId", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    if (!cloud) return reply.code(503).send({ error: "cloud_bots_unavailable" });
    const p = botIdParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_bot" });
    reply.header("cache-control", "no-store");
    const a = await cloud.detail(user.userId, p.data.botId);
    return reply.code(a.status).send(a.body);
  });
  app.post("/portal/api/bots/cloud/:botId/commands", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    if (!cloud) return reply.code(503).send({ error: "cloud_bots_unavailable" });
    const p = botIdParam.safeParse(req.params);
    const body = z.object({ action: z.string().min(1).max(40), args: z.record(z.string(), z.unknown()).optional() }).safeParse(req.body ?? {});
    if (!p.success || !body.success) return reply.code(400).send({ error: "invalid_command" });
    const a = await cloud.command(user.userId, p.data.botId, body.data.action, body.data.args ?? {});
    return reply.code(a.status).send(a.body);
  });
  app.get("/portal/api/bots/cloud/commands/:commandId", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    if (!cloud) return reply.code(503).send({ error: "cloud_bots_unavailable" });
    const p = z.object({ commandId: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/) }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_command" });
    reply.header("cache-control", "no-store");
    const a = await cloud.commandState(user.userId, p.data.commandId);
    return reply.code(a.status).send(a.body);
  });

  app.get("/portal/api/bots", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const [machines, cloudBots] = await Promise.all([machinesFor(user.userId), cloud ? cloud.list(user.userId).catch(() => []) : Promise.resolve([])]);
    const pending = await reconcile(user.userId, machines).catch(() => [] as PendingBot[]);
    reply.header("cache-control", "no-store");
    return reply.send({
      machines: machines.map((m) => m.machine),
      bots: [
        ...cloudBots.map(({ tail: _tail, instructions: _i, ...b }) => b),
        ...machines.flatMap((m) => m.bots.map(({ tail: _tail, instructions: _i, ...b }) => ({ ...b, runtime: "desktop", machine: m.machine }))),
      ],
      pending: pending.map((p) => pendingView(p, machines.map((m) => m.machine))),
      // Cloud first: there is always somewhere to make a bot, with or without a machine.
      targets: [...(cloud ? [{ agentId: CLOUD_MACHINE.agentId, machineName: CLOUD_MACHINE.machineName, online: true, canCreate: true }] : []), ...(await targetsFor(user.userId, machines))],
      canCreate: !!pendingStore() || !!cloud,
      ...(cloud ? { cloud: { github: cloud.githubEnabled } } : {}),
    });
  });

  app.post("/portal/api/bots/new", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const body = z.object({ requestId: botRequestIdSchema, agentId: agentIdSchema.nullable().default(null), bot: z.record(z.string(), z.unknown()) }).strict().safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_bot" });
    if (body.data.agentId === CLOUD_AGENT_ID) {
      if (!cloud) return reply.code(503).send({ error: "cloud_bots_unavailable", message: "Cloud bits aren't available here." });
      const a = await cloud.create(user.userId, body.data.requestId, body.data.bot);
      return reply.code(a.status).send(a.body);
    }
    const store = pendingStore();
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const spec = remoteBotCreateSchema.safeParse({ ...machineBotSpec(body.data.bot), requestId: body.data.requestId });
    if (!spec.success) return reply.code(400).send({ error: "invalid_bot", detail: spec.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) });
    // Only the session's own enrolled machines (the coordinator checks the verified owner again).
    if (body.data.agentId && !(await agentNodes(user.userId)).includes(body.data.agentId)) return reply.code(403).send({ error: "not_your_machine" });
    const accountId = `acct-${user.userId}`;
    const botId = webBotId(accountId, body.data.requestId);
    const { list, version } = await store.getPendingBots(user.userId);
    const same = list.find((p) => p.requestId === body.data.requestId);
    if (!same) {
      // Already made (a retry after it arrived): nothing new.
      const machines = await machinesFor(user.userId);
      const made = machines.find((m) => m.bots.some((b) => b.id === botId));
      if (made) return reply.send({ ok: true, botId, agentId: made.machine.agentId, state: "created" });
      if (list.length >= MAX_PENDING_BOTS) return reply.code(429).send({ error: "too_many_pending", message: `At most ${MAX_PENDING_BOTS} new bits can wait for a machine.` });
      const entry: PendingBot = { requestId: body.data.requestId, botId, target: body.data.agentId, spec: spec.data, state: "waiting", createdAtMs: now() };
      if (!(await store.savePendingBots(user.userId, [...list, entry], version, now()))) return reply.code(409).send({ error: "busy", message: "Try again." });
      const after = await reconcile(user.userId, machines);
      const p = after.find((x) => x.requestId === body.data.requestId) ?? entry;
      return reply.send({ ok: true, botId, state: p.state, pending: pendingView(p, machines.map((m) => m.machine)) });
    }
    return reply.send({ ok: true, botId, state: same.state, pending: pendingView(same, []) });
  });

  app.delete("/portal/api/bots/pending/:requestId", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const store = pendingStore();
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const p = z.object({ requestId: botRequestIdSchema }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_request" });
    const { list, version } = await store.getPendingBots(user.userId);
    if (!list.some((x) => x.requestId === p.data.requestId)) return reply.code(404).send({ error: "not_found" });
    if (!(await store.savePendingBots(user.userId, list.filter((x) => x.requestId !== p.data.requestId), version, now()))) return reply.code(409).send({ error: "busy", message: "Try again." });
    return reply.send({ ok: true });
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
    // New bots go through /portal/api/bots/new (kept until a machine made them).
    if (!body.success || body.data.action === "create") return reply.code(400).send({ error: "invalid_command" });
    const parsed = botControlRequestSchema.safeParse({ action: body.data.action, args: body.data.args ?? {} });
    if (!parsed.success) return reply.code(400).send({ error: "invalid_command", detail: parsed.error.issues[0]?.message });
    // First check here (enrolled to this user); the coordinator checks the verified ownership row again.
    if (!(await agentNodes(user.userId)).includes(p.data.agentId)) return reply.code(403).send({ error: "not_your_machine" });
    const accountId = `acct-${user.userId}`;
    const r = await sendCommand(p.data.agentId, { accountId, botId: p.data.botId, ...parsed.data });
    if (r.status !== 200) return reply.code(r.status).send({ error: r.body?.error ?? "command_failed", message: r.body?.message });
    return reply.send({ ok: true, commandId: r.body.commandId });
  });

  app.get("/portal/api/bots/:agentId/commands/:commandId", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const p = z.object({ agentId: agentIdSchema, commandId: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/) }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_command" });
    reply.header("cache-control", "no-store");
    const state = await commandState(`acct-${user.userId}`, p.data.agentId, p.data.commandId);
    return state ? reply.send(state) : reply.code(404).send({ error: "unknown_command" });
  });
}
