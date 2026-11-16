// Folding the IDE agent's stream events (/v1/ide/chat) into what a chat view shows: the reply
// text and a list of tool events (calls with their results, shell output, plans). Shared by the
// full chat page and the editor's side panel.
import type { IdeStreamEvent } from "./api";
import type { ToolEvent } from "./types";
import type { CallUsage, Served } from "./served";

export interface AgentTurn {
  text: string;
  toolEvents: ToolEvent[];
  /** Checkpoint id of the turn (review / undo of its file changes). */
  turnId?: string;
  /** Project files the turn wrote, in first-write order. */
  changedFiles?: string[];
  /** cSats the turn's model calls cost, where the last one ran, and each call (machine, timings). */
  usage?: { cSats: number; where?: string; calls?: CallUsage[] };
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
      return { turn: { ...turn, text: turn.text + String(event.content ?? "") }, filesChanged: false };
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
      return { turn: { ...turn, usage: { cSats: Number(((turn.usage?.cSats ?? 0) + call.cSats).toFixed(6)), where, calls } }, filesChanged: false };
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
            { type: "shell_output", id: event.id as string, stdout: event.stdout as string, stderr: event.stderr as string, exit_code: event.exit_code as number },
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
    case "status": {
      // Auto says where each model call went ("Auto: this computer (free) · qwen3.5:9b for agent work").
      const msg = String(event.message ?? "");
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
