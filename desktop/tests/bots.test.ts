import { describe, expect, it } from "vitest";
import { botCompute, botInitial, botStatusLine, botTitle, budgetText, computeText, failureNotice, foldBotReply, folderName, formatCSats, groupsOf, relativeTime, scheduleText, statusChip, toolsFor, type Bot } from "../src/lib/bots";

describe("bot header helpers", () => {
  it("status chip, folder name and compute text", () => {
    expect(statusChip(bot({ status: "error" }))).toEqual({ text: "Failed", tone: "err" });
    expect(statusChip(bot({ status: "needs_approval" })).text).toBe("Needs approval");
    expect(statusChip(bot({ status: "paused" })).text).toBe("Paused");
    expect(statusChip(bot()).text).toBe("Idle");
    expect(folderName("/Users/me/Library/CloudStorage/Dropbox/Agents/Harry the Engineer/")).toBe("Harry the Engineer");
    expect(folderName("C:\\code\\proj")).toBe("proj");
    expect(botCompute(bot())).toEqual({ policy: "auto" });
    expect(computeText({ policy: "local_first" })).toBe("Local first");
    expect(computeText({ policy: "model", model: "network/x@gpu" }, () => ({ model: "x", where: "Network GPU" }))).toBe("x · Network GPU");
  });

  it("turns a cSats failure into a plain notice with actions", () => {
    const error = "Not enough cSats for this request (it sets aside up to 91.8 cSats; unused cSats come back).";
    const failed = bot({ status: "error", lastRun: { id: "run_9", trigger: "schedule", startedAtMs: 0, status: "failed", summary: `Failed: ${error}`, cSats: 0, error } });
    const n = failureNotice(failed)!;
    expect(n.runId).toBe("run_9");
    expect(n.detail).not.toMatch(/91\.8/);
    expect(n.actions).toEqual(["buy", "local_only"]);
    expect(failureNotice({ ...failed, compute: { policy: "local_only" } })!.actions).toEqual(["buy", "edit"]);
    expect(failureNotice(bot())).toBeNull();
    expect(failureNotice(bot({ lastRun: { ...failed.lastRun!, error: "No model is installed on this computer." } }))!.actions).toEqual(["edit"]);
  });
});

const bot = (over: Partial<Bot> = {}): Bot => ({
  id: "bot_1",
  name: "Harry",
  role: "Engineer",
  instructions: "",
  projectRoot: "/tmp/p",
  enabled: true,
  schedule: "",
  budgetCSatsPerDay: 100,
  allowedTools: [],
  autoApproveEdits: true,
  color: "#0090ff",
  createdAtMs: 0,
  updatedAtMs: 0,
  status: "idle",
  spentTodayCSats: 0,
  pending: [],
  queuedMessages: 0,
  ...over,
});

describe("bots helpers", () => {
  it("avatar initial and title", () => {
    expect(botInitial("harry")).toBe("H");
    expect(botInitial("  #42 bot")).toBe("4");
    expect(botInitial("")).toBe("?");
    expect(botTitle(bot())).toBe("Harry · Engineer");
    expect(botTitle(bot({ role: " " }))).toBe("Harry");
  });

  it("status line follows what the bot is doing", () => {
    const now = 1_000_000;
    expect(botStatusLine(bot({ status: "needs_approval", pending: [{ callId: "c", tool: "run_shell", args: { command: "npm test" } }] }))).toBe("Needs approval: run `npm test`");
    expect(botStatusLine(bot({ status: "needs_approval", pending: [{ callId: "c", tool: "git_push", args: {} }] }))).toBe("Needs approval: git push");
    expect(botStatusLine(bot({ status: "running", activity: "Using read_file" }))).toBe("Working: Using read_file");
    expect(botStatusLine(bot({ status: "running", activity: "Auto: this computer" }))).toBe("Working…");
    expect(botStatusLine(bot({ status: "over_budget" }))).toBe("Paused: today's budget is spent");
    const lastRun = { id: "r", trigger: "manual" as const, startedAtMs: 0, status: "done" as const, summary: "Fixed 2 tests.", cSats: 0 };
    expect(botStatusLine(bot({ lastRun }))).toBe("Fixed 2 tests.");
    expect(botStatusLine(bot({ status: "paused", lastRun }))).toBe("Paused · Fixed 2 tests.");
    expect(botStatusLine(bot({ nextRunAtMs: now + 30 * 60_000 }), now)).toBe("First run in 30 min");
    expect(botStatusLine(bot())).toBe("Message it or press Run now");
  });

  it("schedule, time and budget text", () => {
    expect(scheduleText("")).toBe("No schedule");
    expect(scheduleText("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(scheduleText("every 2 hours")).toBe("Every 2 hours");
    expect(scheduleText("*/10 * * * *")).toBe("Cron: */10 * * * *");
    expect(relativeTime(5 * 3_600_000, 0)).toBe("in 5 h");
    expect(relativeTime(0, 2 * 86_400_000)).toBe("2 d ago");
    expect(formatCSats(0)).toBe("0");
    expect(formatCSats(1.5)).toBe("1.5");
    expect(formatCSats(1234)).toBe("1,234");
    expect(budgetText({ spentTodayCSats: 12, budgetCSatsPerDay: 100 })).toBe("12 of 100 cSats today");
    expect(budgetText({ spentTodayCSats: 3, budgetCSatsPerDay: null })).toBe("3 cSats today · no limit");
  });

  it("tool groups round-trip", () => {
    const tools = toolsFor({ edit: true, shell: false, git: true });
    expect(tools).toContain("read_file");
    expect(tools).toContain("edit_file");
    expect(tools).not.toContain("run_shell");
    expect(groupsOf(tools)).toEqual({ edit: true, shell: false, git: true });
  });

  it("folds a stored run reply; only server-pending calls still ask", () => {
    const events = [
      { type: "turn" as const, id: "run_1" },
      { type: "tool_call" as const, id: "a", tool: "run_shell", args: { command: "ls" }, requires_approval: true },
      { type: "shell_output" as const, id: "a", stdout: "x", stderr: "", exit_code: 0 },
      { type: "tool_call" as const, id: "b", tool: "git_push", args: {}, requires_approval: true },
      { type: "tool_call" as const, id: "c", tool: "run_shell", args: { command: "npm test" }, requires_approval: true },
      { type: "text" as const, content: "Working on it." },
    ];
    const turn = foldBotReply(events, ["c"]);
    expect(turn.text).toBe("Working on it.");
    expect(turn.turnId).toBe("run_1");
    const status = Object.fromEntries(turn.toolEvents.filter((e) => e.type === "tool_call").map((e) => [e.id, e.approval_status]));
    expect(status).toEqual({ a: "approved", b: "approved", c: "pending" });
  });
});
