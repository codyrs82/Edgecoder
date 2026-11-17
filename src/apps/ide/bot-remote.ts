// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The provider's side of bots on the web (src/common/bot-relay.ts has the whole chain).
 *
 *   GET  /v1/ide/bots/remote/snapshot?machine=<name>&controls=on|view   capped summaries of every bot
 *   POST /v1/ide/bots/remote/command   { requestedBy, botId, action, args }   one command from the web
 *
 * Both sit behind the provider's IDE token like every /v1/ide route; this machine's agent is the
 * only caller (it verified the coordinator's signed frame first). A command is refused unless the
 * account signed in on this computer is the account that asked, and runs through the same
 * BotManager calls and validation as the desktop app: the bot's own permission rules still apply.
 */

import { basename } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BOT_READ_ACTIONS, MAX_PAGE_MESSAGES, MAX_RESULT_BYTES, PAGE_MESSAGE_CHARS, SNAPSHOT_MAX_BOTS, SNAPSHOT_MESSAGE_CHARS, SNAPSHOT_TAIL_MESSAGES,
  botControlRequestSchema, botIdSchema, capMessage, fitSnapshot, toolCallDetail, toolSteps,
  type BotControlRequest, type BotControlResult, type BotsSnapshot, type RelayControls, type RemoteBotMessage, type RemoteBotRun, type RemoteBotSummary,
} from "../../common/bot-relay.js";
import { BotError, botPatchSchema, type BotManager, type BotMessage, type BotRun, type BotView } from "./bots.js";

function remoteRun(r: BotRun): RemoteBotRun {
  return {
    id: r.id,
    trigger: r.trigger,
    ...(r.source ? { source: r.source.slice(0, 200) } : {}),
    startedAtMs: r.startedAtMs,
    ...(r.endedAtMs ? { endedAtMs: r.endedAtMs } : {}),
    status: r.status,
    summary: (r.summary ?? "").slice(0, 400),
    cSats: r.cSats,
    ...(r.where ? { where: r.where.slice(0, 200) } : {}),
    ...(r.note ? { note: r.note.slice(0, 300) } : {}),
    ...(r.error ? { error: r.error.slice(0, 300) } : {}),
    ...(r.pullRequests?.length ? { pullRequests: r.pullRequests.slice(0, 5).map((p) => ({ url: p.url, number: p.number, title: p.title?.slice(0, 200) })) } : {}),
  };
}

function remoteMessage(m: BotMessage, pendingIds: ReadonlySet<string>, chars: number): RemoteBotMessage {
  const steps = toolSteps(m.events as never, pendingIds);
  return capMessage({ id: m.id, role: m.role, content: m.content ?? "", atMs: m.atMs, ...(m.runId ? { runId: m.runId } : {}), ...(steps.length ? { steps } : {}) }, chars);
}

export function remoteSummary(b: BotView, messages: BotMessage[]): RemoteBotSummary {
  const pendingIds = new Set(b.pending.map((p) => p.callId));
  return {
    id: b.id,
    name: b.name,
    role: b.role,
    color: b.color,
    ...(b.avatarShape ? { avatarShape: b.avatarShape } : {}),
    status: b.status,
    ...(b.activity ? { activity: b.activity.slice(0, 200) } : {}),
    enabled: b.enabled,
    instructions: b.instructions.slice(0, 8_000),
    folderName: basename(b.projectRoot) || b.projectRoot.slice(-60),
    ...(b.repository ? { repository: b.repository } : {}),
    ...(b.repo ? { repo: { state: b.repo.state, message: b.repo.message.slice(0, 300) } } : {}),
    schedule: b.schedule,
    heartbeatMinutes: b.heartbeatMinutes,
    maxRunsPerDay: b.maxRunsPerDay,
    runsToday: b.runsToday,
    runCount: b.runCount,
    budgetCSatsPerDay: b.budgetCSatsPerDay,
    spentTodayCSats: b.spentTodayCSats,
    compute: { policy: b.compute.policy, ...(b.compute.model ? { model: b.compute.model } : {}) },
    triggers: b.triggers.map((t) => ({ id: t.id, kind: t.kind, enabled: t.enabled, ...(t.label ? { label: t.label } : {}), ...(t.scope ? { scope: t.scope } : {}), ...(t.onlyOthers !== undefined ? { onlyOthers: t.onlyOthers } : {}) })),
    maxTriggerRunsPerHour: b.maxTriggerRunsPerHour,
    triggerStatus: b.triggerStatus,
    ...(b.nextRun ? { nextRun: { ...b.nextRun } } : {}),
    ...(b.held ? { held: b.held } : {}),
    ...(b.lastRun ? { lastRun: remoteRun(b.lastRun) } : {}),
    pending: b.pending.map((p) => ({ callId: p.callId, tool: p.tool, detail: toolCallDetail(p.tool, p.args) })),
    queuedMessages: b.queuedMessages,
    ...(b.auto ? { idleStreak: b.auto.idleStreak } : {}),
    tail: messages.slice(-SNAPSHOT_TAIL_MESSAGES).map((m) => remoteMessage(m, pendingIds, SNAPSHOT_MESSAGE_CHARS)),
    messageCount: messages.length,
    updatedAtMs: b.updatedAtMs,
  };
}

export function botsSnapshot(bots: BotManager, machineName: string, controls: RelayControls, now = Date.now()): BotsSnapshot {
  const list = bots.list().slice(0, SNAPSHOT_MAX_BOTS);
  return fitSnapshot({ v: 1, machineName: machineName.slice(0, 80), controls, generatedAtMs: now, bots: list.map((b) => remoteSummary(b, bots.messages(b.id))) });
}

/** Keeps a read's data within MAX_RESULT_BYTES (drops the oldest items first). */
function fitList<T>(items: T[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  let list = items;
  while (list.length > 1 && Buffer.byteLength(JSON.stringify({ items: list, ...extra })) > MAX_RESULT_BYTES) list = list.slice(1);
  return { items: list, ...extra, ...(list.length < items.length ? { truncated: true } : {}) };
}

type Outcome = Omit<BotControlResult, "commandId">;

/** Carries out one verified command from the web on this computer's bots. */
export function runRemoteBotCommand(bots: BotManager, botId: string, request: BotControlRequest, controls: RelayControls): Outcome {
  if (controls !== "on" && !BOT_READ_ACTIONS.has(request.action)) return { status: "refused", error: "view_only", message: "This Mac shows its bots on the web read-only. Change it on the Mac." };
  try {
    const bot = bots.get(botId);
    switch (request.action) {
      case "message":
        return { status: "done", data: bots.message(botId, request.args.content) };
      case "pause":
        bots.update(botId, { enabled: false });
        return { status: "done" };
      case "resume":
        bots.update(botId, { enabled: true });
        return { status: "done" };
      case "check_now": {
        const r = bots.runNow(botId, "manual");
        if (!r.started) return { status: "refused", error: r.reason ?? "busy", message: r.reason === "budget" ? "Today's budget for this bot is spent." : "The bot is already running." };
        return { status: "done", data: { started: true } };
      }
      case "stop":
        return { status: "done", data: { cancelled: bots.cancel(botId) } };
      case "update_settings": {
        // The desktop form's validation, then BotManager's own checks (schedule, compute, triggers).
        const patch = botPatchSchema.safeParse(request.args);
        if (!patch.success) return { status: "refused", error: "invalid_settings", message: patch.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) };
        // Permissions (tools, auto-approval, the permission mode) change on the Mac only.
        const { projectRoot, repository, allowedTools, autoApproveEdits, mode, ...safe } = patch.data;
        if (projectRoot !== undefined || repository !== undefined || allowedTools !== undefined || autoApproveEdits !== undefined || mode !== undefined) {
          return { status: "refused", error: "change_on_mac", message: "The folder, repository, tools and auto-approval are changed on the Mac." };
        }
        bots.update(botId, safe);
        return { status: "done" };
      }
      case "approve": {
        // Only a call this bot is waiting on right now; the first answer (Mac or web) wins.
        if (!bot.pending.some((p) => p.callId === request.args.callId)) return { status: "refused", error: "no_pending_approval", message: "That approval was already answered or the run ended." };
        return bots.approve(botId, request.args.callId, request.args.approved) ? { status: "done" } : { status: "refused", error: "no_pending_approval" };
      }
      case "messages": {
        const all = bots.messages(botId);
        // Messages are kept in the order they were added, and several can share a millisecond, so the
        // cursor is the oldest message the caller has (its id): a time alone would skip messages from that same ms.
        const { beforeId, beforeMs } = request.args;
        const cut = beforeId === undefined ? -1 : all.findIndex((m) => m.id === beforeId);
        const older = cut >= 0 ? all.slice(0, cut) : beforeMs === undefined ? all : all.filter((m) => m.atMs < beforeMs);
        const limit = Math.min(request.args.limit ?? 20, MAX_PAGE_MESSAGES);
        const page = older.slice(-limit);
        const pendingIds = new Set(bot.pending.map((p) => p.callId));
        return { status: "done", data: fitList(page.map((m) => remoteMessage(m, pendingIds, PAGE_MESSAGE_CHARS)), { more: older.length > page.length, total: all.length }) };
      }
      case "history":
        return { status: "done", data: fitList(bots.history(botId).map(remoteRun).reverse()) };
      case "memory":
        return { status: "done", data: { memory: bots.memory(botId).slice(0, 8_000) } };
    }
  } catch (err) {
    if (err instanceof BotError) {
      if (err.status === 404) return { status: "refused", error: "no_such_bot", message: err.message.slice(0, 300) };
      return { status: err.status < 500 ? "refused" : "failed", error: err.status < 500 ? "invalid_settings" : "bot_error", message: err.message.slice(0, 300) };
    }
    if (err instanceof z.ZodError) return { status: "refused", error: "invalid_settings", message: err.issues.map((i) => i.message).join("; ").slice(0, 300) };
    return { status: "failed", error: "bot_error", message: String((err as Error)?.message ?? err).slice(0, 300) };
  }
}

const commandBody = z.object({ requestedBy: z.string().min(1).max(160), botId: botIdSchema, action: z.string(), args: z.unknown().optional(), controls: z.enum(["on", "view"]).default("on") });

export interface RemoteBotRouteDeps {
  /** The EdgeCoder account signed in on this computer (null: unknown, so nothing from the web runs). */
  account: () => Promise<string | null>;
}

export function registerRemoteBotRoutes(app: FastifyInstance, bots: BotManager, deps: RemoteBotRouteDeps): void {
  app.get("/v1/ide/bots/remote/snapshot", async (req) => {
    const q = z.object({ machine: z.string().max(80).default(""), controls: z.enum(["on", "view"]).default("on") }).catch({ machine: "", controls: "view" }).parse(req.query ?? {});
    return botsSnapshot(bots, q.machine, q.controls);
  });
  app.post("/v1/ide/bots/remote/command", async (req, reply) => {
    const body = commandBody.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ status: "refused", error: "malformed" });
    const request = botControlRequestSchema.safeParse({ action: body.data.action, args: body.data.args ?? {} });
    if (!request.success) return reply.status(400).send({ status: "refused", error: "invalid_request", message: request.error.issues[0]?.message });
    // Defense in depth: the coordinator checked ownership; the Mac checks its own signed-in account too.
    const account = await deps.account().catch(() => null);
    if (!account || account !== body.data.requestedBy) return reply.status(403).send({ status: "refused", error: "not_this_account", message: "The account signed in on this Mac didn't ask for this." });
    return runRemoteBotCommand(bots, body.data.botId, request.data, body.data.controls);
  });
}
