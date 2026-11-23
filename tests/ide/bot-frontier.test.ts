import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatFn } from "../../src/apps/ide/agent-loop.js";
import { BotManager, nextLocalMidnight, registerBotRoutes, type BotRunContext, type BotRunner } from "../../src/apps/ide/bots.js";
import { FRONTIER_ASK_TIMEOUT_MS, FRONTIER_ASK_TOOL, botFrontierChat, type BotFrontierHooks, type FrontierAnswer } from "../../src/apps/ide/bot-frontier.js";
import { botsSnapshot, runRemoteBotCommand } from "../../src/apps/ide/bot-remote.js";
import { FrontierAccess, botSpendKey } from "../../src/apps/ide/frontier-access.js";
import { botControlRequestSchema, remoteBotSettingsSchema } from "../../src/common/bot-relay.js";
import { FrontierKeyStore, type Keychain } from "../../src/inference-api/frontier-keys.js";
import { FrontierSpend } from "../../src/inference-api/frontier-usage.js";

/*
 * A desktop bot led by its owner's frontier key (docs/frontier-keys.md, "Bots and your key"): only
 * for a bot only its owner can start, only from the desktop app, and only after the owner approves
 * each use (this run, or every run today), within the run and daily caps.
 */
const tmp = mkdtempSync(join(tmpdir(), "bot-frontier-"));
const KEY = "sk-ant-api03-FAKEKEY-abcdefghijklmnopqrstuvwxyz0123456789";
const LEAD = "frontier/anthropic/claude-opus-5-5";
const HARD = "Refactor the whole auth module across these files, fix the race condition in the token refresh, migrate the database schema and add tests.\n```ts\n" + "x\n".repeat(400) + "```";

// A fake Anthropic: every call is 2,000 input and 100 output tokens of Opus 5.5 ($4/$20 per M) = $0.01.
let calls = 0;
const fake: Server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (o: Record<string, unknown>) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 2000, output_tokens: 1 } } });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "claude" } });
    ev({ type: "content_block_stop", index: 0 });
    ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } });
    ev({ type: "message_stop" });
    res.end();
  });
});
let BASE = "";
beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  BASE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => fake.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});

const managers: BotManager[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const m of managers.splice(0)) await m.shutdown();
});

function memKeychain(): Keychain {
  const m = new Map<string, string>();
  return { name: "test keychain", set: async (a, s) => void m.set(a, s), get: async (a) => m.get(a) ?? null, remove: async (a) => void m.delete(a) };
}

async function frontier(acct: { id: string | null }) {
  const d = mkdtempSync(join(tmp, "f-"));
  const store = new FrontierKeyStore({ file: join(d, "frontier.json"), keychain: memKeychain() });
  const spend = new FrontierSpend(join(d, "usage.json"));
  const access = new FrontierAccess({ store, spend, account: async () => acct.id, target: { baseDelayMs: 1, maxRetries: 0 } });
  await access.add({ id: "anthropic", key: KEY, skipTest: true, baseUrl: BASE });
  return { store, spend, access };
}

const worker: ChatFn = async () => ({ content: "worker", toolCalls: [] });
const ask = (text = "go") => ({ messages: [{ role: "user", content: text }] });

/**
 * A manager whose runs make `steps` model calls through botFrontierChat (the provider's wiring),
 * recording who answered each one.
 */
function harness(access: FrontierAccess, opts: { steps?: number; now?: () => number; text?: string } = {}) {
  const answered: string[][] = [];
  const runner: BotRunner = async (ctx: BotRunContext) => {
    const chat = botFrontierChat({ bot: ctx.bot, trigger: ctx.trigger ?? "manual", access, worker, hooks: ctx.frontier, sendEvent: ctx.sendEvent, signal: ctx.signal, isCancelled: ctx.isCancelled });
    const got: string[] = [];
    answered.push(got);
    for (let i = 0; i < (opts.steps ?? 1); i++) got.push((await chat(ask(opts.text))).content);
  };
  const m = new BotManager({ runner, file: join(mkdtempSync(join(tmp, "b-")), "bots.json"), approvals: new Map(), now: opts.now, frontierSpentToday: (id) => access.spend.todayFor(botSpendKey(id)) });
  managers.push(m);
  return { m, answered };
}

const desktop = { desktop: true, account: "acct-alice" };
const folder = () => mkdtempSync(join(tmp, "p-"));
const pr = { kind: "pr" as const, enabled: true };

/** Waits until the bot asks to use the key; returns the ask's call id. */
async function asked(m: BotManager, id: string): Promise<string> {
  for (let i = 0; i < 500; i++) {
    const p = m.get(id).pending.find((x) => x.tool === FRONTIER_ASK_TOOL);
    if (p) return p.callId;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the bot never asked");
}

describe("FrontierAccess.forBot: every refusal path, in order", () => {
  const base = { botId: "bot_1", ownerAccount: "acct-alice", trigger: "message", githubTriggers: 0, model: LEAD, runSpentUsd: 0, runCapUsd: 2, dailyCapUsd: 5 };

  it("allows only the owner's own bot, started by the owner, with room in the caps", async () => {
    const acct = { id: "acct-alice" as string | null };
    const { access, spend, store } = await frontier(acct);
    for (const trigger of ["message", "manual", "schedule", "heartbeat", "start", "follow_up"]) expect(await access.forBot({ ...base, trigger })).toEqual({ ok: true, runCapReached: false });
    expect(await access.forBot({ ...base, trigger: "github" })).toMatchObject({ ok: false, reason: "trigger", note: "Claude lead off: GitHub trigger" });
    expect(await access.forBot({ ...base, githubTriggers: 1 })).toMatchObject({ ok: false, reason: "github_trigger", note: "Claude lead off: the bot has GitHub triggers" });
    expect(await access.forBot({ ...base, ownerAccount: undefined })).toMatchObject({ ok: false, reason: "no_owner" });
    expect(await access.forBot({ ...base, ownerAccount: "acct-bob" })).toMatchObject({ ok: false, reason: "other_account" });
    expect(await access.forBot({ ...base, model: "frontier/openai/gpt-5" })).toMatchObject({ ok: false, reason: "no_key" });
    expect(await access.forBot({ ...base, model: "qwen3:8b" })).toMatchObject({ ok: false, reason: "bad_id" });
    // The run cap is reported (the bot asks again), not refused.
    expect(await access.forBot({ ...base, runSpentUsd: 2 })).toEqual({ ok: true, runCapReached: true });
    // The bot's own daily cap, then the key's daily cap.
    spend.record(botSpendKey("bot_1"), "anthropic/claude-opus-5-5", 5, { inputTokens: 0, outputTokens: 0 });
    expect(await access.forBot(base)).toMatchObject({ ok: false, reason: "bot_daily_cap" });
    expect(await access.forBot({ ...base, botId: "bot_2" })).toMatchObject({ ok: true });
    store.updateSettings({ dailyCapUsd: 5 });
    expect(await access.forBot({ ...base, botId: "bot_2" })).toMatchObject({ ok: false, reason: "daily_cap" });
    // Signed out, or another account signed in on this computer.
    acct.id = null;
    expect(await access.forBot(base)).toMatchObject({ ok: false, reason: "not_signed_in" });
    acct.id = "acct-bob";
    expect(await access.forBot({ ...base, botId: "bot_2" })).toMatchObject({ ok: false, reason: "other_account" });
    // Bob's own bot: alice's key belongs to another account.
    expect(await access.forBot({ ...base, botId: "bot_3", ownerAccount: "acct-bob" })).toMatchObject({ ok: false, reason: "no_key" });
  });

  it("logs spend per bot per day", async () => {
    const { spend } = await frontier({ id: "acct-alice" });
    spend.record(botSpendKey("bot_a"), "m", 0.25, { inputTokens: 0, outputTokens: 0 });
    spend.record(botSpendKey("bot_a"), "m", 0.5, { inputTokens: 0, outputTokens: 0 });
    spend.record(botSpendKey("bot_b"), "m", 1, { inputTokens: 0, outputTokens: 0 });
    expect(spend.todayFor(botSpendKey("bot_a"))).toBe(0.75);
    expect(spend.todayFor(botSpendKey("bot_c"))).toBe(0);
    expect(spend.totals().dayUsd).toBe(1.75);
  });
});

describe("the switch: owner-only, desktop-only, never with GitHub triggers", () => {
  it("stamps the owner on create and turns on only from the desktop, signed in, without GitHub triggers", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    const { m } = harness(access);
    const plain = m.create({ name: "Plain", projectRoot: folder(), enabled: false });
    expect(plain.ownerAccount).toBeUndefined();
    expect(() => m.create({ name: "Web", projectRoot: folder(), enabled: false, frontierLead: LEAD })).toThrow(/EdgeCoder app on this computer/);
    expect(() => m.create({ name: "Nobody", projectRoot: folder(), enabled: false, frontierLead: LEAD }, { desktop: true, account: null })).toThrow(/Sign in/);
    expect(() => m.create({ name: "Hooked", projectRoot: folder(), enabled: false, repository: "o/r", triggers: [pr], frontierLead: LEAD }, desktop)).toThrow(/GitHub triggers/);
    const b = m.create({ name: "Mine", projectRoot: folder(), enabled: false, frontierLead: LEAD }, desktop);
    expect(b).toMatchObject({ ownerAccount: "acct-alice", frontierLead: LEAD });
  });

  it("can't be turned on while the bot has any GitHub trigger, enabled or not", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    const { m } = harness(access);
    for (const enabled of [true, false]) {
      const b = m.create({ name: `T${enabled}`, projectRoot: folder(), enabled: false, repository: "o/r", triggers: [{ ...pr, enabled }] }, desktop);
      expect(() => m.update(b.id, { frontierLead: LEAD }, desktop)).toThrow(/GitHub triggers/);
      // Removing the triggers in the same change is fine.
      expect(m.update(b.id, { frontierLead: LEAD, triggers: [] }, desktop).frontierLead).toBe(LEAD);
    }
  });

  it("adding a GitHub trigger turns it off and says so", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    const { m } = harness(access);
    const b = m.create({ name: "Harry", projectRoot: folder(), enabled: false, repository: "o/r", frontierLead: LEAD }, desktop);
    const r = m.update(b.id, { triggers: [pr] }, desktop);
    expect(r.frontierLead).toBeNull();
    expect(r.notice).toMatch(/Claude lead turned off: GitHub triggers let other people start Harry/);
    expect(m.messages(b.id).some((x) => x.role === "event" && /Claude lead turned off/.test(x.content))).toBe(true);
    // From the web too (update_settings with triggers): done, with the same message.
    const b2 = m.create({ name: "Sally", projectRoot: folder(), enabled: false, repository: "o/r", frontierLead: LEAD }, desktop);
    const w = runRemoteBotCommand(m, b2.id, { action: "update_settings", args: { triggers: [pr] } } as never, "on", { requestedBy: "acct-alice" });
    expect(w).toMatchObject({ status: "done", message: expect.stringMatching(/Claude lead turned off/) });
    expect(m.get(b2.id).frontierLead).toBeNull();
  });

  it("the web can't turn it on, change its caps or make a frontier model a bot's compute", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    const { m } = harness(access);
    const b = m.create({ name: "Harry", projectRoot: folder(), enabled: false }, desktop);
    // The relay's own schema has no such field; the provider refuses it even if one slips through.
    expect(remoteBotSettingsSchema.safeParse({ frontierLead: LEAD }).success).toBe(false);
    expect(botControlRequestSchema.safeParse({ action: "update_settings", args: { frontierLead: LEAD } }).success).toBe(false);
    for (const args of [{ frontierLead: LEAD }, { frontierRunCapUsd: 50 }, { frontierDailyCapUsd: 50 }]) {
      expect(runRemoteBotCommand(m, b.id, { action: "update_settings", args } as never, "on", { requestedBy: "acct-alice" })).toMatchObject({ status: "refused", error: "change_on_mac" });
    }
    expect(() => m.update(b.id, { frontierLead: LEAD })).toThrow(/EdgeCoder app on this computer/);
    expect(m.get(b.id).frontierLead).toBeUndefined();
    expect(botControlRequestSchema.safeParse({ action: "create", args: { requestId: "req-00000001", name: "X", compute: { policy: "model", model: LEAD } } }).success).toBe(false);
  });

  it("another account can't turn on a bot that isn't theirs; an older bot without an owner is confirmed by turning it on", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    const { m } = harness(access);
    const old = m.create({ name: "Old", projectRoot: folder(), enabled: false });
    expect(old.ownerAccount).toBeUndefined();
    expect(m.update(old.id, { frontierLead: LEAD }, desktop)).toMatchObject({ ownerAccount: "acct-alice", frontierLead: LEAD });
    const hers = m.create({ name: "Hers", projectRoot: folder(), enabled: false }, desktop);
    expect(() => m.update(hers.id, { frontierLead: LEAD }, { desktop: true, account: "acct-bob" })).toThrow(/belongs to another account/);
  });

  it("the desktop route needs a key for that model for the account signed in here", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    const { m } = harness(access);
    const app = Fastify();
    registerBotRoutes(app, m, { account: async () => "acct-alice", frontierModels: () => access.modelIds() });
    const b = m.create({ name: "Harry", projectRoot: folder(), enabled: false }, desktop);
    const bad = await app.inject({ method: "PATCH", url: `/v1/ide/bots/${b.id}`, payload: { frontierLead: "frontier/openai/gpt-5" } });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error).toMatch(/No key for that model/);
    const ok = await app.inject({ method: "PATCH", url: `/v1/ide/bots/${b.id}`, payload: { frontierLead: LEAD, frontierRunCapUsd: 1, frontierDailyCapUsd: 3 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().bot).toMatchObject({ frontierLead: LEAD, frontierRunCapUsd: 1, frontierDailyCapUsd: 3, ownerAccount: "acct-alice", frontierSpentTodayUsd: 0 });
    await app.close();
  });
});

describe("approval: the owner approves each use", () => {
  it("asks before the first call; approving this run leads with the key, spend is logged under bot:<id>", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    const { m, answered } = harness(access, { steps: 2 });
    const b = m.create({ name: "Harry", projectRoot: folder(), enabled: false, frontierLead: LEAD }, desktop);
    const before = calls;
    m.message(b.id, "Fix the tests");
    const callId = await asked(m, b.id);
    const waiting = m.get(b.id);
    expect(waiting.status).toBe("needs_approval");
    expect(waiting.pending[0]).toMatchObject({ tool: FRONTIER_ASK_TOOL, args: { question: "Use Claude for this run? Up to $2.00." } });
    expect(calls).toBe(before); // nothing sent while it waits
    // The generic tool approval can't answer it; another account can't either.
    expect(m.approve(b.id, callId, true)).toBe(false);
    expect(() => m.answerFrontier(b.id, callId, "run", "acct-bob")).toThrow(/Only Harry's owner/);
    expect(m.answerFrontier(b.id, callId, "run", "acct-alice")).toBe(true);
    await m.idle(b.id);
    expect(answered[0]).toEqual(["claude", "claude"]);
    expect(calls - before).toBe(2);
    expect(access.spend.todayFor(botSpendKey(b.id))).toBeCloseTo(0.02, 6);
    expect(m.get(b.id).frontierSpentTodayUsd).toBeCloseTo(0.02, 6);
    expect(m.history(b.id)[0]).toMatchObject({ where: "Claude Opus 5.5 · your key", cSats: 0 });
    expect(m.history(b.id)[0].frontierUsd).toBeCloseTo(0.02, 6);
    expect(m.messages(b.id).some((x) => x.content === "You approved Claude for this run")).toBe(true);
    // The next run asks again.
    m.message(b.id, "Again");
    await m.answerFrontier(b.id, await asked(m, b.id), "decline", "acct-alice");
    await m.idle(b.id);
    expect(answered[1]).toEqual(["worker", "worker"]);
    expect(m.history(b.id)[0].note).toBe("Claude lead off: you declined");
  });

  it("an unanswered ask runs on the bot's own compute after 30 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { access } = await frontier({ id: "acct-alice" });
    const { m, answered } = harness(access);
    const b = m.create({ name: "Harry", projectRoot: folder(), enabled: false, frontierLead: LEAD }, desktop);
    m.message(b.id, "Fix the tests");
    for (let i = 0; i < 50 && !m.get(b.id).pending.length; i++) await vi.advanceTimersByTimeAsync(1);
    expect(m.get(b.id).status).toBe("needs_approval");
    await vi.advanceTimersByTimeAsync(FRONTIER_ASK_TIMEOUT_MS - 1_000);
    expect(m.get(b.id).status).toBe("needs_approval");
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    await m.idle(b.id);
    expect(answered[0]).toEqual(["worker"]);
    expect(m.history(b.id)[0].note).toBe("Claude lead off: no answer in 30 minutes");
  });

  it("reaching the run cap stops the key and asks again (the run waits)", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    const { m, answered } = harness(access, { steps: 4 });
    // $0.01 a call: the cap is reached after two calls.
    const b = m.create({ name: "Harry", projectRoot: folder(), enabled: false, frontierLead: LEAD, frontierRunCapUsd: 0.015 }, desktop);
    m.message(b.id, "Big job");
    const first = await asked(m, b.id);
    m.answerFrontier(b.id, first, "run", "acct-alice");
    const second = await asked(m, b.id);
    expect(second).not.toBe(first);
    expect(m.get(b.id).pending[0].args).toMatchObject({ why: "run_cap", question: "This run reached its $0.01 cap. Keep using Claude? Up to $0.01 more." });
    expect(m.get(b.id).status).toBe("needs_approval");
    m.answerFrontier(b.id, second, "decline", "acct-alice");
    await m.idle(b.id);
    expect(answered[0]).toEqual(["claude", "claude", "worker", "worker"]);
  });

  it("approve for today: later runs don't ask until local midnight", async () => {
    let now = new Date(2026, 10, 23, 15, 0).getTime();
    const { access } = await frontier({ id: "acct-alice" });
    const { m, answered } = harness(access, { now: () => now });
    const b = m.create({ name: "Harry", projectRoot: folder(), enabled: false, frontierLead: LEAD }, desktop);
    m.message(b.id, "one");
    m.answerFrontier(b.id, await asked(m, b.id), "day", "acct-alice");
    await m.idle(b.id);
    expect(m.get(b.id).frontierApprovedUntilMs).toBe(nextLocalMidnight(now));
    m.message(b.id, "two");
    await m.idle(b.id);
    expect(answered).toEqual([["claude"], ["claude"]]);
    // After midnight it asks again.
    now = new Date(2026, 10, 24, 0, 1).getTime();
    m.message(b.id, "three");
    m.answerFrontier(b.id, await asked(m, b.id), "decline", "acct-alice");
    await m.idle(b.id);
    expect(answered[2]).toEqual(["worker"]);
    // Turning the switch off drops the day's approval.
    m.update(b.id, { frontierLead: null }, desktop);
    expect(m.get(b.id).frontierApprovedUntilMs).toBeUndefined();
  });

  it("another account signed in here: no ask, the bot's own compute, with a note", async () => {
    const acct = { id: "acct-alice" as string | null };
    const { access } = await frontier(acct);
    const { m, answered } = harness(access);
    const b = m.create({ name: "Harry", projectRoot: folder(), enabled: false, frontierLead: LEAD }, desktop);
    acct.id = "acct-bob";
    m.message(b.id, "hi");
    await m.idle(b.id);
    expect(answered[0]).toEqual(["worker"]);
    expect(m.history(b.id)[0].note).toBe("Claude lead off: the bot belongs to another account");
  });

  it("the web relay answers with approve_frontier / decline_frontier, checked against the owner", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    const { m, answered } = harness(access);
    const b = m.create({ name: "Harry", projectRoot: folder(), enabled: false, frontierLead: LEAD }, desktop);
    m.message(b.id, "hi");
    const callId = await asked(m, b.id);
    // The snapshot shows the ask as a pending item and the lead read-only.
    const s = botsSnapshot(m, "Mac", "on").bots[0];
    expect(s.pending[0]).toMatchObject({ callId, tool: FRONTIER_ASK_TOOL, detail: "Use Claude for this run? Up to $2.00." });
    expect(s.frontier).toEqual({ on: true, name: "Claude", spentTodayUsd: 0 });
    expect(runRemoteBotCommand(m, b.id, { action: "approve_frontier", args: { callId, scope: "run" } }, "on", { requestedBy: "acct-bob" })).toMatchObject({ status: "refused", error: "not_this_account" });
    // Approve / Deny (the phone, an older web page) answer it too, owner-only.
    expect(runRemoteBotCommand(m, b.id, { action: "approve", args: { callId, approved: true } }, "on", { requestedBy: "acct-bob" })).toMatchObject({ status: "refused", error: "not_this_account" });
    expect(runRemoteBotCommand(m, b.id, { action: "approve_frontier", args: { callId, scope: "run" } }, "view", { requestedBy: "acct-alice" })).toMatchObject({ status: "refused", error: "view_only" });
    expect(runRemoteBotCommand(m, b.id, { action: "approve_frontier", args: { callId, scope: "run" } }, "on", { requestedBy: "acct-alice" })).toEqual({ status: "done" });
    await m.idle(b.id);
    expect(answered[0]).toEqual(["claude"]);
    expect(runRemoteBotCommand(m, b.id, { action: "decline_frontier", args: { callId } }, "on", { requestedBy: "acct-alice" })).toMatchObject({ status: "refused", error: "no_pending_approval" });
    // The phone's Deny declines.
    m.message(b.id, "again");
    const next = await asked(m, b.id);
    expect(runRemoteBotCommand(m, b.id, { action: "approve", args: { callId: next, approved: false } }, "on", { requestedBy: "acct-alice" })).toEqual({ status: "done" });
    await m.idle(b.id);
    expect(answered[1]).toEqual(["worker"]);
  });

  it("a mode change never answers the ask", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    const { m } = harness(access);
    const b = m.create({ name: "Harry", projectRoot: folder(), enabled: false, frontierLead: LEAD }, desktop);
    m.message(b.id, "hi");
    await asked(m, b.id);
    m.update(b.id, { mode: "auto" });
    expect(m.get(b.id).status).toBe("needs_approval");
    m.cancel(b.id);
    await m.idle(b.id);
  });
});

describe("botFrontierChat", () => {
  const hooks = (answer: FrontierAnswer, asks: unknown[] = []): BotFrontierHooks => ({ ask: async (a) => (asks.push(a), answer), dayApproved: () => false });
  const bot = { id: "bot_x", ownerAccount: "acct-alice", frontierLead: LEAD, triggers: [] as unknown[], compute: { policy: "auto" } };

  it("a GitHub-started run never asks and never uses the key", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    const events: Array<{ type: string; note?: string }> = [];
    const asks: unknown[] = [];
    const chat = botFrontierChat({ bot, trigger: "github", access, worker, hooks: hooks("run", asks), sendEvent: (e) => events.push(e as never) });
    expect((await chat(ask())).content).toBe("worker");
    expect((await chat(ask())).content).toBe("worker");
    expect(asks).toEqual([]);
    expect(events.filter((e) => e.note).map((e) => e.note)).toEqual(["Claude lead off: GitHub trigger"]);
  });

  it("is the worker alone when the switch is off and Auto doesn't use the key", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    expect(botFrontierChat({ bot: { ...bot, frontierLead: null }, trigger: "message", access, worker, hooks: hooks("run"), sendEvent: () => {} })).toBe(worker);
    access.store.updateSettings({ useForAuto: true });
    // Auto with the setting on, but a bot on another compute policy.
    expect(botFrontierChat({ bot: { ...bot, frontierLead: null, compute: { policy: "local_only" } }, trigger: "message", access, worker, hooks: hooks("run"), sendEvent: () => {} })).toBe(worker);
  });

  it("Auto with 'use my frontier key for Auto': only hard steps ask, behind the same approval", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    access.store.updateSettings({ useForAuto: true });
    const asks: unknown[] = [];
    const chat = botFrontierChat({ bot: { ...bot, frontierLead: null }, trigger: "schedule", access, worker, hooks: hooks("run", asks), sendEvent: () => {} });
    expect((await chat(ask("hi"))).content).toBe("worker");
    expect(asks).toEqual([]);
    expect((await chat(ask(HARD))).content).toBe("claude");
    expect(asks).toHaveLength(1);
    expect((await chat(ask("hi"))).content).toBe("worker");
    // A declined ask keeps the run on the worker, hard steps included.
    const declined = botFrontierChat({ bot: { ...bot, frontierLead: null }, trigger: "schedule", access, worker, hooks: hooks("decline"), sendEvent: () => {} });
    expect((await declined(ask(HARD))).content).toBe("worker");
  });

  it("compaction summaries run on the worker", async () => {
    const { access } = await frontier({ id: "acct-alice" });
    const seen: string[] = [];
    const w: ChatFn = async (r) => (seen.push(String(r.messages[0].content)), { content: "summary", toolCalls: [] });
    const chat = botFrontierChat({ bot, trigger: "message", access, worker: w, hooks: hooks("run"), sendEvent: () => {} });
    expect(await chat.summarize!("long text")).toBe("summary");
    expect(seen[0]).toMatch(/^Summarize this coding-agent conversation/);
  });
});
