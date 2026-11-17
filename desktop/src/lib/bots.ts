// Persistent bots (:4304 /v1/ide/bots): types mirroring src/apps/ide/bots.ts and the pure helpers
// the sidebar and the bot page use (avatar, status line, schedule text, folding a run's events).
import { applyAgentEvent, type AgentTurn } from "./agent-events";
import type { IdeStreamEvent } from "./api";
import { frontierName } from "./compute-choice";
import { hardwareShort, type Served } from "./served";

export type BotStatus = "idle" | "running" | "needs_approval" | "paused" | "over_budget" | "error";
export type BotRunStatus = "running" | "needs_approval" | "done" | "failed" | "budget" | "cancelled" | "interrupted";
/** What started a run: the ones it starts on its own, your message, or "Check now" (manual). */
export type BotTriggerKind = "schedule" | "manual" | "message" | "github" | "start" | "heartbeat" | "follow_up";

/** What it runs next on its own (the server's BotNextRun). */
export interface BotNextRun {
  kind: "start" | "follow_up" | "schedule" | "heartbeat";
  atMs: number;
}

export interface BotPullRequest {
  url: string;
  number?: number;
  title?: string;
  branch?: string;
}

export interface BotRun {
  id: string;
  trigger: BotTriggerKind;
  /** github runs: what fired it ("PR #12 updated", "CI failed on main"). */
  source?: string;
  /** Pull requests the run opened. */
  pullRequests?: BotPullRequest[];
  startedAtMs: number;
  endedAtMs?: number;
  status: BotRunStatus;
  summary: string;
  cSats: number;
  where?: string;
  /** e.g. "ran on a smaller local model (no cSats)" */
  note?: string;
  error?: string;
}

export interface BotPendingCall {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

export type TriggerKind = "pr" | "ci_failed" | "issue_labeled";
export type CiScope = "default" | "prs" | "any";
export interface BotTriggerConfig {
  /** Missing on triggers added in the form and not saved yet. */
  id?: string;
  kind: TriggerKind;
  enabled: boolean;
  label?: string;
  onlyOthers?: boolean;
  scope?: CiScope;
}

export interface Bot {
  id: string;
  name: string;
  role: string;
  instructions: string;
  /** The home folder: its own notes and files (and its work folder without a repository). */
  projectRoot: string;
  /** owner/repo it works in (older servers and bots without one: unset). */
  repository?: string;
  /** Where the repository is checked out. */
  repoPath?: string;
  repo?: { state: "cloning" | "ready" | "error"; message: string };
  triggers?: BotTriggerConfig[];
  maxTriggerRunsPerHour?: number;
  triggerStatus?: Record<string, { lastCheckedAtMs?: number; error?: string; backoffUntilMs?: number }>;
  queuedEvents?: number;
  enabled: boolean;
  schedule: string;
  /** Without a schedule: check in this often (minutes); null = never. Older servers: unset. */
  heartbeatMinutes?: number | null;
  /** Runs it may start on its own a day. */
  maxRunsPerDay?: number;
  auto?: { idleStreak: number; followUps: number; due?: { atMs: number; kind: "start" | "follow_up"; reason?: string } };
  runsToday?: number;
  runCount?: number;
  nextRun?: BotNextRun;
  /** A limit holding back the runs it starts on its own. */
  held?: "run_cap" | "budget";
  /** Paused because its last runs kept hitting the same problem; your message or resuming clears it. */
  stuck?: { atMs: number; problem: string; runs: number };
  budgetCSatsPerDay: number | null;
  allowedTools: string[];
  autoApproveEdits: boolean;
  /** Its permission mode (ask, auto-edits, auto, plan); older servers don't send it (see botModeOf). */
  mode?: import("./permission-modes").EngineMode;
  /** Where its model calls run (older servers don't send it: Auto). */
  compute?: BotCompute;
  color: string;
  /** "robot" | "orb" | "hex" | "block"; unset: picked from the name (lib/bot-avatar). */
  avatarShape?: string;
  createdAtMs: number;
  updatedAtMs: number;
  nextRunAtMs?: number;
  status: BotStatus;
  spentTodayCSats: number;
  lastRun?: BotRun;
  pending: BotPendingCall[];
  queuedMessages: number;
  activity?: string;
}

export interface BotMessage {
  id: string;
  role: "user" | "assistant" | "event";
  content: string;
  atMs: number;
  runId?: string;
  events?: IdeStreamEvent[];
}

export interface BotInput {
  name: string;
  role?: string;
  instructions?: string;
  projectRoot: string;
  repository?: string;
  triggers?: BotTriggerConfig[];
  maxTriggerRunsPerHour?: number;
  enabled?: boolean;
  schedule?: string;
  heartbeatMinutes?: number | null;
  maxRunsPerDay?: number;
  budgetCSatsPerDay?: number | null;
  allowedTools?: string[];
  autoApproveEdits?: boolean;
  mode?: import("./permission-modes").EngineMode;
  compute?: BotCompute;
  color?: string;
  avatarShape?: string;
}

/** A tool call the bot asked you about, as a card in the conversation. */
export interface AskCard {
  id: string;
  question: string;
  detail?: string;
  /** While it waits for you: the whole call, so the card shows every argument in full, not just `detail`. */
  call?: { tool: string; args: Record<string, unknown> };
  /** null while it waits for you. */
  answer: "Allowed" | "Denied" | null;
  /** The "Always allow" rule this command may keep for the project (`npm test:*`). */
  rule?: string;
  /** open_pull_request: what the PR will be. */
  pr?: { title: string; body: string; branch: string; base: string; diffstat: string; commits?: number; uncommitted?: number };
}

/** The approvals in a run's tool events, as cards: waiting ones have no answer yet. */
/** A bot's permission mode (older servers: from autoApproveEdits). */
export function botModeOf(bot: Pick<Bot, "mode" | "autoApproveEdits">): import("./permission-modes").EngineMode {
  return bot.mode ?? (bot.autoApproveEdits ? "auto-edits" : "ask");
}

export function askCards(events: Array<{ type: string; id?: string; tool?: string; args?: Record<string, unknown>; requires_approval?: boolean; approval_status?: string; allow_rule?: string }>, botName: string): AskCard[] {
  return events
    .filter((e) => e.type === "tool_call" && e.requires_approval && e.id)
    .map((e) => {
      const args = e.args ?? {};
      const cmd = typeof args.command === "string" ? args.command : undefined;
      const path = typeof args.path === "string" ? args.path : undefined;
      const tool = e.tool ?? "a tool";
      const question =
        tool === "run_shell" ? `${botName} wants to run a command` :
        tool === "git_commit" ? `${botName} wants to commit` :
        tool === "git_push" ? `${botName} wants to push` :
        tool === "open_pull_request" ? `${botName} wants to open a pull request` :
        tool === "write_file" || tool === "edit_file" ? `${botName} wants to ${tool === "write_file" ? "write" : "edit"} a file` :
        `${botName} wants to use ${tool.replace(/_/g, " ")}`;
      const detail = cmd ?? path ?? (typeof args.message === "string" ? args.message : undefined);
      const answer = e.approval_status === "approved" ? "Allowed" : e.approval_status === "rejected" ? "Denied" : null;
      if (tool === "open_pull_request") {
        const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
        const n = (k: string) => (typeof args[k] === "number" ? (args[k] as number) : undefined);
        const pr = { title: s("title"), body: s("body"), branch: s("branch"), base: s("base"), diffstat: s("diffstat"), commits: n("commits"), uncommitted: n("uncommitted") };
        return { id: e.id!, question, answer, pr };
      }
      return { id: e.id!, question, ...(detail ? { detail } : {}), ...(answer === null ? { call: { tool, args } } : {}), ...(answer === null && e.allow_rule ? { rule: e.allow_rule } : {}), answer };
    });
}

export type ComputePolicy = "local_first" | "auto" | "local_only" | "mine_only" | "model" | "network_only";
/** The classes "Network only" may be limited to (src/inference-api/auto-route.ts NETWORK_CLASSES). */
export type NetworkClass = "gpu" | "apple" | "cpu" | "gpu.dc";
export interface BotCompute {
  policy: ComputePolicy;
  /** "model": a ComputePicker id ("qwen3.5:9b", "mine/...", "network/...@gpu", "reserved/<id>/..."); "network_only": optional, a "network/..." id (else best fit). */
  model?: string;
  /** Only for "network_only": the one class it runs on. */
  computeClass?: NetworkClass;
}

/** A card in the form: a policy, and for the per-class network cards its class ("network_only:gpu"). */
export type ComputeChoice = Exclude<ComputePolicy, "network_only"> | "network_only" | `network_only:${NetworkClass}`;

/** The form's choices, in order; new bots start on Auto. */
export const COMPUTE_POLICY_OPTIONS: Array<{ value: ComputeChoice; title: string; desc: string }> = [
  { value: "auto", title: "Auto", desc: "Recommended. A capable model for each step: your machines when one has a 14B or larger model (free), else the network's best fit, within the daily budget." },
  { value: "local_first", title: "Local first", desc: "This computer first when it has a 14B or larger model, then your machines, then the network's best fit within the daily budget." },
  { value: "local_only", title: "This computer only", desc: "Never leaves this computer. Free." },
  { value: "mine_only", title: "My machines only", desc: "This computer and your other machines. Free, never the network." },
  { value: "network_only", title: "Network only", desc: "Always the network's best fit, paid within the daily budget. Never this computer or your machines." },
  { value: "network_only:gpu", title: "Network GPU only", desc: "The network's GPU machines only, within the daily budget. Never this computer or your machines." },
  { value: "network_only:apple", title: "Network Apple only", desc: "The network's Apple silicon Macs only, within the daily budget. Never this computer or your machines." },
  { value: "network_only:cpu", title: "Network CPU only", desc: "The network's CPU machines only: cheapest power floor, slowest. Within the daily budget." },
  { value: "network_only:gpu.dc", title: "Network Datacenter GPU only", desc: "The network's datacenter GPUs only: fastest, within the daily budget. Never this computer or your machines." },
  { value: "model", title: "Specific model", desc: "Always the model you pick below." },
];

/** The card a bot's compute shows as. */
export function computeChoiceOf(c: BotCompute): ComputeChoice {
  if (c.policy === "network_only") return c.computeClass ? `network_only:${c.computeClass}` : "network_only";
  return c.policy;
}

/** The compute a card (and the Model selector) saves: per-class cards are network_only with a class. */
export function computeFromChoice(choice: ComputeChoice, model?: string): BotCompute {
  if (choice === "model") return { policy: "model", ...(model ? { model } : {}) };
  if (choice.startsWith("network_only")) {
    const cls = choice.split(":")[1] as NetworkClass | undefined;
    const net = model ? networkModelId(model) : undefined;
    return { policy: "network_only", ...(net ? { model: net } : {}), ...(cls ? { computeClass: cls } : {}) };
  }
  return { policy: choice as ComputePolicy };
}

/** A picker id as a network model id: "qwen3:30b", "mine/qwen3:30b" → "network/qwen3:30b" (the class comes from the card). */
export function networkModelId(id: string): string | undefined {
  const t = id.trim();
  if (!t || t === "auto" || t.startsWith("frontier/")) return undefined;
  if (t.startsWith("network/")) return t.replace(/@[^@/]+$/, "");
  const reserved = /^reserved\/[^/]+\/(.+)$/.exec(t);
  return `network/${reserved ? reserved[1] : t.replace(/^mine\//, "")}`;
}

export const DEFAULT_COMPUTE: BotCompute = { policy: "auto" };

/** Read-only tools every bot has; the form toggles the rest. */
export const BOT_READ_TOOLS = ["read_file", "list_directory", "search_files", "search_codebase", "git_status", "git_diff", "git_log", "git_fetch", "github_list_prs", "github_list_issues"];
export const BOT_TOOL_GROUPS: Array<{ id: string; title: string; desc: string; tools: string[] }> = [
  { id: "edit", title: "Edit files", desc: "Write and edit files inside its project folder.", tools: ["write_file", "edit_file"] },
  { id: "shell", title: "Run commands", desc: "Tests, builds, scripts. Each command asks you first.", tools: ["run_shell"] },
  { id: "git", title: "Commit, push and open pull requests", desc: "Commits, pushes and pull requests ask you first. Pull requests never go to the default branch.", tools: ["git_commit", "git_push", "open_pull_request"] },
];

export function toolsFor(groups: Record<string, boolean>): string[] {
  return [...BOT_READ_TOOLS, ...BOT_TOOL_GROUPS.filter((g) => groups[g.id]).flatMap((g) => g.tools)];
}

export function groupsOf(tools: string[]): Record<string, boolean> {
  return Object.fromEntries(BOT_TOOL_GROUPS.map((g) => [g.id, g.tools.every((t) => tools.includes(t))]));
}

export const SCHEDULE_PRESETS: Array<{ value: string; label: string }> = [
  { value: "", label: "No fixed schedule (check-ins)" },
  { value: "every 30 minutes", label: "Every 30 minutes" },
  { value: "hourly", label: "Every hour" },
  { value: "every 6 hours", label: "Every 6 hours" },
  { value: "daily at 09:00", label: "Daily at 09:00" },
  { value: "0 9 * * 1-5", label: "Weekdays at 09:00" },
];

/** How often a bot without a fixed schedule checks in on its project ("" = never). */
export const HEARTBEAT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "15", label: "Every 15 minutes" },
  { value: "30", label: "Every 30 minutes" },
  { value: "60", label: "Every hour" },
  { value: "240", label: "Every 4 hours" },
  { value: "", label: "Never (only messages and triggers)" },
];
export const DEFAULT_HEARTBEAT_MINUTES = 30;
export const DEFAULT_MAX_RUNS_PER_DAY = 48;

/** Check-ins apply: a job (role or instructions), a heartbeat and no fixed schedule. */
export function checksIn(bot: Pick<Bot, "role" | "instructions" | "schedule" | "heartbeatMinutes">): boolean {
  const minutes = bot.heartbeatMinutes === undefined ? DEFAULT_HEARTBEAT_MINUTES : bot.heartbeatMinutes;
  return !!minutes && !bot.schedule.trim() && !!(bot.role.trim() || bot.instructions.trim());
}

/** Its routine in words: the schedule, "Checks in every 30 minutes", or "Works when you message it". */
export function routineText(bot: Pick<Bot, "role" | "instructions" | "schedule" | "heartbeatMinutes">): string {
  if (bot.schedule.trim()) return scheduleText(bot.schedule);
  if (!checksIn(bot)) return "Works when you message it";
  const m = bot.heartbeatMinutes ?? DEFAULT_HEARTBEAT_MINUTES;
  const every = HEARTBEAT_OPTIONS.find((o) => o.value === String(m))?.label.toLowerCase() ?? (m % 60 === 0 ? `every ${m / 60} hours` : `every ${m} minutes`);
  return `Checks in ${every}`;
}

/** "in 12 min" → "12 min"; "in less than a minute" → "less than a minute". */
function untilText(ms: number, now: number): string {
  return relativeTime(ms, now).replace(/^in /, "");
}

/**
 * The header status: what the bot is doing now or when it next works on its own, instead of a
 * "Run now" button ("Working…", "Next check in 12 min", "Paused").
 */
export function autoStatus(bot: Pick<Bot, "status" | "enabled" | "nextRun" | "held" | "activity" | "maxRunsPerDay" | "lastRun"> & Partial<Pick<Bot, "name" | "stuck">>, now = Date.now()): { text: string; tone: "muted" | "accent" | "warn" | "err" } {
  if (bot.status === "running") return { text: bot.activity && !/^(Auto|Compute): /.test(bot.activity) ? `Working: ${bot.activity}` : "Working…", tone: "accent" };
  if (bot.status === "needs_approval") return { text: "Waiting for your approval", tone: "warn" };
  if (!bot.enabled && bot.stuck) return { text: stuckText(bot.name ?? "It", bot.stuck), tone: "warn" };
  if (!bot.enabled) return { text: "Paused", tone: "muted" };
  if (bot.status === "over_budget" || bot.held === "budget") return { text: "Budget spent · resumes tomorrow", tone: "warn" };
  if (bot.held === "run_cap") return { text: `Daily limit of ${bot.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY} runs reached · resumes tomorrow`, tone: "warn" };
  const n = bot.nextRun;
  const failed = bot.status === "error" ? "Last run failed · " : "";
  const tone = bot.status === "error" ? "err" : "muted";
  if (n) {
    if (n.atMs <= now + 30_000) return { text: n.kind === "start" ? "Starting…" : `${failed}Continuing…`, tone: bot.status === "error" ? "err" : "accent" };
    const when = untilText(n.atMs, now);
    const text = n.kind === "follow_up" ? `Continuing in ${when}` : n.kind === "start" ? `Starting in ${when}` : n.kind === "schedule" ? `Next run in ${when}` : `Next check in ${when}`;
    return { text: failed + text, tone };
  }
  return { text: `${failed}Waiting for a message`, tone };
}

/** "Paused: Harry kept hitting the same problem (npm test: package.json not found). Tell it what to do, or resume." */
export function stuckText(name: string, stuck: NonNullable<Bot["stuck"]>): string {
  const problem = stuck.problem.length > 120 ? `${stuck.problem.slice(0, 119)}…` : stuck.problem;
  return `Paused: ${name} kept hitting the same problem (${problem}). Tell it what to do, or resume.`;
}

/** The bot's compute, as the server treats it (bots from older servers run on Auto). */
export function botCompute(bot: Pick<Bot, "compute">): BotCompute {
  return bot.compute ?? { policy: "auto" };
}

/** Header text for the policy: "Local first", "This computer only", "qwen3.5:9b · Network GPU". */
export function computeText(c: BotCompute, label?: (id: string) => { model: string; where: string }): string {
  if (c.policy === "model") {
    if (!c.model) return "Specific model";
    const l = label?.(c.model);
    return l ? `${l.model} · ${l.where}` : c.model;
  }
  const title = COMPUTE_POLICY_OPTIONS.find((o) => o.value === computeChoiceOf(c))?.title ?? "Auto";
  return c.policy === "network_only" && c.model ? `${title} · ${c.model.replace(/^network\//, "")}` : title;
}

/** The status chip in the bot header. */
export function statusChip(bot: Pick<Bot, "status"> & Partial<Pick<Bot, "stuck">>): { text: string; tone: "muted" | "accent" | "warn" | "err" } {
  if (bot.status === "paused" && bot.stuck) return { text: "Stuck", tone: "warn" };
  switch (bot.status) {
    case "running":
      return { text: "Running", tone: "accent" };
    case "needs_approval":
      return { text: "Needs approval", tone: "warn" };
    case "error":
      return { text: "Failed", tone: "err" };
    case "paused":
      return { text: "Paused", tone: "muted" };
    case "over_budget":
      return { text: "Budget spent", tone: "warn" };
    default:
      return { text: "Idle", tone: "muted" };
  }
}

/** "Harry the Engineer" from "/Users/me/Dropbox/Agents/Harry the Engineer". */
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export type NoticeAction = "buy" | "local_only" | "edit";
export interface FailureNotice {
  runId: string;
  title: string;
  detail: string;
  actions: NoticeAction[];
}

/** The last run's failure in plain words, with what the user can do about it; null when it didn't fail. */
export function failureNotice(bot: Pick<Bot, "name" | "lastRun" | "compute">): FailureNotice | null {
  const r = bot.lastRun;
  if (!r || r.status !== "failed") return null;
  const err = (r.error ?? r.summary ?? "").replace(/^Failed:\s*/, "").trim();
  const onlyHere = botCompute(bot).policy === "local_only";
  const base = { runId: r.id, title: `${bot.name}'s last run didn't finish` };
  if (/not enough cSats|no cSats|insufficient|budget is spent/i.test(err)) {
    return {
      ...base,
      detail: "It needed the network, and there weren't enough cSats for it. Buy cSats, or keep it on this computer (free).",
      actions: onlyHere ? ["buy", "edit"] : ["buy", "local_only"],
    };
  }
  if (/isn't installed|no model is installed|no model is available|no model fits|isn't running/i.test(err)) {
    return { ...base, detail: err, actions: ["edit"] };
  }
  if (/isn't connected|not connected|offline/i.test(err)) {
    return { ...base, detail: err, actions: onlyHere ? ["edit"] : ["local_only", "edit"] };
  }
  return { ...base, detail: err || "It stopped with an error.", actions: ["edit"] };
}

export const NOTICE_ACTION_TEXT: Record<NoticeAction, string> = { buy: "Buy cSats", local_only: "Switch to This computer", edit: "Edit compute" };

/** The avatar letter: the first letter or digit of the name. */
export function botInitial(name: string): string {
  const m = /[\p{L}\p{N}]/u.exec(name);
  return m ? m[0].toUpperCase() : "?";
}

/** "Harry · Engineer" */
export function botTitle(bot: Pick<Bot, "name" | "role">): string {
  return bot.role.trim() ? `${bot.name} · ${bot.role.trim()}` : bot.name;
}

/** Plain-language schedule: "Every 30 minutes", "Daily at 09:00", or the cron text. */
export function scheduleText(schedule: string): string {
  const s = schedule.trim();
  if (!s) return "No schedule";
  const preset = SCHEDULE_PRESETS.find((p) => p.value === s);
  if (preset) return preset.label;
  const lower = s.toLowerCase();
  if (lower.startsWith("every ") || lower.startsWith("daily")) return s[0].toUpperCase() + s.slice(1);
  return `Cron: ${s}`;
}

export function relativeTime(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  const text = min < 1 ? "less than a minute" : min < 60 ? `${min} min` : min < 60 * 24 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`;
  if (min < 1) return diff >= 0 ? "in less than a minute" : "just now";
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export function formatCSats(n: number): string {
  if (n === 0) return "0";
  if (n < 0.01) return "<0.01";
  return n < 10 ? n.toFixed(2).replace(/\.?0+$/, "") : Math.round(n).toLocaleString("en-US");
}

/** "12 of 100 cSats today" or "3 cSats today · no limit" */
export function budgetText(bot: Pick<Bot, "spentTodayCSats" | "budgetCSatsPerDay">): string {
  return bot.budgetCSatsPerDay == null
    ? `${formatCSats(bot.spentTodayCSats)} cSats today · no limit`
    : `${formatCSats(bot.spentTodayCSats)} of ${formatCSats(bot.budgetCSatsPerDay)} cSats today`;
}

/**
 * A run summary as words. Older agents stored a reply that was only a tool call the model wrote
 * as text (`{"name": "git_status", "arguments": …`, often cut off): that reads as "Ran git status".
 * Mirrors summarize() in src/apps/ide/bots.ts, which now does this when the run ends.
 */
export function readableSummary(summary: string | undefined): string {
  const s = (summary ?? "").trim();
  const t = s.replace(/^```\w*\s*/, "").trim();
  if (!/^[[{]/.test(t)) return s;
  const names = [...new Set([...t.matchAll(/"(?:name|tool|function)"\s*:\s*"([\w.-]{1,64})"/g)].map((m) => m[1]))];
  if (!names.length) return s;
  const words = names.map((n) => n.replace(/[_.-]+/g, " ").trim());
  return `Ran ${words.length > 3 ? `${words.slice(0, 3).join(", ")} and ${words.length - 3} more` : words.join(", ")}`;
}

/** The one line under a bot's name in the sidebar: what it is doing or last did. */
export function botStatusLine(bot: Bot, now = Date.now()): string {
  switch (bot.status) {
    case "needs_approval": {
      const p = bot.pending[0];
      const what = p ? (p.tool === "run_shell" && typeof p.args.command === "string" ? `run \`${p.args.command}\`` : p.tool.replace(/_/g, " ")) : "a tool call";
      return `Needs approval: ${what}`;
    }
    case "running":
      return bot.activity && !/^(Auto|Compute): /.test(bot.activity) ? `Working: ${bot.activity}` : "Working…";
    case "over_budget":
      return "Paused: today's budget is spent";
    case "paused":
      if (bot.stuck) return `Stuck: same result ${bot.stuck.runs} runs in a row`;
      return bot.lastRun?.summary ? `Paused · ${readableSummary(bot.lastRun.summary)}` : "Paused";
    case "error":
      return readableSummary(bot.lastRun?.summary) || "Last run failed";
    default:
      if (bot.lastRun?.summary) return readableSummary(bot.lastRun.summary);
      if (bot.nextRun) return bot.nextRun.atMs <= now + 30_000 ? "Starting work…" : `First run ${relativeTime(bot.nextRun.atMs, now)}`;
      if (bot.nextRunAtMs) return `First run ${relativeTime(bot.nextRunAtMs, now)}`;
      return "Message it to get it started";
  }
}

export const RUN_STATUS_TEXT: Record<BotRunStatus, string> = {
  running: "Running",
  needs_approval: "Needs approval",
  done: "Done",
  failed: "Failed",
  budget: "Budget spent",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

/**
 * A stored run reply as a chat turn. A call that asked for approval and has no result is only
 * still waiting when the server lists it as pending; otherwise it was answered (or the run ended).
 */
export function foldBotReply(events: IdeStreamEvent[] | undefined, pendingCallIds: string[]): AgentTurn {
  let turn: AgentTurn = { text: "", toolEvents: [] };
  for (const e of events ?? []) turn = applyAgentEvent(turn, e).turn;
  const pending = new Set(pendingCallIds);
  turn.toolEvents = turn.toolEvents.map((e) =>
    e.type === "tool_call" && e.approval_status === "pending" && !pending.has(e.id ?? "") ? { ...e, approval_status: e.error ? "rejected" : "approved" } : e,
  );
  return turn;
}

/** How much of one bot reply the page renders as markdown (the same cap as every chat view). */
export { MAX_MARKDOWN as MAX_SHOWN_REPLY, TRIMMED_TEXT as REPLY_TRIMMED_TEXT, capMarkdownSource as shownReplyText } from "./markdown";

/**
 * The runs list as the page shows it: the history, reconciled with the bot's last run (it comes
 * with every poll of the bots list, so it is fresher, and it is there before the history loads).
 */
export function reconcileRuns(history: BotRun[], lastRun: BotRun | undefined): BotRun[] {
  if (!lastRun) return history;
  const i = history.findIndex((r) => r.id === lastRun.id);
  if (i < 0) return [lastRun, ...history];
  return history.map((r, k) => (k === i ? lastRun : r));
}

/** The pull requests a run's tool events opened (for the PR card). */
export function prCards(events: Array<{ type: string; id?: string; tool?: string; args?: Record<string, unknown>; result?: string; error?: string }>): Array<{ id: string; url: string; number: number; title: string; branch: string; base: string }> {
  const out: Array<{ id: string; url: string; number: number; title: string; branch: string; base: string }> = [];
  for (const e of events) {
    if (e.type !== "tool_call" || e.tool !== "open_pull_request" || e.error) continue;
    const m = /https:\/\/\S+\/pull\/(\d+)/.exec(e.result ?? "");
    if (!m) continue;
    const a = e.args ?? {};
    const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
    out.push({ id: e.id ?? m[0], url: m[0], number: Number(m[1]), title: s("title"), branch: s("branch"), base: s("base") });
  }
  return out;
}

const RUN_SOURCE_TEXT: Record<BotTriggerKind, string> = {
  schedule: "Schedule",
  message: "Message",
  manual: "Check now",
  start: "Started work",
  heartbeat: "Check-in",
  follow_up: "Follow-up",
  github: "GitHub",
};

/** The runs table's trigger column: "Check-in", "Follow-up", "Message", the GitHub event… */
export function runSourceText(r: Pick<BotRun, "trigger" | "source">): string {
  if (r.trigger === "github") return r.source ?? "GitHub";
  return RUN_SOURCE_TEXT[r.trigger] ?? "Check now";
}

export const TRIGGER_KIND_OPTIONS: Array<{ value: TriggerKind; label: string }> = [
  { value: "pr", label: "PR opened or updated" },
  { value: "ci_failed", label: "CI failed" },
  { value: "issue_labeled", label: "Issue labeled" },
];
export const CI_SCOPE_OPTIONS: Array<{ value: CiScope; label: string }> = [
  { value: "any", label: "Default branch or a PR" },
  { value: "default", label: "Default branch" },
  { value: "prs", label: "A pull request" },
];

/** A trigger in plain words: "PR opened or updated by others", "CI failed on the default branch". */
export function triggerText(t: Pick<BotTriggerConfig, "kind" | "label" | "onlyOthers" | "scope">): string {
  if (t.kind === "pr") return `PR opened or updated${t.onlyOthers !== false ? " by others" : ""}${t.label ? ` with label ${t.label}` : ""}`;
  if (t.kind === "ci_failed") return `CI failed ${t.scope === "default" ? "on the default branch" : t.scope === "prs" ? "on a PR" : "on the default branch or a PR"}`;
  return `Issue labeled ${t.label?.trim() || "…"}`;
}

/** The line under a trigger: when it last checked, or why it's waiting. */
export function triggerStatusText(st: { lastCheckedAtMs?: number; error?: string; backoffUntilMs?: number } | undefined, enabled: boolean, now = Date.now()): string {
  if (!enabled) return "Off";
  if (st?.error) return st.backoffUntilMs && st.backoffUntilMs > now ? `${st.error} Next check ${relativeTime(st.backoffUntilMs, now)}.` : st.error;
  if (st?.lastCheckedAtMs) return `Checked ${relativeTime(st.lastCheckedAtMs, now)}`;
  return "Checks GitHub every 2 minutes";
}

/**
 * Where a bot's model calls run, from its reply's events (the same served-by data the Tasks page's
 * "Where it ran" uses): "This computer (Apple M1 Max) · qwen3.5:9b · free", "Your machine (Mac) ·
 * Apple · qwen3-coder:30b · free", "Network · Datacenter GPU 2×A16 · qwen3-coder:30b · 3.4 cSats",
 * "Claude Opus 5.5 · your key". Before the first call answers, the route Auto picked
 * ("Compute: this computer · qwen3.5:9b …"). Null when nothing says yet.
 */
export function botPlacement(events: IdeStreamEvent[] | undefined, runCSats = 0): string | null {
  const list = events ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i] as { type: string; served?: Served; model?: string; where?: string; message?: string };
    if (e.type === "usage" && e.served) return placementText(e.served, e.model, runCSats);
    if (e.type === "usage" && e.where) return `${e.where}${runCSats > 0 ? ` · ${fmtCSats(runCSats)}` : ""}`;
    if (e.type === "status" && typeof e.message === "string" && /^Compute: /.test(e.message)) {
      // "Compute: this computer · qwen3.5:9b · ran on a smaller local model (no cSats) (why)" -> place and model.
      const text = e.message.replace(/^Compute: /, "").replace(/\s*\([^)]*\)\s*$/, "");
      const [place, model] = text.split(" · ");
      return [place.replace(/^\w/, (c) => c.toUpperCase()), model].filter(Boolean).join(" · ");
    }
  }
  return null;
}

const fmtCSats = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 3 })} cSats`;

function placementText(s: Served, model: string | undefined, runCSats: number): string {
  if (s.computeClass === "frontier") return `${model ? frontierName(model) : s.hardware.split(" · ")[0]} · your key`;
  const m = model && model !== "auto" ? model.replace(/^(network|mine)\//, "").replace(/^reserved\/[^/]+\//, "").replace(/@[\w.]+$/, "") : "";
  if (s.computeClass === "local") return [s.hardware, m, "free"].filter(Boolean).join(" · ");
  if (s.own) return [s.label.replace(/^your/, "Your"), hardwareShort(s).replace(/ · your machine$/, ""), m, "free"].filter(Boolean).join(" · ");
  return ["Network", hardwareShort(s), m, runCSats > 0 ? fmtCSats(runCSats) : "cSats"].filter(Boolean).join(" · ");
}
