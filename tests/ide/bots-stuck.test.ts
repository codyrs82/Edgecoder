import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotManager, agentBotRunner, type BotRunContext } from "../../src/apps/ide/bots.js";
import type { ChatFn } from "../../src/apps/ide/agent-loop.js";
import { MAX_DIGEST_CHARS, errorGist, projectCheck, runsDigest, sameOutcome, textSimilarity, type RunOutcome } from "../../src/apps/ide/bot-outcomes.js";

const dir = () => mkdtempSync(join(tmpdir(), "bots-stuck-"));
let managers: BotManager[] = [];
afterEach(async () => {
  for (const m of managers) await m.shutdown();
  managers = [];
});

const NPM = "npm test src/swarm/worker-runner.ts";
const NPM_FAIL = { stdout: "", stderr: "npm error code ENOENT\nnpm error syscall open\nnpm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/x/package.json'", exit_code: 254 };
const SUMMARY = "## Summary\n\nI tried to run the tests but package.json was not found.\n\n## Next steps\n\nI am ready to create package.json so the tests can run.";

/**
 * A bot on the real agent loop whose model asks to run `command` once a run, then writes `reply`.
 * The shell "runs" it with `shell` (default: npm's missing package.json error).
 */
function setup(opts: { command?: string; reply?: (n: number) => string; shell?: { stdout: string; stderr: string; exit_code: number }; root?: string } = {}) {
  const clock = { now: new Date(2026, 10, 16, 10, 0).getTime() };
  const systems: string[] = [];
  const executed: string[] = [];
  let runNo = 0;
  const runner = agentBotRunner({
    chat: (): ChatFn => {
      let step = 0;
      const n = ++runNo;
      return async (req, onDelta) => {
        if (step === 0) systems.push(req.messages[0].content);
        step += 1;
        if (step === 1) return { content: "", toolCalls: [{ name: "run_shell", arguments: { command: opts.command ?? NPM } }] };
        const text = opts.reply ? opts.reply(n) : SUMMARY;
        onDelta?.(text);
        return { content: text, toolCalls: [] };
      };
    },
    execute: () => async (tool, args) => {
      executed.push(String(args.command ?? tool));
      return { result: JSON.stringify(opts.shell ?? NPM_FAIL) };
    },
    systemPrompt: async () => () => "BASE",
  });
  const m = new BotManager({ runner, file: join(dir(), "bots.json"), now: () => (clock.now += 1_000), fingerprint: async () => "same" });
  managers.push(m);
  const root = opts.root ?? dir();
  const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: root, enabled: false, allowedTools: ["read_file", "run_shell"] });
  // Working on its own (the tests start its runs), checking in every 30 minutes.
  m.update(bot.id, { enabled: true });
  return { m, id: bot.id, root, clock, systems, executed };
}

/** Start a run, answer its approval (if it asks) and wait for it to end. Returns whether it asked. */
async function run(m: BotManager, id: string, trigger: "heartbeat" | "message" = "heartbeat", answer: boolean | null = true, text = "Please continue"): Promise<boolean> {
  if (trigger === "message") m.message(id, text);
  else m.runNow(id, trigger);
  let asked = false;
  for (let i = 0; i < 200 && m.isRunning(id); i++) {
    const p = m.get(id).pending[0];
    if (p) {
      asked = true;
      if (answer === null) {
        m.cancel(id);
        break;
      }
      m.approve(id, p.callId, answer);
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  await m.idle(id);
  await m.settled();
  return asked;
}

const results = (m: BotManager, id: string) => JSON.stringify(m.messages(id).filter((x) => x.role === "assistant").at(-1)?.events ?? []);

describe("working folder sanity", () => {
  it("refuses npm, git, pytest and cargo in a folder that isn't a project, and lets them run in one", () => {
    const notes = dir();
    const msg = projectCheck(NPM, notes)!;
    expect(msg).toContain(`This folder isn't a code project (no package.json). Your working folder is ${notes}.`);
    expect(msg).toMatch(/ask the user for the repository path/);
    expect(msg).toMatch(/Don't create package\.json/);
    expect(projectCheck("git status", notes)).toMatch(/no \.git/);
    expect(projectCheck("pytest -q", notes)).toMatch(/no pyproject\.toml or setup\.py/);
    expect(projectCheck("cargo test", notes)).toMatch(/no Cargo\.toml/);
    expect(projectCheck("FOO=1 npm run build", notes)).toMatch(/no package\.json/);
    // Commands that work anywhere, and ordinary commands.
    expect(projectCheck("npm init -y", notes)).toBeNull();
    expect(projectCheck("npm install -g typescript", notes)).toBeNull();
    expect(projectCheck("git clone https://github.com/a/b", notes)).toBeNull();
    expect(projectCheck("ls -la && cat notes.md", notes)).toBeNull();

    const proj = dir();
    writeFileSync(join(proj, "package.json"), "{}");
    expect(projectCheck(NPM, proj)).toBeNull();
    mkdirSync(join(proj, "src"));
    expect(projectCheck("cd src && npm test", proj)).toBeNull(); // found in a parent inside the folder
    // A subfolder that is the project.
    const outer = dir();
    mkdirSync(join(outer, "app"));
    writeFileSync(join(outer, "app", "package.json"), "{}");
    expect(projectCheck("npm test", outer)).toMatch(/no package\.json/);
    expect(projectCheck("cd app && npm test", outer)).toBeNull();
  });

  it("a bot's npm test in its notes folder isn't run or asked about; the tool result says why", async () => {
    const { m, id, root, executed } = setup();
    const asked = await run(m, id);
    expect(asked).toBe(false);
    expect(executed).toEqual([]);
    expect(results(m, id)).toContain(`isn't a code project (no package.json). Your working folder is ${root}`);
  });
});

describe("no re-asking", () => {
  it("an approved command that failed isn't asked again on its own runs; the next run's digest says it failed", async () => {
    const root = dir();
    writeFileSync(join(root, "package.json"), "{}");
    const { m, id, systems, executed } = setup({ root, shell: { stdout: "", stderr: 'npm error Missing script: "test"', exit_code: 1 } });
    expect(await run(m, id)).toBe(true);
    expect(executed).toEqual([NPM]);
    expect(m.history(id)[0].outcome?.problem).toBe(`${NPM}: Missing script: "test"`);
    expect(await run(m, id)).toBe(false);
    expect(executed).toEqual([NPM]);
    expect(results(m, id)).toContain("Not run again");
    // The second run started with what the first tried, what you answered and how it failed.
    expect(systems[1]).toContain("Your last runs (oldest first):");
    expect(systems[1]).toContain(`\`${NPM}\` (you allowed it) → failed: Missing script: "test"`);
    expect(systems[1]).toMatch(/Don't repeat an action that failed/);
    expect(systems[1]).toContain("Don't repeat (same command, same folder):");
    expect(systems[0]).not.toContain("Your last runs");
  });

  it("a command you said no to isn't asked again on its own runs; your message may ask once more", async () => {
    const root = dir();
    writeFileSync(join(root, "package.json"), "{}");
    const { m, id, systems, executed } = setup({ root, shell: { stdout: "ok", stderr: "", exit_code: 0 } });
    expect(await run(m, id, "heartbeat", false)).toBe(true);
    expect(executed).toEqual([]);
    expect(await run(m, id, "heartbeat")).toBe(false);
    expect(results(m, id)).toContain("Not asked again: the user said no");
    expect(systems[1]).toContain("(you said no)");
    // You message it (it may ask, you're there); allowed and it worked: no longer held back.
    expect(await run(m, id, "message", true, "Go ahead and run the tests")).toBe(true);
    expect(executed).toEqual([NPM]);
    expect(await run(m, id, "heartbeat")).toBe(true);
  });
});

describe("stuck-loop detection", () => {
  it("pauses after the same problem 3 runs in a row, says so, and a message clears it", async () => {
    const root = dir();
    writeFileSync(join(root, "package.json"), "{}");
    // Allowed every time and fails the same way: before, it asked every check-in.
    const { m, id } = setup({ root, shell: { stdout: "", stderr: 'npm error Missing script: "test"', exit_code: 1 }, reply: (n) => `${SUMMARY}\n\n(run ${n} at 10:${n}0)` });
    await run(m, id);
    await run(m, id);
    expect(m.get(id)).toMatchObject({ enabled: true, status: "idle" });
    expect(m.get(id).stuck).toBeUndefined();
    await run(m, id);
    const v = m.get(id);
    expect(v.enabled).toBe(false);
    expect(v.status).toBe("paused");
    expect(v.stuck).toMatchObject({ runs: 3, problem: `${NPM}: Missing script: "test"` });
    expect(v.nextRun).toBeUndefined();
    expect(m.messages(id).at(-1)).toMatchObject({ role: "event", content: expect.stringMatching(/^Paused: Harry kept hitting the same problem 3 runs in a row \(npm test .*\)\. Tell it what to do, or resume it\.$/) });
    // Nothing on its own while stuck.
    expect(m.tick(Date.now() + 10 * 3_600_000)).toEqual([]);

    // Your message clears it and it works on its own again.
    await run(m, id, "message", true, "The repo is at ~/code/edgecoder; work there.");
    const after = m.get(id);
    expect(after.stuck).toBeUndefined();
    expect(after.enabled).toBe(true);
    expect(after.auto?.stuck).toBeUndefined();
  });

  it("resuming clears it, and the runs before don't count toward the next pause", async () => {
    const { m, id } = setup();
    for (let i = 0; i < 3; i++) await run(m, id);
    expect(m.get(id).stuck?.problem).toBe(`${NPM}: not a code project (no package.json)`);
    m.update(id, { enabled: true });
    expect(m.get(id).stuck).toBeUndefined();
    expect(m.get(id).enabled).toBe(true);
    await m.idle(id);
    await m.settled();
    await run(m, id);
    expect(m.get(id).enabled).toBe(true);
  });

  it("doesn't pause for different results, quiet check-ins, or a message in between", async () => {
    const replies = ["Ran the tests: 3 failures in parser.ts.", "Fixed the parser; now auth.test.ts times out.", "All green except the flaky e2e suite."];
    const a = setup({ reply: (n) => replies[(n - 1) % 3] });
    for (let i = 0; i < 3; i++) await run(a.m, a.id);
    expect(a.m.get(a.id).enabled).toBe(true);

    const quiet = setup({ command: "ls", shell: { stdout: "notes.md", stderr: "", exit_code: 0 }, reply: () => "Nothing to do." });
    for (let i = 0; i < 4; i++) await run(quiet.m, quiet.id);
    expect(quiet.m.get(quiet.id).enabled).toBe(true);

    const b = setup();
    await run(b.m, b.id);
    await run(b.m, b.id, "message", true, "what's up?");
    await run(b.m, b.id);
    expect(b.m.get(b.id).enabled).toBe(true);
  });
});

describe("outcomes and the digest", () => {
  it("compares final messages by normalized text", () => {
    expect(textSimilarity(`${SUMMARY} (run 1 at 10:10, /Users/a/b/c)`, `${SUMMARY} (run 7 at 11:40, /Users/x/y/z)`)).toBe(1);
    expect(textSimilarity("Fixed the parser.", "All tests pass on main now.")).toBeLessThan(0.3);
    expect(errorGist(NPM_FAIL.stderr)).toBe("package.json not found");
    expect(errorGist("fatal: not a git repository (or any of the parent directories): .git")).toBe("not a git repository");
    const o = (reply: string): RunOutcome => ({ actions: [{ tool: "run_shell", key: "k", label: NPM, approval: "approved", error: "package.json not found" }], problem: `${NPM}: package.json not found`, reply });
    expect(sameOutcome(o(SUMMARY), o(SUMMARY.replace("ready", "prepared")))).toBe(true);
    expect(sameOutcome(o(SUMMARY), o("I created the project and the tests pass."))).toBe(false);
    expect(sameOutcome({ actions: [], reply: "Nothing to do." }, { actions: [], reply: "Nothing to do." })).toBe(false);
  });

  it("is truncated to its limit, keeping the newest runs and the don't-repeat list", () => {
    const runs = Array.from({ length: 12 }, (_, i) => ({
      trigger: "heartbeat",
      startedAtMs: i,
      status: "done",
      summary: "",
      outcome: { actions: [{ tool: "run_shell", key: `k${i}`, label: `npm test file-${i}.ts ${"x".repeat(200)}`, approval: "approved" as const, error: "package.json not found" }], problem: "p", reply: `Run ${i}: ${"words ".repeat(300)}` },
    }));
    const blocks = [{ key: "k", tool: "run_shell", label: NPM, kind: "failed" as const, error: "package.json not found", atMs: 1, count: 3 }];
    const d = runsDigest(runs, blocks, (ms) => `t${ms}`);
    expect(d.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
    expect(d).toContain("t11 (check-in, done)");
    expect(d).not.toContain("t0 ");
    expect(d).toContain(`\`${NPM}\`: failed (package.json not found), 3 times`);
    expect(d).toMatch(/Don't repeat an action that failed/);
    const tiny = runsDigest(runs, blocks, (ms) => `t${ms}`, 400);
    expect(tiny.length).toBeLessThanOrEqual(400);
    expect(runsDigest([], [], String)).toBe("");
  });
});
