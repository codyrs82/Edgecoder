// Persistent bots (:4304 /v1/ide/bots): types mirroring src/apps/ide/bots.ts and the pure helpers
// the sidebar and the bot page use (avatar, status line, schedule text, folding a run's events).
import { applyAgentEvent, type AgentTurn } from "./agent-events";
import type { IdeStreamEvent } from "./api";

export type BotStatus = "idle" | "running" | "needs_approval" | "paused" | "over_budget" | "error";
export type BotRunStatus = "running" | "needs_approval" | "done" | "failed" | "budget" | "cancelled" | "interrupted";

export interface BotRun {
  id: string;
  trigger: "schedule" | "manual" | "message";
  startedAtMs: number;
  endedAtMs?: number;
  status: BotRunStatus;
  summary: string;
  cSats: number;
  where?: string;
  error?: string;
}

export interface BotPendingCall {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface Bot {
  id: string;
  name: string;
  role: string;
  instructions: string;
  projectRoot: string;
  enabled: boolean;
  schedule: string;
  budgetCSatsPerDay: number | null;
  allowedTools: string[];
  autoApproveEdits: boolean;
  color: string;
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
  enabled?: boolean;
  schedule?: string;
  budgetCSatsPerDay?: number | null;
  allowedTools?: string[];
  autoApproveEdits?: boolean;
  color?: string;
}

/** Read-only tools every bot has; the form toggles the rest. */
export const BOT_READ_TOOLS = ["read_file", "list_directory", "search_files", "search_codebase", "git_status", "git_diff", "git_log", "git_fetch", "github_list_prs", "github_list_issues"];
export const BOT_TOOL_GROUPS: Array<{ id: string; title: string; desc: string; tools: string[] }> = [
  { id: "edit", title: "Edit files", desc: "Write and edit files inside its project folder.", tools: ["write_file", "edit_file"] },
  { id: "shell", title: "Run commands", desc: "Tests, builds, scripts. Each command asks you first.", tools: ["run_shell"] },
  { id: "git", title: "Commit and push", desc: "Commits and pushes ask you first.", tools: ["git_commit", "git_push"] },
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
      return bot.activity && !bot.activity.startsWith("Auto: ") ? `Working: ${bot.activity}` : "Working…";
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
