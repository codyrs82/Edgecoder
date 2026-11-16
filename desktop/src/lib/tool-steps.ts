// How the coding chat shows the agent's tool calls: one plain line per step ("Read index.html",
// "Edited src/app.ts", "Ran npm test"), a one-line summary for a finished turn's steps, and the
// lines an edit changes.

import { diffLines } from "./line-diff";
import type { ToolEvent } from "./types";

const VERBS: Record<string, [doing: string, done: string, noun?: string]> = {
  read_file: ["Reading", "Read", "file"],
  list_directory: ["Listing", "Listed", "folder"],
  search_files: ["Searching", "Searched", "search"],
  search_codebase: ["Searching", "Searched", "search"],
  edit_file: ["Editing", "Edited", "file"],
  write_file: ["Writing", "Wrote", "file"],
  run_shell: ["Running", "Ran", "command"],
  git_status: ["Checking", "Checked", "git"],
  git_diff: ["Diffing", "Diffed", "git"],
  git_log: ["Reading", "Read", "git"],
  git_fetch: ["Fetching", "Fetched", "git"],
  git_pull: ["Pulling", "Pulled", "git"],
  git_push: ["Pushing", "Pushed", "git"],
  git_commit: ["Committing", "Committed", "git"],
  git_branch: ["Branching", "Branched", "git"],
  open_pull_request: ["Opening", "Opened", "git"],
  github_create_pr: ["Opening", "Opened", "git"],
  github_list_prs: ["Listing", "Listed", "git"],
  github_list_issues: ["Listing", "Listed", "git"],
};

const TARGET_KEYS = ["path", "file_path", "command", "pattern", "query", "message", "branch", "title", "url"];

export type StepStatus = "pending" | "executing" | "completed" | "failed" | "rejected";

/**
 * A step's state from its events: a call that came back with an error failed (✗, the reason in its
 * details), never "completed" (✓) as if it had worked.
 */
export function toolStepStatus(e: Pick<ToolEvent, "error" | "result" | "approval_status">): StepStatus {
  if (e.approval_status === "rejected") return "rejected";
  if (e.error) return /^Tool call \S+ was rejected by the user\.$/.test(e.error) ? "rejected" : "failed";
  if (e.result !== undefined) return "completed";
  if (e.approval_status === "pending") return "pending";
  return "executing";
}

/** The first line of a failed step's error, short enough for the step's header. */
export function failureReason(error: string | undefined, max = 140): string {
  const line = (error ?? "").trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "Read" + "index.html" for a finished read_file; "Running" + "npm test" for a running command; "Listing failed" for a failed one. */
export function stepLabel(tool: string, args: Record<string, unknown>, done = true, failed = false): { verb: string; target: string } {
  const v = VERBS[tool];
  const base = tool.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const verb = failed ? `${v ? v[0] : base} failed` : v ? (done ? v[1] : v[0]) : base;
  let target = "";
  for (const k of TARGET_KEYS) {
    const val = args[k];
    if (typeof val === "string" && val.trim()) {
      target = val.trim().split("\n")[0];
      break;
    }
  }
  if (tool === "git_status") target = target || "git status";
  if (tool === "git_diff") target = target || "git diff";
  if (tool === "git_log") target = target || "git log";
  return { verb, target };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Read 2 files, edited 1 file, ran 1 command" for a turn's tool calls. */
export function summarizeSteps(events: ToolEvent[]): string {
  const calls = events.filter((e) => e.type === "tool_call");
  const files = { read: new Set<string>(), edited: new Set<string>() };
  let searches = 0;
  let commands = 0;
  let git = 0;
  let other = 0;
  for (const e of calls) {
    const path = typeof e.args?.path === "string" ? e.args.path : typeof e.args?.file_path === "string" ? e.args.file_path : "";
    switch (e.tool) {
      case "read_file":
      case "list_directory":
        files.read.add(path || String(files.read.size));
        break;
      case "edit_file":
      case "write_file":
        files.edited.add(path || String(files.edited.size));
        break;
      case "search_files":
      case "search_codebase":
        searches++;
        break;
      case "run_shell":
        commands++;
        break;
      default:
        if (e.tool && VERBS[e.tool]?.[2] === "git") git++;
        else other++;
    }
  }
  const parts: string[] = [];
  if (files.read.size) parts.push(`read ${plural(files.read.size, "file")}`);
  if (searches) parts.push(`searched ${plural(searches, "time")}`);
  if (files.edited.size) parts.push(`edited ${plural(files.edited.size, "file")}`);
  if (commands) parts.push(`ran ${plural(commands, "command")}`);
  if (git) parts.push(plural(git, "git step"));
  if (other) parts.push(plural(other, "other step"));
  const failed = calls.filter((e) => toolStepStatus(e) === "failed").length;
  if (failed) parts.push(`${failed} failed`);
  const text = parts.join(", ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "No steps";
}

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}

/** The lines an edit_file call changes (old_string to new_string), or a write's new content. */
export function editDiff(tool: string, args: Record<string, unknown>, maxLines = 200): DiffLine[] | null {
  if (tool === "write_file" && typeof args.content === "string") {
    return args.content.replace(/\n$/, "").split("\n").slice(0, maxLines).map((text) => ({ kind: "add", text }));
  }
  if (tool !== "edit_file") return null;
  const before = typeof args.old_string === "string" ? args.old_string : typeof args.old_text === "string" ? args.old_text : null;
  const after = typeof args.new_string === "string" ? args.new_string : typeof args.new_text === "string" ? args.new_text : null;
  if (before === null || after === null) return null;
  const a = before.split("\n");
  const b = after.split("\n");
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const h of diffLines(a, b)) {
    while (i < h.oldStart && j < h.newStart) out.push({ kind: "ctx", text: a[i++] }), j++;
    for (const t of h.oldLines) out.push({ kind: "del", text: t }), i++;
    for (let k = 0; k < h.newCount; k++) out.push({ kind: "add", text: b[j++] });
  }
  while (i < a.length && j < b.length) out.push({ kind: "ctx", text: a[i++] }), j++;
  return out.slice(0, maxLines);
}
