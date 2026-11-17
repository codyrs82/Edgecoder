import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotManager, isOutOfCSatsError, type BotRunner } from "../../src/apps/ide/bots.js";

/*
 * A Network only bot that runs out of cSats stops starting runs on its own (status "Out of cSats",
 * not a failure every 30 minutes) and resumes by itself when the balance goes up.
 */

const dir = () => mkdtempSync(join(tmpdir(), "bots-csats-"));
let managers: BotManager[] = [];
afterEach(async () => {
  for (const m of managers) await m.shutdown();
  managers = [];
});

const BROKE = "Not enough cSats: your balance is 0.01 cSats (Harry's budget has 6 left today). This step needs about 0.4 cSats on a Datacenter GPU.";

function setup(policy: "network_only" | "auto", error = BROKE) {
  const clock = { now: new Date(2026, 10, 16, 10, 0).getTime() };
  let balance: number | undefined = 0.01;
  let runs = 0;
  const runner: BotRunner = async () => {
    runs++;
    throw new Error(error);
  };
  const m = new BotManager({ runner, file: join(dir(), "bots.json"), now: () => clock.now, fingerprint: async () => "same", balance: async () => balance });
  managers.push(m);
  const bot = m.create({ name: "Harry", role: "Engineer", projectRoot: dir(), enabled: true, heartbeatMinutes: 30, compute: policy === "network_only" ? { policy, computeClass: "gpu.dc" } : { policy } });
  return { m, id: bot.id, clock, setBalance: (n: number | undefined) => (balance = n), runs: () => runs };
}

async function runOnce(m: BotManager, id: string) {
  m.runNow(id, "heartbeat");
  await m.idle(id);
  await m.settled();
}

describe("Network only, out of cSats", () => {
  it("recognizes the message", () => {
    expect(isOutOfCSatsError(BROKE)).toBe(true);
    expect(isOutOfCSatsError(`Error contacting model: ${BROKE}`)).toBe(true);
    expect(isOutOfCSatsError("No GPU machines online. Available now: CPU (9).")).toBe(false);
  });

  it("pauses its own runs with status Out of cSats, then resumes after a top-up", async () => {
    const { m, id, clock, setBalance, runs } = setup("network_only");
    await runOnce(m, id);
    expect(m.get(id).status).toBe("out_of_csats");
    expect(m.get(id).auto?.outOfCSats).toMatchObject({ balanceCSats: 0.01 });
    // The check-ins don't start a run that would fail the same way.
    clock.now += 31 * 60_000;
    expect(m.tick(clock.now)).toEqual([]);
    expect(await m.checkIn(id, clock.now)).toBe("csats");
    expect(runs()).toBe(1);
    // Same balance: still paused.
    clock.now += 2 * 60_000;
    await m.checkTopUp(clock.now);
    expect(m.get(id).status).toBe("out_of_csats");
    // Topped up: it works on its own again, starting now.
    setBalance(5_000);
    clock.now += 2 * 60_000;
    await m.checkTopUp(clock.now);
    expect(m.get(id).auto?.outOfCSats).toBeUndefined();
    expect(m.get(id).auto?.due).toMatchObject({ kind: "start" });
    expect(m.get(id).status).not.toBe("out_of_csats");
  });

  it("editing it (a bigger budget, other compute) or a new day lets it try again", async () => {
    const { m, id, clock } = setup("network_only");
    await runOnce(m, id);
    m.update(id, { budgetCSatsPerDay: 500 });
    expect(m.get(id).auto?.outOfCSats).toBeUndefined();
    await runOnce(m, id);
    expect(m.get(id).status).toBe("out_of_csats");
    clock.now += 24 * 60 * 60_000;
    m.tick(clock.now);
    expect(m.get(id).auto?.outOfCSats).toBeUndefined();
  });

  it("other policies and other failures keep failing as before", async () => {
    const auto = setup("auto");
    await runOnce(auto.m, auto.id);
    expect(auto.m.get(auto.id).status).toBe("error");
    const cls = setup("network_only", "No GPU machines online. Available now: CPU (9).");
    await runOnce(cls.m, cls.id);
    expect(cls.m.get(cls.id).status).toBe("error");
  });
});
