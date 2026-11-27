import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotManager, UNAVAILABLE_RETRY_STEPS_MS, unavailableRetryMs, type BotRunner } from "../../src/apps/ide/bots.js";
import { networkUnavailable, runFailureClass } from "../../src/apps/ide/bot-outcomes.js";

/*
 * A bot whose runs can't reach the network (this computer's agent reconnecting, a coordinator
 * restarting, every machine busy) waits and tries again by itself, status "waiting_network"; it
 * never pauses as stuck for that. Real blockers (cSats, budget, refusals, a task it can't do) still do.
 */

const dir = () => mkdtempSync(join(tmpdir(), "bots-netretry-"));
let managers: BotManager[] = [];
afterEach(async () => {
  for (const m of managers) await m.shutdown();
  managers = [];
});

const NOT_CONNECTED = "Error contacting model: This computer's agent isn't connected to the network right now (it is starting or reconnecting). Nothing was charged; try again shortly.";
const OLD_NOT_CONNECTED = "This computer's agent isn't connected to the network yet.";

function setup(errors: Array<string | null>, file = join(dir(), "bots.json")) {
  const clock = { now: new Date(2026, 10, 26, 13, 55).getTime() };
  let runs = 0;
  const runner: BotRunner = async (ctx) => {
    const e = errors[Math.min(runs, errors.length - 1)];
    runs++;
    if (e) throw new Error(e);
    ctx.sendEvent({ type: "text", content: "Done: market notes updated." } as never);
  };
  const m = new BotManager({ runner, file, now: () => clock.now, fingerprint: async () => "same" });
  managers.push(m);
  return { m, clock, runs: () => runs, file };
}

async function settle(m: BotManager, id: string) {
  await m.idle(id);
  await m.settled();
}

describe("run failure classification", () => {
  it.each([
    [OLD_NOT_CONNECTED, "transient"],
    [NOT_CONNECTED, "transient"],
    ["Network request failed: agent_not_registered", "transient"],
    ["The coordinator is restarting for an update. Nothing was charged; try again in a few seconds.", "transient"],
    ["Every machine that runs auto is busy and none could start this request in time. Nothing was charged; try again in 15 s.", "transient"],
    ["Network request failed: coordinator_unreachable", "transient"],
    ["connect ECONNREFUSED 127.0.0.1:4305", "transient"],
    ["fetch failed", "transient"],
    ["The network didn't finish within 6 minutes.", "transient"],
    ["Not enough cSats: your balance is 0.01 cSats.", "blocker"],
    ["Stopped: today's budget (100 cSats) is spent.", "blocker"],
    ["run_shell npm test: you said no", "blocker"],
    ["npm test: package.json not found", "blocker"],
    ["Permission denied writing market-notes/x.md", "blocker"],
    ["No machine on the network has qwen9:70b right now.", "blocker"],
    ["Something unexpected happened", "blocker"],
  ])("%s -> %s", (error, cls) => {
    expect(runFailureClass(error)).toBe(cls);
    expect(networkUnavailable(error)).toBe(cls === "transient");
  });

  it("no error is no failure", () => {
    expect(runFailureClass(undefined)).toBeNull();
    expect(runFailureClass("  ")).toBeNull();
  });

  it("backs off 15 s, 1 min, then every 5 min", () => {
    expect(UNAVAILABLE_RETRY_STEPS_MS).toEqual([15_000, 60_000, 300_000]);
    expect([0, 1, 2, 3, 9].map(unavailableRetryMs)).toEqual([15_000, 60_000, 300_000, 300_000, 300_000]);
  });
});

describe("a Network only bot that can't reach the network", () => {
  it("retries by itself with backoff, never pauses as stuck, and goes back to work once it gets through", async () => {
    const { m, clock, runs } = setup([OLD_NOT_CONNECTED, OLD_NOT_CONNECTED, OLD_NOT_CONNECTED, OLD_NOT_CONNECTED, null]);
    const bot = m.create({ name: "Trader Boy", role: "Stock Trader", instructions: "Analyze the markets.", projectRoot: dir(), enabled: true, heartbeatMinutes: null, compute: { policy: "network_only" } });
    const id = bot.id;
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const due = m.get(id).auto?.due;
      expect(due?.kind).toBe("start");
      clock.now = Math.max(clock.now, due!.atMs);
      const started = m.tick(clock.now);
      expect(started).toEqual([id]);
      await settle(m, id);
      const v = m.get(id);
      // More than three runs in a row with the same failure: still enabled, not stuck.
      expect(v.enabled).toBe(true);
      expect(v.auto?.stuck).toBeUndefined();
      expect(v.status).toBe("waiting_network");
      waits.push(v.auto!.due!.atMs - clock.now);
    }
    expect(waits).toEqual([15_000, 60_000, 300_000, 300_000]);
    expect(m.messages(id).filter((x) => /retrying automatically/.test(x.content ?? "")).length).toBe(1);
    // The network is back: the retry gets through and the wait resets.
    clock.now = m.get(id).auto!.due!.atMs;
    m.tick(clock.now);
    await settle(m, id);
    expect(runs()).toBe(5);
    expect(m.get(id).status).not.toBe("waiting_network");
    expect(m.get(id).auto?.unavailableRetries).toBeUndefined();
  });

  it("still pauses for a real blocker three runs in a row", async () => {
    const { m, clock } = setup(["npm test: package.json not found"]);
    const bot = m.create({ name: "Harry", role: "Engineer", instructions: "Fix the tests.", projectRoot: dir(), enabled: true, heartbeatMinutes: 30, compute: { policy: "network_only" } });
    for (let i = 0; i < 3; i++) {
      clock.now += 31 * 60_000;
      m.runNow(bot.id, "heartbeat");
      await settle(m, bot.id);
    }
    expect(m.get(bot.id).enabled).toBe(false);
    expect(m.get(bot.id).auto?.stuck?.problem).toMatch(/package\.json not found/);
    expect(m.get(bot.id).status).toBe("paused");
  });

  it("a bot an older version paused as stuck for the network resumes by itself", async () => {
    const first = setup([null]);
    const bot = first.m.create({ name: "Trader Boy", role: "Stock Trader", instructions: "Analyze the markets.", projectRoot: dir(), enabled: true, heartbeatMinutes: null, compute: { policy: "network_only" } });
    await first.m.shutdown();
    managers = managers.filter((x) => x !== first.m);
    // As saved by the old version: paused, stuck on "agent isn't connected".
    const saved = JSON.parse(readFileSync(first.file, "utf8"));
    const b = saved.bots.find((x: { id: string }) => x.id === bot.id);
    b.enabled = false;
    b.auto = { idleStreak: 0, followUps: 0, stuck: { atMs: first.clock.now, problem: OLD_NOT_CONNECTED, runs: 3 } };
    writeFileSync(first.file, JSON.stringify(saved));
    const second = setup([null], first.file);
    second.m.load();
    expect(second.m.get(bot.id).enabled).toBe(false);
    second.m.tick(second.clock.now);
    const v = second.m.get(bot.id);
    expect(v.enabled).toBe(true);
    expect(v.auto?.stuck).toBeUndefined();
    expect(v.auto?.due).toMatchObject({ kind: "start" });
    // A real blocker stays paused.
    const blocked = second.m.create({ name: "Harry", role: "Engineer", instructions: "x", projectRoot: dir(), enabled: true, heartbeatMinutes: null });
    second.m.update(blocked.id, { enabled: false });
    await second.m.settled();
    const s2 = JSON.parse(readFileSync(first.file, "utf8"));
    expect(s2.bots.length).toBe(2);
  });
});
