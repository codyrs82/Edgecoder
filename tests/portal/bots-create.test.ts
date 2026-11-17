import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import vm from "node:vm";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerBotRoutes, MAX_PENDING_BOTS, type PendingBot, type PendingBotStore } from "../../src/portal/routes/bots.js";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { webBotId } from "../../src/common/bot-relay.js";

/*
 * New bots from the web (#409), portal side: only the session's account, only its own machines;
 * a new bot is kept (pending) until a Mac made it, sent as the relay's "create" to the machine
 * picked or the first that can take it, never twice for one request id, and dropped from pending
 * once the Mac's list shows it ("Needs folder" until the folder is set there).
 */
const SERVICE = "s".repeat(40);
const NOW = Date.now();
const sent: Array<{ agentId: string; body: any }> = [];
const coord = {
  /** Machines online with an app that can create, and the bots each one shows. */
  canCreate: new Set<string>(["mac-1"]),
  connected: new Set<string>(["mac-1", "mac-2"]),
  bots: new Map<string, any[]>(),
  results: new Map<string, any>(),
};

function bot(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, role: "", color: "#0090ff", status: "idle", enabled: true, instructions: "", folderName: "", schedule: "", heartbeatMinutes: 30, maxRunsPerDay: 48, runsToday: 0, runCount: 0, budgetCSatsPerDay: 100, spentTodayCSats: 0, compute: { policy: "auto" }, triggers: [], maxTriggerRunsPerHour: 6, pending: [], queuedMessages: 0, tail: [], messageCount: 0, updatedAtMs: 1, ...extra };
}

function fakeCoordinator(): Server {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = req.url ?? "";
      const json = (code: number, j: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(j));
      };
      if (req.headers["x-portal-service-token"] !== SERVICE) return json(401, { error: "unauthorized" });
      if (url === "/agent-control/bots") {
        return json(200, {
          machines: ["mac-1", "mac-2"].map((agentId) => ({
            agentId,
            connected: coord.connected.has(agentId),
            reportedAtMs: NOW,
            lastSeenMs: NOW,
            snapshot: { v: 1, machineName: agentId === "mac-1" ? "MAW-MB-02" : "MAW-MB-03", controls: "on", ...(coord.canCreate.has(agentId) ? { features: ["create"] } : {}), generatedAtMs: NOW, bots: coord.bots.get(agentId) ?? [] },
          })),
        });
      }
      const m = /^\/agent-control\/agents\/([^/]+)\/bot-commands$/.exec(url);
      if (m) {
        const agentId = decodeURIComponent(m[1]);
        if (!coord.connected.has(agentId)) return json(409, { error: "agent_not_connected" });
        sent.push({ agentId, body });
        const commandId = `cmd-${String(sent.length).padStart(8, "0")}`;
        coord.results.set(commandId, { agentId, botId: body.botId, action: body.action, accountId: body.accountId });
        return json(200, { ok: true, commandId });
      }
      const r = /^\/agent-control\/bot-commands\/([^/]+)$/.exec(url);
      if (r) {
        const e = coord.results.get(r[1]);
        if (!e || e.accountId !== body.accountId) return json(404, { error: "unknown_command" });
        return json(200, { status: e.result?.status ?? "sent", agentId: e.agentId, botId: e.botId, action: e.action, ...(e.result ? { result: e.result } : {}) });
      }
      json(404, {});
    });
  });
}

/** The portal database's pending rows, with the version check of PortalStore.savePendingBots. */
function memoryStore(): PendingBotStore & { rows: Map<string, { list: PendingBot[]; version: number }> } {
  const rows = new Map<string, { list: PendingBot[]; version: number }>();
  return {
    rows,
    async getPendingBots(userId) {
      const r = rows.get(userId);
      return r ? { list: structuredClone(r.list), version: r.version } : { list: [], version: 0 };
    },
    async savePendingBots(userId, list, version, nowMs) {
      if ((rows.get(userId)?.version ?? 0) !== version) return false;
      if (!list.length) rows.delete(userId);
      else rows.set(userId, { list: structuredClone(list), version: Math.max(nowMs, version + 1) });
      return true;
    },
    async listPendingBotOwners() {
      return [...rows.keys()];
    },
  };
}

let server: Server;
let app: ReturnType<typeof Fastify>;
let store: ReturnType<typeof memoryStore>;
const as = (user: string | null) => (user ? { "x-test-user": user } : {});
const create = (user: string | null, payload: unknown) => app.inject({ method: "POST", url: "/portal/api/bots/new", headers: as(user), payload: payload as any });
const list = (user = "u1") => app.inject({ url: "/portal/api/bots", headers: as(user) }).then((r) => r.json());
const spec = { name: "Harry", role: "Engineer", instructions: "Fix issues", mode: "auto", suggestedFolder: "~/Projects/site" };

beforeAll(async () => {
  server = fakeCoordinator();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  store = memoryStore();
  app = Fastify();
  registerBotRoutes(app, {
    PORTAL_SERVICE_TOKEN: SERVICE,
    EXTERNAL_HTTP_TIMEOUT_MS: 3000,
    discoverCoordinatorUrlsForPortal: async () => [`http://127.0.0.1:${(server.address() as AddressInfo).port}`],
    getCurrentUser: async (req) => (req.headers["x-test-user"] ? { userId: String(req.headers["x-test-user"]) } : null),
    pendingSweepMs: 0,
    store: {
      ...store,
      listNodesByOwner: async (userId: string) => (userId === "u1" ? [{ nodeId: "mac-1", nodeKind: "agent" }, { nodeId: "mac-2", nodeKind: "agent" }, { nodeId: "mac-3", nodeKind: "agent" }] : [{ nodeId: "other-1", nodeKind: "agent" }]),
    },
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  sent.length = 0;
  store.rows.clear();
  coord.bots.clear();
  coord.canCreate = new Set(["mac-1"]);
  coord.connected = new Set(["mac-1", "mac-2"]);
});

describe("POST /portal/api/bots/new", () => {
  it("needs a session, a valid bot, and one of my machines", async () => {
    expect((await create(null, { requestId: "req-00000001", bot: spec })).statusCode).toBe(401);
    expect((await create("u1", { requestId: "req-00000001", bot: { ...spec, name: "" } })).statusCode).toBe(400);
    expect((await create("u1", { requestId: "req-00000001", bot: { ...spec, projectRoot: "/" } })).statusCode).toBe(400);
    expect((await create("u1", { requestId: "req-00000001", bot: { ...spec, compute: { policy: "model", model: "frontier/anthropic/x" } } })).statusCode).toBe(400);
    expect((await create("u2", { requestId: "req-00000001", agentId: "mac-1", bot: spec })).statusCode).toBe(403);
    expect(sent).toEqual([]);
    expect(store.rows.size).toBe(0);
  });

  it("an online Mac gets the create at once, for the session's account; a retry sends nothing new", async () => {
    const res = await create("u1", { requestId: "req-00000002", agentId: "mac-1", bot: spec });
    expect(res.statusCode, res.body).toBe(200);
    const botId = webBotId("acct-u1", "req-00000002");
    expect(res.json()).toMatchObject({ ok: true, botId, state: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ agentId: "mac-1", body: { accountId: "acct-u1", botId, action: "create", args: { requestId: "req-00000002", name: "Harry", mode: "auto", suggestedFolder: "~/Projects/site" } } });
    const again = await create("u1", { requestId: "req-00000002", agentId: "mac-1", bot: spec });
    expect(again.json()).toMatchObject({ botId, state: "sent" });
    expect(sent).toHaveLength(1);
    // The Mac made it: the list shows the bot (Needs folder) and the pending entry is gone.
    coord.results.get("cmd-00000001").result = { commandId: "cmd-00000001", status: "done", data: { botId, created: true } };
    coord.bots.set("mac-1", [bot(botId, "Harry", { status: "needs_folder", setup: { autoRequested: true } })]);
    const j = await list();
    expect(j.pending).toEqual([]);
    expect(j.bots).toMatchObject([{ id: botId, status: "needs_folder", machine: { agentId: "mac-1", canCreate: true } }]);
    expect(store.rows.size).toBe(0);
    // And once made, the same request again makes nothing.
    expect((await create("u1", { requestId: "req-00000002", agentId: "mac-1", bot: spec })).json()).toMatchObject({ state: "created" });
    expect(sent).toHaveLength(1);
  });

  it("no Mac that can take it: kept pending, sent to the first that can when the list is next read", async () => {
    coord.canCreate.clear();
    const res = await create("u1", { requestId: "req-00000003", agentId: null, bot: spec });
    expect(res.json()).toMatchObject({ state: "waiting" });
    expect(sent).toEqual([]);
    let j = await list();
    expect(j.pending).toMatchObject([{ requestId: "req-00000003", name: "Harry", state: "waiting", target: null }]);
    // The pending view carries no settings (instructions stay server-side).
    expect(JSON.stringify(j.pending)).not.toContain("Fix issues");
    expect(j.targets).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: "mac-1", canCreate: false }), expect.objectContaining({ agentId: "mac-3", online: false })]));
    coord.canCreate.add("mac-2");
    j = await list();
    expect(sent).toHaveLength(1);
    expect(sent[0].agentId).toBe("mac-2");
    expect(j.pending[0]).toMatchObject({ state: "sent", machineName: "MAW-MB-03" });
  });

  it("a chosen machine is waited for, even when another one is online", async () => {
    await create("u1", { requestId: "req-00000004", agentId: "mac-3", bot: spec });
    await list();
    expect(sent).toEqual([]);
    expect((await list()).pending[0]).toMatchObject({ state: "waiting", target: "mac-3" });
  });

  it("a refusal from the Mac shows as failed; a lost command is sent again", async () => {
    await create("u1", { requestId: "req-00000005", agentId: "mac-1", bot: spec });
    coord.results.get("cmd-00000001").result = { commandId: "cmd-00000001", status: "refused", error: "invalid_settings", message: "Unknown trigger" };
    expect((await list()).pending[0]).toMatchObject({ state: "failed", error: "invalid_settings", message: "Unknown trigger" });
    await create("u1", { requestId: "req-00000006", agentId: "mac-1", bot: spec });
    coord.results.get("cmd-00000002").result = { commandId: "cmd-00000002", status: "refused", error: "agent_rate_limited" };
    await list();
    // Rate limited on the Mac: back to waiting and sent again.
    expect(sent.filter((s) => s.body.args.requestId === "req-00000006")).toHaveLength(2);
  });

  it("cancel, the per-account cap, and another user's list stays empty", async () => {
    coord.canCreate.clear();
    for (let i = 0; i < MAX_PENDING_BOTS; i++) expect((await create("u1", { requestId: `req-1000000${i}`, bot: spec })).statusCode).toBe(200);
    expect((await create("u1", { requestId: "req-20000000", bot: spec })).statusCode).toBe(429);
    expect((await list("u2")).pending).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: "/portal/api/bots/pending/req-10000000", headers: as("u2") })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/portal/api/bots/pending/req-10000000", headers: as("u1") })).statusCode).toBe(200);
    expect((await list()).pending).toHaveLength(MAX_PENDING_BOTS - 1);
  });

  it("the commands route doesn't take create (it goes through /new)", async () => {
    const r = await app.inject({ method: "POST", url: "/portal/api/bots/mac-1/bot_x/commands", headers: as("u1"), payload: { action: "create", args: { requestId: "req-00000007", name: "H" } } });
    expect(r.statusCode).toBe(400);
    expect(sent).toEqual([]);
  });
});

describe("the sweep sends pending bots with nobody on the page", () => {
  it("retries every pendingSweepMs", async () => {
    const a = Fastify();
    const s = memoryStore();
    registerBotRoutes(a, {
      PORTAL_SERVICE_TOKEN: SERVICE,
      EXTERNAL_HTTP_TIMEOUT_MS: 3000,
      discoverCoordinatorUrlsForPortal: async () => [`http://127.0.0.1:${(server.address() as AddressInfo).port}`],
      getCurrentUser: async () => ({ userId: "u1" }),
      pendingSweepMs: 30,
      store: { ...s, listNodesByOwner: async () => [{ nodeId: "mac-1", nodeKind: "agent" }] },
    });
    await a.ready();
    coord.canCreate.clear();
    await a.inject({ method: "POST", url: "/portal/api/bots/new", payload: { requestId: "req-30000000", bot: spec } });
    expect(sent).toEqual([]);
    coord.canCreate.add("mac-1");
    const end = Date.now() + 2000;
    while (!sent.length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    await a.close();
  });
});

describe("the page", () => {
  it("has New bot with the desktop form's fields, Runs on, and pending cards; its scripts parse", async () => {
    const a = Fastify();
    registerPortalPages(a);
    const html = (await a.inject({ url: "/portal/bots" })).body;
    await a.close();
    for (const id of ["bnOpen", "bnDialog", "bnForm", "bnTemplate", "bnTarget", "bnSchedule", "bnHeartbeat", "bnCompute", "bnClass", "bnMode", "bnTriggers", "bnSave"]) expect(html, id).toContain(`id="${id}"`);
    for (const name of ["name", "role", "instructions", "maxRunsPerDay", "budgetCSatsPerDay", "repository", "suggestedFolder"]) expect(html, name).toContain(`name="${name}"`);
    expect(html).toContain("Only a suggestion: the Mac asks before it uses or creates any folder.");
    expect(html).toContain("Auto (confirm on the Mac)");
    expect(html).toContain("/portal/api/bots/new");
    expect(html).toContain("data-cancel-pending");
    expect(html).toContain("Needs folder: open the EdgeCoder app on");
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) if (!/\bsrc=/.test(m[1])) expect(() => new vm.Script(m[2])).not.toThrow();
    // The shared helpers say "Needs folder" like the desktop.
    const ctx: Record<string, any> = { escapeHtml: (s: unknown) => String(s ?? "") };
    vm.createContext(ctx);
    const helpers = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("function botAvatarHtml"))!;
    vm.runInContext(helpers.slice(helpers.indexOf("var BOT_SCHEDULE_PRESETS"), helpers.indexOf("async function loadBotsNav")), ctx);
    expect(vm.runInContext(`botStatusChip({ status: "needs_folder" }).text`, ctx)).toBe("Needs folder");
    expect(vm.runInContext(`botAutoStatus({ status: "needs_folder", enabled: true, machine: { machineName: "MAW-MB-02" } }).text`, ctx)).toContain("set it up in the EdgeCoder app on MAW-MB-02");
  });
});

describe("account delete", () => {
  it("removes the account's pending new bots too", async () => {
    const { USER_DELETE_PLAN, deleteStatement, PENDING_BOTS_KEY_PREFIX } = await import("../../src/portal/account-admin.js");
    const step = USER_DELETE_PLAN.find((s) => "keyPrefix" in s && s.keyPrefix === PENDING_BOTS_KEY_PREFIX)!;
    expect(deleteStatement(step, "u1", "a@b.c")).toEqual({ sql: "DELETE FROM portal_onboarding WHERE user_id = $1", params: ["bots-pending:u1"] });
  });
});
