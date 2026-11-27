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
 *
 * "create" (#409) makes a bot through BotManager.createFromWeb: without a folder ("Needs folder"),
 * on Accept edits (Auto only as a request), with the id fixed by the account and request id so a
 * retry makes no second bot. Nothing from the web can set or create a folder: that is
 * BotManager.setupFolder, reached only from the desktop app (/v1/ide/bots/:id/folder).
 *
 * A bot's frontier lead (its owner's key, bot-frontier.ts) is turned on only in the desktop app:
 * settings changes from the web can't touch it, and a frontier model is never a bot's compute. The
 * web sees whether it is on and today's spend, and the owner may answer the bot's ask to use it
 * (approve_frontier / decline_frontier: the account must be the bot's owner).
 */

import { basename } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BOT_READ_ACTIONS, BOT_RELAY_FEATURES, MAX_PAGE_MESSAGES, MAX_RESULT_BYTES, PAGE_MESSAGE_CHARS, SNAPSHOT_MAX_BOTS, SNAPSHOT_MESSAGE_CHARS, SNAPSHOT_TAIL_MESSAGES,
  botControlRequestSchema, botIdSchema, capMessage, fitSnapshot, isFrontierModel, servedSummary, toolCallDetail, toolSteps, usageCalls, webBotId,
  type BotControlRequest, type BotControlResult, type BotsSnapshot, type RelayControls, type RemoteBotMessage, type RemoteBotRun, type RemoteBotSummary, type RemoteServed,
} from "../../common/bot-relay.js";
import { BotError, botPatchSchema, type BotInput, type BotManager, type BotMessage, type BotRun, type BotView } from "./bots.js";
import { frontierLeadName } from "./frontier-access.js";
import { FRONTIER_ASK_TOOL } from "./bot-frontier.js";

/** Where each run's model calls ran, from its replies' usage events (runId -> served). */
function servedByRun(messages: BotMessage[]): Map<string, RemoteServed> {
  const calls = new Map<string, ReturnType<typeof usageCalls>>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.runId || !m.events?.length) continue;
    const list = usageCalls(m.events as never);
    if (list.length) calls.set(m.runId, [...(calls.get(m.runId) ?? []), ...list]);
  }
  const out = new Map<string, RemoteServed>();
  for (const [runId, list] of calls) {
    const s = servedSummary(list);
    if (s) out.set(runId, s);
  }
  return out;
}

function remoteRun(r: BotRun, served?: ReadonlyMap<string, RemoteServed>): RemoteBotRun {
  const ran = served?.get(r.id);
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
    ...(ran ? { served: ran } : {}),
    ...(r.note ? { note: r.note.slice(0, 300) } : {}),
    ...(r.error ? { error: r.error.slice(0, 300) } : {}),
    ...(r.pullRequests?.length ? { pullRequests: r.pullRequests.slice(0, 5).map((p) => ({ url: p.url, number: p.number, title: p.title?.slice(0, 200) })) } : {}),
  };
}

function remoteMessage(m: BotMessage, pendingIds: ReadonlySet<string>, chars: number): RemoteBotMessage {
  const steps = toolSteps(m.events as never, pendingIds);
  const served = m.role === "assistant" ? servedSummary(usageCalls(m.events as never)) : undefined;
  return capMessage({ id: m.id, role: m.role, content: m.content ?? "", atMs: m.atMs, ...(m.runId ? { runId: m.runId } : {}), ...(steps.length ? { steps } : {}), ...(served ? { served } : {}) }, chars);
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
    folderName: b.projectRoot ? basename(b.projectRoot) || b.projectRoot.slice(-60) : "",
    ...(b.setup ? { setup: { autoRequested: b.setup.requestedMode === "auto" } } : {}),
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
    ...(b.lastRun ? { lastRun: remoteRun(b.lastRun, servedByRun(messages.filter((m) => m.runId === b.lastRun!.id))) } : {}),
    pending: b.pending.map((p) => ({ callId: p.callId, tool: p.tool, detail: toolCallDetail(p.tool, p.args), ...(p.allowRun ? { allowRun: p.allowRun.slice(0, 160) } : {}) })),
    ...(b.frontierLead || b.frontierSpentTodayUsd ? { frontier: { on: !!b.frontierLead, ...(b.frontierLead ? { name: frontierLeadName(b.frontierLead) } : {}), spentTodayUsd: b.frontierSpentTodayUsd ?? 0 } } : {}),
    queuedMessages: b.queuedMessages,
    ...(b.auto ? { idleStreak: b.auto.idleStreak } : {}),
    tail: messages.slice(-SNAPSHOT_TAIL_MESSAGES).map((m) => remoteMessage(m, pendingIds, SNAPSHOT_MESSAGE_CHARS)),
    messageCount: messages.length,
    updatedAtMs: b.updatedAtMs,
  };
}

export function botsSnapshot(bots: BotManager, machineName: string, controls: RelayControls, now = Date.now()): BotsSnapshot {
  const list = bots.list().slice(0, SNAPSHOT_MAX_BOTS);
  return fitSnapshot({ v: 1, machineName: machineName.slice(0, 80), controls, features: [...BOT_RELAY_FEATURES], generatedAtMs: now, bots: list.map((b) => remoteSummary(b, bots.messages(b.id))) });
}

/** Keeps a read's data within MAX_RESULT_BYTES (drops the oldest items first). */
function fitList<T>(items: T[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  let list = items;
  while (list.length > 1 && Buffer.byteLength(JSON.stringify({ items: list, ...extra })) > MAX_RESULT_BYTES) list = list.slice(1);
  return { items: list, ...extra, ...(list.length < items.length ? { truncated: true } : {}) };
}

type Outcome = Omit<BotControlResult, "commandId">;

/** Carries out one verified command from the web on this computer's bots. */
export function runRemoteBotCommand(bots: BotManager, botId: string, request: BotControlRequest, controls: RelayControls, ctx: { requestedBy?: string } = {}): Outcome {
  if (controls !== "on" && !BOT_READ_ACTIONS.has(request.action)) return { status: "refused", error: "view_only", message: "This Mac shows its bits on the web read-only. Change it on the Mac." };
  try {
    if (request.action === "create") return createFromWeb(bots, botId, request.args, ctx.requestedBy);
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
        if (!r.started) return { status: "refused", error: r.reason ?? "busy", message: r.reason === "budget" ? "Today's budget for this bit is spent." : "The bit is already running." };
        return { status: "done", data: { started: true } };
      }
      case "stop":
        return { status: "done", data: { cancelled: bots.cancel(botId) } };
      case "update_settings": {
        // The desktop form's validation, then BotManager's own checks (schedule, compute, triggers).
        const patch = botPatchSchema.safeParse(request.args);
        if (!patch.success) return { status: "refused", error: "invalid_settings", message: patch.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) };
        // Permissions (tools, auto-approval, the permission mode) and the frontier lead change on the Mac only.
        const { projectRoot, repository, allowedTools, autoApproveEdits, mode, frontierLead, frontierRunCapUsd, frontierDailyCapUsd, ...safe } = patch.data;
        if (frontierLead !== undefined || frontierRunCapUsd !== undefined || frontierDailyCapUsd !== undefined) {
          return { status: "refused", error: "change_on_mac", message: "A bit's frontier lead (your own key) is turned on and off in the EdgeCoder app on the Mac." };
        }
        if (projectRoot !== undefined || repository !== undefined || allowedTools !== undefined || autoApproveEdits !== undefined || mode !== undefined) {
          return { status: "refused", error: "change_on_mac", message: "The folder, repository, tools and auto-approval are changed on the Mac." };
        }
        const updated = bots.update(botId, safe);
        // A GitHub trigger added from the web turns the frontier lead off: say so.
        return updated.notice ? { status: "done", message: updated.notice.slice(0, 300) } : { status: "done" };
      }
      case "approve": {
        // Only a call this bot is waiting on right now; the first answer (Mac or web) wins.
        const waiting = bot.pending.find((p) => p.callId === request.args.callId);
        if (!waiting) return { status: "refused", error: "no_pending_approval", message: "That approval was already answered or the run ended." };
        // Apps that only know Approve and Deny (the phone, an older web page): a frontier ask is approved for this run, or declined; still owner-only.
        if (waiting.tool === FRONTIER_ASK_TOOL) return bots.answerFrontier(botId, request.args.callId, request.args.approved ? "run" : "decline", ctx.requestedBy) ? { status: "done" } : { status: "refused", error: "no_pending_approval" };
        // "Allow for the rest of this run": the bot's owner (every request here is), in memory for this run only.
        return bots.approve(botId, request.args.callId, request.args.approved, false, false, request.args.approved && request.args.scope === "run") ? { status: "done" } : { status: "refused", error: "no_pending_approval" };
      }
      case "approve_frontier":
      case "decline_frontier": {
        // Only the bot's owner (checked in answerFrontier), only an ask it is waiting on right now.
        const choice = request.action === "decline_frontier" ? "decline" : request.args.scope;
        return bots.answerFrontier(botId, request.args.callId, choice, ctx.requestedBy)
          ? { status: "done" }
          : { status: "refused", error: "no_pending_approval", message: "That question was already answered or the run ended." };
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
      case "history": {
        const served = servedByRun(bots.messages(botId));
        return { status: "done", data: fitList(bots.history(botId).map((r) => remoteRun(r, served)).reverse()) };
      }
      case "memory":
        return { status: "done", data: { memory: bots.memory(botId).slice(0, 8_000) } };
    }
    return { status: "refused", error: "invalid_request" };
  } catch (err) {
    if (err instanceof BotError) {
      if (err.status === 404) return { status: "refused", error: "no_such_bot", message: err.message.slice(0, 300) };
      if (err.status === 403) return { status: "refused", error: "not_this_account", message: err.message.slice(0, 300) };
      return { status: err.status < 500 ? "refused" : "failed", error: err.status < 500 ? "invalid_settings" : "bot_error", message: err.message.slice(0, 300) };
    }
    if (err instanceof z.ZodError) return { status: "refused", error: "invalid_settings", message: err.issues.map((i) => i.message).join("; ").slice(0, 300) };
    return { status: "failed", error: "bot_error", message: String((err as Error)?.message ?? err).slice(0, 300) };
  }
}

/** "create": a new bot from the web, made the way a local create is, minus the folder (see the header). */
function createFromWeb(bots: BotManager, botId: string, args: Extract<BotControlRequest, { action: "create" }>["args"], requestedBy: string | undefined): Outcome {
  if (!requestedBy) return { status: "refused", error: "not_this_account" };
  // One bot per request and account, whatever the retries; a frame naming another id is refused.
  if (botId !== webBotId(requestedBy, args.requestId)) return { status: "refused", error: "bad_bot_id" };
  if (isFrontierModel(args.compute?.model)) return { status: "refused", error: "invalid_settings", message: "A bit's compute can't be a frontier model. Turn on its frontier lead in the EdgeCoder app on the Mac." };
  // The desktop form's validation of every field (a folder is never part of a web create).
  const { requestId, suggestedFolder, ...fields } = args;
  const checked = botPatchSchema.safeParse(fields);
  if (!checked.success) return { status: "refused", error: "invalid_settings", message: checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) };
  const { projectRoot: _p, allowedTools: _t, autoApproveEdits: _a, memory: _m, frontierLead: _fl, frontierRunCapUsd: _fr, frontierDailyCapUsd: _fd, ...safe } = checked.data;
  const r = bots.createFromWeb({ ...(safe as Omit<BotInput, "projectRoot">), name: args.name, id: botId, requestId, requestedBy, ...(suggestedFolder ? { suggestedFolder } : {}) });
  return { status: "done", data: { botId: r.bot.id, created: r.created, status: r.bot.status } };
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
    return runRemoteBotCommand(bots, body.data.botId, request.data, body.data.controls, { requestedBy: account });
  });
}
