import { describe, expect, it } from "vitest";
import { frontierAsk, frontierSpendLine, autoStatus, checksIn, routineText, botCompute, botInitial, botStatusLine, readableSummary, reconcileRuns, shownReplyText, MAX_SHOWN_REPLY, REPLY_TRIMMED_TEXT, botTitle, budgetText, computeText, failureNotice, foldBotReply, folderName, formatCSats, groupsOf, relativeTime, scheduleText, statusChip, toolsFor, type Bot } from "../src/lib/bots";

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

  it("a stuck bot: chip, header status and sidebar line say so; a plain pause doesn't", () => {
    const stuck = { atMs: 5, problem: "npm test: package.json not found", runs: 3 };
    const b = bot({ status: "paused", enabled: false, stuck });
    expect(statusChip(b)).toEqual({ text: "Stuck", tone: "warn" });
    // The banner has the full story; the header and the sidebar only the short status.
    expect(autoStatus(b)).toEqual({ text: "Paused · stuck", tone: "muted" });
    expect(botStatusLine(b)).toBe("Stuck");
    expect(failureNotice(b)).toMatchObject({ kind: "stuck", title: "Stuck", detail: "Paused: Harry kept hitting the same problem (npm test: package.json not found). Tell it what to do, or resume.", actions: ["edit"] });
    expect(statusChip(bot({ status: "paused", enabled: false })).text).toBe("Paused");
    expect(autoStatus(bot({ status: "paused", enabled: false })).text).toBe("Paused");
  });

  it("turns a cSats failure into a plain notice with actions", () => {
    const error = "Not enough cSats for this request (it sets aside up to 91.8 cSats; unused cSats come back).";
    const failed = bot({ status: "error", lastRun: { id: "run_9", trigger: "schedule", startedAtMs: 0, status: "failed", summary: `Failed: ${error}`, cSats: 0, error } });
    const n = failureNotice(failed)!;
    expect(n.runId).toBe("run_9");
    expect(n.detail).not.toMatch(/91\.8/);
    // Out of cSats: Buy cSats first (the primary action), then Edit budget.
    expect(n).toMatchObject({ kind: "csats", title: "Out of cSats" });
    expect(n.actions).toEqual(["buy", "budget"]);
    const broke = "Not enough cSats: your balance is 0.01 cSats (Harry's budget has 6 left today). This step needs about 0.4 cSats on a Datacenter GPU.";
    expect(failureNotice({ ...failed, lastRun: { ...failed.lastRun!, error: broke } })).toMatchObject({
      title: "Out of cSats",
      detail: "Your balance is 0.01 cSats (Harry's budget has 6 left today). This step needs about 0.4 cSats on a Datacenter GPU.",
      actions: ["buy", "budget"],
    });
    // No machine of the class: the class in the title, what's online instead, Edit compute.
    const cls = failureNotice({ ...failed, lastRun: { ...failed.lastRun!, error: "No GPU machines online. Available now: Datacenter GPU (1), Apple (2), CPU (9). Choose another compute option, or try again when one is back." } })!;
    expect(cls).toMatchObject({ kind: "class", title: "No GPU machines online", actions: ["edit"] });
    expect(cls.detail).toMatch(/^Available now: Datacenter GPU \(1\), Apple \(2\), CPU \(9\)\./);
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
    expect(botStatusLine(bot({ status: "over_budget" }))).toBe("Budget spent");
    expect(botStatusLine(bot({ status: "out_of_csats" }))).toBe("Out of cSats");
    // A failure: a short neutral status, never the error sentence.
    const failedRun = { id: "f", trigger: "schedule" as const, startedAtMs: 0, status: "failed" as const, cSats: 0, summary: "Failed: No model on the network fits this request: no agent with a model is online.", error: "No model on the network fits this request: no agent with a model is online." };
    expect(botStatusLine(bot({ status: "error", lastRun: failedRun }))).toBe("No machines of its class online");
    expect(botStatusLine(bot({ status: "error", lastRun: { ...failedRun, error: "Not enough cSats: your balance is 0 cSats." } }))).toBe("Out of cSats");
    expect(botStatusLine(bot({ status: "error", lastRun: { ...failedRun, error: "boom" } }))).toBe("Last run failed");
    const lastRun = { id: "r", trigger: "manual" as const, startedAtMs: 0, status: "done" as const, summary: "Fixed 2 tests.", cSats: 0 };
    expect(botStatusLine(bot({ lastRun }))).toBe("Fixed 2 tests.");
    expect(botStatusLine(bot({ status: "paused", lastRun }))).toBe("Paused · Fixed 2 tests.");
    expect(botStatusLine(bot({ nextRunAtMs: now + 30 * 60_000 }), now)).toBe("First run in 30 min");
    expect(botStatusLine(bot())).toBe("Message it to get it started");
    expect(botStatusLine(bot({ nextRun: { kind: "start", atMs: now } }), now)).toBe("Starting work…");
    // Raw tool-call JSON from an older run never shows in the sidebar.
    const jsonRun = { ...lastRun, summary: '{"name": "git_status", "argumen' };
    expect(botStatusLine(bot({ lastRun: jsonRun }))).toBe("Ran git status");
    expect(readableSummary('```json\n[{"name": "read_file"}, {"name": "git_diff"}]')).toBe("Ran read file, git diff");
    expect(readableSummary("{plain braces}")).toBe("{plain braces}");
  });

  it("the header says what it's doing or when it next works on its own (no Run now)", () => {
    const now = 1_000_000;
    expect(autoStatus(bot({ status: "running" }), now)).toEqual({ text: "Working…", tone: "accent" });
    expect(autoStatus(bot({ status: "running", activity: "Using read_file" }), now).text).toBe("Working: Using read_file");
    expect(autoStatus(bot({ status: "needs_approval" }), now).text).toBe("Waiting for your approval");
    expect(autoStatus(bot({ enabled: false, status: "paused", nextRun: { kind: "heartbeat", atMs: now + 60_000 } }), now).text).toBe("Paused");
    expect(autoStatus(bot({ nextRun: { kind: "heartbeat", atMs: now + 12 * 60_000 } }), now).text).toBe("Next check in 12 min");
    expect(autoStatus(bot({ nextRun: { kind: "schedule", atMs: now + 2 * 3_600_000 } }), now).text).toBe("Next run in 2 h");
    expect(autoStatus(bot({ nextRun: { kind: "follow_up", atMs: now + 2 * 60_000 } }), now).text).toBe("Continuing in 2 min");
    expect(autoStatus(bot({ nextRun: { kind: "start", atMs: now } }), now)).toEqual({ text: "Starting…", tone: "accent" });
    expect(autoStatus(bot({ held: "run_cap", maxRunsPerDay: 48 }), now)).toEqual({ text: "Daily limit of 48 runs reached · resumes tomorrow", tone: "warn" });
    expect(autoStatus(bot({ status: "over_budget" }), now).text).toBe("Budget spent · resumes tomorrow");
    expect(autoStatus(bot(), now).text).toBe("Waiting for a message");
    // A failure is the banner's to tell: the header just says what's next.
    expect(autoStatus(bot({ status: "error", nextRun: { kind: "heartbeat", atMs: now + 30 * 60_000 } }), now)).toEqual({ text: "Next check in 30 min", tone: "muted" });
    expect(autoStatus(bot({ status: "out_of_csats" }), now)).toEqual({ text: "Paused · resumes after top-up", tone: "muted" });
    expect(statusChip(bot({ status: "out_of_csats" }))).toEqual({ text: "Out of cSats", tone: "warn" });
  });

  it("check-ins: a bot with a job and no schedule checks in every 30 minutes by default", () => {
    expect(checksIn(bot({ role: "Lead Developer" }))).toBe(true);
    expect(checksIn(bot({ role: "" }))).toBe(false);
    expect(checksIn(bot({ role: "Dev", heartbeatMinutes: null }))).toBe(false);
    expect(checksIn(bot({ role: "Dev", schedule: "hourly" }))).toBe(false);
    expect(routineText(bot({ role: "Dev" }))).toBe("Checks in every 30 minutes");
    expect(routineText(bot({ role: "Dev", heartbeatMinutes: 120 }))).toBe("Checks in every 2 hours");
    expect(routineText(bot({ role: "Dev", schedule: "hourly" }))).toBe("Every hour");
    expect(routineText(bot({ role: "" }))).toBe("Works when you message it");
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
    expect(groupsOf(tools)).toEqual({ edit: true, shell: false, git: true, web: false });
    // "Search the web" only when chosen (a new bot's form starts with it chosen).
    expect(tools).not.toContain("web_search");
    const withWeb = toolsFor({ web: true });
    expect(withWeb).toEqual(expect.arrayContaining(["web_search", "read_page"]));
    expect(groupsOf(withWeb).web).toBe(true);
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

describe("the bot page's bounded views", () => {
  it("shows a long reply as its start and latest part", () => {
    expect(shownReplyText("short")).toBe("short");
    const long = "Start." + " self._cache".repeat(10_000) + "\n\nAll done.";
    const shown = shownReplyText(long);
    expect(shown.length).toBeLessThanOrEqual(MAX_SHOWN_REPLY);
    expect(shown.startsWith("Start.")).toBe(true);
    expect(shown.endsWith("All done.")).toBe(true);
    expect(shown).toContain(REPLY_TRIMMED_TEXT);
    // Text the server already trimmed keeps its own head.
    const serverTrimmed = "Head." + `\n\n${REPLY_TRIMMED_TEXT}\n\n` + "y".repeat(20_000);
    expect(shownReplyText(serverTrimmed).split(REPLY_TRIMMED_TEXT)).toHaveLength(2);
    expect(shownReplyText(serverTrimmed).startsWith("Head.")).toBe(true);
  });

  it("reconciles the runs list with the bot's last run", () => {
    const run = (id: string, status: "done" | "running" = "done") => ({ id, trigger: "schedule" as const, startedAtMs: 0, status, summary: "", cSats: 0 });
    expect(reconcileRuns([], undefined)).toEqual([]);
    expect(reconcileRuns([], run("a")).map((r) => r.id)).toEqual(["a"]);
    expect(reconcileRuns([run("b")], run("a")).map((r) => r.id)).toEqual(["a", "b"]);
    const fresher = run("b", "running");
    expect(reconcileRuns([run("b"), run("c")], fresher)).toEqual([fresher, run("c")]);
  });
});

describe("frontier lead helpers", () => {
  const ask = { callId: "fr_1", tool: "use_frontier", args: { name: "Claude", capUsd: 2, question: "Use Claude for this run? Up to $2.00." } };
  it("reads the bot's ask and says what it waits for", () => {
    expect(frontierAsk(bot())).toBeNull();
    expect(frontierAsk(bot({ pending: [ask] }))).toEqual({ callId: "fr_1", question: "Use Claude for this run? Up to $2.00.", name: "Claude", capUsd: 2 });
    expect(botStatusLine(bot({ status: "needs_approval", pending: [ask] }))).toBe("Needs your OK: use Claude");
  });
  it("the spend line: only when the lead is on or it spent something", () => {
    expect(frontierSpendLine(bot())).toBeNull();
    expect(frontierSpendLine(bot({ frontierLead: "frontier/anthropic/claude-opus-5-5" }))).toBe("Claude Opus 5.5 · $0.00 of $5.00 today");
    expect(frontierSpendLine(bot({ frontierSpentTodayUsd: 1.5, frontierDailyCapUsd: 3 }))).toBe("Your frontier key · $1.50 of $3.00 today");
  });
});
