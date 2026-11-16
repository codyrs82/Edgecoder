import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { BotManager, type BotRunner } from "../../src/apps/ide/bots.js";
import { botsSnapshot, registerRemoteBotRoutes, runRemoteBotCommand } from "../../src/apps/ide/bot-remote.js";
import { MAX_SNAPSHOT_BYTES, SNAPSHOT_MESSAGE_CHARS, SNAPSHOT_TAIL_MESSAGES } from "../../src/common/bot-relay.js";

/*
 * Bots on the web, the provider's side: what the Mac publishes (capped, no full paths), and the
 * owner's commands from the web going through the same BotManager calls and validation as the
 * desktop app, with the bot's own approvals still in charge.
 */
const dir = () => mkdtempSync(join(tmpdir(), "bot-remote-"));
const managers: BotManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
});

function manager(runner: BotRunner = async (ctx) => ctx.sendEvent({ type: "text", content: "On it." })) {
  const m = new BotManager({ runner, file: join(dir(), "bots.json"), approvals: new Map() });
  managers.push(m);
  return m;
}

describe("snapshot", () => {
  it("publishes summaries with a capped conversation tail and only the folder's name", async () => {
    const m = manager(async (ctx) => ctx.sendEvent({ type: "text", content: "x".repeat(50_000) }));
    const root = join(dir(), "Harry the Engineer");
    mkdirSync(root);
    const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: root, enabled: false });
    for (let i = 0; i < 3; i++) {
      m.message(bot.id, `hello ${i}`);
      await m.idle(bot.id);
    }
    const s = botsSnapshot(m, "MAW-MB-02", "on");
    expect(s).toMatchObject({ v: 1, machineName: "MAW-MB-02", controls: "on" });
    const b = s.bots[0];
    expect(b).toMatchObject({ id: bot.id, name: "Harry", role: "Lead Developer", folderName: "Harry the Engineer", status: "paused" });
    expect(JSON.stringify(s)).not.toContain(root);
    expect(b.messageCount).toBe(6);
    expect(b.tail.length).toBeLessThanOrEqual(SNAPSHOT_TAIL_MESSAGES);
    for (const msg of b.tail) expect(msg.content.length).toBeLessThanOrEqual(SNAPSHOT_MESSAGE_CHARS);
    expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThan(MAX_SNAPSHOT_BYTES);
  });
});

describe("commands from the web", () => {
  it("message, pause, resume, check now, history and memory", async () => {
    const m = manager();
    const bot = m.create({ name: "Harry", projectRoot: dir(), enabled: false });
    expect(runRemoteBotCommand(m, bot.id, { action: "message", args: { content: "Ship it" } }, "on")).toMatchObject({ status: "done", data: { started: true } });
    await m.idle(bot.id);
    expect(m.messages(bot.id).map((x) => x.content)).toContain("Ship it");
    expect(runRemoteBotCommand(m, bot.id, { action: "resume", args: {} }, "on").status).toBe("done");
    expect(m.get(bot.id).enabled).toBe(true);
    expect(runRemoteBotCommand(m, bot.id, { action: "pause", args: {} }, "on").status).toBe("done");
    expect(m.get(bot.id).enabled).toBe(false);
    expect(runRemoteBotCommand(m, bot.id, { action: "check_now", args: {} }, "on").status).toBe("done");
    await m.idle(bot.id);
    const hist = runRemoteBotCommand(m, bot.id, { action: "history", args: {} }, "on");
    expect((hist.data as { items: unknown[] }).items.length).toBe(2);
    expect(runRemoteBotCommand(m, bot.id, { action: "memory", args: {} }, "on")).toMatchObject({ status: "done", data: { memory: "" } });
    expect(runRemoteBotCommand(m, "bot_nope", { action: "pause", args: {} }, "on")).toMatchObject({ status: "refused", error: "no_such_bot" });
  });

  it("older messages come in pages", async () => {
    const m = manager();
    const bot = m.create({ name: "P", projectRoot: dir(), enabled: false });
    for (let i = 0; i < 5; i++) {
      m.message(bot.id, `m${i}`);
      await m.idle(bot.id);
    }
    const all = m.messages(bot.id);
    const page = runRemoteBotCommand(m, bot.id, { action: "messages", args: { beforeMs: all[all.length - 2].atMs + 0, limit: 3 } }, "on").data as { items: Array<{ content: string }>; more: boolean };
    expect(page.items.length).toBeLessThanOrEqual(3);
    expect(page.more).toBe(true);
  });

  it("settings: the desktop form's validation, and never the folder, repository, tools or auto-approval", async () => {
    const m = manager();
    const bot = m.create({ name: "S", projectRoot: dir(), enabled: false });
    expect(runRemoteBotCommand(m, bot.id, { action: "update_settings", args: { name: "Sam", schedule: "every 2 hours", budgetCSatsPerDay: 50 } }, "on").status).toBe("done");
    expect(m.get(bot.id)).toMatchObject({ name: "Sam", schedule: "every 2 hours", budgetCSatsPerDay: 50 });
    // BotManager's own checks (a schedule more often than every 5 minutes) still apply.
    expect(runRemoteBotCommand(m, bot.id, { action: "update_settings", args: { schedule: "every 1 minute" } }, "on").status).toBe("refused");
    expect(runRemoteBotCommand(m, bot.id, { action: "update_settings", args: { compute: { policy: "nonsense" } } }, "on")).toMatchObject({ status: "refused", error: "invalid_settings" });
    const sneaky = runRemoteBotCommand(m, bot.id, { action: "update_settings", args: { projectRoot: "/", allowedTools: ["run_shell"] } as never }, "on");
    expect(sneaky).toMatchObject({ status: "refused", error: "change_on_mac" });
    expect(m.get(bot.id).projectRoot).not.toBe("/");
  });

  it("view-only refuses changes but still answers reads", async () => {
    const m = manager();
    const bot = m.create({ name: "V", projectRoot: dir(), enabled: false });
    expect(runRemoteBotCommand(m, bot.id, { action: "pause", args: {} }, "view")).toMatchObject({ status: "refused", error: "view_only" });
    expect(runRemoteBotCommand(m, bot.id, { action: "memory", args: {} }, "view").status).toBe("done");
  });

  it("approvals: only a call the bot is waiting on, and the bot's run continues with the answer", async () => {
    const answers: boolean[] = [];
    const m = manager(async (ctx) => {
      answers.push(await ctx.waitForApproval("tc_9", "run_shell", { command: "npm test" }));
    });
    const bot = m.create({ name: "A", projectRoot: dir(), enabled: false });
    m.runNow(bot.id);
    await new Promise((r) => setTimeout(r, 5));
    const snap = botsSnapshot(m, "mac", "on").bots[0];
    expect(snap.status).toBe("needs_approval");
    expect(snap.pending).toEqual([{ callId: "tc_9", tool: "run_shell", detail: "npm test" }]);
    expect(runRemoteBotCommand(m, bot.id, { action: "approve", args: { callId: "tc_other", approved: true } }, "on")).toMatchObject({ status: "refused", error: "no_pending_approval" });
    // Read-only machines show "Approve on your Mac": the answer is refused here.
    expect(runRemoteBotCommand(m, bot.id, { action: "approve", args: { callId: "tc_9", approved: true } }, "view").error).toBe("view_only");
    expect(runRemoteBotCommand(m, bot.id, { action: "approve", args: { callId: "tc_9", approved: false } }, "on").status).toBe("done");
    await m.idle(bot.id);
    expect(answers).toEqual([false]);
  });

  it("the route refuses a command unless the account signed in on the Mac asked", async () => {
    const m = manager();
    const bot = m.create({ name: "R", projectRoot: dir(), enabled: false });
    const app = Fastify();
    registerRemoteBotRoutes(app, m, { account: async () => "acct-owner" });
    const post = (body: unknown) => app.inject({ method: "POST", url: "/v1/ide/bots/remote/command", payload: body as object });
    expect((await post({ requestedBy: "acct-other", botId: bot.id, action: "pause" })).statusCode).toBe(403);
    expect((await post({ requestedBy: "acct-owner", botId: bot.id, action: "format_disk" })).statusCode).toBe(400);
    const ok = await post({ requestedBy: "acct-owner", botId: bot.id, action: "resume", args: {} });
    expect(ok.json()).toMatchObject({ status: "done" });
    const snap = await app.inject({ method: "GET", url: "/v1/ide/bots/remote/snapshot?machine=MAW-MB-02&controls=on" });
    expect(snap.json().bots[0]).toMatchObject({ name: "R", enabled: true });
    await app.close();
  });
});
