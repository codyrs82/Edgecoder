import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BotManager, DEFAULT_HEARTBEAT_MINUTES, FOLLOW_UP_DELAY_MS, MAX_FOLLOW_UPS_IN_A_ROW, heartbeatInterval, projectFingerprint,
  type BotRunContext, type BotRunner,
} from "../../src/apps/ide/bots.js";
import { GO_AHEAD, announcesWork, runAgentLoop, type ChatFn } from "../../src/apps/ide/agent-loop.js";

const MIN = 60_000;
const dir = () => mkdtempSync(join(tmpdir(), "bots-auto-"));
let managers: BotManager[] = [];
afterEach(async () => {
  for (const m of managers) await m.shutdown();
  managers = [];
});

/** A manager on a clock and a project fingerprint the test controls; each run replies with the next text. */
/** A run that used a tool before replying. */
const usedTool = (ctx: BotRunContext) => ctx.sendEvent({ type: "tool_call", id: `tc_${Math.random()}`, tool: "list_directory", args: { path: "." }, requires_approval: false });

function setup(opts: { replies?: string[]; file?: string; gate?: boolean; onRun?: (ctx: BotRunContext) => void } = {}) {
  const clock = { now: new Date(2026, 10, 16, 10, 0).getTime() };
  const project: { fp: string | null } = { fp: "v1" };
  const calls: BotRunContext[] = [];
  const gates: Array<() => void> = [];
  const replies = [...(opts.replies ?? [])];
  const runner: BotRunner = async (ctx) => {
    calls.push(ctx);
    opts.onRun?.(ctx);
    ctx.sendEvent({ type: "text", content: replies.shift() ?? "Checked the project. Nothing needs attention." });
    if (opts.gate) await new Promise<void>((r) => gates.push(r));
  };
  const m = new BotManager({ runner, file: opts.file ?? join(dir(), "bots.json"), now: () => clock.now, fingerprint: async () => project.fp });
  managers.push(m);
  const advance = (ms: number) => (clock.now += ms);
  const label = (ctx: BotRunContext) => /^\[([^·]+) ·/.exec(ctx.messages.at(-1)?.content ?? "")?.[1]?.trim();
  return { m, clock, project, calls, advance, label, release: () => gates.shift()?.() };
}

async function drain(m: BotManager, id: string) {
  await m.settled();
  await m.idle(id);
  await m.settled();
}

describe("bots start on their own", () => {
  it("a bot with a job starts working when created; one without waits for a message", async () => {
    const { m, calls, label, clock } = setup();
    const harry = m.create({ name: "Harry", role: "Lead Developer", projectRoot: dir() });
    const plain = m.create({ name: "Plain", projectRoot: dir() });
    expect(m.get(harry.id).nextRun).toEqual({ kind: "start", atMs: clock.now });
    expect(m.get(plain.id).nextRun).toBeUndefined();
    expect(m.tick()).toEqual([harry.id]);
    expect(label(calls[0])).toBe("Started work");
    expect(calls[0].messages.at(-1)?.content).toMatch(/start on it now with your tools/);
    await drain(m, harry.id);
    expect(m.history(harry.id)[0]).toMatchObject({ trigger: "start", status: "done" });
    expect(m.messages(harry.id)[0]).toMatchObject({ role: "event", content: "Started work" });
    // Nothing for the bot without a job, and no check-ins for it.
    m.tick(clock.now + 10 * 60 * MIN);
    await m.settled();
    expect(m.history(plain.id)).toEqual([]);
  });

  it("an old bot with a job that never ran (waiting for Run now) starts after the update", async () => {
    const file = join(dir(), "bots.json");
    const root = dir();
    writeFileSync(file, JSON.stringify({ bots: [{ id: "bot_old", name: "Harry", role: "Lead Developer", instructions: "", projectRoot: root, enabled: true, schedule: "", budgetCSatsPerDay: 100, allowedTools: ["read_file"], autoApproveEdits: true, compute: { policy: "local_first" }, color: "#0090ff", createdAtMs: 0, updatedAtMs: 0 }], runs: {} }));
    const { m, calls, label } = setup({ file });
    m.load();
    const v = m.get("bot_old");
    expect(v).toMatchObject({ heartbeatMinutes: DEFAULT_HEARTBEAT_MINUTES, maxRunsPerDay: 48, nextRun: { kind: "start" } });
    expect(JSON.parse(readFileSync(file, "utf8")).bots[0].heartbeatMinutes).toBe(30);
    expect(m.tick()).toEqual(["bot_old"]);
    expect(label(calls[0])).toBe("Started work");
  });
});

describe("check-ins (heartbeat) with idle backoff", () => {
  it("checks in every 30 minutes, backs off while nothing changes, and runs again when something does", async () => {
    const { m, calls, label, project, advance, clock } = setup();
    const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: dir() });
    m.tick();
    await drain(m, bot.id);
    // After the start run: the next check-in in 30 minutes.
    expect(m.get(bot.id).nextRun).toEqual({ kind: "heartbeat", atMs: clock.now + 30 * MIN });

    // Something changed: the check-in runs.
    project.fp = "v2";
    advance(30 * MIN);
    m.tick();
    await drain(m, bot.id);
    expect(calls.map(label)).toEqual(["Started work", "Check-in"]);
    // The check-in run changed nothing: the next one waits twice as long.
    expect(m.get(bot.id).auto?.idleStreak).toBe(1);
    expect(m.get(bot.id).nextRun?.atMs).toBe(clock.now + 60 * MIN);

    // Quiet check-ins don't run; the waits double up to 8 hours, then it runs anyway.
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      advance(m.get(bot.id).nextRun!.atMs - clock.now);
      m.tick();
      await drain(m, bot.id);
      waits.push((m.get(bot.id).nextRun!.atMs - clock.now) / MIN);
    }
    expect(waits).toEqual([120, 240, 480, 480]);
    expect(calls.map(label)).toEqual(["Started work", "Check-in", "Check-in"]);

    // A change resets the wait.
    project.fp = "v3";
    advance(480 * MIN);
    m.tick();
    await drain(m, bot.id);
    expect(calls).toHaveLength(4);
    expect(m.get(bot.id).auto?.idleStreak).toBe(1);
  });

  it("a run that changes the project keeps the check-ins at the base interval", async () => {
    const { m, project, advance, clock } = setup({ onRun: () => (project.fp = `${project.fp}+`) });
    const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: dir() });
    m.tick();
    await drain(m, bot.id);
    project.fp = "changed";
    advance(30 * MIN);
    m.tick();
    await drain(m, bot.id);
    expect(m.get(bot.id).auto?.idleStreak).toBe(0);
    expect(m.get(bot.id).nextRun?.atMs).toBe(clock.now + 30 * MIN);
  });

  it("an explicit schedule replaces check-ins; heartbeat off means none", async () => {
    const { m, advance } = setup();
    const scheduled = m.create({ name: "S", role: "Reviewer", projectRoot: dir(), schedule: "every 2 hours" });
    const off = m.create({ name: "O", role: "Reviewer", projectRoot: dir(), heartbeatMinutes: null });
    m.tick();
    await drain(m, scheduled.id);
    await drain(m, off.id);
    expect(m.get(scheduled.id).nextRun?.kind).toBe("schedule");
    expect(m.get(off.id).nextRun).toBeUndefined();
    advance(60 * MIN);
    m.tick();
    await m.settled();
    expect(m.history(off.id)).toHaveLength(1); // only its start
    expect(() => m.update(off.id, { heartbeatMinutes: 2 })).toThrow(/5 to 1440/);
  });

  it("the interval doubles per quiet check-in up to 8 hours", () => {
    expect([0, 1, 2, 3, 4, 9].map((s) => heartbeatInterval(30, s) / MIN)).toEqual([30, 60, 120, 240, 480, 480]);
    expect(heartbeatInterval(1440, 3) / MIN).toBe(1440);
  });
});

describe("one run at a time", () => {
  it("never starts a check-in, follow-up or start while a run is going; messages wait their turn", async () => {
    const { m, calls, release, advance } = setup({ gate: true });
    const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: dir() });
    m.tick();
    expect(m.get(bot.id).status).toBe("running");
    advance(10 * 60 * MIN);
    expect(m.tick()).toEqual([]);
    await m.settled();
    expect(m.runNow(bot.id).started).toBe(false);
    expect(m.message(bot.id, "and the README")).toEqual({ started: false, queued: true });
    expect(calls).toHaveLength(1);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(2);
    release();
    await drain(m, bot.id);
  });
});

describe("check-ins that skip are not runs", () => {
  it("a quiet check-in adds no run; an unreadable folder backs off like a quiet one", async () => {
    const { m, calls, project, advance } = setup();
    const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: dir() });
    m.tick();
    await drain(m, bot.id);
    expect(m.history(bot.id)).toHaveLength(1);
    // Nothing changed: check-ins skip without a run, waiting longer each time.
    for (let i = 0; i < 4; i++) {
      advance(heartbeatInterval(DEFAULT_HEARTBEAT_MINUTES, 8));
      m.tick();
      await drain(m, bot.id);
    }
    expect(calls).toHaveLength(1);
    expect(m.history(bot.id)).toHaveLength(1);
    // A folder it can't read (no fingerprint) runs once, then counts as unchanged.
    (project as { fp: string | null }).fp = null;
    for (let i = 0; i < 4; i++) {
      advance(heartbeatInterval(DEFAULT_HEARTBEAT_MINUTES, 8));
      m.tick();
      await drain(m, bot.id);
    }
    expect(calls).toHaveLength(2);
  });
});

describe("follow-ups", () => {
  it("a run that ends saying what it'll do next continues in 2 minutes", async () => {
    const { m, calls, label, advance, clock } = setup({ replies: ["Looked at the project.\n\nNext, I'll check the current status of the tests."], onRun: usedTool });
    const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: dir() });
    m.tick();
    await drain(m, bot.id);
    expect(m.get(bot.id).nextRun).toEqual({ kind: "follow_up", atMs: clock.now + FOLLOW_UP_DELAY_MS });
    advance(FOLLOW_UP_DELAY_MS);
    m.tick();
    await drain(m, bot.id);
    expect(calls.map(label)).toEqual(["Started work", "Follow-up"]);
    expect(calls[1].messages.at(-1)?.content).toMatch(/Continue where your last run left off/);
    // That one reported back: no more follow-ups, the check-in clock is next.
    expect(m.get(bot.id).nextRun?.kind).toBe("heartbeat");
  });

  it("the follow_up tool sets when; at most 5 in a row", async () => {
    const { m, calls, advance, clock } = setup({ onRun: (ctx) => ctx.followUp(10, "finish the migration") });
    const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: dir() });
    m.tick();
    await drain(m, bot.id);
    expect(m.get(bot.id).nextRun).toEqual({ kind: "follow_up", atMs: clock.now + 10 * MIN });
    for (let i = 0; i < MAX_FOLLOW_UPS_IN_A_ROW + 2; i++) {
      advance(10 * MIN);
      m.tick();
      await drain(m, bot.id);
    }
    expect(calls.filter((c) => /Follow-up/.test(c.messages.at(-1)?.content ?? ""))).toHaveLength(MAX_FOLLOW_UPS_IN_A_ROW);
    expect(m.messages(bot.id).some((x) => x.role === "event" && /Stopped following up after 5 runs/.test(x.content))).toBe(true);
  });

  it("an announce-only run that did nothing (its go-ahead used up) ends: no follow-up loop", async () => {
    const { m, calls, advance } = setup({ replies: ["I'll start by listing all the files in the folder.", "I'll start by listing all the files in the folder."] });
    const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: dir() });
    m.tick();
    await drain(m, bot.id);
    expect(m.get(bot.id).nextRun?.kind).toBe("heartbeat");
    advance(FOLLOW_UP_DELAY_MS * 3);
    m.tick();
    await drain(m, bot.id);
    expect(calls).toHaveLength(1);
    expect(m.history(bot.id)).toHaveLength(1);
  });

  it("no follow-up after a question, a failure or a stop", async () => {
    const { m } = setup({ replies: ["Should I also update the changelog?"] });
    const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: dir() });
    m.tick();
    await drain(m, bot.id);
    expect(m.get(bot.id).nextRun?.kind).toBe("heartbeat");
  });
});

describe("limits", () => {
  it("stops starting runs on its own at the daily run limit (messages still answered)", async () => {
    const { m, calls, project, advance } = setup();
    const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: dir(), maxRunsPerDay: 2 });
    m.tick();
    await drain(m, bot.id);
    project.fp = "v2";
    advance(30 * MIN);
    m.tick();
    await drain(m, bot.id);
    expect(calls).toHaveLength(2);
    expect(m.get(bot.id)).toMatchObject({ runsToday: 2, held: "run_cap" });
    project.fp = "v3";
    advance(60 * MIN);
    m.tick();
    await drain(m, bot.id);
    expect(calls).toHaveLength(2);
    expect(m.messages(bot.id).filter((x) => /daily limit/.test(x.content))).toHaveLength(1);
    expect(m.message(bot.id, "are you there?").started).toBe(true);
    await drain(m, bot.id);
    expect(calls).toHaveLength(3);
  });

  it("doesn't start on its own once today's budget is spent", async () => {
    const { m, calls } = setup({ onRun: (ctx) => ctx.sendEvent({ type: "usage", cSats: 5, where: "network" }) });
    const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: dir(), budgetCSatsPerDay: 5, maxRunsPerDay: 10 });
    m.tick();
    await drain(m, bot.id);
    expect(m.get(bot.id)).toMatchObject({ status: "over_budget", held: "budget" });
    m.update(bot.id, { enabled: false });
    m.update(bot.id, { enabled: true });
    m.tick();
    await drain(m, bot.id);
    expect(calls).toHaveLength(1);
  });
});

describe("pause and resume", () => {
  it("pausing stops everything it does on its own; resuming starts work again", async () => {
    const { m, calls, label, advance } = setup({ replies: ["Next, I'll fix the lint errors."], onRun: usedTool });
    const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: dir() });
    m.tick();
    await drain(m, bot.id);
    expect(m.get(bot.id).nextRun?.kind).toBe("follow_up");
    const paused = m.update(bot.id, { enabled: false });
    expect(paused).toMatchObject({ status: "paused" });
    expect(paused.nextRun).toBeUndefined();
    advance(24 * 60 * MIN);
    m.tick();
    await m.settled();
    expect(calls).toHaveLength(1);
    const resumed = m.update(bot.id, { enabled: true });
    expect(resumed.nextRun?.kind).toBe("start");
    m.tick();
    await drain(m, bot.id);
    expect(calls.map(label)).toEqual(["Started work", "Started work"]);
  });
});

describe("announced work", () => {
  it("tells announcing from reporting or asking", () => {
    expect(announcesWork("I'll start by checking the current status of the project to see what needs attention.")).toBe(true);
    expect(announcesWork("Sure. Let me look at the failing test.")).toBe(true);
    expect(announcesWork("Looked around.\n\nNext, I'll update the README.")).toBe(true);
    expect(announcesWork("Fixed the failing test in src/a.ts.")).toBe(false);
    expect(announcesWork("I'll need your go-ahead: should I push?")).toBe(false);
    expect(announcesWork("")).toBe(false);
  });

  it("the agent loop gives a bot one go-ahead when it only announced work", async () => {
    const replies: Array<Awaited<ReturnType<ChatFn>>> = [
      { content: "I'll start by checking the current status of the project.", toolCalls: [] },
      { content: "", toolCalls: [{ name: "git_status", arguments: {} }] },
      { content: "Clean tree; nothing to do.", toolCalls: [] },
    ];
    const seen: string[] = [];
    const ran: string[] = [];
    const chat: ChatFn = async (req) => {
      seen.push(req.messages.at(-1)!.content);
      return replies.shift()!;
    };
    await runAgentLoop({ chat, systemPrompt: () => "", messages: [{ role: "user", content: "go" }], sendEvent: () => undefined, isCancelled: () => false, runTool: async (t) => (ran.push(t), "ok"), continueOnIntent: true });
    expect(seen[1]).toBe(GO_AHEAD);
    expect(ran).toEqual(["git_status"]);
    // Without the option (the IDE chat), the turn ends after the announcement.
    let n = 0;
    await runAgentLoop({ chat: async () => (n++, { content: "I'll check.", toolCalls: [] }), systemPrompt: () => "", messages: [{ role: "user", content: "go" }], sendEvent: () => undefined, isCancelled: () => false, runTool: async () => "ok" });
    expect(n).toBe(1);
  });
});

describe("projectFingerprint", () => {
  it("changes when a file changes and stays put otherwise", async () => {
    const root = dir();
    writeFileSync(join(root, "a.txt"), "one");
    const a = await projectFingerprint(root);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await projectFingerprint(root)).toBe(a);
    writeFileSync(join(root, "b.txt"), "two");
    expect(await projectFingerprint(root)).not.toBe(a);
  });
});
