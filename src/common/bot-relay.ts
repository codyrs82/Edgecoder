// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Bots on the web ("same bots, everywhere"): the bots on the owner's desktop machines are shown and
 * driven from the portal, while they keep running on their Mac with its folder and tools.
 *
 * Publishing (desktop -> web):
 *   provider (/v1/ide/bots/remote/snapshot, IDE token) <- this machine's agent polls it, and sends a
 *   capped BotsSnapshot to its coordinator on change and on a heartbeat (signed agent request).
 *   The coordinator serves a snapshot only to the agent's verified owning account.
 *
 * Commands (web -> desktop), the same chain as remote model control (#302):
 *   portal session -> portal (service token, accountId = acct-<session user>, enrolled-node check)
 *     -> coordinator (verified ownership row names the account; rate limits)
 *     -> agent (a bot_control frame signed by the coordinator's identity key, down the agent's
 *        authenticated mesh WebSocket; pinned key, own agent id, 2-minute lifetime, replay cache)
 *     -> provider (/v1/ide/bots/remote/command, IDE token; the account signed in on the Mac must be
 *        the one that asked; the desktop form's validation; the bot's own permission rules).
 *   The agent reports each result (and any data asked for) back with a signed request; the portal
 *   polls for it.
 *
 * No new privileges: a remote settings change cannot touch the bot's folder, repository, tools or
 * auto-approval (change those on the Mac), and approvals answer only calls the bot itself asked
 * about. A bot's frontier lead (its owner's own key) is turned on only at the Mac; the web shows
 * whether it is on and what it spent today, and its owner may answer the bot's "Use Claude for this
 * run?" (approve_frontier / decline_frontier). A bot made from the web ("create", #409) arrives without a folder and with the default
 * tools on Accept edits; someone at the Mac picks its folder (and confirms Auto, if the web asked)
 * before it runs. Its id is webBotId(account, request id), so a retried create makes one bot. AGENT_BOT_RELAY=view (or AGENT_REMOTE_CONTROL=off) makes the web read-only; off publishes
 * nothing.
 */

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { signPayload, verifyPayload } from "../mesh/peer.js";
import { canonicalJson, CommandReplayGuard } from "../model/remote-control/protocol.js";
import { capMarkdownSource } from "./markdown-cap.js";
import { hardwareShort, type CallUsage } from "./served.js";

export { CommandReplayGuard };

export const BOT_CONTROL_FRAME_TYPE = "bot_control";
export const BOT_CONTROL_VERSION = 1;
export const BOT_CONTROL_MAX_LIFETIME_MS = 2 * 60_000;
export const BOT_CONTROL_MAX_FUTURE_SKEW_MS = 60_000;

// ---- Size caps (the #333 caps: a message renders at most MAX_MARKDOWN characters) ----

/** Messages of each bot's conversation published with the snapshot (the rest is fetched on demand). */
export const SNAPSHOT_TAIL_MESSAGES = 12;
/** Each published message's text is capped to this (start + latest part). */
export const SNAPSHOT_MESSAGE_CHARS = 4_000;
/** Bots per machine in a snapshot. */
export const SNAPSHOT_MAX_BOTS = 30;
/** A whole snapshot; a bigger one is shrunk (shorter tails) before it is sent, and refused above this. */
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
/** A command result's data (a page of messages, the run history, the memory). */
export const MAX_RESULT_BYTES = 192 * 1024;
/** Messages per page fetched on demand. */
export const MAX_PAGE_MESSAGES = 40;
/** Each message in a fetched page (the #333 markdown cap). */
export const PAGE_MESSAGE_CHARS = 8_000;
/** Tool steps listed per published message. */
const MAX_TOOL_STEPS = 12;

// ---- Snapshot (what the web sees) ----

export type RelayControls = "on" | "view";

export interface RemoteToolStep {
  tool: string;
  /** One line: the command, the file, the commit message. */
  detail: string;
  status: "ok" | "error" | "pending" | "denied" | "running";
}

/**
 * Where a reply's (or a run's) model calls ran, compact: the web's "qwen3-coder:30b · Datacenter GPU
 * · Frankfurt · 3.4 cSats" line. Newer Macs only: an older one leaves it out and the web shows the
 * run's `where` as before. Every string is capped (SERVED_CAPS).
 */
export interface RemoteServed {
  /** The model that answered the last call ("qwen3-coder:30b"), when known. */
  model?: string;
  /** A run: the distinct models its calls ran on (at most SERVED_CAPS.models). */
  models?: string[];
  /** The last call's machine class, short ("Datacenter GPU 2×A16", "This computer (Apple M1 Max)", "GPU"). */
  machine?: string;
  /** City, region or country, when known. */
  place?: string;
  /** Distinct machines, when more than one answered. */
  machines?: number;
  /** Model calls. */
  calls: number;
  /** cSats of all of them. */
  cSats: number;
  /** Frontier calls on the owner's own key: estimated USD. */
  usd?: number;
}

export interface RemoteBotMessage {
  id: string;
  role: "user" | "assistant" | "event";
  content: string;
  atMs: number;
  runId?: string;
  steps?: RemoteToolStep[];
  /** assistant: where its model calls ran (newer Macs; see RemoteServed). */
  served?: RemoteServed;
}

export interface RemoteBotRun {
  id: string;
  trigger: string;
  source?: string;
  startedAtMs: number;
  endedAtMs?: number;
  status: string;
  summary: string;
  cSats: number;
  where?: string;
  /** Where its model calls ran: models and machine class (newer Macs; see RemoteServed). */
  served?: RemoteServed;
  note?: string;
  error?: string;
  pullRequests?: Array<{ url: string; number?: number; title?: string }>;
}

export interface RemotePendingCall {
  callId: string;
  tool: string;
  detail: string;
}

export interface RemoteBotSummary {
  id: string;
  name: string;
  role: string;
  color: string;
  avatarShape?: string;
  status: string;
  activity?: string;
  enabled: boolean;
  instructions: string;
  /** The home folder's name only (the full path stays on the Mac); "" while a web-made bot waits for one. */
  folderName: string;
  /** Made on the web and waiting for the Mac to set its folder (status "needs_folder"). */
  setup?: { autoRequested: boolean };
  repository?: string;
  repo?: { state: string; message: string };
  schedule: string;
  heartbeatMinutes: number | null;
  maxRunsPerDay: number;
  runsToday: number;
  runCount: number;
  budgetCSatsPerDay: number | null;
  spentTodayCSats: number;
  compute: { policy: string; model?: string };
  triggers: Array<{ id: string; kind: string; enabled: boolean; label?: string; scope?: string; onlyOthers?: boolean }>;
  maxTriggerRunsPerHour: number;
  triggerStatus?: Record<string, { lastCheckedAtMs?: number; error?: string; backoffUntilMs?: number }>;
  nextRun?: { kind: string; atMs: number };
  held?: string;
  lastRun?: RemoteBotRun;
  pending: RemotePendingCall[];
  /**
   * Its owner's frontier key, read-only (it is turned on only in the app on the Mac): on or off,
   * the model's short name ("Claude") and the estimated USD spent today. A pending item with tool
   * "use_frontier" is the bot asking to use it (approve_frontier / decline_frontier).
   */
  frontier?: { on: boolean; name?: string; spentTodayUsd: number };
  queuedMessages: number;
  idleStreak?: number;
  /** The conversation's latest messages (capped); `messageCount` says how many there are. */
  tail: RemoteBotMessage[];
  messageCount: number;
  updatedAtMs: number;
}

/** What this Mac's app can do from the web beyond the original commands ("create": new bots from the web). */
export const BOT_RELAY_FEATURES = ["create"] as const;

export interface BotsSnapshot {
  v: 1;
  /** Newer apps only (older coordinators drop the snapshot with it; the agent then resends without). */
  features?: string[];
  /** The Mac's name as its owner sees it ("MAW-MB-02"). */
  machineName: string;
  /** on: the web may message, pause, edit and approve; view: read-only ("Approve on your Mac"). */
  controls: RelayControls;
  bots: RemoteBotSummary[];
  generatedAtMs: number;
}

const short = (v: unknown, n: number) => {
  const s = typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** One line for a tool call: what it runs or touches, never the file contents. */
export function toolCallDetail(tool: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  switch (tool) {
    case "run_shell":
      return short(a.command, 300);
    case "git_commit":
      return short(a.message, 200);
    case "git_push":
      return short([a.remote, a.branch].filter(Boolean).join(" ") || "push", 200);
    case "open_pull_request":
      return short([a.title, a.branch ? `(${String(a.branch)})` : ""].filter(Boolean).join(" "), 200);
    case "cost_check":
      // A chat's per-reply cost check (src/apps/ide/cost-guard.ts): its question.
      return short(a.question, 200);
    default:
      return short(a.path ?? a.file ?? a.query ?? a.pattern ?? a.url ?? a.note ?? "", 200);
  }
}

interface StreamEventLike {
  type: string;
  id?: string;
  tool?: string;
  args?: Record<string, unknown>;
  requires_approval?: boolean;
  error?: string;
  result?: string;
  approval_status?: string;
}

/** A message's tool steps (call + its result), at most MAX_TOOL_STEPS of the latest. */
export function toolSteps(events: StreamEventLike[] | undefined, pendingIds: ReadonlySet<string>): RemoteToolStep[] {
  if (!events?.length) return [];
  const calls = new Map<string, RemoteToolStep>();
  for (const e of events) {
    if (e.type === "tool_call" && e.id && e.tool) {
      calls.set(e.id, { tool: e.tool, detail: toolCallDetail(e.tool, e.args), status: pendingIds.has(e.id) ? "pending" : "running" });
    } else if (e.type === "tool_result" && e.id) {
      const c = calls.get(e.id);
      if (c) c.status = e.error ? (/denied|rejected/i.test(e.error) ? "denied" : "error") : "ok";
    }
  }
  return [...calls.values()].slice(-MAX_TOOL_STEPS);
}

export function capMessage<T extends { content: string }>(m: T, chars: number): T {
  return m.content.length > chars ? { ...m, content: capMarkdownSource(m.content, chars) } : m;
}

/** The caps on a RemoteServed's fields (a served line is at most a few hundred bytes). */
export const SERVED_CAPS = { model: 80, machine: 60, place: 40, models: 3 } as const;

const CLASS_NAMES: Record<string, string> = { gpu: "GPU", "gpu.dc": "Datacenter GPU", apple: "Apple", cpu: "CPU", cloud: "Cloud", local: "This computer" };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plainModel = (m: string) => clip(m.replace(/^network\//, "").replace(/^frontier\/[^/]+\//, "").trim(), SERVED_CAPS.model);

/**
 * The model and machine class named by a backend's `where`, when it names them: the coordinator's
 * "routed to <model> on <class> because …", or a compute label ("Network · <model> · GPU",
 * "My machines · <model>"). Route labels that name neither give {}.
 */
export function servedFromWhere(where: string | undefined): { model?: string; machine?: string } {
  const w = (where ?? "").trim();
  const routed = /routed to (\S+) on (\S+)/.exec(w);
  if (routed) {
    const cls = routed[2].replace(/[,.;]$/, "");
    return { model: plainModel(routed[1]), machine: CLASS_NAMES[cls] ?? clip(cls, SERVED_CAPS.machine) };
  }
  const label = /^(Network|My machines|Reserved [^·]*?) · ([^·\s]+)(?: · ([^·]+))?$/.exec(w);
  if (label && label[2] !== "best") {
    const machine = label[1] === "My machines" ? "Your machines" : label[1].startsWith("Reserved") ? label[1].trim() : label[3]?.trim() || undefined;
    return { model: plainModel(label[2]), ...(machine ? { machine: clip(machine, SERVED_CAPS.machine) } : {}) };
  }
  return {};
}

type CallLike = CallUsage & { usd?: number };

/** A reply's or run's model calls (usage events), compact; undefined when there were none. */
export function servedSummary(calls: CallLike[]): RemoteServed | undefined {
  const list = calls.filter((c) => c && Number.isFinite(c.cSats));
  if (!list.length) return undefined;
  const last = list[list.length - 1];
  const fromWhere = servedFromWhere(last.where);
  const model = last.model ? plainModel(last.model) : fromWhere.model;
  const s = last.served;
  const machine = s ? clip(hardwareShort(s).replace(/ · your machine$/, " (yours)"), SERVED_CAPS.machine) : fromWhere.machine;
  const place = s ? (s.city ?? s.region ?? s.country ?? undefined) : undefined;
  const models = [...new Set(list.map((c) => (c.model ? plainModel(c.model) : servedFromWhere(c.where).model)).filter((m): m is string => !!m))].slice(-SERVED_CAPS.models);
  const machines = new Set(list.filter((c) => c.served).map((c) => c.served!.label)).size;
  const cSats = Number(list.reduce((n, c) => n + c.cSats, 0).toFixed(6));
  const usd = list.reduce((n, c) => n + (typeof c.usd === "number" && Number.isFinite(c.usd) ? c.usd : c.served?.usd ?? 0), 0);
  return {
    ...(model ? { model } : {}),
    ...(models.length > 1 ? { models } : {}),
    ...(machine ? { machine } : {}),
    ...(place ? { place: clip(place, SERVED_CAPS.place) } : {}),
    ...(machines > 1 ? { machines } : {}),
    calls: list.length,
    cSats,
    ...(usd > 0 ? { usd: Number(usd.toFixed(4)) } : {}),
  };
}

/** The usage events among a message's stream events, as calls. */
export function usageCalls(events: Array<{ type: string } & Record<string, unknown>> | undefined): CallLike[] {
  return (events ?? []).filter((e) => e.type === "usage" && typeof e.cSats === "number").map((e) => e as unknown as CallLike);
}

/** Shrinks a snapshot until it fits MAX_SNAPSHOT_BYTES: shorter tails, then shorter messages. */
export function fitSnapshot(s: BotsSnapshot, maxBytes = MAX_SNAPSHOT_BYTES): BotsSnapshot {
  let out = s;
  const size = () => Buffer.byteLength(JSON.stringify(out));
  for (const [keep, chars] of [[SNAPSHOT_TAIL_MESSAGES, SNAPSHOT_MESSAGE_CHARS], [6, 2_000], [3, 1_000], [1, 500], [0, 0]] as const) {
    if (size() <= maxBytes) return out;
    out = { ...out, bots: out.bots.map((b) => ({ ...b, tail: b.tail.slice(-keep).map((m) => capMessage({ ...m, steps: m.steps?.slice(-3) }, Math.max(chars, 1))) })) };
  }
  while (size() > maxBytes && out.bots.length) out = { ...out, bots: out.bots.slice(0, -1) };
  return out;
}

// ---- Commands ----

export const BOT_CONTROL_ACTIONS = ["message", "pause", "resume", "check_now", "stop", "update_settings", "approve", "messages", "history", "memory", "create", "approve_frontier", "decline_frontier"] as const;
export type BotControlAction = (typeof BOT_CONTROL_ACTIONS)[number];
/** Actions that only read (their own, larger rate limit; allowed in view-only mode). */
export const BOT_READ_ACTIONS: ReadonlySet<BotControlAction> = new Set(["messages", "history", "memory"]);

const enumLike = z.string().trim().min(1).max(40).regex(/^[a-z_]+$/);
/**
 * What a remote settings change may set: the desktop form's fields and bounds (src/apps/ide/bots.ts
 * botFields), without the folder, repository, tools and auto-approval (those widen what the bot can
 * touch, so they are changed on the Mac). The provider validates again with the desktop schema.
 */
export const remoteBotSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    role: z.string().max(80),
    instructions: z.string().max(8_000),
    enabled: z.boolean(),
    schedule: z.string().max(100),
    heartbeatMinutes: z.number().int().min(5).max(1440).nullable(),
    maxRunsPerDay: z.number().int().min(1).max(500),
    budgetCSatsPerDay: z.number().positive().max(1e9).nullable(),
    compute: z.object({ policy: enumLike, model: z.string().trim().min(1).max(300).optional() }).strict(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    avatarShape: enumLike,
    triggers: z
      .array(
        z
          .object({
            id: z.string().max(40).optional(),
            kind: enumLike,
            enabled: z.boolean().default(true),
            label: z.string().trim().max(100).optional(),
            onlyOthers: z.boolean().optional(),
            scope: enumLike.optional()
          })
          .strict()
      )
      .max(10),
    maxTriggerRunsPerHour: z.number().int().min(1).max(60),
    memory: z.string().max(8_000)
  })
  .strict()
  .partial()
  .refine((p) => Object.keys(p).length > 0, "at least one setting");
export type RemoteBotSettings = z.infer<typeof remoteBotSettingsSchema>;

/** A client request id: the web makes one per "Create bot", and every retry sends the same one. */
export const botRequestIdSchema = z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/);

/**
 * A model id that would use a frontier key. A bot's compute never is one, wherever it was made: a
 * desktop bot uses its owner's key only through its frontier lead switch, which only the app on
 * the Mac can turn on (docs/frontier-keys.md).
 */
export function isFrontierModel(id: string | undefined): boolean {
  return !!id && /^\s*frontier\//i.test(id);
}

/**
 * A new bot from the web (#409): the desktop form's fields and bounds, without anything that makes
 * the Mac touch a place on disk. `suggestedFolder` is only shown on the Mac as a suggestion; the
 * provider never creates or uses it until someone at the Mac confirms a folder (BotManager.setupFolder).
 * The permission mode defaults to Accept edits; Auto is kept as a request the Mac must confirm.
 */
export const remoteBotCreateSchema = z
  .object({
    requestId: botRequestIdSchema,
    name: z.string().trim().min(1).max(60),
    role: z.string().max(80).default(""),
    instructions: z.string().max(8_000).default(""),
    enabled: z.boolean().default(true),
    schedule: z.string().max(100).default(""),
    heartbeatMinutes: z.number().int().min(5).max(1440).nullable().optional(),
    maxRunsPerDay: z.number().int().min(1).max(500).optional(),
    budgetCSatsPerDay: z.number().positive().max(1e9).nullable().optional(),
    compute: z
      .object({ policy: enumLike, model: z.string().trim().min(1).max(300).optional(), computeClass: z.string().trim().min(1).max(20).regex(/^[a-z.]+$/).optional() })
      .strict()
      .refine((c) => !isFrontierModel(c.model), "a bot's compute can't be a frontier model (turn on its frontier lead in the app on the Mac)")
      .optional(),
    mode: z.enum(["ask", "auto-edits", "plan", "auto"]).default("auto-edits"),
    repository: z.string().trim().max(500).optional(),
    triggers: z
      .array(
        z
          .object({ kind: enumLike, enabled: z.boolean().default(true), label: z.string().trim().max(100).optional(), onlyOthers: z.boolean().optional(), scope: enumLike.optional() })
          .strict()
      )
      .max(10)
      .optional(),
    maxTriggerRunsPerHour: z.number().int().min(1).max(60).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    avatarShape: enumLike.optional(),
    /** Shown on the Mac as a suggestion only (never created or used without the Mac's confirmation). */
    suggestedFolder: z.string().trim().max(1_000).optional()
  })
  .strict();
export type RemoteBotCreate = z.infer<typeof remoteBotCreateSchema>;

/**
 * The id a bot made from the web gets on the Mac: the same for every retry of one request by one
 * account, so a create that is sent twice (a retry, another portal machine) makes one bot.
 */
export function webBotId(requestedBy: string, requestId: string): string {
  return `bot_w${createHash("sha256").update(`${requestedBy}\n${requestId}`).digest("hex").slice(0, 12)}`;
}

const none = z.object({}).strict().default({});
export const botControlRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("message"), args: z.object({ content: z.string().trim().min(1).max(20_000) }).strict() }),
  z.object({ action: z.literal("pause"), args: none }),
  z.object({ action: z.literal("resume"), args: none }),
  z.object({ action: z.literal("check_now"), args: none }),
  z.object({ action: z.literal("stop"), args: none }),
  z.object({ action: z.literal("update_settings"), args: remoteBotSettingsSchema }),
  z.object({ action: z.literal("approve"), args: z.object({ callId: z.string().min(1).max(100), approved: z.boolean() }).strict() }),
  // The bot's ask to use its owner's frontier key: this run, or every run until midnight; or no.
  z.object({ action: z.literal("approve_frontier"), args: z.object({ callId: z.string().min(1).max(100), scope: z.enum(["run", "day"]).default("run") }).strict() }),
  z.object({ action: z.literal("decline_frontier"), args: z.object({ callId: z.string().min(1).max(100) }).strict() }),
  z.object({
    action: z.literal("messages"),
    args: z.object({ beforeMs: z.number().int().nonnegative().optional(), beforeId: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(MAX_PAGE_MESSAGES).default(20) }).strict().default({ limit: 20 })
  }),
  z.object({ action: z.literal("history"), args: none }),
  z.object({ action: z.literal("memory"), args: none }),
  z.object({ action: z.literal("create"), args: remoteBotCreateSchema })
]);
export type BotControlRequest = z.infer<typeof botControlRequestSchema>;

export const botIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

export interface BotControlCommand {
  v: typeof BOT_CONTROL_VERSION;
  id: string;
  agentId: string;
  coordinatorId: string;
  /** The owning account the coordinator verified (acct-<userId>). */
  requestedBy: string;
  issuedAtMs: number;
  expiresAtMs: number;
  botId: string;
  action: BotControlAction;
  args: Record<string, unknown>;
}

export interface BotControlFrame {
  type: typeof BOT_CONTROL_FRAME_TYPE;
  command: BotControlCommand;
  signature: string;
}

export function botControlSigningPayload(command: BotControlCommand): string {
  return `edgecoder-bot-control-v1\n${canonicalJson(command)}`;
}

export function createBotControlFrame(input: {
  request: BotControlRequest;
  botId: string;
  agentId: string;
  coordinatorId: string;
  requestedBy: string;
  privateKeyPem: string;
  nowMs?: number;
  id?: string;
}): BotControlFrame {
  const issuedAtMs = input.nowMs ?? Date.now();
  const command: BotControlCommand = {
    v: BOT_CONTROL_VERSION,
    id: input.id ?? randomUUID(),
    agentId: input.agentId,
    coordinatorId: input.coordinatorId,
    requestedBy: input.requestedBy,
    issuedAtMs,
    expiresAtMs: issuedAtMs + BOT_CONTROL_MAX_LIFETIME_MS,
    botId: input.botId,
    action: input.request.action,
    args: input.request.args as Record<string, unknown>
  };
  return { type: BOT_CONTROL_FRAME_TYPE, command, signature: signPayload(botControlSigningPayload(command), input.privateKeyPem) };
}

const commandShape = z
  .object({
    v: z.literal(BOT_CONTROL_VERSION),
    id: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/),
    agentId: z.string().min(1).max(128),
    coordinatorId: z.string().min(1).max(256),
    requestedBy: z.string().min(1).max(160),
    issuedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().nonnegative(),
    botId: botIdSchema,
    action: z.enum(BOT_CONTROL_ACTIONS),
    args: z.record(z.string(), z.unknown())
  })
  .strict();

export type BotFrameVerdict =
  | { ok: true; command: BotControlCommand; request: BotControlRequest }
  | { ok: false; reason: "malformed" | "no_verified_coordinator" | "wrong_coordinator" | "invalid_signature" | "wrong_agent" | "expired" | "from_future" | "lifetime_too_long" | "replayed" | "replay_cache_full" | "invalid_request" };

/** The agent's check of a bot_control frame (the same rules as verifyModelControlFrame). */
export function verifyBotControlFrame(
  frame: unknown,
  ctx: { agentId: string; coordinator: { peerId: string; publicKeyPem: string } | null; replay: CommandReplayGuard; nowMs?: number }
): BotFrameVerdict {
  const f = frame as Partial<BotControlFrame> | null;
  if (!f || typeof f !== "object" || f.type !== BOT_CONTROL_FRAME_TYPE || typeof f.signature !== "string") return { ok: false, reason: "malformed" };
  const parsed = commandShape.safeParse(f.command);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const command = parsed.data as BotControlCommand;
  if (!ctx.coordinator) return { ok: false, reason: "no_verified_coordinator" };
  if (command.coordinatorId !== ctx.coordinator.peerId) return { ok: false, reason: "wrong_coordinator" };
  if (!verifyPayload(botControlSigningPayload(f.command as BotControlCommand), f.signature, ctx.coordinator.publicKeyPem)) return { ok: false, reason: "invalid_signature" };
  if (command.agentId !== ctx.agentId) return { ok: false, reason: "wrong_agent" };
  const now = ctx.nowMs ?? Date.now();
  if (command.issuedAtMs > now + BOT_CONTROL_MAX_FUTURE_SKEW_MS) return { ok: false, reason: "from_future" };
  if (command.expiresAtMs - command.issuedAtMs > BOT_CONTROL_MAX_LIFETIME_MS || command.expiresAtMs < command.issuedAtMs) return { ok: false, reason: "lifetime_too_long" };
  if (now > command.expiresAtMs) return { ok: false, reason: "expired" };
  const request = botControlRequestSchema.safeParse({ action: command.action, args: command.args });
  if (!request.success) return { ok: false, reason: "invalid_request" };
  // A new bot's id is fixed by who asked and the request id (one bot per request, whatever retries).
  if (request.data.action === "create" && command.botId !== webBotId(command.requestedBy, request.data.args.requestId)) return { ok: false, reason: "invalid_request" };
  const fresh = ctx.replay.accept(command.id, command.expiresAtMs, now);
  if (fresh === "full") return { ok: false, reason: "replay_cache_full" };
  if (!fresh) return { ok: false, reason: "replayed" };
  return { ok: true, command, request: request.data };
}

/** One command's outcome, reported by the agent. */
export interface BotControlResult {
  commandId: string;
  status: "done" | "refused" | "failed";
  error?: string;
  message?: string;
  /** What a read asked for (messages, runs, memory) or what a change returned (started, queued). */
  data?: unknown;
}

/** AGENT_BOT_RELAY: off publishes nothing; view publishes read-only; on (default) also takes commands. */
export function botRelayMode(value: string | undefined, remoteControl: boolean): "off" | RelayControls {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
  if (v === "view" || !remoteControl) return "view";
  return "on";
}
