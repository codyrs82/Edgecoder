// The web-page guard per permission mode, "Allow for the rest of this run", and "Always allow"
// rules for command lines (agent-loop.ts makeToolRunner, permission-policy.ts suggestRules).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeToolRunner, type ApprovalAnswer, type ApprovalAsk } from "../../src/apps/ide/agent-loop.js";
import { editKey, runsEditedFile } from "../../src/apps/ide/edited-runs.js";
import { classifyCommand, decideToolCall, suggestRules, suggestToolRules } from "../../src/apps/ide/permission-policy.js";
import { splitCommand, type PermissionMode } from "../../src/apps/ide/permissions.js";
import type { IdeStreamEvent, ToolName } from "../../src/apps/ide/tool-types.js";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "web-guard-"));
  mkdirSync(join(root, "tools"));
  mkdirSync(join(root, "market-notes"));
  writeFileSync(join(root, "tools", "watchlist.py"), "print('ok')\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Trader Boy's calls (an Auto-mode bot that reads market pages).
const WATCHLIST = 'python3 tools/watchlist.py SPY 2>&1 | head -20; echo "exit=$?"';
const RULE = "python3 tools/watchlist.py:*";

function setup(mode: PermissionMode, answers: ApprovalAnswer[] = [], rules: string[] = []) {
  const events: IdeStreamEvent[] = [];
  const asks: Array<{ tool: ToolName; args: Record<string, unknown>; ask: ApprovalAsk }> = [];
  const executed: Array<{ tool: ToolName; approved: boolean }> = [];
  const runTool = makeToolRunner({
    execute: async (tool, _args, opts) => {
      executed.push({ tool, approved: opts.approved });
      return { result: `ran ${tool}` };
    },
    sendEvent: (e) => events.push(e),
    waitForApproval: vi.fn(async (_id, tool, args, ask) => {
      asks.push({ tool, args, ask });
      return answers.shift() ?? false;
    }),
    captureBeforeWrite: () => null,
    turnId: "t1",
    decide: (tool, args) => decideToolCall(tool, args, { mode, root, rules, branch: () => "main" }),
  });
  const lastCall = () => events.filter((e) => e.type === "tool_call").at(-1) as Extract<IdeStreamEvent, { type: "tool_call" }>;
  return { runTool, events, asks, executed, lastCall };
}

const edit = (path: string) => ({ path, old_string: "a", new_string: "b" });

describe("after a web page read: edits the mode applies inside the project still apply", () => {
  it.each(["auto", "auto-edits"] as PermissionMode[])("%s: edits and writes in the project run without asking", async (mode) => {
    const r = setup(mode);
    await r.runTool("read_page", { url: "https://markets.example/" });
    expect(await r.runTool("edit_file", edit("market-notes/2026-11-24.md"))).toBe("ran edit_file");
    expect(await r.runTool("write_file", { path: "portfolio.md", content: "# Portfolio" })).toBe("ran write_file");
    expect(r.asks).toHaveLength(0);
    // Edits never count as approved for the executor (it still guards protected paths itself).
    expect(r.executed.filter((e) => e.tool !== "read_page").every((e) => !e.approved)).toBe(true);
  });

  it("still asks (or refuses) for protected paths, secrets and files outside the project", async () => {
    const r = setup("auto");
    await r.runTool("read_page", { url: "https://markets.example/" });
    await r.runTool("write_file", { path: ".husky/pre-commit", content: "x" });
    await r.runTool("edit_file", edit("../elsewhere.md"));
    expect(r.asks.map((a) => a.tool)).toEqual(["write_file", "edit_file"]);
    // These ask because of the mode, not the guard: no "Allow for the rest of this run".
    expect(r.asks.every((a) => !a.ask.webGuard)).toBe(true);
    expect(await r.runTool("write_file", { path: ".env", content: "X=1" })).toMatch(/^\[Refused\]/);
  });

  it("Manual still asks for every edit (the mode asks, not the guard)", async () => {
    // Manual asks for the page read itself too.
    const r = setup("ask", [true]);
    await r.runTool("read_page", { url: "https://markets.example/" });
    await r.runTool("edit_file", edit("market-notes/2026-11-24.md"));
    expect(r.asks.map((a) => [a.tool, a.ask.webGuard])).toEqual([["read_page", false], ["edit_file", false]]);
    expect(r.lastCall().web_guard).toBeUndefined();
  });
});

describe("after a web page read: commands ask, and one answer can lift the guard for the run", () => {
  it("a command Auto runs asks, marked as the guard's ask", async () => {
    const r = setup("auto");
    await r.runTool("read_page", { url: "https://markets.example/" });
    expect(await r.runTool("run_shell", { command: "npm test" })).toMatch(/rejected by the user/);
    expect(r.asks[0].ask.webGuard).toBe(true);
    expect(r.lastCall()).toMatchObject({ requires_approval: true, web_guard: true });
  });

  it('"Allow for the rest of this run" lets later guard asks run, but never what the mode asks about', async () => {
    const r = setup("auto", ["run"], [RULE]);
    await r.runTool("read_page", { url: "https://markets.example/" });
    expect(await r.runTool("run_shell", { command: WATCHLIST })).toBe("ran run_shell");
    expect(await r.runTool("run_shell", { command: "npm test" })).toBe("ran run_shell");
    expect(await r.runTool("run_shell", { command: "python3 tools/watchlist.py QQQ" })).toBe("ran run_shell");
    expect(r.asks).toHaveLength(1);
    // Commands the mode lets run count as approved for the executor's shell policy.
    expect(r.executed.filter((e) => e.tool === "run_shell").every((e) => e.approved)).toBe(true);
    // A command Auto itself asks about still asks, and so does git push.
    expect(await r.runTool("run_shell", { command: "python3 tools/other.py" })).toMatch(/rejected/);
    expect(await r.runTool("git_push", {})).toMatch(/rejected/);
    expect(r.asks.slice(1).map((a) => a.ask.webGuard)).toEqual([false, false]);
  });

  it("a plain Allow (or Always allow) answers one call: the next guard ask asks again", async () => {
    const r = setup("auto", [true, true]);
    await r.runTool("read_page", { url: "https://markets.example/" });
    await r.runTool("run_shell", { command: "npm test" });
    await r.runTool("run_shell", { command: "npm test" });
    expect(r.asks.map((a) => a.ask.webGuard)).toEqual([true, true]);
  });

  it('"run" on an ask the mode made lifts nothing', async () => {
    const r = setup("auto", ["run"]);
    await r.runTool("read_page", { url: "https://markets.example/" });
    await r.runTool("run_shell", { command: "python3 tools/other.py" });
    await r.runTool("run_shell", { command: "npm test" });
    expect(r.asks.map((a) => a.ask.webGuard)).toEqual([false, true]);
  });

  it("the allowance ends with the run: a new runner guards again", async () => {
    const first = setup("auto", ["run"]);
    await first.runTool("read_page", { url: "https://markets.example/" });
    await first.runTool("run_shell", { command: "npm test" });
    const next = setup("auto");
    await next.runTool("read_page", { url: "https://markets.example/" });
    await next.runTool("run_shell", { command: "npm test" });
    expect(next.asks[0].ask.webGuard).toBe(true);
  });

  it("a mode ask keeps offering its Always allow rule after a page read", async () => {
    const r = setup("auto");
    await r.runTool("read_page", { url: "https://markets.example/" });
    await r.runTool("run_shell", { command: "python3 tools/watchlist.py --md" });
    expect(r.lastCall()).toMatchObject({ requires_approval: true, allow_rule: RULE });
    expect(r.lastCall().web_guard).toBeUndefined();
  });
});

describe("Full access skips the web-page guard", () => {
  it("runs commands, edits, commits and pushes after a page read, counted as approved", async () => {
    const r = setup("full");
    await r.runTool("read_page", { url: "https://markets.example/" });
    for (const [tool, args] of [
      ["run_shell", { command: WATCHLIST }],
      ["edit_file", edit("src/a.ts")],
      ["write_file", { path: ".husky/pre-commit", content: "x" }],
      ["git_commit", { message: "notes" }],
      ["git_push", {}],
    ] as Array<[ToolName, Record<string, unknown>]>) {
      expect(await r.runTool(tool, args)).toBe(`ran ${tool}`);
    }
    expect(r.asks).toHaveLength(0);
    expect(r.executed.filter((e) => e.tool !== "read_page").every((e) => e.approved)).toBe(true);
  });

  it("keeps the hard refusals", async () => {
    const r = setup("full");
    await r.runTool("read_page", { url: "https://markets.example/" });
    expect(await r.runTool("run_shell", { command: "sudo rm -rf /var/lib" })).toMatch(/^\[Refused\]: Full access still refuses/);
    expect(await r.runTool("write_file", { path: ".env", content: "X=1" })).toMatch(/^\[Refused\]/);
  });
});

describe("Always allow for command lines", () => {
  it("splits at |, ;, && and || but keeps 2>&1 and &> inside their part", () => {
    expect(splitCommand(WATCHLIST)?.map((p) => p.text)).toEqual(["python3 tools/watchlist.py SPY 2>&1", "head -20", 'echo "exit=$?"']);
    expect(splitCommand("npm test &> out.log")?.map((p) => p.text)).toEqual(["npm test &> out.log"]);
    expect(splitCommand("npm test & ls")?.map((p) => p.op)).toEqual(["&", ""]);
  });

  it("Trader Boy's command offers one rule for its script; head and echo need none", () => {
    expect(suggestRules(WATCHLIST, { root })).toEqual([RULE]);
    expect(decideToolCall("run_shell", { command: WATCHLIST }, { mode: "auto", root })).toMatchObject({ action: "ask", rule: RULE });
    expect(suggestRules("python3 tools/watchlist.py --md", { root })).toEqual([RULE]);
  });

  it.each(["auto", "ask", "auto-edits"] as PermissionMode[])("%s: the kept rule covers the line and the plain command", (mode) => {
    const ctx = { mode, root, rules: [RULE] };
    expect(decideToolCall("run_shell", { command: WATCHLIST }, ctx).action).toBe("run");
    expect(decideToolCall("run_shell", { command: "python3 tools/watchlist.py --md" }, ctx).action).toBe("run");
    expect(decideToolCall("run_shell", { command: "python3 tools/watchlist.py QQQ 2>/dev/null | tail -5 | sort | wc -l" }, ctx).action).toBe("run");
    expect(decideToolCall("run_shell", { command: "python3 tools/other.py | head" }, ctx).action).toBe("ask");
  });

  it("keeps one simple rule per non-trivial part", () => {
    expect(suggestRules("npm run gen && python3 tools/watchlist.py | grep SPY", { root })).toEqual(["npm run gen:*", RULE]);
    const v = decideToolCall("run_shell", { command: "npm run gen && python3 tools/watchlist.py | grep SPY" }, { mode: "ask", root });
    expect(v).toMatchObject({ action: "ask", rule: "npm run gen:*", rules: ["npm run gen:*", RULE] });
    expect(suggestToolRules("run_shell", { command: "npm run gen; python3 tools/watchlist.py" }, { root })).toEqual(["npm run gen:*", RULE]);
    // Covered only when every part is.
    expect(decideToolCall("run_shell", { command: "npm run gen && python3 tools/watchlist.py" }, { mode: "ask", root, rules: [RULE] }).action).toBe("ask");
    expect(decideToolCall("run_shell", { command: "npm run gen && python3 tools/watchlist.py" }, { mode: "ask", root, rules: [RULE, "npm run gen:*"] }).action).toBe("run");
  });

  it("a plain interpreter rule names the script, not every script", () => {
    expect(suggestRules("python3 tools/watchlist.py", { root })).toEqual([RULE]);
    expect(suggestRules("node scripts/build.mjs --fast", { root })).toEqual(["node scripts/build.mjs:*"]);
    expect(suggestRules("python3 ../outside/x.py", { root })).toBeNull();
  });

  // Built at runtime so the repo-wide pipe-to-shell scan stays strict.
  const pipe = (...parts: string[]) => parts.join(" | ");
  it.each([
    ["command substitution", "python3 tools/watchlist.py $(cat tickers.txt)"],
    ["backticks", "python3 tools/watchlist.py `cat tickers.txt`"],
    ["eval", "eval python3 tools/watchlist.py; echo done"],
    ["source", "source tools/env.sh && python3 tools/watchlist.py"],
    ["a redirect outside the project", "python3 tools/watchlist.py > /tmp/out.txt"],
    ["a redirect into the parent folder", "python3 tools/watchlist.py 2>&1 > ../out.txt"],
    ["a redirect inside the project", "python3 tools/watchlist.py > notes.txt"],
    ["a pipe into sh", pipe("python3 tools/watchlist.py", "sh")],
    ["a pipe into bash -s", pipe("python3 tools/watchlist.py", "bash -s")],
    ["a pipe into env sh", pipe("python3 tools/watchlist.py", "env sh")],
    ["a pipe into python -c", pipe("python3 tools/watchlist.py", "python -c 'import sys'")],
    ["a pipe into a bare python3", pipe("python3 tools/watchlist.py", "python3")],
    ["a pipe into xargs", pipe("python3 tools/watchlist.py", "xargs rm")],
    ["the network", "python3 tools/watchlist.py && curl https://x.example"],
    ["a background job", "python3 tools/watchlist.py & echo hi"],
    ["a variable", 'python3 tools/watchlist.py "$TICKER"'],
  ])("never for %s", (_why, command) => {
    expect(suggestRules(command, { root })).toBeNull();
    for (const mode of ["auto", "ask"] as PermissionMode[]) {
      const v = decideToolCall("run_shell", { command }, { mode, root, rules: [RULE, "sh:*", "bash:*", "python:*", "python3:*", "eval:*", "source:*", "xargs:*", "curl:*"] });
      expect(v.action).not.toBe("run");
      expect(v.rule).toBeUndefined();
    }
  });

  it("a shell fed a file on stdin can't be kept either", () => {
    expect(classifyCommand("bash < tools/setup.sh", { root }).category).toBe("inline");
    expect(suggestRules("bash < tools/setup.sh", { root })).toBeNull();
  });

  it("2>&1 no longer reads as a background job", () => {
    expect(classifyCommand("npm test 2>&1 | tail -5", { root })).toMatchObject({ action: "run", category: "dev" });
  });
});

describe("the run-wide allowance never covers running a file this run changed", () => {
  const ed = (...paths: string[]) => new Set(paths);
  it.each([
    ["tools/watchlist.py", "python3 tools/watchlist.py SPY"],
    ["tools/watchlist.py", "python3 ./tools/watchlist.py 2>&1 | head -20"],
    ["scripts/run.sh", "./scripts/run.sh --fast"],
    ["scripts/run.sh", "bash -e scripts/run.sh"],
    ["x.sh", "source x.sh && npm test"],
    ["src/gen.js", "nice -n 5 node src/gen.js"],
    ["Makefile", "make build"],
    ["mk/rules.mk", "make"],
    ["package.json", "npm run report"],
    ["package.json", "npx some-bin"],
    ["Cargo.toml", "cargo build"],
    ["conftest.py", "pytest -q"],
    ["vitest.config.ts", "npx vitest run"],
  ])("after editing %s: %s", (path, command) => {
    expect(runsEditedFile("run_shell", { command }, ed(editKey(path)!))).toBe(editKey(path));
  });

  it.each([
    ["tools/watchlist.py", "python3 tools/other.py"],
    ["tools/watchlist.py", "cat tools/watchlist.py"],
    ["market-notes/2026-11-24.md", "python3 tools/watchlist.py --md"],
    ["portfolio.md", "make report"],
    ["package.json", "make build"],
    ["Makefile", "npm test"],
    ["pyproject.toml", "python3 tools/watchlist.py"],
  ])("after editing %s: %s is not running it", (path, command) => {
    expect(runsEditedFile("run_shell", { command }, ed(editKey(path)!))).toBeNull();
  });

  it("only shell commands can run one", () => {
    expect(runsEditedFile("git_commit", { message: "x" }, ed("Makefile"))).toBeNull();
    expect(runsEditedFile("run_shell", { command: "make" }, ed())).toBeNull();
  });

  it("after a page read and the allowance, an edited script still asks, without the run-wide answer", async () => {
    const r = setup("auto", ["run", true], [RULE]);
    await r.runTool("read_page", { url: "https://markets.example/" });
    // The allowance is given on a plain guard ask.
    await r.runTool("run_shell", { command: "npm test" });
    expect(await r.runTool("run_shell", { command: WATCHLIST })).toBe("ran run_shell");
    expect(r.asks).toHaveLength(1);
    // The run edits the script (applies on its own), then runs it: the guard asks again.
    expect(await r.runTool("edit_file", edit("tools/watchlist.py"))).toBe("ran edit_file");
    expect(await r.runTool("run_shell", { command: WATCHLIST })).toBe("ran run_shell");
    expect(r.asks).toHaveLength(2);
    expect(r.asks[1].ask.webGuard).toBe(true);
    expect(r.lastCall()).toMatchObject({ web_guard: true, runs_edited: "tools/watchlist.py" });
    // Other covered calls still go ahead.
    expect(await r.runTool("run_shell", { command: "npm test" })).toBe("ran run_shell");
    expect(r.asks).toHaveLength(2);
  });

  it('answering an edited-file ask with "run" lifts nothing', async () => {
    const r = setup("auto", ["run"], [RULE]);
    await r.runTool("edit_file", edit("tools/watchlist.py"));
    await r.runTool("read_page", { url: "https://markets.example/" });
    await r.runTool("run_shell", { command: "python3 tools/watchlist.py" });
    expect(r.lastCall()).toMatchObject({ web_guard: true, runs_edited: "tools/watchlist.py" });
    await r.runTool("run_shell", { command: "npm test" });
    expect(r.asks.map((a) => a.ask.webGuard)).toEqual([true, true]);
  });

  it("no page read means no guard at all, edited or not", async () => {
    const r = setup("auto", [], [RULE]);
    await r.runTool("edit_file", edit("tools/watchlist.py"));
    expect(await r.runTool("run_shell", { command: "python3 tools/watchlist.py" })).toBe("ran run_shell");
    expect(r.asks).toHaveLength(0);
  });
});
