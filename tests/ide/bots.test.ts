import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { FALLBACK_NOTE } from "../../src/inference-api/auto-route.js";
import { BotManager, agentBotRunner, botComputeChat, nextRunAt, parseSchedule, registerBotRoutes, summarize, type BotRunContext, type BotRunner } from "../../src/apps/ide/bots.js";
import type { ChatFn } from "../../src/apps/ide/agent-loop.js";

const dir = () => mkdtempSync(join(tmpdir(), "bots-"));
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
let managers: BotManager[] = [];
afterEach(async () => {
  for (const m of managers) await m.shutdown();
  managers = [];
});
function manager(runner: BotRunner, opts: { file?: string; now?: () => number } = {}) {
  const m = new BotManager({ runner, file: opts.file ?? join(dir(), "bots.json"), now: opts.now });
  managers.push(m);
  return m;
}
/** A runner the test drives: each run waits until released. */
function gatedRunner() {
  const calls: BotRunContext[] = [];
  const gates: Array<() => void> = [];
  const runner: BotRunner = (ctx) =>
    new Promise<void>((resolve) => {
      calls.push(ctx);
      ctx.sendEvent({ type: "text", content: `Run ${calls.length} done.` });
      gates.push(resolve);
    });
  return { calls, runner, release: () => gates.shift()?.() };
}

describe("bot schedules", () => {
  it("parses intervals, daily times and cron", () => {
    expect(parseSchedule("")).toBeNull();
    expect(parseSchedule("manual")).toBeNull();
    expect(parseSchedule("every 30 minutes")).toEqual({ kind: "every", ms: 30 * 60_000 });
    expect(parseSchedule("Every 2 Hours")).toEqual({ kind: "every", ms: 2 * 3_600_000 });
    expect(parseSchedule("every hour")).toEqual({ kind: "every", ms: 3_600_000 });
    expect(parseSchedule("hourly")).toEqual({ kind: "every", ms: 3_600_000 });
    expect(parseSchedule("daily at 09:30")).toEqual({ kind: "daily", hour: 9, minute: 30 });
    expect(parseSchedule("daily at 5pm")).toEqual({ kind: "daily", hour: 17, minute: 0 });
    expect(parseSchedule("0 9 * * 1-5")?.kind).toBe("cron");
    expect(() => parseSchedule("every 1 minute")).toThrow(/at most every 5 minutes/);
    expect(() => parseSchedule("daily at 25:00")).toThrow();
    expect(() => parseSchedule("61 * * * *")).toThrow(/out of range/);
    expect(() => parseSchedule("sometimes")).toThrow(/isn't a schedule/);
  });

  it("finds the next run", () => {
    const from = at(2026, 11, 2, 10, 15); // a Monday
    expect(nextRunAt(parseSchedule("every 30 minutes")!, from)).toBe(from + 30 * 60_000);
    expect(nextRunAt(parseSchedule("daily at 09:00")!, from)).toBe(at(2026, 11, 3, 9, 0));
    expect(nextRunAt(parseSchedule("daily at 11:00")!, from)).toBe(at(2026, 11, 2, 11, 0));
    expect(nextRunAt(parseSchedule("*/15 * * * *")!, from)).toBe(at(2026, 11, 2, 10, 30));
    expect(nextRunAt(parseSchedule("0 9 * * 1-5")!, from)).toBe(at(2026, 11, 3, 9, 0));
    // Friday evening -> Monday 09:00
    expect(nextRunAt(parseSchedule("0 9 * * 1-5")!, at(2026, 11, 6, 18, 0))).toBe(at(2026, 11, 9, 9, 0));
    expect(nextRunAt(parseSchedule("0 0 1 1 *")!, from)).toBe(at(2027, 1, 1, 0, 0));
    expect(nextRunAt(parseSchedule("0 0 30 2 *")!, from)).toBeNull();
  });

  it("summarizes a run by its last paragraph", () => {
    expect(summarize("Looked around.\n\nFixed the  failing test in\nsrc/a.ts.")).toBe("Fixed the failing test in src/a.ts.");
    expect(summarize("x".repeat(300))).toHaveLength(238);
  });
});

describe("BotManager", () => {
  it("saves bots privately and loads them back, marking unfinished runs", async () => {
    const file = join(dir(), "bots.json");
    const g = gatedRunner();
    const m = manager(g.runner, { file });
    const bot = m.create({ name: "Harry", role: "Engineer", projectRoot: dir(), schedule: "every 30 minutes" });
    expect(bot.budgetCSatsPerDay).toBe(100);
    expect(bot.allowedTools).toContain("read_file");
    expect(bot.nextRunAtMs).toBeGreaterThan(Date.now());
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    m.remember(bot.id, "The tests live in tests/.");
    expect(m.memory(bot.id)).toMatch(/- \d{4}-\d\d-\d\d: The tests live in tests\/\./);
    if (process.platform !== "win32") expect(statSync(join(file, "..", "bots", bot.id, "memory.md")).mode & 0o777).toBe(0o600);
    expect(m.runNow(bot.id).started).toBe(true);
    // A second manager on the same file (the server restarted mid-run).
    const m2 = manager(gatedRunner().runner, { file });
    m2.load();
    expect(m2.list().map((b) => b.name)).toEqual(["Harry"]);
    expect(m2.history(bot.id)[0].status).toBe("interrupted");
    expect(JSON.parse(readFileSync(file, "utf8")).bots).toHaveLength(1);
    g.release();
  });

  it("never runs two runs of one bot at once, and queues messages", async () => {
    const g = gatedRunner();
    const m = manager(g.runner);
    const bot = m.create({ name: "B", projectRoot: dir() });
    expect(m.runNow(bot.id)).toMatchObject({ started: true });
    expect(m.runNow(bot.id)).toEqual({ started: false, reason: "busy" });
    expect(m.tick(Date.now() + 10 ** 9)).toEqual([]);
    expect(m.message(bot.id, "also check the README")).toEqual({ started: false, queued: true });
    expect(m.get(bot.id).status).toBe("running");
    expect(g.calls).toHaveLength(1);
    g.release();
    await new Promise((r) => setTimeout(r, 10));
    // The queued message started the next run, with the message in its context.
    expect(g.calls).toHaveLength(2);
    expect(g.calls[1].messages.at(-1)).toEqual({ role: "user", content: "also check the README" });
    g.release();
    await m.idle(bot.id);
    const runs = m.history(bot.id);
    expect(runs.map((r) => [r.trigger, r.status])).toEqual([["message", "done"], ["manual", "done"]]);
    expect(runs[1].summary).toBe("Run 1 done.");
    expect(m.messages(bot.id).map((x) => x.role)).toEqual(["event", "assistant", "user", "assistant"]);
  });

  it("runs on schedule, skips while paused", async () => {
    let now = at(2026, 11, 2, 8, 0);
    const g = gatedRunner();
    const m = manager(g.runner, { now: () => now });
    const bot = m.create({ name: "Daily", projectRoot: dir(), schedule: "daily at 09:00" });
    expect(bot.nextRunAtMs).toBe(at(2026, 11, 2, 9, 0));
    expect(m.tick(now)).toEqual([]);
    now = at(2026, 11, 2, 9, 0, );
    expect(m.tick(now)).toEqual([bot.id]);
    expect(m.get(bot.id).nextRunAtMs).toBe(at(2026, 11, 3, 9, 0));
    expect(g.calls[0].messages.at(-1)?.content).toMatch(/^\[Scheduled run/);
    expect(g.calls[0].systemAddition).toContain('You are "Daily"');
    g.release();
    await m.idle(bot.id);
    m.update(bot.id, { enabled: false });
    now = at(2026, 11, 3, 9, 1);
    expect(m.tick(now)).toEqual([]);
    expect(m.get(bot.id).status).toBe("paused");
  });

  it("stops a run when the day's budget is spent, and won't start another", async () => {
    const runner: BotRunner = async (ctx) => {
      for (let i = 0; i < 10 && !ctx.isCancelled(); i++) {
        ctx.sendEvent({ type: "usage", cSats: 4, where: "network (gpu)" });
        await new Promise((r) => setTimeout(r, 1));
      }
    };
    const m = manager(runner);
    const bot = m.create({ name: "Spender", projectRoot: dir(), budgetCSatsPerDay: 10 });
    m.runNow(bot.id);
    await m.idle(bot.id);
    const [run] = m.history(bot.id);
    expect(run.status).toBe("budget");
    expect(run.cSats).toBe(12);
    expect(run.where).toBe("network (gpu)");
    expect(m.get(bot.id).status).toBe("over_budget");
    expect(m.runNow(bot.id)).toEqual({ started: false, reason: "budget" });
    // Raising the budget lets it run again.
    m.update(bot.id, { budgetCSatsPerDay: 1000 });
    expect(m.runNow(bot.id).started).toBe(true);
    await m.idle(bot.id);
  });

  it("pauses for approval and resumes when answered", async () => {
    const approvals = new Map();
    const results: boolean[] = [];
    const runner: BotRunner = async (ctx) => {
      results.push(await ctx.waitForApproval("tc_1", "run_shell", { command: "npm test" }));
    };
    const m = new BotManager({ runner, file: join(dir(), "bots.json"), approvals });
    managers.push(m);
    const bot = m.create({ name: "A", projectRoot: dir() });
    m.runNow(bot.id);
    await new Promise((r) => setTimeout(r, 5));
    const v = m.get(bot.id);
    expect(v.status).toBe("needs_approval");
    expect(v.pending).toEqual([{ callId: "tc_1", tool: "run_shell", args: { command: "npm test" } }]);
    expect(approvals.get("tc_1")?.owner).toBe(`bot:${bot.id}`);
    expect(m.approve(bot.id, "nope", true)).toBe(false);
    expect(m.approve(bot.id, "tc_1", true)).toBe(true);
    await m.idle(bot.id);
    expect(results).toEqual([true]);
    expect(approvals.size).toBe(0);
    expect(m.history(bot.id)[0].status).toBe("done");
  });

  it("cancel rejects pending approvals and records the run as stopped", async () => {
    const results: boolean[] = [];
    const m = manager(async (ctx) => {
      results.push(await ctx.waitForApproval("tc_2", "git_push", {}));
    });
    const bot = m.create({ name: "C", projectRoot: dir() });
    m.runNow(bot.id);
    await new Promise((r) => setTimeout(r, 5));
    expect(m.cancel(bot.id)).toBe(true);
    await m.idle(bot.id);
    expect(results).toEqual([false]);
    expect(m.history(bot.id)[0].status).toBe("cancelled");
  });

  it("rejects bad input", () => {
    const m = manager(gatedRunner().runner);
    expect(() => m.create({ name: "X", projectRoot: "relative/path" })).toThrow(/absolute/);
    expect(() => m.create({ name: "X", projectRoot: join(dir(), "missing") })).toThrow(/No folder/);
    expect(() => m.create({ name: "X", projectRoot: dir(), schedule: "whenever" })).toThrow(/isn't a schedule/);
    expect(() => m.create({ name: "X", projectRoot: dir(), budgetCSatsPerDay: 0 })).toThrow(/budget/);
  });
});

describe("agentBotRunner", () => {
  it("runs the agent loop with the bot's tool policy and memory tool", async () => {
    const project = dir();
    writeFileSync(join(project, "notes.txt"), "hello\n");
    const replies: Array<Awaited<ReturnType<ChatFn>>> = [
      { content: "", toolCalls: [{ name: "read_file", arguments: { path: "notes.txt" } }] },
      { content: "", toolCalls: [{ name: "remember", arguments: { note: "notes.txt says hello" } }] },
      { content: "", toolCalls: [{ name: "run_shell", arguments: { command: "ls" } }] },
      { content: "", toolCalls: [{ name: "git_push", arguments: {} }] },
      { content: "Read the notes.\n\nAll good: notes.txt says hello.", toolCalls: [] },
    ];
    const seen: string[] = [];
    let system = "";
    const runner = agentBotRunner({
      chat: () => async (req, onDelta) => {
        system = req.messages[0].content;
        seen.push(...(req.tools ?? []).map((t) => t.function.name));
        const r = replies.shift()!;
        if (r.content) onDelta?.(r.content);
        return r;
      },
      execute: () => async (tool, args, opts) => {
        if (tool === "read_file") return { result: readFileSync(join(project, String(args.path)), "utf8") };
        return { result: `ran ${tool} approved=${opts.approved}` };
      },
      systemPrompt: async () => () => "BASE PROMPT",
    });
    const m = manager(runner);
    const bot = m.create({ name: "Harry", projectRoot: project, instructions: "Keep the notes tidy.", allowedTools: ["read_file", "run_shell"] });
    m.runNow(bot.id);
    await new Promise((r) => setTimeout(r, 20));
    // run_shell needs approval: the run is paused.
    const v = m.get(bot.id);
    expect(v.status).toBe("needs_approval");
    expect(v.pending[0].tool).toBe("run_shell");
    m.approve(bot.id, v.pending[0].callId, true);
    await m.idle(bot.id);
    expect(system).toContain("BASE PROMPT");
    expect(system).toContain("Keep the notes tidy.");
    expect(new Set(seen)).toEqual(new Set(["read_file", "run_shell", "remember"]));
    expect(m.memory(bot.id)).toContain("notes.txt says hello");
    const [run] = m.history(bot.id);
    expect(run.status).toBe("done");
    expect(run.summary).toBe("All good: notes.txt says hello.");
    const reply = m.messages(bot.id).at(-1)!;
    const results = reply.events!.filter((e) => e.type === "tool_result" || e.type === "shell_output");
    expect(JSON.stringify(results)).toContain("hello");
    expect(JSON.stringify(results)).toContain("ran run_shell approved=true");
    // git_push isn't allowed for this bot: refused without running.
    expect(JSON.stringify(reply.events)).not.toContain("ran git_push");
  });
});

describe("/v1/ide/bots routes", () => {
  it("create, list, run, message, history, approve, update, delete", async () => {
    const app = Fastify();
    let release: () => void = () => undefined;
    const m = manager(
      (ctx) =>
        new Promise<void>((resolve) => {
          ctx.sendEvent({ type: "text", content: "Did the job." });
          release = resolve;
        }),
    );
    registerBotRoutes(app, m);
    const project = dir();
    const created = await app.inject({ method: "POST", url: "/v1/ide/bots", payload: { name: "Harry", role: "Engineer", projectRoot: project, schedule: "every 2 hours", budgetCSatsPerDay: 50 } });
    expect(created.statusCode).toBe(200);
    const id = created.json().bot.id as string;
    expect((await app.inject({ method: "POST", url: "/v1/ide/bots", payload: { name: "Bad", projectRoot: project, schedule: "nope" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/ide/bots", payload: { projectRoot: project } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/ide/bots" })).json().bots).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/v1/ide/bots/nope/history" })).statusCode).toBe(404);

    const run = await app.inject({ method: "POST", url: `/v1/ide/bots/${id}/run` });
    expect(run.json()).toMatchObject({ started: true, bot: { status: "running" } });
    expect((await app.inject({ method: "POST", url: `/v1/ide/bots/${id}/run` })).statusCode).toBe(409);
    const msg = await app.inject({ method: "POST", url: `/v1/ide/bots/${id}/messages`, payload: { content: "hi" } });
    expect(msg.json()).toMatchObject({ queued: true });
    expect((await app.inject({ method: "POST", url: `/v1/ide/bots/${id}/approve`, payload: { callId: "x", approved: true } })).statusCode).toBe(404);
    release();
    await new Promise((r) => setTimeout(r, 10));
    release();
    await m.idle(id);
    const history = (await app.inject({ method: "GET", url: `/v1/ide/bots/${id}/history` })).json().runs;
    expect(history).toHaveLength(2);
    const messages = (await app.inject({ method: "GET", url: `/v1/ide/bots/${id}/messages` })).json().messages;
    expect(messages.filter((x: { role: string }) => x.role === "assistant")).toHaveLength(2);

    const patched = await app.inject({ method: "PATCH", url: `/v1/ide/bots/${id}`, payload: { enabled: false, memory: "- remember this\n" } });
    expect(patched.json().bot).toMatchObject({ enabled: false, status: "paused" });
    expect((await app.inject({ method: "GET", url: `/v1/ide/bots/${id}` })).json().memory).toBe("- remember this\n");
    expect((await app.inject({ method: "DELETE", url: `/v1/ide/bots/${id}` })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: "/v1/ide/bots" })).json().bots).toHaveLength(0);
    await app.close();
  });
});

describe("bot compute policy", () => {
  it("new bots default to Local first; the policy saves and loads; old bots become Auto", () => {
    const file = join(dir(), "bots.json");
    const m = manager(gatedRunner().runner, { file });
    const a = m.create({ name: "Harry", projectRoot: dir() });
    expect(a.compute).toEqual({ policy: "local_first" });
    const b = m.create({ name: "Pinned", projectRoot: dir(), compute: { policy: "model", model: " network/qwen3.5:9b@gpu " } });
    expect(b.compute).toEqual({ policy: "model", model: "network/qwen3.5:9b@gpu" });
    // Switching away from a specific model drops the model.
    expect(m.update(b.id, { compute: { policy: "local_only", model: "x" } }).compute).toEqual({ policy: "local_only" });
    const m2 = manager(gatedRunner().runner, { file });
    m2.load();
    expect(m2.get(a.id).compute).toEqual({ policy: "local_first" });
    expect(m2.get(b.id).compute).toEqual({ policy: "local_only" });

    // A bots.json from before compute policies: those bots keep Auto (and the file is migrated).
    const old = JSON.parse(readFileSync(file, "utf8"));
    for (const bot of old.bots) delete bot.compute;
    writeFileSync(file, JSON.stringify(old));
    const m3 = manager(gatedRunner().runner, { file });
    m3.load();
    expect(m3.list().map((x) => x.compute)).toEqual([{ policy: "auto" }, { policy: "auto" }]);
    expect(JSON.parse(readFileSync(file, "utf8")).bots[0].compute).toEqual({ policy: "auto" });
  });

  it("keeps the avatar shape the user picked", async () => {
    const m = manager(gatedRunner().runner);
    const b = m.create({ name: "Harry", projectRoot: dir(), avatarShape: "hex", color: "#46a758" });
    expect(b).toMatchObject({ avatarShape: "hex", color: "#46a758" });
    expect(m.update(b.id, { avatarShape: "orb" }).avatarShape).toBe("orb");
    expect(m.create({ name: "Plain", projectRoot: dir() }).avatarShape).toBeUndefined();
    const app = Fastify();
    registerBotRoutes(app, m);
    const bad = await app.inject({ method: "PATCH", url: `/v1/ide/bots/${b.id}`, payload: { avatarShape: "blob" } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a specific-model policy without a model, and unknown policies", () => {
    const m = manager(gatedRunner().runner);
    expect(() => m.create({ name: "X", projectRoot: dir(), compute: { policy: "model" } })).toThrow(/Pick the model/);
    expect(() => m.create({ name: "X", projectRoot: dir(), compute: { policy: "cloud" as never } })).toThrow(/Unknown compute policy/);
  });

  it("gives each model call the budget left today, and notes a small-model fallback", async () => {
    const seen: Array<{ policy: string; allowance?: number }> = [];
    const runner: BotRunner = async (ctx) => {
      const chat = botComputeChat(ctx, (policy, plan, onRoute) => async function* () {
        seen.push({ policy, allowance: plan().allowanceCSats });
        const fallback = seen.length === 2;
        onRoute({ placement: "local", model: "qwen2.5-coder:1.5b", cSatsPerSecond: 0, fallback, reason: fallback ? `this computer · qwen2.5-coder:1.5b · ${FALLBACK_NOTE}` : "network gpu" });
        yield { delta: "ok" };
        yield { done: true, cSatsSpent: fallback ? 0 : 3 };
      });
      await chat({ messages: [{ role: "user", content: "go" }] });
      await chat({ messages: [{ role: "user", content: "go" }] });
    };
    const m = manager(runner);
    const bot = m.create({ name: "Harry", projectRoot: dir(), budgetCSatsPerDay: 10 });
    m.runNow(bot.id);
    await m.idle(bot.id);
    expect(seen).toEqual([{ policy: "local_first", allowance: 10 }, { policy: "local_first", allowance: 7 }]);
    const [run] = m.history(bot.id);
    expect(run).toMatchObject({ status: "done", cSats: 3, where: "This computer · qwen2.5-coder:1.5b", note: FALLBACK_NOTE });
  });
});
