import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { BotManager, botFolderName, registerBotRoutes, type BotRunner } from "../../src/apps/ide/bots.js";
import { registerRemoteBotRoutes, runRemoteBotCommand } from "../../src/apps/ide/bot-remote.js";
import { botControlRequestSchema, webBotId } from "../../src/common/bot-relay.js";

/*
 * Bots made on the web (#409), the provider's side: the relay's "create" makes the bot the way a
 * local create does, but without a folder. It is "Needs folder" and does nothing on its own until
 * this computer sets the folder; the web's folder is only ever a suggestion (the path guard), and
 * an Auto mode asked for on the web needs the Mac's confirmation.
 */
const dir = () => mkdtempSync(join(tmpdir(), "bot-web-"));
const managers: BotManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
});

function manager(home = dir()) {
  const runs: string[] = [];
  const runner: BotRunner = async (ctx) => {
    runs.push(ctx.bot.projectRoot);
    ctx.sendEvent({ type: "text", content: "On it." });
  };
  const m = new BotManager({ runner, file: join(dir(), "bots.json"), approvals: new Map(), botsHome: () => home });
  managers.push(m);
  return { m, runs, home };
}

const ACCOUNT = "acct-owner";
const create = (m: BotManager, requestId: string, extra: Record<string, unknown> = {}, requestedBy = ACCOUNT) =>
  runRemoteBotCommand(m, webBotId(requestedBy, requestId), botControlRequestSchema.parse({ action: "create", args: { requestId, name: "Harry", role: "Engineer", instructions: "Keep the docs current", ...extra } }), "on", { requestedBy });

describe("create from the relay", () => {
  it("makes a bot without a folder: Needs folder, nothing runs, no messages, no clone", async () => {
    const { m, runs } = manager();
    const r = create(m, "req-aaaaaaaa", { repository: "octo/site", schedule: "hourly", budgetCSatsPerDay: 50, compute: { policy: "network_only", computeClass: "gpu" } });
    expect(r).toMatchObject({ status: "done", data: { created: true, status: "needs_folder" } });
    const id = webBotId(ACCOUNT, "req-aaaaaaaa");
    const bot = m.get(id);
    expect(bot).toMatchObject({ projectRoot: "", status: "needs_folder", schedule: "hourly", budgetCSatsPerDay: 50, compute: { policy: "network_only", computeClass: "gpu" }, repository: "octo/site", mode: "auto-edits" });
    expect(bot.nextRun).toBeUndefined();
    expect(bot.repo).toBeUndefined();
    expect(m.runNow(id)).toEqual({ started: false, reason: "needs_folder" });
    expect(() => m.message(id, "hi")).toThrow(/folder/);
    expect(m.tick(Date.now() + 10 * 3_600_000)).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("idempotent per request and account; another account's request makes another bot; a mismatched id is refused", () => {
    const { m } = manager();
    create(m, "req-bbbbbbbb");
    expect(create(m, "req-bbbbbbbb")).toMatchObject({ status: "done", data: { created: false } });
    expect(m.list().length).toBe(1);
    expect(create(m, "req-bbbbbbbb", {}, "acct-other")).toMatchObject({ status: "done", data: { created: true } });
    expect(m.list().length).toBe(2);
    const wrong = runRemoteBotCommand(m, "bot_w000000000000", botControlRequestSchema.parse({ action: "create", args: { requestId: "req-cccccccc", name: "X" } }), "on", { requestedBy: ACCOUNT });
    expect(wrong).toMatchObject({ status: "refused", error: "bad_bot_id" });
    expect(runRemoteBotCommand(m, webBotId(ACCOUNT, "req-cccccccc"), botControlRequestSchema.parse({ action: "create", args: { requestId: "req-cccccccc", name: "X" } }), "view", { requestedBy: ACCOUNT })).toMatchObject({ status: "refused", error: "view_only" });
  });

  it("set folder (default) → it starts on its job in that folder", async () => {
    const { m, runs, home } = manager();
    create(m, "req-dddddddd");
    const id = webBotId(ACCOUNT, "req-dddddddd");
    const bot = m.setupFolder(id, { kind: "default" });
    const expected = join(home, "Harry");
    expect(bot).toMatchObject({ projectRoot: expected, status: "idle" });
    expect(bot.setup).toBeUndefined();
    expect(existsSync(expected)).toBe(true);
    expect(bot.nextRun?.kind).toBe("start");
    expect(m.tick()).toEqual([id]);
    await m.idle(id);
    expect(runs).toEqual([expected]);
    // Only once: it now has a folder.
    expect(() => m.setupFolder(id, { kind: "default" })).toThrow(/already has a folder/);
  });

  it("set folder (an existing one) clones its repository afterwards; a missing path is refused", () => {
    const { m } = manager();
    const repos: string[] = [];
    (m as any).deps.ensureRepo = async (r: string) => (repos.push(r), { path: dir(), message: "ok" });
    create(m, "req-eeeeeeee", { repository: "octo/site" });
    const id = webBotId(ACCOUNT, "req-eeeeeeee");
    expect(repos).toEqual([]);
    expect(() => m.setupFolder(id, { kind: "path", path: join(dir(), "nope") })).toThrow(/No folder/);
    expect(() => m.setupFolder(id, { kind: "path", path: "relative/path" })).toThrow(/absolute/);
    const root = dir();
    expect(m.setupFolder(id, { kind: "path", path: root }).projectRoot).toBe(root);
    expect(repos).toEqual(["octo/site"]);
  });

  it("Auto asked on the web stays Accept edits unless the Mac confirms it", () => {
    const { m } = manager();
    create(m, "req-ffffffff", { mode: "auto" });
    create(m, "req-gggggggg", { mode: "auto" });
    const a = webBotId(ACCOUNT, "req-ffffffff"), b = webBotId(ACCOUNT, "req-gggggggg");
    expect(m.get(a).mode).toBe("auto-edits");
    expect(m.setupFolder(a, { kind: "path", path: dir() }).mode).toBe("auto-edits");
    expect(m.setupFolder(b, { kind: "path", path: dir() }, { allowAuto: true }).mode).toBe("auto");
    // Manual or Plan from the web are kept as they are (they ask more, not less).
    create(m, "req-hhhhhhhh", { mode: "ask" });
    expect(m.get(webBotId(ACCOUNT, "req-hhhhhhhh")).mode).toBe("ask");
  });

  it("frontier models are refused", () => {
    const { m } = manager();
    expect(() => create(m, "req-iiiiiiii", { compute: { policy: "model", model: "frontier/anthropic/claude-x" } })).toThrow();
  });
});

describe("the path guard: a web-suggested folder is never used without the Mac", () => {
  it("the suggestion is stored, not created, and nothing from the web can set a folder", () => {
    const { m } = manager();
    const suggested = join(dir(), "Suggested", "Harry");
    const existing = dir();
    create(m, "req-jjjjjjjj", { suggestedFolder: suggested });
    create(m, "req-kkkkkkkk", { suggestedFolder: existing });
    const id = webBotId(ACCOUNT, "req-jjjjjjjj"), id2 = webBotId(ACCOUNT, "req-kkkkkkkk");
    expect(existsSync(suggested)).toBe(false);
    // Even an existing folder the web names is not used until the Mac confirms it.
    expect(m.get(id2)).toMatchObject({ projectRoot: "", status: "needs_folder", setup: { suggestedFolder: existing } });
    for (const args of [{ projectRoot: existing }, { repository: "octo/x" }, { mode: "auto" }]) {
      // The relay's schema has no such field (the coordinator and the agent check it), and the Mac refuses it too.
      expect(botControlRequestSchema.safeParse({ action: "update_settings", args: { name: "H", ...args } }).success, JSON.stringify(args)).toBe(false);
      const r = runRemoteBotCommand(m, id2, { action: "update_settings", args: { name: "H", ...args } } as never, "on", { requestedBy: ACCOUNT });
      expect(r.status, JSON.stringify(args)).toBe("refused");
    }
    // Safe settings may still change from the web; the bot still has no folder.
    expect(runRemoteBotCommand(m, id2, botControlRequestSchema.parse({ action: "update_settings", args: { budgetCSatsPerDay: 7 } }), "on", { requestedBy: ACCOUNT }).status).toBe("done");
    expect(m.get(id2)).toMatchObject({ projectRoot: "", status: "needs_folder", budgetCSatsPerDay: 7 });
    expect(runRemoteBotCommand(m, id, botControlRequestSchema.parse({ action: "check_now", args: {} }), "on", { requestedBy: ACCOUNT }).status).toBe("refused");
    expect(m.get(id).projectRoot).toBe("");
  });

  it("over HTTP: the relay's command route can't set a folder; the app's own folder route can", async () => {
    const { m } = manager();
    const app = Fastify();
    registerBotRoutes(app, m);
    registerRemoteBotRoutes(app, m, { account: async () => ACCOUNT });
    const requestId = "req-llllllll";
    const id = webBotId(ACCOUNT, requestId);
    const suggested = dir();
    // Someone else's account is refused on this Mac.
    const other = await app.inject({ method: "POST", url: "/v1/ide/bots/remote/command", payload: { requestedBy: "acct-other", botId: webBotId("acct-other", requestId), action: "create", args: { requestId, name: "Harry" } } });
    expect(other.statusCode).toBe(403);
    const made = await app.inject({ method: "POST", url: "/v1/ide/bots/remote/command", payload: { requestedBy: ACCOUNT, botId: id, action: "create", args: { requestId, name: "Harry", suggestedFolder: suggested } } });
    expect(made.json()).toMatchObject({ status: "done", data: { botId: id, created: true } });
    const viaWeb = await app.inject({ method: "POST", url: "/v1/ide/bots/remote/command", payload: { requestedBy: ACCOUNT, botId: id, action: "update_settings", args: { projectRoot: suggested } } });
    expect(viaWeb.json().status).toBe("refused");
    expect(m.get(id).projectRoot).toBe("");
    // The desktop's card: "Use an existing folder" with the suggestion, confirmed here.
    const set = await app.inject({ method: "POST", url: `/v1/ide/bots/${id}/folder`, payload: { choice: "path", path: suggested } });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().bot).toMatchObject({ projectRoot: suggested, status: "idle" });
    expect((await app.inject({ method: "POST", url: `/v1/ide/bots/${id}/folder`, payload: { choice: "default" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/v1/ide/bots/${id}/folder`, payload: { choice: "path" } })).statusCode).toBe(400);
    await app.close();
  });

  it("a local edit that sets the folder is the confirmation too", () => {
    const { m } = manager();
    create(m, "req-mmmmmmmm");
    const id = webBotId(ACCOUNT, "req-mmmmmmmm");
    const root = dir();
    expect(m.update(id, { projectRoot: root, role: "Docs" })).toMatchObject({ projectRoot: root, role: "Docs", status: "idle" });
  });

  it("folder names from bot names are safe", () => {
    expect(botFolderName("../../etc")).toBe("etc");
    expect(botFolderName("a/b\\c:d")).toBe("a b c d");
    expect(botFolderName("...")).toBe("Bot");
    mkdirSync(join(dir(), botFolderName("Harry the Engineer")));
  });
});
