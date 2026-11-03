// Persistent bots (:4304 /v1/ide/bots): types mirroring src/apps/ide/bots.ts and the pure helpers
// the sidebar and the bot page use (avatar, status line, schedule text, folding a run's events).
import { applyAgentEvent, type AgentTurn } from "./agent-events";
import type { IdeStreamEvent } from "./api";

export type BotStatus = "idle" | "running" | "needs_approval" | "paused" | "over_budget" | "error";
export type BotRunStatus = "running" | "needs_approval" | "done" | "failed" | "budget" | "cancelled" | "interrupted";

export interface BotPullRequest {
  url: string;
  number?: number;
  title?: string;
  branch?: string;
}

export interface BotRun {
  id: string;
  trigger: "schedule" | "manual" | "message" | "github";
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
  budgetCSatsPerDay: number | null;
  allowedTools: string[];
  autoApproveEdits: boolean;
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
  budgetCSatsPerDay?: number | null;
  allowedTools?: string[];
  autoApproveEdits?: boolean;
  compute?: BotCompute;
  color?: string;
  avatarShape?: string;
}

/** A tool call the bot asked you about, as a card in the conversation. */
export interface AskCard {
  id: string;
  question: string;
  detail?: string;
  /** null while it waits for you. */
  answer: "Allowed" | "Denied" | null;
  /** open_pull_request: what the PR will be. */
  pr?: { title: string; body: string; branch: string; base: string; diffstat: string; commits?: number; uncommitted?: number };
}

/** The approvals in a run's tool events, as cards: waiting ones have no answer yet. */
export function askCards(events: Array<{ type: string; id?: string; tool?: string; args?: Record<string, unknown>; requires_approval?: boolean; approval_status?: string }>, botName: string): AskCard[] {
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
      return { id: e.id!, question, ...(detail ? { detail } : {}), answer };
    });
}

export type ComputePolicy = "local_first" | "auto" | "local_only" | "mine_only" | "model";
export interface BotCompute {
  policy: ComputePolicy;
  /** Only for "model": a ComputePicker id ("qwen3.5:9b", "mine/...", "network/...@gpu", "reserved/<id>/..."). */
  model?: string;
}

/** The form's choices, in order; new bots start on Local first. */
export const COMPUTE_POLICY_OPTIONS: Array<{ value: ComputePolicy; title: string; desc: string }> = [
  { value: "local_first", title: "Local first", desc: "This computer, then your machines, then the network within the daily budget." },
  { value: "auto", title: "Auto", desc: "The cheapest place that fits each step, network included (within the budget)." },
  { value: "local_only", title: "This computer only", desc: "Never leaves this computer. Free." },
  { value: "mine_only", title: "My machines only", desc: "This computer and your other machines. Free, never the network." },
  { value: "model", title: "Specific model", desc: "Always the model you pick below." },
];
export const DEFAULT_COMPUTE: BotCompute = { policy: "local_first" };

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
  { value: "", label: "No schedule (run when asked)" },
  { value: "every 30 minutes", label: "Every 30 minutes" },
  { value: "hourly", label: "Every hour" },
  { value: "every 6 hours", label: "Every 6 hours" },
  { value: "daily at 09:00", label: "Daily at 09:00" },
  { value: "0 9 * * 1-5", label: "Weekdays at 09:00" },
];

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
  return COMPUTE_POLICY_OPTIONS.find((o) => o.value === c.policy)?.title ?? "Auto";
}

/** The status chip in the bot header. */
export function statusChip(bot: Pick<Bot, "status">): { text: string; tone: "muted" | "accent" | "warn" | "err" } {
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
      return bot.lastRun?.summary ? `Paused · ${bot.lastRun.summary}` : "Paused";
    case "error":
      return bot.lastRun?.summary || "Last run failed";
    default:
      if (bot.lastRun?.summary) return bot.lastRun.summary;
      if (bot.nextRunAtMs) return `First run ${relativeTime(bot.nextRunAtMs, now)}`;
      return "Message it or press Run now";
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

/** The runs table's trigger column: "Schedule", "Run now", "Message" or the GitHub event. */
export function runSourceText(r: Pick<BotRun, "trigger" | "source">): string {
  if (r.trigger === "github") return r.source ?? "GitHub";
  return r.trigger === "schedule" ? "Schedule" : r.trigger === "message" ? "Message" : "Run now";
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
