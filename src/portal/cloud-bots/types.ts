// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Cloud bots (docs/cloud-bots.md): bots that run on EdgeCoder's servers, with no machine or folder.
 * The settings a client may send (create and update_settings), normalised here once.
 */

import { z } from "zod";
import { isFrontierModel } from "../../common/bot-relay.js";

/** The agentId every cloud bot answers to, so the desktop bots' /portal/api/bots/:agentId/:botId routes fit them. */
export const CLOUD_AGENT_ID = "cloud";
export const CLOUD_MACHINE = { agentId: CLOUD_AGENT_ID, machineName: "Cloud", online: true, controls: "on" as const, canCreate: true };

export const CLOUD_TRIGGER_KINDS = ["pr_opened", "ci_failed", "issue_labeled"] as const;
export type CloudTriggerKind = (typeof CLOUD_TRIGGER_KINDS)[number];
export interface CloudTrigger {
  id: string;
  kind: CloudTriggerKind;
  enabled: boolean;
  /** issue_labeled: the label that starts a run. */
  label?: string;
}

export type CloudSchedule = { everyMinutes: number } | { dailyAtUtc: string };

export interface CloudBotLimits {
  maxTurns: number;
  budgetCSatsPerRun: number;
  budgetCSatsPerDay: number;
  maxRunsPerDay: number;
}
export const DEFAULT_LIMITS: CloudBotLimits = { maxTurns: 12, budgetCSatsPerRun: 25, budgetCSatsPerDay: 100, maxRunsPerDay: 48 };

/** What a cloud bot is configured to do (stored as one JSON column). Never holds a secret. */
export interface CloudBotConfig {
  color: string;
  web: boolean;
  schedule: CloudSchedule | null;
  github: { repo: string; triggers: CloudTrigger[] } | null;
  limits: CloudBotLimits;
}

export interface CloudBot {
  id: string;
  userId: string;
  requestId: string;
  name: string;
  role: string;
  instructions: string;
  /** "auto", "mine:<model>" or "network:<model>" ("network:auto": the network's best fit). */
  compute: string;
  config: CloudBotConfig;
  /** Whether a GitHub token is stored (the token itself is never on this object). */
  hasGithubToken: boolean;
  paused: boolean;
  nextRunAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export type CloudRunStatus = "queued" | "running" | "done" | "failed" | "budget" | "cancelled" | "interrupted";
export interface CloudRun {
  id: string;
  botId: string;
  userId: string;
  trigger: string;
  source: string;
  status: CloudRunStatus;
  createdAtMs: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  cSats: number;
  summary: string;
  error: string | null;
  activity: string | null;
  where: string | null;
}

export interface CloudMessage {
  id: string;
  botId: string;
  userId: string;
  role: "user" | "assistant" | "event";
  content: string;
  runId: string | null;
  meta: Record<string, unknown> | null;
  createdAtMs: number;
}

// ---- Input ----

const MODEL_RE = /^[A-Za-z0-9._:/@+-]{1,200}$/;
export const GITHUB_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** "auto" | "mine:<model>" | "network:<model>" from a string or a desktop-style {policy, model}. Null: not valid. */
export function normalizeCompute(input: unknown): string | null {
  let kind: "auto" | "mine" | "network";
  let model: string | undefined;
  if (typeof input === "string") {
    const s = input.trim();
    if (s === "auto" || s === "") return "auto";
    const m = /^(mine|network):(.+)$/.exec(s);
    if (m) {
      kind = m[1] as "mine" | "network";
      model = m[2].trim();
    } else {
      // A bare model name: that model on the network.
      kind = "network";
      model = s;
    }
  } else if (input && typeof input === "object") {
    const o = input as { policy?: unknown; target?: unknown; model?: unknown };
    const p = String(o.policy ?? o.target ?? "auto");
    model = typeof o.model === "string" && o.model.trim() ? o.model.trim() : undefined;
    if (p === "auto" || p === "local_first") return "auto";
    if (p === "mine" || p === "mine_only" || p === "my_machines") kind = "mine";
    else if (p === "network" || p === "network_only" || p === "model") kind = "network";
    else return null;
    if (kind === "network" && !model) model = "auto";
  } else return null;
  if (!model || !MODEL_RE.test(model) || isFrontierModel(model) || (kind === "mine" && model === "auto")) return null;
  return `${kind}:${model}`;
}

/** Desktop-style compute for the bot summary (the page's botComputeText). */
export function computeView(compute: string): { policy: string; model?: string } {
  if (compute.startsWith("mine:")) return { policy: "mine_only", model: compute.slice(5) };
  if (compute.startsWith("network:")) return compute === "network:auto" ? { policy: "network_only" } : { policy: "network_only", model: compute.slice(8) };
  return { policy: "auto" };
}

const scheduleSchema = z.union([
  z.object({ everyMinutes: z.number().int().min(15).max(7 * 24 * 60) }).strip(),
  z.object({ dailyAtUtc: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour, UTC") }).strip(),
]);

const triggerInput = z.union([
  z.enum(CLOUD_TRIGGER_KINDS),
  z
    .object({
      id: z.string().max(40).optional(),
      kind: z.enum(CLOUD_TRIGGER_KINDS).optional(),
      event: z.enum(CLOUD_TRIGGER_KINDS).optional(),
      label: z.string().trim().max(50).optional(),
      enabled: z.boolean().optional(),
    })
    .strip()
    .refine((t) => t.kind || t.event, "kind"),
]);

export function normalizeTriggers(list: Array<z.infer<typeof triggerInput>>): CloudTrigger[] {
  const out = new Map<string, CloudTrigger>();
  for (const t of list) {
    const kind = (typeof t === "string" ? t : (t.kind ?? t.event)) as CloudTriggerKind;
    const label = kind === "issue_labeled" ? (typeof t === "string" ? "" : (t.label ?? "")).trim() || "bot" : undefined;
    const enabled = typeof t === "string" ? true : t.enabled !== false;
    out.set(kind, { id: kind, kind, enabled, ...(label ? { label } : {}) });
  }
  return [...out.values()];
}

// A GitHub token: classic (ghp_), fine-grained (github_pat_), or an app token; never echoed back.
const tokenSchema = z.string().trim().min(20).max(400).regex(/^[A-Za-z0-9_.-]+$/, "a GitHub token");

const githubSchema = z
  .object({
    repo: z.string().trim().regex(GITHUB_REPO_RE, "owner/repo"),
    /** Omitted: keep the stored one. "" or null: remove it. */
    token: z.union([tokenSchema, z.literal(""), z.null()]).optional(),
    triggers: z.array(triggerInput).max(6).optional(),
  })
  .strip();

const computeSchema = z.unknown().transform((v, ctx) => {
  const c = normalizeCompute(v);
  if (!c) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'auto, "mine:<model>" or "network:<model>" (bots never use a frontier key)' });
    return z.NEVER;
  }
  return c;
});

const common = {
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().max(80),
  instructions: z.string().max(8_000),
  compute: computeSchema,
  web: z.boolean(),
  schedule: scheduleSchema.nullable(),
  github: githubSchema.nullable(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  budgetCSatsPerDay: z.number().positive().max(100_000),
  budgetCSatsPerRun: z.number().positive().max(100_000),
  maxRunsPerDay: z.number().int().min(1).max(500),
  maxTurns: z.number().int().min(1).max(30),
};

/** POST /portal/api/bots/new's `bot` for agentId "cloud". Desktop-only fields a client may also send are dropped. */
export const cloudBotCreateSchema = z
  .object({
    ...common,
    role: common.role.default(""),
    instructions: common.instructions.default(""),
    compute: z.unknown().optional().transform((v, ctx) => {
      if (v === undefined || v === null) return "auto";
      const c = normalizeCompute(v);
      if (!c) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'auto, "mine:<model>" or "network:<model>" (bots never use a frontier key)' });
        return z.NEVER;
      }
      return c;
    }),
    web: z.boolean().default(true),
    schedule: scheduleSchema.nullable().optional(),
    github: githubSchema.nullable().optional(),
    color: common.color.optional(),
    budgetCSatsPerDay: common.budgetCSatsPerDay.optional(),
    budgetCSatsPerRun: common.budgetCSatsPerRun.optional(),
    maxRunsPerDay: common.maxRunsPerDay.optional(),
    maxTurns: common.maxTurns.optional(),
  })
  .strip();
export type CloudBotCreate = z.infer<typeof cloudBotCreateSchema>;

/** update_settings for a cloud bot: any of the create fields, plus enabled and the page's trigger switches. */
export const cloudBotUpdateSchema = z
  .object({
    ...common,
    enabled: z.boolean(),
    triggers: z.array(triggerInput).max(6),
  })
  .strip()
  .partial()
  .refine((p) => Object.values(p).some((v) => v !== undefined), "at least one setting");
export type CloudBotUpdate = z.infer<typeof cloudBotUpdateSchema>;

const BOT_COLORS = ["#6e56cf", "#0090ff", "#12a594", "#e5484d", "#f76b15", "#ab4aba"];
export function defaultColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BOT_COLORS[h % BOT_COLORS.length];
}

/** The next time a schedule fires after `afterMs` (UTC). */
export function nextScheduledRun(schedule: CloudSchedule | null, afterMs: number): number | null {
  if (!schedule) return null;
  if ("everyMinutes" in schedule) return afterMs + schedule.everyMinutes * 60_000;
  const [h, m] = schedule.dailyAtUtc.split(":").map(Number);
  const d = new Date(afterMs);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m);
  if (at <= afterMs) at += 24 * 3_600_000;
  return at;
}

/** "Every 30 minutes", "Daily at 09:00 UTC". */
export function scheduleText(s: CloudSchedule | null): string {
  if (!s) return "";
  if ("dailyAtUtc" in s) return `daily at ${s.dailyAtUtc} UTC`;
  const m = s.everyMinutes;
  return m % 60 === 0 ? (m === 60 ? "hourly" : `every ${m / 60} hours`) : `every ${m} minutes`;
}

export function utcDayStart(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
