// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Cloud bots on the existing bots API (routes/bots.ts; docs/cloud-bots.md). A cloud bot answers to
 * agentId "cloud", so clients list, open and drive it like a desktop bot:
 *
 *   GET  /portal/api/bots                          cloud bots are in `bots` (runtime "cloud"), and
 *                                                  `targets` always starts with the Cloud target
 *   POST /portal/api/bots/new                      agentId "cloud": made at once -> { botId, agentId: "cloud" }
 *   GET  /portal/api/bots/cloud/:botId             { bot, machine } like a desktop bot (tail = latest messages)
 *   POST /portal/api/bots/cloud/:botId/commands    { action, args } -> { commandId, result } (result inline)
 *   GET  /portal/api/bots/cloud/commands/:id       that command's state (a message: its run's status)
 *
 * Actions: message, pause, resume, check_now, stop, update_settings, delete, and the reads the page
 * uses (messages, history, memory). Every call is the session's own account: each store read names
 * the user, and another account's bot id answers 404 like a missing one. The GitHub token is
 * accepted on create and update_settings, sealed (cloud-bots/secrets.ts) and never sent back:
 * clients see only `github.hasToken`.
 */

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { BOT_CONTROL_ACTIONS, type RemoteBotMessage, type RemoteBotRun } from "../../common/bot-relay.js";
import type { CloudBotRunner } from "../cloud-bots/runner.js";
import { BOT_SECRETS_DISABLED_MESSAGE, type BotSecrets } from "../cloud-bots/secrets.js";
import type { CloudBotPatch, CloudBotStore } from "../cloud-bots/store.js";
import {
  CLOUD_AGENT_ID,
  CLOUD_MACHINE,
  DEFAULT_LIMITS,
  cloudBotCreateSchema,
  cloudBotUpdateSchema,
  computeView,
  defaultColor,
  nextScheduledRun,
  normalizeTriggers,
  scheduleText,
  utcDayStart,
  type CloudBot,
  type CloudBotConfig,
  type CloudMessage,
  type CloudRun,
} from "../cloud-bots/types.js";

export const CLOUD_ACTIONS = ["message", "pause", "resume", "check_now", "stop", "update_settings", "delete", "messages", "history", "memory"] as const;
export type CloudAction = (typeof CLOUD_ACTIONS)[number];
export const CLOUD_TAIL_MESSAGES = 30;

export interface CloudBotServiceDeps {
  store: CloudBotStore;
  secrets: BotSecrets;
  /** Kicked when a run is queued (null: queued runs wait for a portal machine that runs them). */
  runner?: Pick<CloudBotRunner, "kick" | "queueEvent"> | null;
  now?: () => number;
  /** Bots per account (CLOUD_BOTS_MAX_PER_ACCOUNT, default 20). */
  maxBotsPerAccount?: number;
  /** GitHub poll interval, for the first poll after a change. */
  pollIntervalMs?: number;
  /** Per-account rate limits (per portal machine): new bots an hour, messages a minute. */
  rate?: { createsPerHour: number; messagesPerMinute: number };
}

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/** Fixed per account and request: a retried create finds the same bot. */
export function cloudBotId(userId: string, requestId: string): string {
  return `cbot_${createHash("sha256").update(`cloud\n${userId}\n${requestId}`).digest("hex").slice(0, 16)}`;
}

class Window {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly ms: number) {}
  take(key: string, nowMs: number): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => nowMs - t < this.ms);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(nowMs);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value!);
    return true;
  }
}

function toRemoteMessage(m: CloudMessage): RemoteBotMessage {
  const steps = Array.isArray(m.meta?.steps) ? (m.meta!.steps as RemoteBotMessage["steps"]) : undefined;
  return { id: m.id, role: m.role, content: m.content, atMs: m.createdAtMs, ...(m.runId ? { runId: m.runId } : {}), ...(steps?.length ? { steps } : {}) };
}

function toRemoteRun(r: CloudRun): RemoteBotRun {
  return {
    id: r.id,
    trigger: r.trigger,
    ...(r.source ? { source: r.source } : {}),
    startedAtMs: r.startedAtMs ?? r.createdAtMs,
    ...(r.endedAtMs ? { endedAtMs: r.endedAtMs } : {}),
    status: r.status === "budget" ? "budget" : r.status,
    summary: r.summary,
    cSats: r.cSats,
    where: r.where ?? "Cloud",
    ...(r.error ? { error: r.error } : {}),
  };
}

export class CloudBotService {
  private readonly now: () => number;
  private readonly results = new Map<string, { userId: string; botId: string; action: string; result: Record<string, unknown>; atMs: number }>();
  private readonly creates: Window;
  private readonly messages: Window;

  constructor(private readonly d: CloudBotServiceDeps) {
    this.now = d.now ?? Date.now;
    this.creates = new Window(d.rate?.createsPerHour ?? 20, 3_600_000);
    this.messages = new Window(d.rate?.messagesPerMinute ?? 20, 60_000);
  }

  get githubEnabled(): boolean {
    return this.d.secrets.enabled;
  }

  /** What a client sees of a cloud bot: the desktop bot summary's fields, plus `runtime` and `cloud`. */
  async summary(bot: CloudBot, opts: { tail: boolean }) {
    const s = this.d.store;
    const nowMs = this.now();
    const [active, day, lastRuns, tail, count, gstate] = await Promise.all([
      s.activeRun(bot.id),
      s.usageSince(bot.id, utcDayStart(nowMs)),
      s.listRuns(bot.userId, bot.id, 3),
      opts.tail ? s.listMessages(bot.userId, bot.id, { limit: CLOUD_TAIL_MESSAGES }) : Promise.resolve(null),
      opts.tail ? s.countMessages(bot.id) : Promise.resolve(0),
      bot.config.github ? s.getGithubState(bot.id) : Promise.resolve(null),
    ]);
    const last = lastRuns.find((r) => r.status !== "queued" && r.status !== "running") ?? null;
    const limits = bot.config.limits;
    const overBudget = day.cSats >= limits.budgetCSatsPerDay;
    const status = active ? "running" : bot.paused ? "paused" : overBudget ? "over_budget" : last && (last.status === "failed" || last.status === "interrupted") ? "error" : "idle";
    const g = bot.config.github;
    const triggers = (g?.triggers ?? []).map((t) => ({ id: t.id, kind: t.kind, enabled: t.enabled, ...(t.label ? { label: t.label } : {}) }));
    const triggerError = !g ? undefined : !this.d.secrets.enabled ? BOT_SECRETS_DISABLED_MESSAGE : !bot.hasGithubToken ? "Add a GitHub token to use triggers" : gstate?.error;
    return {
      id: bot.id,
      runtime: "cloud" as const,
      name: bot.name,
      role: bot.role,
      color: bot.config.color,
      status,
      ...(active ? { activity: active.status === "queued" ? "Starting…" : (active.activity ?? "Working…") } : {}),
      enabled: !bot.paused,
      instructions: bot.instructions,
      folderName: "",
      ...(g ? { repository: g.repo } : {}),
      schedule: scheduleText(bot.config.schedule),
      heartbeatMinutes: null,
      maxRunsPerDay: limits.maxRunsPerDay,
      runsToday: day.ownRuns,
      runCount: day.runs,
      budgetCSatsPerDay: limits.budgetCSatsPerDay,
      spentTodayCSats: Number(day.cSats.toFixed(6)),
      compute: computeView(bot.compute),
      triggers,
      maxTriggerRunsPerHour: 20,
      ...(g ? { triggerStatus: Object.fromEntries(triggers.map((t) => [t.id, { ...(gstate?.checkedAtMs ? { lastCheckedAtMs: gstate.checkedAtMs } : {}), ...(triggerError ? { error: triggerError } : {}) }])) } : {}),
      ...(bot.nextRunAtMs && !bot.paused ? { nextRun: { kind: "schedule", atMs: bot.nextRunAtMs } } : {}),
      ...(overBudget && !active ? { held: "budget" } : {}),
      ...(last ? { lastRun: toRemoteRun(last) } : {}),
      pending: [],
      queuedMessages: active?.status === "queued" ? 1 : 0,
      tail: tail ? tail.items.map(toRemoteMessage) : [],
      messageCount: count,
      updatedAtMs: Math.max(bot.updatedAtMs, active?.createdAtMs ?? 0, tail?.items.at(-1)?.createdAtMs ?? 0),
      cloud: {
        compute: bot.compute,
        web: bot.config.web,
        schedule: bot.config.schedule,
        github: g ? { repo: g.repo, hasToken: bot.hasGithubToken, triggers: g.triggers, available: this.d.secrets.enabled } : null,
        limits,
      },
    };
  }

  async list(userId: string) {
    const bots = await this.d.store.listBots(userId);
    return Promise.all(bots.map(async (b) => ({ ...(await this.summary(b, { tail: false })), machine: CLOUD_MACHINE })));
  }

  async detail(userId: string, botId: string): Promise<Answer> {
    const bot = await this.d.store.getBot(userId, botId);
    if (!bot) return { status: 404, body: { error: "no_such_bot" } };
    return { status: 200, body: { bot: await this.summary(bot, { tail: true }), machine: { ...CLOUD_MACHINE, reportedAtMs: this.now() } } };
  }

  private sealToken(botId: string, token: string | null | undefined): { sealed?: string | null; error?: Answer } {
    if (token === undefined) return {};
    if (token === null || token === "") return { sealed: null };
    if (!this.d.secrets.enabled) return { error: { status: 400, body: { error: "github_unavailable", message: BOT_SECRETS_DISABLED_MESSAGE } } };
    return { sealed: this.d.secrets.encrypt(token, botId) };
  }

  async create(userId: string, requestId: string, raw: Record<string, unknown>): Promise<Answer> {
    const parsed = cloudBotCreateSchema.safeParse(raw);
    if (!parsed.success) return { status: 400, body: { error: "invalid_bot", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) } };
    const b = parsed.data;
    const botId = cloudBotId(userId, requestId);
    // A retry of a create that went through: the same bot, nothing new.
    const existing = await this.d.store.getBot(userId, botId);
    if (existing) return { status: 200, body: { ok: true, botId, agentId: CLOUD_AGENT_ID, state: "created", runtime: "cloud" } };
    const nowMs = this.now();
    if (!this.creates.take(userId, nowMs)) return { status: 429, body: { error: "rate_limited", message: "Too many new bots; try again later." } };
    const max = this.d.maxBotsPerAccount ?? 20;
    if ((await this.d.store.countBots(userId)) >= max) return { status: 429, body: { error: "too_many_bots", message: `An account can have at most ${max} cloud bots.` } };
    const token = this.sealToken(botId, b.github?.token);
    if (token.error) return token.error;
    const config: CloudBotConfig = {
      color: b.color ?? defaultColor(botId),
      web: b.web,
      schedule: b.schedule ?? null,
      github: b.github ? { repo: b.github.repo, triggers: normalizeTriggers(b.github.triggers ?? []) } : null,
      limits: {
        maxTurns: b.maxTurns ?? DEFAULT_LIMITS.maxTurns,
        budgetCSatsPerRun: b.budgetCSatsPerRun ?? DEFAULT_LIMITS.budgetCSatsPerRun,
        budgetCSatsPerDay: b.budgetCSatsPerDay ?? DEFAULT_LIMITS.budgetCSatsPerDay,
        maxRunsPerDay: b.maxRunsPerDay ?? DEFAULT_LIMITS.maxRunsPerDay,
      },
    };
    const { created } = await this.d.store.createBot({
      id: botId,
      userId,
      requestId,
      name: b.name,
      role: b.role,
      instructions: b.instructions,
      compute: b.compute,
      config,
      githubTokenSealed: token.sealed ?? null,
      nextRunAtMs: nextScheduledRun(config.schedule, nowMs),
      nextPollAtMs: config.github ? nowMs : null,
      nowMs,
    });
    return { status: 200, body: { ok: true, botId, agentId: CLOUD_AGENT_ID, state: "created", runtime: "cloud", created } };
  }

  private remember(commandId: string, userId: string, botId: string, action: string, result: Record<string, unknown>) {
    this.results.set(commandId, { userId, botId, action, result, atMs: this.now() });
    for (const [k, v] of this.results) if (this.now() - v.atMs > 10 * 60_000 || this.results.size > 5_000) this.results.delete(k);
  }

  private done(userId: string, botId: string, action: string, data?: unknown, commandId = `cc-${randomUUID()}`): Answer {
    const result = { commandId, status: "done", ...(data !== undefined ? { data } : {}) };
    this.remember(commandId, userId, botId, action, result);
    return { status: 200, body: { ok: true, commandId, result } };
  }

  private refused(error: string, message: string, status = 400): Answer {
    return { status, body: { error, message } };
  }

  async command(userId: string, botId: string, action: string, args: Record<string, unknown>): Promise<Answer> {
    if (!(CLOUD_ACTIONS as readonly string[]).includes(action)) {
      return (BOT_CONTROL_ACTIONS as readonly string[]).includes(action)
        ? this.refused("not_supported", "Cloud bots don't do that.")
        : this.refused("invalid_command", "Unknown action.");
    }
    const bot = await this.d.store.getBot(userId, botId);
    if (!bot) return { status: 404, body: { error: "no_such_bot" } };
    const nowMs = this.now();
    const store = this.d.store;
    switch (action as CloudAction) {
      case "message": {
        const p = z.object({ content: z.string().trim().min(1).max(20_000) }).strip().safeParse(args);
        if (!p.success) return this.refused("invalid_command", "A message needs content (at most 20,000 characters).");
        if (!this.messages.take(userId, nowMs)) return this.refused("rate_limited", "Too many messages; try again in a minute.", 429);
        const busy = (await store.activeRun(bot.id))?.status === "running";
        const { runId } = await store.enqueueRun({ userId, botId: bot.id, trigger: "message", source: "", nowMs });
        const msg = await store.addMessage({ botId: bot.id, userId, role: "user", content: p.data.content, runId, meta: null, createdAtMs: nowMs });
        this.d.runner?.kick();
        return this.done(userId, bot.id, action, { queued: busy, runId, messageId: msg.id }, msg.id);
      }
      case "pause":
      case "resume": {
        const paused = action === "pause";
        await store.updateBot(userId, bot.id, { paused, ...(paused ? {} : { nextRunAtMs: nextScheduledRun(bot.config.schedule, nowMs), nextPollAtMs: bot.config.github ? nowMs : null }) }, nowMs);
        return this.done(userId, bot.id, action);
      }
      case "check_now": {
        const runId = this.d.runner ? await this.d.runner.queueEvent(bot, "manual", "check_now", "Check now") : (await store.enqueueRun({ userId, botId: bot.id, trigger: "manual", source: "check_now", nowMs })).runId;
        return this.done(userId, bot.id, action, { started: true, runId });
      }
      case "stop":
        return this.done(userId, bot.id, action, { stopped: await store.requestCancel(userId, bot.id) });
      case "delete":
        await store.requestCancel(userId, bot.id);
        await store.deleteBot(userId, bot.id);
        return this.done(userId, bot.id, action);
      case "update_settings":
        return this.updateSettings(bot, args, nowMs);
      case "messages": {
        const p = z.object({ beforeMs: z.number().int().nonnegative().optional(), beforeId: z.string().max(200).optional(), limit: z.number().int().min(1).max(40).default(20) }).strip().safeParse(args);
        if (!p.success) return this.refused("invalid_command", "Bad page.");
        const page = await store.listMessages(userId, bot.id, p.data);
        return this.done(userId, bot.id, action, { items: page.items.map(toRemoteMessage), more: page.more });
      }
      case "history": {
        const runs = await store.listRuns(userId, bot.id, 50);
        return this.done(userId, bot.id, action, { items: runs.reverse().map(toRemoteRun) });
      }
      case "memory":
        return this.done(userId, bot.id, action, { memory: "" });
    }
  }

  private async updateSettings(bot: CloudBot, args: Record<string, unknown>, nowMs: number): Promise<Answer> {
    const p = cloudBotUpdateSchema.safeParse(args);
    if (!p.success) return { status: 400, body: { error: "invalid_command", detail: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) } };
    const u = p.data;
    const config: CloudBotConfig = structuredClone(bot.config);
    const patch: CloudBotPatch = {};
    if (u.name !== undefined) patch.name = u.name;
    if (u.role !== undefined) patch.role = u.role;
    if (u.instructions !== undefined) patch.instructions = u.instructions;
    if (u.compute !== undefined) patch.compute = u.compute;
    if (u.web !== undefined) config.web = u.web;
    if (u.color !== undefined) config.color = u.color;
    if (u.budgetCSatsPerDay !== undefined) config.limits.budgetCSatsPerDay = u.budgetCSatsPerDay;
    if (u.budgetCSatsPerRun !== undefined) config.limits.budgetCSatsPerRun = u.budgetCSatsPerRun;
    if (u.maxRunsPerDay !== undefined) config.limits.maxRunsPerDay = u.maxRunsPerDay;
    if (u.maxTurns !== undefined) config.limits.maxTurns = u.maxTurns;
    if (u.schedule !== undefined) {
      config.schedule = u.schedule;
      patch.nextRunAtMs = nextScheduledRun(u.schedule, nowMs);
    }
    if (u.github !== undefined) {
      if (u.github === null) {
        config.github = null;
        patch.githubTokenSealed = null;
        patch.nextPollAtMs = null;
        patch.resetGithubState = true;
      } else {
        const sealed = this.sealToken(bot.id, u.github.token);
        if (sealed.error) return sealed.error;
        if (sealed.sealed !== undefined) patch.githubTokenSealed = sealed.sealed;
        const repoChanged = config.github?.repo !== u.github.repo;
        config.github = { repo: u.github.repo, triggers: u.github.triggers ? normalizeTriggers(u.github.triggers) : (config.github?.triggers ?? []) };
        // A new repository (or token) starts its poller over: old events are not replayed.
        if (repoChanged || sealed.sealed !== undefined) patch.resetGithubState = true;
        patch.nextPollAtMs = nowMs;
      }
    }
    if (u.triggers !== undefined) {
      if (!config.github) return this.refused("invalid_command", "Set a GitHub repository first.");
      config.github.triggers = normalizeTriggers(u.triggers);
      patch.nextPollAtMs = nowMs;
    }
    if (u.enabled !== undefined) {
      patch.paused = !u.enabled;
      if (u.enabled) patch.nextRunAtMs = nextScheduledRun(config.schedule, nowMs);
    }
    patch.config = config;
    await this.d.store.updateBot(bot.userId, bot.id, patch, nowMs);
    return this.done(bot.userId, bot.id, "update_settings");
  }

  async commandState(userId: string, commandId: string): Promise<Answer> {
    if (commandId.startsWith("cm-")) {
      const m = await this.d.store.getMessage(userId, commandId);
      if (!m || m.role !== "user") return { status: 404, body: { error: "unknown_command" } };
      const run = m.runId ? await this.d.store.getRun(userId, m.runId) : null;
      return {
        status: 200,
        body: { status: "done", agentId: CLOUD_AGENT_ID, botId: m.botId, action: "message", result: { commandId, status: "done", data: { runId: m.runId, messageId: m.id } }, ...(run ? { run: { id: run.id, status: run.status } } : {}) },
      };
    }
    const r = this.results.get(commandId);
    if (!r || r.userId !== userId) return { status: 404, body: { error: "unknown_command" } };
    return { status: 200, body: { status: "done", agentId: CLOUD_AGENT_ID, botId: r.botId, action: r.action, result: r.result } };
  }
}
