// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Persistent bots: named, long-lived agents that own a job in one project folder ("Harry the
 * Engineer", a billing bot, a security reviewer). Each keeps its instructions, a short memory file
 * it can append to, the tools it may use, a daily cSat budget and a history of its runs.
 *
 * A run is one agent turn in the bot's project (the same loop as the IDE chat, on Auto compute).
 * Runs start on the bot's schedule, on "Run now", or when you message it; never two at once for
 * one bot. A tool call that needs approval pauses the run ("Needs approval") until you answer.
 *
 * Config and run history: ~/.edgecoder/bots.json (0600). Per bot, under ~/.edgecoder/bots/<id>/:
 * conversation.json and memory.md (0600, directory 0700).
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { makeToolRunner, runAgentLoop, toolSchemas, type ChatFn, type ToolRunnerDeps, type ToolSchema } from "./agent-loop.js";
import { READ_TOOLS, TOOL_DEFINITIONS, type IdeStreamEvent, type ToolName } from "./tool-types.js";

// ---------------------------------------------------------------------------
// Schedules: "every 30 minutes", "every 2 hours", "hourly", "daily at 09:00", or 5-field cron
// ---------------------------------------------------------------------------

export type Schedule =
  | { kind: "every"; ms: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "cron"; minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean };

export class ScheduleError extends Error {}

const MINUTE = 60_000;
const UNIT_MS: Record<string, number> = { m: MINUTE, min: MINUTE, minute: MINUTE, h: 60 * MINUTE, hr: 60 * MINUTE, hour: 60 * MINUTE, d: 1440 * MINUTE, day: 1440 * MINUTE };

function parseClock(text: string): { hour: number; minute: number } {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text.trim());
  if (!m) throw new ScheduleError(`"${text}" isn't a time of day (use HH:MM, e.g. 09:00)`);
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (ampm) {
    if (hour < 1 || hour > 12) throw new ScheduleError(`"${text}" isn't a time of day`);
    hour = (hour % 12) + (ampm === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) throw new ScheduleError(`"${text}" isn't a time of day`);
  return { hour, minute };
}

function cronField(field: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new ScheduleError(`bad step in cron ${name}: "${part}"`);
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (/^\d+-\d+$/.test(range)) [lo, hi] = range.split("-").map(Number) as [number, number];
    else if (/^\d+$/.test(range)) [lo, hi] = [Number(range), stepText === undefined ? Number(range) : max];
    else throw new ScheduleError(`bad cron ${name}: "${part}"`);
    if (lo < min || hi > max || lo > hi) throw new ScheduleError(`cron ${name} out of range (${min}-${max}): "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse a schedule; null means no schedule (manual runs and messages only). Throws ScheduleError. */
export function parseSchedule(text: string | undefined | null): Schedule | null {
  const s = (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s || s === "manual" || s === "none" || s === "off") return null;
  if (s === "hourly") return { kind: "every", ms: 60 * MINUTE };
  if (s === "daily" || s === "every day") return { kind: "daily", hour: 9, minute: 0 };
  const every = /^every (\d+ ?)?(minutes?|mins?|m|hours?|hrs?|h|days?|d)$/.exec(s);
  if (every) {
    const n = every[1] === undefined ? 1 : Number(every[1].trim());
    const unit = every[2].replace(/s$/, "");
    const ms = n * UNIT_MS[unit];
    if (!Number.isFinite(ms) || n < 1) throw new ScheduleError(`"${text}": the interval must be at least 1`);
    if (ms < 5 * MINUTE) throw new ScheduleError(`"${text}": bots run at most every 5 minutes`);
    return { kind: "every", ms };
  }
  const daily = /^(?:daily|every day) at (.+)$/.exec(s);
  if (daily) return { kind: "daily", ...parseClock(daily[1]) };
  const fields = s.split(" ");
  if (fields.length === 5) {
    const [mi, ho, dm, mo, dw] = fields;
    const dow = cronField(dw, 0, 7, "day of week");
    if (dow.has(7)) {
      dow.delete(7);
      dow.add(0);
    }
    return {
      kind: "cron",
      minute: cronField(mi, 0, 59, "minute"),
      hour: cronField(ho, 0, 23, "hour"),
      dom: cronField(dm, 1, 31, "day of month"),
      month: cronField(mo, 1, 12, "month"),
      dow,
      domAny: dm === "*",
      dowAny: dw === "*",
    };
  }
  throw new ScheduleError(`"${text}" isn't a schedule. Use "every 30 minutes", "every 2 hours", "daily at 09:00" or a cron expression like "0 9 * * 1-5".`);
}

/** The first time the schedule fires strictly after `fromMs` (local time), or null when it never does. */
export function nextRunAt(schedule: Schedule, fromMs: number): number | null {
  if (schedule.kind === "every") return fromMs + schedule.ms;
  if (schedule.kind === "daily") {
    const d = new Date(fromMs);
    d.setHours(schedule.hour, schedule.minute, 0, 0);
    if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
    d.setHours(schedule.hour, schedule.minute, 0, 0);
    return d.getTime();
  }
  const c = schedule;
  const dayOk = (d: Date) => {
    const dom = c.dom.has(d.getDate());
    const dow = c.dow.has(d.getDay());
    if (c.domAny && c.dowAny) return true;
    if (c.domAny) return dow;
    if (c.dowAny) return dom;
    return dom || dow;
  };
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = fromMs + 5 * 366 * 1440 * MINUTE;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
    } else if (!dayOk(d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else return d.getTime();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

/** Read tools, file edits, shell commands and commit/push. Edits apply on their own; commands and git writes ask. */
export const DEFAULT_BOT_TOOLS: ToolName[] = [...READ_TOOLS, "write_file", "edit_file", "run_shell", "git_commit", "git_push"];
const ALL_TOOLS = TOOL_DEFINITIONS.map((t) => t.name) as [ToolName, ...ToolName[]];
export const DEFAULT_BUDGET_CSATS_PER_DAY = 100;
const MAX_RUNS = 50;
const MAX_MESSAGES = 200;
const CONTEXT_MESSAGES = 20;
const MAX_EVENTS_PER_REPLY = 300;
const MAX_EVENT_TEXT = 4_000;
const MAX_MEMORY_BYTES = 8_000;
const APPROVAL_TIMEOUT_MS = 24 * 60 * MINUTE;
const COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];

export interface BotConfig {
  id: string;
  name: string;
  /** Short job title shown next to the name ("Engineer", "Security reviewer"). */
  role: string;
  /** Added to the agent's system prompt on every run. */
  instructions: string;
  projectRoot: string;
  /** false pauses the schedule; "Run now" and messages still work. */
  enabled: boolean;
  /** See parseSchedule; "" = no schedule. */
  schedule: string;
  /** Stop once this much was spent today (cSats, local day); null = no limit. */
  budgetCSatsPerDay: number | null;
  allowedTools: ToolName[];
  /** Apply write_file / edit_file without asking (each run's checkpoint keeps them undoable). */
  autoApproveEdits: boolean;
  color: string;
  createdAtMs: number;
  updatedAtMs: number;
  nextRunAtMs?: number;
}

export type BotTrigger = "schedule" | "manual" | "message";
export type BotRunStatus = "running" | "needs_approval" | "done" | "failed" | "budget" | "cancelled" | "interrupted";

export interface BotRun {
  id: string;
  trigger: BotTrigger;
  startedAtMs: number;
  endedAtMs?: number;
  status: BotRunStatus;
  summary: string;
  cSats: number;
  /** Where the model calls ran (Auto's last decision, e.g. "local qwen3.5:9b"). */
  where?: string;
  error?: string;
}

export interface PendingCall {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface BotMessage {
  id: string;
  role: "user" | "assistant" | "event";
  content: string;
  atMs: number;
  runId?: string;
  /** assistant: the run's stream events (text merged), for tool calls and approvals. */
  events?: IdeStreamEvent[];
}

export type BotStatus = "idle" | "running" | "needs_approval" | "paused" | "over_budget" | "error";

export interface BotView extends BotConfig {
  status: BotStatus;
  spentTodayCSats: number;
  lastRun?: BotRun;
  pending: PendingCall[];
  queuedMessages: number;
  /** What the bot is doing right now (last status line of the active run). */
  activity?: string;
}

export interface BotRunContext {
  bot: BotConfig;
  runId: string;
  memory: string;
  /** Conversation context for the turn, ending with the message or trigger prompt. */
  messages: Array<{ role: string; content: string }>;
  /** The bot's part of the system prompt: who it is, its instructions and memory. */
  systemAddition: string;
  sendEvent: (event: IdeStreamEvent) => void;
  signal: AbortSignal;
  isCancelled: () => boolean;
  /** Pauses the run until the user answers (resolves false on reject, cancel or timeout). */
  waitForApproval: ToolRunnerDeps["waitForApproval"];
  remember: (note: string) => void;
}

export type BotRunner = (ctx: BotRunContext) => Promise<void>;

export interface ApprovalEntry {
  resolve: (approved: boolean) => void;
  tool: ToolName;
  args: Record<string, unknown>;
  owner?: string;
}

export class BotError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function botsFile(): string {
  return process.env.EDGECODER_BOTS_FILE ?? join(homedir(), ".edgecoder", "bots.json");
}

function writePrivate(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // best effort (Windows)
  }
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function clip(s: string, n = MAX_EVENT_TEXT): string {
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s;
}

/** The run's summary: the last paragraph of its reply, shortened. */
export function summarize(text: string): string {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paras[paras.length - 1] ?? "";
  const flat = last.replace(/\s+/g, " ");
  return flat.length > 240 ? `${flat.slice(0, 237)}…` : flat;
}

export function botSystemPrompt(bot: BotConfig, memory: string): string {
  return [
    `--- Persistent bot ---`,
    `You are "${bot.name}"${bot.role ? `, ${bot.role}` : ""}: a persistent bot that owns a job in the project at ${bot.projectRoot}. You run on a schedule, when asked to run, or when the user messages you; each run starts fresh except for your memory below and the recent conversation.`,
    bot.instructions.trim() ? `Your instructions:\n${bot.instructions.trim()}` : "",
    `Your memory (notes you saved on earlier runs):\n${memory.trim() || "(empty)"}`,
    `To save a short note for future runs (what you did, what to check next time), call the \`remember\` tool with {"note": "..."}. Keep notes brief.`,
    `Work only inside the project folder. Shell commands, commits and pushes need the user's approval: ask only when needed. End every run with a short summary of what you did and anything that needs the user's attention.`,
  ].filter(Boolean).join("\n\n");
}

const REMEMBER_TOOL: ToolSchema = {
  type: "function",
  function: {
    name: "remember",
    description: "Save a short note to your memory for future runs.",
    parameters: { type: "object", properties: { note: { type: "string", description: "The note (one or two sentences)." } }, required: ["note"] },
  },
};

export interface BotInput {
  name: string;
  role?: string;
  instructions?: string;
  projectRoot: string;
  enabled?: boolean;
  schedule?: string;
  budgetCSatsPerDay?: number | null;
  allowedTools?: ToolName[];
  autoApproveEdits?: boolean;
  color?: string;
}

export type BotPatch = Partial<BotInput> & { memory?: string };

interface ActiveRun {
  run: BotRun;
  abort: AbortController;
  cancelReason?: "cancelled" | "budget";
  pending: Map<string, PendingCall & { finish: (approved: boolean) => void }>;
  reply: BotMessage;
  activity?: string;
  done: Promise<void>;
}

export class BotManager {
  private bots: BotConfig[] = [];
  private runs = new Map<string, BotRun[]>();
  private conversations = new Map<string, BotMessage[]>();
  private active = new Map<string, ActiveRun>();
  private queued = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private readonly approvals: Map<string, ApprovalEntry>;

  constructor(
    private readonly deps: {
      runner: BotRunner;
      file?: string;
      /** Shared with the IDE chat's approvals, so /v1/ide/tool-approval answers bot calls too. */
      approvals?: Map<string, ApprovalEntry>;
      now?: () => number;
      log?: (msg: string, extra?: unknown) => void;
    },
  ) {
    this.approvals = deps.approvals ?? new Map();
  }

  private get file() {
    return this.deps.file ?? botsFile();
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private botDir(id: string) {
    return join(dirname(this.file), "bots", id);
  }

  // --- persistence ---

  load(): void {
    try {
      if (!existsSync(this.file)) return;
      const data = JSON.parse(readFileSync(this.file, "utf8")) as { bots?: BotConfig[]; runs?: Record<string, BotRun[]> };
      this.bots = data.bots ?? [];
      this.runs = new Map(Object.entries(data.runs ?? {}));
      // Runs that were going when the server stopped can't be resumed.
      let changed = false;
      for (const list of this.runs.values())
        for (const r of list)
          if (r.status === "running" || r.status === "needs_approval") {
            r.status = "interrupted";
            r.endedAtMs ??= this.now();
            r.summary ||= "Stopped when EdgeCoder restarted.";
            changed = true;
          }
      if (changed) this.save();
    } catch (err) {
      this.deps.log?.("bots_load_failed", err);
      this.bots = [];
      this.runs = new Map();
    }
  }

  private save(): void {
    writePrivate(this.file, JSON.stringify({ bots: this.bots, runs: Object.fromEntries(this.runs) }, null, 2));
  }

  private conversation(id: string): BotMessage[] {
    let c = this.conversations.get(id);
    if (!c) {
      try {
        const f = join(this.botDir(id), "conversation.json");
        c = existsSync(f) ? ((JSON.parse(readFileSync(f, "utf8")) as { messages: BotMessage[] }).messages ?? []) : [];
      } catch {
        c = [];
      }
      this.conversations.set(id, c);
    }
    return c;
  }

  private saveConversation(id: string, soon = false): void {
    clearTimeout(this.saveTimers.get(id));
    const write = () => {
      this.saveTimers.delete(id);
      if (!this.bots.some((b) => b.id === id)) return;
      const c = this.conversation(id);
      if (c.length > MAX_MESSAGES) c.splice(0, c.length - MAX_MESSAGES);
      writePrivate(join(this.botDir(id), "conversation.json"), JSON.stringify({ messages: c }));
    };
    if (!soon) return write();
    const t = setTimeout(write, 300);
    t.unref?.();
    this.saveTimers.set(id, t);
  }

  memory(id: string): string {
    try {
      return readFileSync(join(this.botDir(id), "memory.md"), "utf8");
    } catch {
      return "";
    }
  }

  private setMemory(id: string, text: string): void {
    let t = text;
    while (Buffer.byteLength(t) > MAX_MEMORY_BYTES) {
      // Keep the newest notes.
      const cut = t.indexOf("\n");
      t = cut < 0 ? t.slice(t.length - MAX_MEMORY_BYTES) : t.slice(cut + 1);
    }
    writePrivate(join(this.botDir(id), "memory.md"), t);
  }

  remember(id: string, note: string): void {
    const line = note.replace(/\s+/g, " ").trim().slice(0, 500);
    if (!line) return;
    const d = new Date(this.now());
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const cur = this.memory(id);
    this.setMemory(id, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}- ${day}: ${line}\n`);
  }

  // --- scheduler ---

  start(intervalMs = 30_000): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Start the runs that are due; returns the ids of the bots started. */
  tick(now = this.now()): string[] {
    const started: string[] = [];
    let changed = false;
    for (const bot of this.bots) {
      if (!bot.enabled) continue;
      let sched: Schedule | null;
      try {
        sched = parseSchedule(bot.schedule);
      } catch {
        continue;
      }
      if (!sched) continue;
      if (bot.nextRunAtMs === undefined) {
        bot.nextRunAtMs = nextRunAt(sched, now) ?? undefined;
        changed = true;
        continue;
      }
      if (bot.nextRunAtMs > now) continue;
      // Due: run unless one is going or today's budget is spent; either way, wait for the next slot.
      if (!this.active.has(bot.id) && !this.overBudget(bot)) {
        const r = this.runNow(bot.id, "schedule");
        if (r.started) started.push(bot.id);
      }
      bot.nextRunAtMs = nextRunAt(sched, now) ?? undefined;
      changed = true;
    }
    if (changed) this.save();
    return started;
  }

  // --- CRUD ---

  private validate(input: Partial<BotInput>): void {
    if (input.projectRoot !== undefined) {
      if (!isAbsolute(input.projectRoot)) throw new BotError("The project folder must be an absolute path");
      let dir = false;
      try {
        dir = statSync(input.projectRoot).isDirectory();
      } catch {
        dir = false;
      }
      if (!dir) throw new BotError(`No folder at ${input.projectRoot}`);
    }
    if (input.schedule !== undefined) {
      try {
        parseSchedule(input.schedule);
      } catch (err) {
        throw new BotError((err as Error).message);
      }
    }
    if (input.budgetCSatsPerDay != null && !(input.budgetCSatsPerDay > 0)) throw new BotError("The budget must be more than 0 cSats a day (or no limit)");
  }

  private nextFor(bot: BotConfig): number | undefined {
    const s = parseSchedule(bot.schedule);
    return s ? nextRunAt(s, this.now()) ?? undefined : undefined;
  }

  create(input: BotInput): BotView {
    this.validate(input);
    const now = this.now();
    const bot: BotConfig = {
      id: `bot_${randomUUID().slice(0, 8)}`,
      name: input.name.trim(),
      role: (input.role ?? "").trim(),
      instructions: input.instructions ?? "",
      projectRoot: input.projectRoot,
      enabled: input.enabled ?? true,
      schedule: (input.schedule ?? "").trim(),
      budgetCSatsPerDay: input.budgetCSatsPerDay === undefined ? DEFAULT_BUDGET_CSATS_PER_DAY : input.budgetCSatsPerDay,
      allowedTools: input.allowedTools ?? [...DEFAULT_BOT_TOOLS],
      autoApproveEdits: input.autoApproveEdits ?? true,
      color: input.color ?? COLORS[this.bots.length % COLORS.length],
      createdAtMs: now,
      updatedAtMs: now,
    };
    bot.nextRunAtMs = this.nextFor(bot);
    this.bots.push(bot);
    this.runs.set(bot.id, []);
    this.save();
    return this.view(bot);
  }

  update(id: string, patch: BotPatch): BotView {
    const bot = this.find(id);
    this.validate(patch);
    const { memory, ...fields } = patch;
    const scheduleChanged = fields.schedule !== undefined && fields.schedule.trim() !== bot.schedule;
    const resumed = fields.enabled === true && !bot.enabled;
    Object.assign(bot, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
    if (fields.name !== undefined) bot.name = fields.name.trim();
    if (fields.schedule !== undefined) bot.schedule = fields.schedule.trim();
    if (scheduleChanged || resumed) bot.nextRunAtMs = this.nextFor(bot);
    bot.updatedAtMs = this.now();
    if (memory !== undefined) this.setMemory(id, memory);
    this.save();
    return this.view(bot);
  }

  async delete(id: string): Promise<void> {
    this.find(id);
    const act = this.active.get(id);
    if (act) {
      this.cancel(id);
      await act.done.catch(() => undefined);
    }
    this.bots = this.bots.filter((b) => b.id !== id);
    this.runs.delete(id);
    this.conversations.delete(id);
    this.queued.delete(id);
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    rmSync(this.botDir(id), { recursive: true, force: true });
    this.save();
  }

  private find(id: string): BotConfig {
    const bot = this.bots.find((b) => b.id === id);
    if (!bot) throw new BotError("No bot with that id", 404);
    return bot;
  }

  spentToday(id: string): number {
    const t0 = startOfDay(this.now());
    return (this.runs.get(id) ?? []).filter((r) => r.startedAtMs >= t0).reduce((s, r) => s + (r.cSats || 0), 0);
  }

  private overBudget(bot: BotConfig): boolean {
    return bot.budgetCSatsPerDay != null && this.spentToday(bot.id) >= bot.budgetCSatsPerDay;
  }

  view(bot: BotConfig): BotView {
    const act = this.active.get(bot.id);
    const runs = this.runs.get(bot.id) ?? [];
    const lastRun = act?.run ?? runs[runs.length - 1];
    const status: BotStatus = act
      ? act.pending.size > 0
        ? "needs_approval"
        : "running"
      : this.overBudget(bot)
        ? "over_budget"
        : !bot.enabled
          ? "paused"
          : lastRun?.status === "failed"
            ? "error"
            : "idle";
    return {
      ...bot,
      status,
      spentTodayCSats: Number(this.spentToday(bot.id).toFixed(6)),
      ...(lastRun ? { lastRun: { ...lastRun } } : {}),
      pending: act ? [...act.pending.values()].map(({ callId, tool, args }) => ({ callId, tool, args })) : [],
      queuedMessages: this.queued.get(bot.id) ?? 0,
      ...(act?.activity ? { activity: act.activity } : {}),
    };
  }

  list(): BotView[] {
    return this.bots.map((b) => this.view(b));
  }

  get(id: string): BotView {
    return this.view(this.find(id));
  }

  history(id: string): BotRun[] {
    this.find(id);
    return [...(this.runs.get(id) ?? [])].reverse();
  }

  messages(id: string): BotMessage[] {
    this.find(id);
    return this.conversation(id);
  }

  isRunning(id: string): boolean {
    return this.active.has(id);
  }

  /** Resolves when the bot's current run (if any) has ended. */
  async idle(id: string): Promise<void> {
    while (this.active.has(id)) await this.active.get(id)!.done.catch(() => undefined);
  }

  // --- runs ---

  /** Message the bot: it answers in a run now, or right after the current one. */
  message(id: string, text: string): { started: boolean; queued: boolean; runId?: string; reason?: string } {
    this.find(id);
    const content = text.trim();
    if (!content) throw new BotError("Empty message");
    this.conversation(id).push({ id: randomUUID(), role: "user", content, atMs: this.now() });
    this.saveConversation(id);
    if (this.active.has(id)) {
      this.queued.set(id, (this.queued.get(id) ?? 0) + 1);
      return { started: false, queued: true };
    }
    const r = this.runNow(id, "message");
    return { ...r, queued: false };
  }

  runNow(id: string, trigger: BotTrigger = "manual"): { started: boolean; runId?: string; reason?: "busy" | "budget" } {
    const bot = this.find(id);
    if (this.active.has(id)) return { started: false, reason: "busy" };
    if (this.overBudget(bot)) return { started: false, reason: "budget" };
    const now = this.now();
    const memory = this.memory(id);
    const conv = this.conversation(id);
    const context = conv
      .filter((m) => m.role === "user" || (m.role === "assistant" && m.content.trim()))
      .slice(-CONTEXT_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }));
    if (trigger !== "message") {
      const label = trigger === "schedule" ? "Scheduled run" : "Run now";
      conv.push({ id: randomUUID(), role: "event", content: label, atMs: now });
      context.push({
        role: "user",
        content: `[${label} · ${new Date(now).toISOString()}] Do your job as described in your instructions. When you're done, reply with a short summary of what you did and anything that needs my attention.`,
      });
    }
    const run: BotRun = { id: `run_${randomUUID().slice(0, 8)}`, trigger, startedAtMs: now, status: "running", summary: "", cSats: 0 };
    const list = this.runs.get(id) ?? [];
    list.push(run);
    if (list.length > MAX_RUNS) list.splice(0, list.length - MAX_RUNS);
    this.runs.set(id, list);
    const reply: BotMessage = { id: randomUUID(), role: "assistant", content: "", atMs: now, runId: run.id, events: [] };
    conv.push(reply);
    const act: ActiveRun = { run, abort: new AbortController(), pending: new Map(), reply, done: Promise.resolve() };
    this.active.set(id, act);
    this.save();
    this.saveConversation(id);
    act.done = this.execute(bot, act, memory, context);
    return { started: true, runId: run.id };
  }

  private record(id: string, act: ActiveRun, event: IdeStreamEvent): void {
    const events = act.reply.events!;
    if (event.type === "text") {
      act.reply.content += event.content;
      const last = events[events.length - 1];
      if (last?.type === "text") last.content += event.content;
      else events.push({ ...event });
    } else if (event.type === "done") {
      return;
    } else if (events.length < MAX_EVENTS_PER_REPLY) {
      const e = { ...event } as IdeStreamEvent & Record<string, unknown>;
      for (const k of ["result", "error", "stdout", "stderr"]) if (typeof e[k] === "string") e[k] = clip(e[k] as string);
      events.push(e);
    }
    if (event.type === "usage") {
      act.run.cSats = Number((act.run.cSats + (Number.isFinite(event.cSats) ? event.cSats : 0)).toFixed(6));
      if (event.where) act.run.where = event.where;
      const bot = this.bots.find((b) => b.id === id);
      if (bot && this.overBudget(bot) && !act.cancelReason) {
        act.cancelReason = "budget";
        this.abortRun(act);
      }
    } else if (event.type === "status") {
      act.activity = event.message;
      if (!act.run.where && event.message.startsWith("Auto: ")) act.run.where = event.message.slice(6);
    } else if (event.type === "tool_call") {
      act.activity = `Using ${event.tool}`;
    }
    this.saveConversation(id, true);
  }

  private abortRun(act: ActiveRun): void {
    act.abort.abort();
    for (const p of [...act.pending.values()]) p.finish(false);
  }

  private async execute(bot: BotConfig, act: ActiveRun, memory: string, messages: Array<{ role: string; content: string }>): Promise<void> {
    const id = bot.id;
    const owner = `bot:${id}`;
    const waitForApproval: BotRunContext["waitForApproval"] = (callId, tool, args) =>
      new Promise<boolean>((resolve) => {
        if (act.cancelReason) return resolve(false);
        const finish = (approved: boolean) => {
          if (!act.pending.has(callId)) return;
          clearTimeout(timer);
          act.pending.delete(callId);
          this.approvals.delete(callId);
          act.run.status = act.pending.size > 0 ? "needs_approval" : "running";
          this.save();
          resolve(approved);
        };
        const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
        timer.unref?.();
        act.pending.set(callId, { callId, tool, args, finish });
        this.approvals.set(callId, { resolve: finish, tool, args, owner });
        act.run.status = "needs_approval";
        act.activity = `Needs approval: ${tool}`;
        this.save();
      });
    let error: string | undefined;
    try {
      await this.deps.runner({
        bot: { ...bot },
        runId: act.run.id,
        memory,
        messages,
        systemAddition: botSystemPrompt(bot, memory),
        sendEvent: (e) => this.record(id, act, e),
        signal: act.abort.signal,
        isCancelled: () => act.cancelReason !== undefined,
        waitForApproval,
        remember: (note) => this.remember(id, note),
      });
    } catch (err) {
      error = (err as Error).message ?? String(err);
    }
    for (const p of [...act.pending.values()]) p.finish(false);
    const text = act.reply.content;
    const modelError = /(^|\n)Error contacting model: (.*)$/.exec(text.trim());
    const run = act.run;
    run.endedAtMs = this.now();
    if (act.cancelReason === "budget") {
      run.status = "budget";
      run.summary = `Stopped: today's budget (${bot.budgetCSatsPerDay} cSats) is spent.`;
    } else if (act.cancelReason === "cancelled") {
      run.status = "cancelled";
      run.summary = "Stopped by you.";
    } else if (error || modelError) {
      run.status = "failed";
      run.error = error ?? modelError![2];
      run.summary = `Failed: ${run.error}`;
    } else {
      run.status = "done";
      run.summary = summarize(text) || "Finished with no reply.";
    }
    if (run.status !== "done" && run.status !== "failed") {
      act.reply.content += `${act.reply.content ? "\n\n" : ""}_${run.summary}_`;
      act.reply.events!.push({ type: "text", content: `${act.reply.events!.length ? "\n\n" : ""}_${run.summary}_` });
    }
    this.active.delete(id);
    if (!this.bots.some((b) => b.id === id)) return;
    this.save();
    this.saveConversation(id);
    const queued = this.queued.get(id) ?? 0;
    if (queued > 0 && run.status !== "cancelled") {
      this.queued.delete(id);
      const next = this.runNow(id, "message");
      if (!next.started) this.deps.log?.("bot_queued_message_not_run", { id, reason: next.reason });
    } else this.queued.delete(id);
  }

  /** Stop the bot's current run (pending approvals are rejected). */
  cancel(id: string): boolean {
    this.find(id);
    const act = this.active.get(id);
    if (!act) return false;
    act.cancelReason ??= "cancelled";
    this.abortRun(act);
    return true;
  }

  /** Answer one of the bot's pending tool calls. */
  approve(id: string, callId: string, approved: boolean): boolean {
    this.find(id);
    const p = this.active.get(id)?.pending.get(callId);
    if (!p) return false;
    p.finish(approved);
    return true;
  }

  async shutdown(): Promise<void> {
    this.stop();
    for (const id of [...this.active.keys()]) this.cancel(id);
    await Promise.all([...this.active.values()].map((a) => a.done.catch(() => undefined)));
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t);
      this.saveConversation(id);
    }
  }
}

// ---------------------------------------------------------------------------
// The real runner: the IDE agent loop in the bot's project, with the bot's tool policy
// ---------------------------------------------------------------------------

export function agentBotRunner(d: {
  /** The model calls for a run (Auto compute in the IDE server). */
  chat: (ctx: BotRunContext) => ChatFn;
  execute: (bot: BotConfig) => ToolRunnerDeps["execute"];
  /** The IDE agent's own system prompt for the bot's project (built once per run). */
  systemPrompt: (bot: BotConfig) => Promise<(format: "native" | "text") => string>;
  checkpoints?: { begin(turnId: string, root: string): void; capture(turnId: string, path: string): string | null };
}): BotRunner {
  return async (ctx) => {
    const turnId = ctx.runId;
    const basePrompt = await d.systemPrompt(ctx.bot);
    d.checkpoints?.begin(turnId, ctx.bot.projectRoot);
    ctx.sendEvent({ type: "turn", id: turnId });
    const allowed = new Set<string>(ctx.bot.allowedTools);
    const tools = [...toolSchemas().filter((t) => allowed.has(t.function.name)), REMEMBER_TOOL];
    const inner = makeToolRunner({
      execute: d.execute(ctx.bot),
      sendEvent: ctx.sendEvent,
      waitForApproval: ctx.waitForApproval,
      captureBeforeWrite: (path) => d.checkpoints?.capture(turnId, path) ?? null,
      turnId,
      autoApproveEdits: ctx.bot.autoApproveEdits,
      allowShellAutoApprove: false,
    });
    await runAgentLoop({
      chat: d.chat(ctx),
      systemPrompt: (format) => [basePrompt(format), ctx.systemAddition].filter(Boolean).join("\n\n"),
      messages: ctx.messages,
      sendEvent: ctx.sendEvent,
      isCancelled: ctx.isCancelled,
      tools,
      runTool: async (tool, args) => {
        if ((tool as string) === "remember") {
          const callId = `tc_${randomUUID().slice(0, 8)}`;
          ctx.sendEvent({ type: "tool_call", id: callId, tool, args, requires_approval: false });
          ctx.remember(String(args.note ?? ""));
          ctx.sendEvent({ type: "tool_result", id: callId, result: "Saved to memory." });
          return "Saved to memory.";
        }
        if (!allowed.has(tool)) return `[Error]: ${tool} isn't allowed for this bot. Ask the user to allow it in the bot's settings.`;
        return inner(tool, args);
      },
    });
  };
}

// ---------------------------------------------------------------------------
// Routes: /v1/ide/bots
// ---------------------------------------------------------------------------

const toolEnum = z.enum(ALL_TOOLS);
const botFields = {
  name: z.string().trim().min(1).max(60),
  role: z.string().max(80),
  instructions: z.string().max(8_000),
  projectRoot: z.string().min(1).max(1_000),
  enabled: z.boolean(),
  schedule: z.string().max(100),
  budgetCSatsPerDay: z.number().positive().max(1e9).nullable(),
  allowedTools: z.array(toolEnum).max(ALL_TOOLS.length),
  autoApproveEdits: z.boolean(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
};
const createSchema = z.object(botFields).partial().required({ name: true, projectRoot: true });
const patchSchema = z.object({ ...botFields, memory: z.string().max(MAX_MEMORY_BYTES) }).partial();
const idParams = z.object({ id: z.string().min(1).max(100) });

export function registerBotRoutes(app: FastifyInstance, bots: BotManager): void {
  const handle = async (reply: { status: (n: number) => { send: (b: unknown) => unknown } }, fn: () => unknown) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BotError) return reply.status(err.status).send({ error: err.message });
      if (err instanceof z.ZodError) return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      throw err;
    }
  };
  app.get("/v1/ide/bots", async () => ({ bots: bots.list() }));
  app.post("/v1/ide/bots", (req, reply) => handle(reply, () => ({ bot: bots.create(createSchema.parse(req.body ?? {})) })));
  app.get("/v1/ide/bots/:id", (req, reply) => handle(reply, () => ({ bot: bots.get(idParams.parse(req.params).id), memory: bots.memory(idParams.parse(req.params).id) })));
  app.patch("/v1/ide/bots/:id", (req, reply) => handle(reply, () => ({ bot: bots.update(idParams.parse(req.params).id, patchSchema.parse(req.body ?? {})) })));
  app.delete("/v1/ide/bots/:id", (req, reply) =>
    handle(reply, async () => {
      await bots.delete(idParams.parse(req.params).id);
      return { ok: true };
    }),
  );
  app.post("/v1/ide/bots/:id/run", (req, reply) =>
    handle(reply, () => {
      const id = idParams.parse(req.params).id;
      const r = bots.runNow(id, "manual");
      if (!r.started) return reply.status(409).send({ error: r.reason === "busy" ? "The bot is already running." : "Today's budget for this bot is spent.", reason: r.reason });
      return { ...r, bot: bots.get(id) };
    }),
  );
  app.post("/v1/ide/bots/:id/cancel", (req, reply) => handle(reply, () => ({ cancelled: bots.cancel(idParams.parse(req.params).id) })));
  app.get("/v1/ide/bots/:id/messages", (req, reply) => handle(reply, () => ({ messages: bots.messages(idParams.parse(req.params).id) })));
  app.post("/v1/ide/bots/:id/messages", (req, reply) =>
    handle(reply, () => {
      const id = idParams.parse(req.params).id;
      const { content } = z.object({ content: z.string().min(1).max(20_000) }).parse(req.body ?? {});
      return { ...bots.message(id, content), bot: bots.get(id) };
    }),
  );
  app.get("/v1/ide/bots/:id/history", (req, reply) => handle(reply, () => ({ runs: bots.history(idParams.parse(req.params).id) })));
  app.post("/v1/ide/bots/:id/approve", (req, reply) =>
    handle(reply, () => {
      const id = idParams.parse(req.params).id;
      const { callId, approved } = z.object({ callId: z.string().min(1).max(100), approved: z.boolean() }).parse(req.body ?? {});
      if (!bots.approve(id, callId, approved)) return reply.status(404).send({ error: "No pending approval with that id" });
      return { ok: true, bot: bots.get(id) };
    }),
  );
}
