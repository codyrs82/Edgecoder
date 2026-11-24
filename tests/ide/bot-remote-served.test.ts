import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotManager, botComputeChat, type BotRunner } from "../../src/apps/ide/bots.js";
import { botsSnapshot, runRemoteBotCommand } from "../../src/apps/ide/bot-remote.js";
import { MAX_SNAPSHOT_BYTES, SERVED_CAPS, fitSnapshot, servedFromWhere, servedSummary, type BotsSnapshot, type RemoteBotSummary } from "../../src/common/bot-relay.js";

/*
 * Where each bot reply ran, on the web: the Mac adds a compact served line to each assistant
 * message and each run (model, machine class, place, cSats) from the run's usage events. Optional
 * fields, so a snapshot from an older Mac (none of them) still reads as before.
 */
const dir = () => mkdtempSync(join(tmpdir(), "bot-served-"));
const managers: BotManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
});
function manager(runner: BotRunner) {
  const m = new BotManager({ runner, file: join(dir(), "bots.json"), approvals: new Map() });
  managers.push(m);
  return m;
}

const gpu = { label: "agent-7f3", own: false, computeClass: "gpu.dc", tier: null, hardware: "Datacenter GPU", gpu: "2× NVIDIA A16", region: "eu-central", city: "Frankfurt", country: "DE", promptTokens: 1200, outputTokens: 80 };

describe("served line in the bot snapshot", () => {
  it("each reply and its run name the model, machine class and place, with the cSats", async () => {
    const m = manager(async (ctx) => {
      ctx.sendEvent({ type: "usage", cSats: 1.5, where: "Network · best fit", model: "network/qwen3-coder:30b", served: gpu });
      ctx.sendEvent({ type: "usage", cSats: 2, where: "Network · best fit", model: "network/qwen3-coder:30b", served: { ...gpu, label: "agent-9c1" } });
      ctx.sendEvent({ type: "text", content: "Done." });
    });
    const bot = m.create({ name: "Harry", projectRoot: dir(), enabled: false });
    m.message(bot.id, "Go");
    await m.idle(bot.id);
    const b = botsSnapshot(m, "Mac", "on").bots[0];
    const reply = b.tail.find((x) => x.role === "assistant")!;
    expect(reply.served).toEqual({ model: "qwen3-coder:30b", machine: "Datacenter GPU 2×A16", place: "Frankfurt", machines: 2, calls: 2, cSats: 3.5 });
    expect(b.tail.find((x) => x.role === "user")!.served).toBeUndefined();
    expect(b.lastRun!.served).toMatchObject({ model: "qwen3-coder:30b", machine: "Datacenter GPU 2×A16", cSats: 3.5 });
    // Its route stays as it was, for older web pages.
    expect(b.lastRun!.where).toBe("Network · best fit");
    const hist = runRemoteBotCommand(m, bot.id, { action: "history", args: {} }, "on").data as { items: Array<{ served?: unknown }> };
    expect(hist.items[0].served).toMatchObject({ model: "qwen3-coder:30b", place: "Frankfurt" });
  });

  it("no usage events (a reply on an older Mac, or no model call): no served field", async () => {
    const m = manager(async (ctx) => ctx.sendEvent({ type: "text", content: "Hi." }));
    const bot = m.create({ name: "Harry", projectRoot: dir(), enabled: false });
    m.message(bot.id, "Go");
    await m.idle(bot.id);
    const b = botsSnapshot(m, "Mac", "on").bots[0];
    expect(b.tail.every((x) => x.served === undefined)).toBe(true);
    expect(b.lastRun!.served).toBeUndefined();
  });

  it("caps every field, keeps at most a few models, and the snapshot within its byte cap", async () => {
    const long = "m".repeat(500);
    const s = servedSummary([
      { cSats: 1, where: "x", model: "b" },
      { cSats: 1, where: "x", model: "c" },
      { cSats: 1, where: "x", model: "d" },
      { cSats: 1, where: "x", model: `network/${long}a`, served: { ...gpu, hardware: "H".repeat(300), gpu: undefined, city: "C".repeat(300) } },
    ])!;
    expect(s.models!.length).toBeLessThanOrEqual(SERVED_CAPS.models);
    for (const m of s.models!) expect(m.length).toBeLessThanOrEqual(SERVED_CAPS.model);
    expect(s.machine!.length).toBeLessThanOrEqual(SERVED_CAPS.machine);
    expect(s.place!.length).toBeLessThanOrEqual(SERVED_CAPS.place);

    const served = { model: "x".repeat(SERVED_CAPS.model), machine: "y".repeat(SERVED_CAPS.machine), place: "z".repeat(SERVED_CAPS.place), calls: 99, cSats: 12.5 };
    const bot = (i: number): RemoteBotSummary => ({
      id: `b${i}`, name: "B", role: "", color: "#000000", status: "idle", enabled: true, instructions: "", folderName: "f", schedule: "", heartbeatMinutes: null, maxRunsPerDay: 1, runsToday: 0, runCount: 0,
      budgetCSatsPerDay: null, spentTodayCSats: 0, compute: { policy: "auto" }, triggers: [], maxTriggerRunsPerHour: 1, pending: [], queuedMessages: 0, messageCount: 12, updatedAtMs: 0,
      lastRun: { id: "r", trigger: "manual", startedAtMs: 0, status: "done", summary: "", cSats: 0, served },
      tail: Array.from({ length: 12 }, (_, j) => ({ id: `m${j}`, role: "assistant" as const, content: "w".repeat(4_000), atMs: j, served })),
    });
    const snap: BotsSnapshot = { v: 1, machineName: "Mac", controls: "on", bots: Array.from({ length: 30 }, (_, i) => bot(i)), generatedAtMs: 0 };
    expect(Buffer.byteLength(JSON.stringify(fitSnapshot(snap)))).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  });

  it("frontier calls on the owner's key count their USD, and a local call is this computer", () => {
    expect(servedSummary([{ cSats: 0, where: "Claude", model: "frontier/anthropic/claude-x", usd: 0.02, served: { label: "Anthropic", own: true, computeClass: "frontier", tier: null, hardware: "Anthropic · claude-x", region: null, country: null, usd: 0.02 } }])).toMatchObject({ model: "claude-x", usd: 0.02, cSats: 0 });
    expect(servedSummary([{ cSats: 0, where: "This computer · qwen3.5:9b", model: "qwen3.5:9b", served: { label: "This computer", own: true, computeClass: "local", tier: null, hardware: "This computer (Apple M1 Max)", region: null, country: null } }])).toEqual({ model: "qwen3.5:9b", machine: "This computer (Apple M1 Max)", calls: 1, cSats: 0 });
    expect(servedSummary([])).toBeUndefined();
  });

  it("reads the model and class from Auto's routed line and compute labels", () => {
    expect(servedFromWhere("routed to qwen3-coder:30b on gpu because high complexity")).toEqual({ model: "qwen3-coder:30b", machine: "GPU" });
    expect(servedFromWhere("Network · qwen3:8b · Apple")).toEqual({ model: "qwen3:8b", machine: "Apple" });
    expect(servedFromWhere("My machines · llama3:8b")).toEqual({ model: "llama3:8b", machine: "Your machines" });
    expect(servedFromWhere("Network · best fit")).toEqual({});
    expect(servedFromWhere(undefined)).toEqual({});
  });

  it("a snapshot from an older Mac (no served fields) is still a valid snapshot", () => {
    const old = { v: 1, machineName: "Mac", controls: "on", generatedAtMs: 0, bots: [{ id: "b", name: "B", tail: [{ id: "m", role: "assistant", content: "x", atMs: 1 }], lastRun: { id: "r", trigger: "manual", startedAtMs: 0, status: "done", summary: "", cSats: 0, where: "Network · best fit" } }] } as unknown as BotsSnapshot;
    expect(fitSnapshot(old)).toEqual(old);
  });
});

describe("the network's best fit", () => {
  it("a step on the best fit names the model the coordinator routed it to", async () => {
    const m = manager(async (ctx) => {
      const chat = botComputeChat(ctx, (_p, _plan, onRoute) => async function* () {
        onRoute({ placement: "network", model: "auto", computeClass: "any", cSatsPerSecond: 0, bestFit: true, reason: "network · best fit" });
        yield { delta: "ok" };
        yield { done: true, cSatsSpent: 2, where: "routed to qwen3-coder:30b on gpu because high complexity", served: gpu };
      });
      await chat({ messages: [{ role: "user", content: "do it" }] });
    });
    const bot = m.create({ name: "Harry", projectRoot: dir(), budgetCSatsPerDay: 100 });
    m.runNow(bot.id);
    await m.idle(bot.id);
    const b = botsSnapshot(m, "Mac", "on").bots[0];
    expect(b.lastRun!.served).toMatchObject({ model: "qwen3-coder:30b", machine: "Datacenter GPU 2×A16", place: "Frankfurt", cSats: 2 });
  });
});

describe("cloud bots", () => {
  it("show the model and class when the run's `where` names them, else the run's route as before", async () => {
    const { toRemoteMessage, toRemoteRun } = await import("../../src/portal/routes/cloud-bots.js");
    const routed = "routed to qwen3-coder:30b on gpu because high complexity";
    const msg = toRemoteMessage({ id: "m", botId: "b", userId: "u", role: "assistant", content: "x", runId: "r", meta: { usage: { cSats: 2.5, where: routed, outputTokens: 9 } }, createdAtMs: 1 });
    expect(msg.served).toEqual({ model: "qwen3-coder:30b", machine: "GPU", calls: 1, cSats: 2.5 });
    const run = (where: string | null) =>
      toRemoteRun({ id: "r", botId: "b", userId: "u", trigger: "manual", source: null, status: "done", createdAtMs: 0, startedAtMs: 0, endedAtMs: 1, cSats: 2.5, summary: "", error: null, activity: null, where } as never);
    expect(run(routed).served).toMatchObject({ model: "qwen3-coder:30b", machine: "GPU" });
    expect(run("Network · best fit").served).toBeUndefined();
    expect(run("Network · best fit").where).toBe("Network · best fit");
    expect(toRemoteMessage({ id: "m", botId: "b", userId: "u", role: "user", content: "x", runId: null, meta: null, createdAtMs: 1 }).served).toBeUndefined();
  });
});
