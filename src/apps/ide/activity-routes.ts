// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Settings → Active work, Tasks and Logs (the desktop app), read-only:
 *
 *   GET /v1/ide/activity          this machine's agent (coordinator, paused, slots, jobs it serves)
 *                                 and the owner's own requests running now (chat, Code, bots, helpers)
 *   GET /v1/ide/activity/recent   finished requests kept in memory (API calls; chat and Code turns)
 *   GET /v1/ide/logs              the end of an app log, then what was appended (?source=&after=&maxKb=)
 *
 * Like every route here they need the IDE token (ide-auth.ts). The log route also refuses any
 * caller that is not on this computer, whatever address the server was bound to.
 */

import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { z } from "zod";
import { agentView, firstLine, type ActivityItem, type ActivityKind, type ActivityTracker, type AgentView } from "./activity.js";
import { DEFAULT_TAIL_BYTES, LOG_SOURCES, MAX_TAIL_BYTES, findSource, logDir, logSourcesStatus, readLogTail } from "./log-tail.js";

/** Something running elsewhere in the provider (a session turn, a bot run, a helper). */
export type ExtraActivity = () => ActivityItem[];

export interface ActivityRouteDeps {
  tracker: ActivityTracker;
  /** This machine's agent forwarder's /forward/health, or null when there is none / it is down. */
  agentHealth: (() => Promise<Record<string, unknown> | null>) | null;
  /** Task ids of network requests this provider has in flight (its own jobs on its own agent). */
  ownTaskIds: () => ReadonlySet<string>;
  /** Running work kept by other stores (sessions, bots, helpers, network jobs). */
  extra?: ExtraActivity[];
  /** Where the log files are (default ~/.edgecoder). */
  logDir?: string;
  now?: () => number;
}

export interface ActivityResponse {
  atMs: number;
  /** null: this computer is not on the network (no agent forwarder). */
  agent: AgentView | null;
  mine: ActivityItem[];
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(addr: string | undefined): boolean {
  return !!addr && (LOOPBACK.has(addr) || /^127\./.test(addr) || /^::ffff:127\./.test(addr));
}

export function registerActivityRoutes(app: FastifyInstance, deps: ActivityRouteDeps): void {
  const now = deps.now ?? Date.now;

  app.get("/v1/ide/activity", async (_req, reply) => {
    const health = deps.agentHealth ? await deps.agentHealth().catch(() => null) : undefined;
    const mine: ActivityItem[] = [...deps.tracker.running()];
    for (const more of deps.extra ?? []) {
      try {
        mine.push(...more());
      } catch {
        // one store failing leaves the others
      }
    }
    mine.sort((a, b) => a.startedAtMs - b.startedAtMs);
    const body: ActivityResponse = {
      atMs: now(),
      agent: health === undefined ? null : agentView(health, deps.ownTaskIds(), now()),
      mine,
    };
    return reply.header("cache-control", "no-store").send(body);
  });

  app.get("/v1/ide/activity/recent", async (req, reply) => {
    const q = z.object({ kind: z.enum(["chat", "code", "bot", "tentacle", "api"]).optional() }).safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send({ error: "invalid" });
    const kinds: ActivityKind[] | undefined = q.data.kind ? [q.data.kind] : undefined;
    return reply.header("cache-control", "no-store").send({ items: deps.tracker.recent(kinds) });
  });

  app.get("/v1/ide/logs", async (req, reply) => {
    if (!isLoopbackAddress(req.socket?.remoteAddress ?? req.ip)) return reply.status(403).send({ error: "loopback_only" });
    const q = z
      .object({
        source: z.string().max(40).default("agent"),
        after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        maxKb: z.coerce.number().int().min(1).max(MAX_TAIL_BYTES / 1024).default(DEFAULT_TAIL_BYTES / 1024),
      })
      .safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send({ error: "invalid", message: q.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    // A source id from the fixed list, never a path: nothing outside the log folder can be named.
    const source = findSource(q.data.source);
    if (!source) return reply.status(404).send({ error: "unknown_source", sources: LOG_SOURCES.map((s) => s.id) });
    const dir = deps.logDir ?? logDir();
    const tail = readLogTail(join(dir, source.file), { after: q.data.after, maxBytes: q.data.maxKb * 1024, source: source.id });
    return reply.header("cache-control", "no-store").send({ ...tail, sources: logSourcesStatus(dir) });
  });
}

// ---------------------------------------------------------------------------
// Running work kept by the provider's other stores, as activity items
// ---------------------------------------------------------------------------

interface CallLike { cSats: number; where?: string; model?: string; served?: ActivityItem["calls"][number]["served"] }

/** A running session turn (`edgecoder code` and other session clients). */
export function sessionActivity(s: { id: string; title: string; model: string; origin: string; updatedAt: number }, running: { turnId: string; text: string; events: Array<Record<string, unknown> & { type: string }> } | null): ActivityItem | null {
  if (!running) return null;
  const calls: CallLike[] = [];
  const steps: string[] = [];
  let progress: string | undefined;
  for (const e of running.events ?? []) {
    if (e.type === "usage") calls.push({ cSats: Number(e.cSats) || 0, ...(typeof e.where === "string" ? { where: e.where } : {}), ...(typeof e.model === "string" ? { model: e.model } : {}), ...(e.served ? { served: e.served as CallLike["served"] } : {}) });
    else if (e.type === "tool_call" && typeof e.tool === "string") steps.push(firstLine(`${e.tool}`, 120));
    else if (e.type === "status" && typeof e.message === "string") progress = firstLine(e.message, 160);
  }
  return {
    id: `turn-${running.turnId}`,
    kind: "code",
    title: firstLine(running.text) || s.title,
    source: s.origin === "terminal" ? `edgecoder code · ${s.title}` : s.title,
    model: s.model,
    startedAtMs: s.updatedAt,
    status: "running",
    cSats: calls.reduce((n, c) => n + c.cSats, 0),
    calls,
    steps: steps.slice(-40),
    ...(progress ? { progress } : {}),
  };
}

/** A bot run in progress (or waiting for an approval). */
export function botActivity(b: { id: string; name: string; status: string; activity?: string; lastRun?: { id: string; trigger: string; startedAtMs: number; cSats: number; where?: string; summary?: string } }): ActivityItem | null {
  if ((b.status !== "running" && b.status !== "needs_approval") || !b.lastRun) return null;
  const r = b.lastRun;
  return {
    id: `bot-${r.id}`,
    kind: "bot",
    title: firstLine(b.activity) || `${b.name}: ${r.trigger} run`,
    source: b.name,
    startedAtMs: r.startedAtMs,
    status: "running",
    cSats: r.cSats,
    calls: r.where ? [{ cSats: r.cSats, where: r.where }] : [],
    steps: [],
    ...(b.status === "needs_approval" ? { progress: "Waiting for your approval" } : b.activity ? { progress: firstLine(b.activity, 160) } : {}),
  };
}

/** A helper (tentacle) that is queued, running or verifying. */
export function tentacleActivity(t: { id: string; task: string; status: string; progress: string; createdAt: number; startedAt?: number; cSats: number; model?: string; calls?: CallLike[] }, sessionTitle: string): ActivityItem | null {
  if (t.status !== "queued" && t.status !== "running" && t.status !== "verifying") return null;
  return {
    id: `tentacle-${t.id}`,
    kind: "tentacle",
    title: firstLine(t.task),
    source: sessionTitle,
    ...(t.model ? { model: t.model } : {}),
    startedAtMs: t.startedAt ?? t.createdAt,
    status: "running",
    cSats: t.cSats,
    calls: (t.calls ?? []).map((c) => ({ cSats: c.cSats, ...(c.where ? { where: c.where } : {}), ...(c.model ? { model: c.model } : {}), ...(c.served ? { served: c.served } : {}) })),
    steps: [],
    progress: t.status === "queued" ? "Waiting for a free helper slot" : firstLine(t.progress, 160),
  };
}

/** A background code job sent to the network from chat (network-tasks.ts). */
export function networkTaskActivity(t: { id: string; prompt: string; state: string; submittedAtMs: number; creditsSpent?: number }): ActivityItem | null {
  if (t.state !== "running") return null;
  return { id: `job-${t.id}`, kind: "chat", title: firstLine(t.prompt), source: "Network job", startedAtMs: t.submittedAtMs, status: "running", cSats: t.creditsSpent ?? 0, calls: [], steps: [], progress: "Running on the network" };
}
