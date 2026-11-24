// Folding the IDE agent's stream events (/v1/ide/chat) into what a chat view shows: the reply
// text and a list of tool events (calls with their results, shell output, plans). Shared by the
// full chat page and the editor's side panel.
import type { IdeStreamEvent } from "./api";
import type { ToolEvent } from "./types";
import type { CallUsage, Served } from "./served";
import { isWebStatus, webUsageOf, type WebUsage } from "./web-tool";

export interface AgentTurn {
  text: string;
  toolEvents: ToolEvent[];
  /** Checkpoint id of the turn (review / undo of its file changes). */
  turnId?: string;
  /** Project files the turn wrote, in first-write order. */
  changedFiles?: string[];
  /** cSats the turn's model calls cost, where the last one ran, each call (machine, timings), and USD on your own frontier key. */
  usage?: { cSats: number; where?: string; calls?: CallUsage[]; usd?: number };
  /** The web tool's running total and numbered sources (docs/web-tool.md). */
  web?: WebUsage;
  /** What it's doing right now, when that's the web tool ("Searching the web…", "Reading example.com…"). */
  activity?: string;
  /** Web was wanted (Auto) but not offered for this reply: "needs_csats", "rate_limited" or "unreachable". */
  webOff?: { reason: string; message: string };
  /** Estimated prompt tokens of the turn's latest model call (the context meter). */
  contextTokens?: number;
  /** Tokens saved by compacting older messages during this turn (context-budget.ts). */
  compactedTokens?: number;
  /**
   * One-line cost notes for this reply (cost-guard.ts, turn-waste.ts): re-reads skipped and tokens
   * saved, what was done about waste, a cheaper model that may fit better.
   */
  costNotes?: string[];
}

/** Tools whose successful result means files in the project changed. */
const WRITE_TOOLS = new Set(["write_file", "edit_file", "run_shell", "git_commit", "git_branch", "git_pull"]);

/**
 * Apply one event; returns the new turn and whether project files may have changed (a write
 * tool finished), so an open editor can reload them.
 */
export function applyAgentEvent(turn: AgentTurn, event: IdeStreamEvent): { turn: AgentTurn; filesChanged: boolean } {
  switch (event.type) {
    case "text":
      return { turn: { ...turn, text: turn.text + String(event.content ?? ""), ...(turn.activity ? { activity: undefined } : {}) }, filesChanged: false };
    case "tool_call":
      return {
        turn: {
          ...turn,
          toolEvents: [
            ...turn.toolEvents,
            {
              type: "tool_call",
              id: event.id as string,
              tool: event.tool as string,
              args: event.args as Record<string, unknown>,
              requires_approval: event.requires_approval as boolean,
              ...(typeof event.allow_rule === "string" ? { allow_rule: event.allow_rule } : {}),
              ...(Array.isArray(event.allow_rules) ? { allow_rules: (event.allow_rules as unknown[]).filter((r): r is string => typeof r === "string") } : {}),
              ...(event.web_guard === true ? { web_guard: true } : {}),
              ...(typeof event.runs_edited === "string" ? { runs_edited: event.runs_edited } : {}),
              ...(event.sandboxed === true ? { sandboxed: true } : {}),
              ...(typeof event.sandbox_retry === "string" ? { sandbox_retry: event.sandbox_retry } : {}),
              ...(typeof event.allow_session === "string" && event.allow_session && event.web_guard !== true ? { allow_session: event.allow_session } : {}),
              ...(typeof event.session_allowed === "string" && event.session_allowed ? { session_allowed: event.session_allowed } : {}),
              approval_status: (event.requires_approval ? "pending" : "approved") as "pending" | "approved",
            },
          ],
        },
        filesChanged: false,
      };
    case "tool_result": {
      const idx = turn.toolEvents.findIndex((e) => e.id === event.id);
      if (idx < 0) return { turn, filesChanged: false };
      const call = turn.toolEvents[idx];
      const toolEvents = [...turn.toolEvents];
      toolEvents[idx] = { ...call, result: event.result as string | undefined, error: event.error as string | undefined };
      return { turn: { ...turn, toolEvents }, filesChanged: !event.error && WRITE_TOOLS.has(call.tool ?? "") };
    }
    case "turn":
      return { turn: { ...turn, turnId: String(event.id) }, filesChanged: false };
    case "usage": {
      const cSats = Number(event.cSats ?? 0);
      const where = typeof event.where === "string" ? event.where : turn.usage?.where;
      const call: CallUsage = { cSats: Number.isFinite(cSats) ? cSats : 0, ...(where ? { where } : {}), ...(typeof event.model === "string" ? { model: event.model } : {}), ...(event.served && typeof event.served === "object" ? { served: event.served as Served } : {}) };
      const calls = [...(turn.usage?.calls ?? []), call].slice(-50);
      const usd = typeof event.usd === "number" && Number.isFinite(event.usd) ? Number(((turn.usage?.usd ?? 0) + event.usd).toFixed(6)) : turn.usage?.usd;
      return { turn: { ...turn, usage: { cSats: Number(((turn.usage?.cSats ?? 0) + call.cSats).toFixed(6)), where, calls, ...(usd !== undefined ? { usd } : {}) } }, filesChanged: false };
    }
    case "file_change": {
      const path = String(event.path);
      const changed = turn.changedFiles ?? [];
      return { turn: changed.includes(path) ? turn : { ...turn, changedFiles: [...changed, path] }, filesChanged: true };
    }
    case "shell_output":
      return {
        turn: {
          ...turn,
          toolEvents: [
            ...turn.toolEvents,
            {
              type: "shell_output", id: event.id as string, stdout: event.stdout as string, stderr: event.stderr as string, exit_code: event.exit_code as number,
              ...(event.sandboxed === true ? { sandboxed: true } : {}),
              ...(typeof event.sandbox_denied === "string" ? { sandbox_denied: event.sandbox_denied } : {}),
            },
          ],
        },
        // A command may have changed files (not tracked by checkpoints): reload what's open.
        filesChanged: true,
      };
    case "plan":
      return {
        turn: { ...turn, toolEvents: [...turn.toolEvents, { type: "plan", steps: event.steps as ToolEvent["steps"], plan_status: event.status as string }] },
        filesChanged: false,
      };
    case "web": {
      const web = webUsageOf(event);
      return { turn: web ? { ...turn, web, activity: undefined } : turn, filesChanged: false };
    }
    case "context": {
      const tokens = Number(event.tokens);
      return { turn: Number.isFinite(tokens) && tokens > 0 ? { ...turn, contextTokens: tokens } : turn, filesChanged: false };
    }
    case "compacted": {
      const saved = Number(event.savedTokens);
      return { turn: Number.isFinite(saved) && saved > 0 ? { ...turn, compactedTokens: (turn.compactedTokens ?? 0) + saved } : turn, filesChanged: false };
    }
    case "cost_note": {
      const msg = String(event.message ?? "").trim();
      return { turn: msg ? { ...turn, costNotes: [...(turn.costNotes ?? []), msg].slice(-5) } : turn, filesChanged: false };
    }
    case "web_off":
      return { turn: { ...turn, webOff: { reason: String(event.reason ?? ""), message: String(event.message ?? "") } }, filesChanged: false };
    case "status": {
      // Auto says where each model call went ("Auto: this computer (free) · qwen3.5:9b for agent work").
      const msg = String(event.message ?? "");
      if (isWebStatus(msg)) return { turn: { ...turn, activity: msg }, filesChanged: false };
      return msg.startsWith("Auto: ") ? { turn: { ...turn, usage: { ...turn.usage, cSats: turn.usage?.cSats ?? 0, where: msg.slice(6) } }, filesChanged: false } : { turn, filesChanged: false };
    }
    default:
      return { turn, filesChanged: false };
  }
}

/** Mark an approval decision on a pending tool call. */
export function markApproval(events: ToolEvent[], id: string, approved: boolean): ToolEvent[] {
  return events.map((e) => (e.id === id ? { ...e, approval_status: approved ? "approved" : "rejected" } : e));
}
