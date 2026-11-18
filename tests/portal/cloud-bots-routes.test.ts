import vm from "node:vm";
import Fastify from "fastify";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerBotRoutes, type PendingBot, type PendingBotStore } from "../../src/portal/routes/bots.js";
import { CloudBotService, cloudBotId } from "../../src/portal/routes/cloud-bots.js";
import { BotSecrets } from "../../src/portal/cloud-bots/secrets.js";
import { MemoryCloudBotStore } from "../helpers/cloud-bot-memory-store.js";

/*
 * Cloud bots on the bots API: the Cloud target is always there, /new with agentId "cloud" makes the
 * bot at once (idempotent by request id), detail and commands work only for the owner, the GitHub
 * token is sealed and never comes back, and the machine path takes the cloud contract's fields.
 */
const KEY = Buffer.alloc(32, 7);
const TOKEN = "ghp_" + "A".repeat(36);
let store: MemoryCloudBotStore;
let pending: Map<string, { list: PendingBot[]; version: number }>;
let kicks = 0;
let app: ReturnType<typeof Fastify>;
let secrets = new BotSecrets(KEY);

const as = (user: string | null) => (user ? { "x-test-user": user } : {});
const get = (user: string | null, url: string) => app.inject({ url, headers: as(user) });
const post = (user: string | null, url: string, payload: unknown) => app.inject({ method: "POST", url, headers: as(user), payload: payload as any });
const newCloud = (user: string, requestId: string, bot: Record<string, unknown>) => post(user, "/portal/api/bots/new", { requestId, agentId: "cloud", bot });

async function build(withKey = true) {
  store = new MemoryCloudBotStore();
  pending = new Map();
  secrets = new BotSecrets(withKey ? KEY : null);
  const pendingStore: PendingBotStore = {
    async getPendingBots(u) {
      const r = pending.get(u);
      return r ? structuredClone(r) : { list: [], version: 0 };
    },
    async savePendingBots(u, list, version, nowMs) {
      if ((pending.get(u)?.version ?? 0) !== version) return false;
      pending.set(u, { list: structuredClone(list), version: Math.max(nowMs, version + 1) });
      return true;
    },
    async listPendingBotOwners() {
      return [...pending.keys()];
    },
  };
  app = Fastify();
  registerBotRoutes(app, {
    PORTAL_SERVICE_TOKEN: "s".repeat(40),
    EXTERNAL_HTTP_TIMEOUT_MS: 1000,
    discoverCoordinatorUrlsForPortal: async () => [],
    getCurrentUser: async (req) => (req.headers["x-test-user"] ? { userId: String(req.headers["x-test-user"]) } : null),
    pendingSweepMs: 0,
    store: { ...pendingStore, listNodesByOwner: async () => [] },
    cloud: new CloudBotService({ store, secrets, runner: { kick: () => void kicks++, queueEvent: async () => "cr-x" }, rate: { createsPerHour: 100, messagesPerMinute: 100 } }),
  });
  await app.ready();
}

beforeAll(() => build());
afterAll(() => app.close());
beforeEach(async () => {
  await app.close();
  await build();
  kicks = 0;
});

describe("cloud bots API", () => {
  it("always offers the Cloud target, with no machine at all", async () => {
    expect((await get(null, "/portal/api/bots")).statusCode).toBe(401);
    const j = (await get("u1", "/portal/api/bots")).json();
    expect(j.targets[0]).toEqual({ agentId: "cloud", machineName: "Cloud", online: true, canCreate: true });
    expect(j.canCreate).toBe(true);
    expect(j.bots).toEqual([]);
  });

  it("creates a cloud bot at once, once per request id, and lists it with runtime cloud", async () => {
    const r = await newCloud("u1", "req-cloud-0001", { name: "Ada", role: "Researcher", instructions: "Watch the news", schedule: { everyMinutes: 60 }, web: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ botId: cloudBotId("u1", "req-cloud-0001"), agentId: "cloud" });
    expect((await newCloud("u1", "req-cloud-0001", { name: "Ada" })).json().botId).toBe(r.json().botId);
    expect(store.bots.size).toBe(1);
    const j = (await get("u1", "/portal/api/bots")).json();
    expect(j.bots).toHaveLength(1);
    expect(j.bots[0]).toMatchObject({ id: r.json().botId, runtime: "cloud", name: "Ada", schedule: "hourly", machine: { agentId: "cloud", machineName: "Cloud" } });
    expect(j.bots[0].instructions).toBeUndefined();
    // Another account sees nothing of it.
    expect((await get("u2", "/portal/api/bots")).json().bots).toEqual([]);
  });

  it("refuses bad input", async () => {
    expect((await newCloud("u1", "req-cloud-0002", { name: "" })).statusCode).toBe(400);
    expect((await newCloud("u1", "req-cloud-0002", { name: "x", compute: "network:frontier/anthropic/x" })).statusCode).toBe(400);
    expect((await newCloud("u1", "req-cloud-0002", { name: "x", schedule: { everyMinutes: 1 } })).statusCode).toBe(400);
    expect((await newCloud("u1", "req-cloud-0002", { name: "x", schedule: { dailyAtUtc: "25:00" } })).statusCode).toBe(400);
    expect((await newCloud("u1", "req-cloud-0002", { name: "x", github: { repo: "not a repo" } })).statusCode).toBe(400);
    expect(store.bots.size).toBe(0);
  });

  it("detail and commands only for the owner", async () => {
    const botId = (await newCloud("u1", "req-cloud-0003", { name: "Ada" })).json().botId;
    const d = await get("u1", `/portal/api/bots/cloud/${botId}`);
    expect(d.statusCode).toBe(200);
    expect(d.json()).toMatchObject({ bot: { id: botId, runtime: "cloud", tail: [], status: "idle" }, machine: { agentId: "cloud", online: true, controls: "on" } });
    expect((await get("u2", `/portal/api/bots/cloud/${botId}`)).statusCode).toBe(404);
    expect((await get(null, `/portal/api/bots/cloud/${botId}`)).statusCode).toBe(401);
    expect((await post("u2", `/portal/api/bots/cloud/${botId}/commands`, { action: "message", args: { content: "hi" } })).statusCode).toBe(404);
    expect((await post("u2", `/portal/api/bots/cloud/${botId}/commands`, { action: "delete" })).statusCode).toBe(404);
    expect(store.bots.size).toBe(1);

    const m = await post("u1", `/portal/api/bots/cloud/${botId}/commands`, { action: "message", args: { content: "What's new?" } });
    expect(m.statusCode).toBe(200);
    const { commandId, result } = m.json();
    expect(result).toMatchObject({ status: "done", data: { queued: false } });
    expect(kicks).toBe(1);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ status: "queued", trigger: "message" });
    const st = await get("u1", `/portal/api/bots/cloud/commands/${commandId}`);
    expect(st.json()).toMatchObject({ status: "done", agentId: "cloud", botId, action: "message", run: { status: "queued" } });
    expect((await get("u2", `/portal/api/bots/cloud/commands/${commandId}`)).statusCode).toBe(404);
    // A second message joins the queued run.
    await post("u1", `/portal/api/bots/cloud/${botId}/commands`, { action: "message", args: { content: "And?" } });
    expect(store.runs).toHaveLength(1);
    const detail = (await get("u1", `/portal/api/bots/cloud/${botId}`)).json();
    expect(detail.bot.tail.map((x: any) => x.content)).toEqual(["What's new?", "And?"]);
    expect(detail.bot.status).toBe("running");

    expect((await post("u1", `/portal/api/bots/cloud/${botId}/commands`, { action: "pause" })).statusCode).toBe(200);
    expect((await get("u1", `/portal/api/bots/cloud/${botId}`)).json().bot.enabled).toBe(false);
    await post("u1", `/portal/api/bots/cloud/${botId}/commands`, { action: "resume" });
    const up = await post("u1", `/portal/api/bots/cloud/${botId}/commands`, { action: "update_settings", args: { name: "Ada 2", schedule: { dailyAtUtc: "09:30" }, budgetCSatsPerDay: 5 } });
    expect(up.statusCode).toBe(200);
    const b = (await get("u1", `/portal/api/bots/cloud/${botId}`)).json().bot;
    expect(b).toMatchObject({ name: "Ada 2", schedule: "daily at 09:30 UTC", budgetCSatsPerDay: 5 });
    expect((await post("u1", `/portal/api/bots/cloud/${botId}/commands`, { action: "update_settings", args: { maxTurns: 99 } })).statusCode).toBe(400);
    expect((await post("u1", `/portal/api/bots/cloud/${botId}/commands`, { action: "approve", args: {} })).statusCode).toBe(400);
    const hist = (await post("u1", `/portal/api/bots/cloud/${botId}/commands`, { action: "history" })).json();
    expect(hist.result.data.items).toHaveLength(1);
    const page = (await post("u1", `/portal/api/bots/cloud/${botId}/commands`, { action: "messages", args: { limit: 1 } })).json();
    expect(page.result.data).toMatchObject({ more: true, items: [{ content: "And?" }] });

    expect((await post("u1", `/portal/api/bots/cloud/${botId}/commands`, { action: "delete" })).statusCode).toBe(200);
    expect(store.bots.size).toBe(0);
    expect(store.messages).toHaveLength(0);
    expect((await get("u1", `/portal/api/bots/cloud/${botId}`)).statusCode).toBe(404);
  });

  it("seals the GitHub token and never returns it", async () => {
    const r = await newCloud("u1", "req-cloud-0004", { name: "Rev", github: { repo: "acme/site", token: TOKEN, triggers: ["pr_opened", { kind: "issue_labeled", label: "bot" }] } });
    expect(r.statusCode).toBe(200);
    const botId = r.json().botId;
    const sealed = await store.getGithubTokenSealed(botId);
    expect(sealed).not.toContain(TOKEN);
    expect(secrets.decrypt(sealed, botId)).toBe(TOKEN);
    const bodies = [JSON.stringify(r.json()), (await get("u1", "/portal/api/bots")).body, (await get("u1", `/portal/api/bots/cloud/${botId}`)).body];
    for (const b of bodies) {
      expect(b).not.toContain(TOKEN);
      expect(b).not.toContain(sealed!);
    }
    const bot = (await get("u1", `/portal/api/bots/cloud/${botId}`)).json().bot;
    expect(bot.cloud.github).toEqual({ repo: "acme/site", hasToken: true, available: true, triggers: [{ id: "pr_opened", kind: "pr_opened", enabled: true }, { id: "issue_labeled", kind: "issue_labeled", enabled: true, label: "bot" }] });
    // Removing it.
    await post("u1", `/portal/api/bots/cloud/${botId}/commands`, { action: "update_settings", args: { github: { repo: "acme/site", token: null } } });
    expect(await store.getGithubTokenSealed(botId)).toBeNull();
  });

  it("without PORTAL_BOT_SECRETS_KEY a token is refused with a clear message", async () => {
    await app.close();
    await build(false);
    const r = await newCloud("u1", "req-cloud-0005", { name: "Rev", github: { repo: "acme/site", token: TOKEN } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "github_unavailable" });
    expect(r.json().message).toContain("PORTAL_BOT_SECRETS_KEY");
    expect((await get("u1", "/portal/api/bots")).json().cloud).toEqual({ github: false });
  });

  it("the machine path takes the cloud contract's fields (iOS sends them for every target)", async () => {
    const r = await post("u1", "/portal/api/bots/new", {
      requestId: "req-machine-0001",
      agentId: null,
      bot: { name: "Harry", compute: "network:qwen3.5:9b", web: true, schedule: { everyMinutes: 30 }, github: { repo: "acme/site", token: TOKEN, triggers: ["pr_opened", "ci_failed", { kind: "issue_labeled", label: "fix" }] } },
    });
    expect(r.statusCode).toBe(200);
    const spec = pending.get("u1")!.list[0].spec;
    expect(spec).toMatchObject({
      name: "Harry",
      schedule: "every 30 minutes",
      compute: { policy: "network_only", model: "network/qwen3.5:9b" },
      repository: "acme/site",
      triggers: [{ kind: "pr", onlyOthers: true }, { kind: "ci_failed", scope: "any" }, { kind: "issue_labeled", label: "fix" }],
    });
    expect(JSON.stringify(pending.get("u1"))).not.toContain(TOKEN);
    // Daily (UTC) isn't carried to a machine's local schedule; compute auto maps to Auto.
    const r2 = await post("u1", "/portal/api/bots/new", { requestId: "req-machine-0002", agentId: null, bot: { name: "Sam", compute: "auto", schedule: { dailyAtUtc: "09:00" }, web: false } });
    expect(r2.statusCode).toBe(200);
    expect(pending.get("u1")!.list[1].spec).toMatchObject({ name: "Sam", schedule: "", compute: { policy: "auto" } });
  });

  it("too many pending bots says machine, not Mac", async () => {
    for (let i = 0; i < 10; i++) await post("u1", "/portal/api/bots/new", { requestId: `req-many-${String(i).padStart(4, "0")}`, agentId: null, bot: { name: `B${i}` } });
    const r = await post("u1", "/portal/api/bots/new", { requestId: "req-many-9999", agentId: null, bot: { name: "One more" } });
    expect(r.statusCode).toBe(429);
    expect(r.json().message).toBe("At most 10 new bots can wait for a machine.");
  });
});

describe("the bots page with cloud bots", () => {
  it("offers Cloud in New bot with its own fields, and its scripts parse", async () => {
    const a = Fastify();
    registerPortalPages(a);
    const html = (await a.inject({ url: "/portal/bots" })).body;
    await a.close();
    for (const id of ["bnCloudOnly", "bnMachineOnly", "bnCloudCompute", "bnCloudSched", "bnCloudTriggers", "bpEditCloud", "bpeCloudCompute", "bpeCloudTriggers", "bpDelete"]) expect(html, id).toContain(`id="${id}"`);
    for (const name of ["cloudCompute", "cloudWeb", "cloudSchedKind", "cloudEvery", "cloudDaily", "cloudRepo", "cloudToken", "cTrigPr", "cTrigCi", "cTrigIssue", "cTrigIssueLabel", "budgetCSatsPerRun"]) expect(html, name).toContain(`name="${name}"`);
    expect(html).toContain("Cloud (no machine needed)");
    expect(html).toContain('type="password"');
    const dialog = html.slice(html.indexOf('id="bnDialog"'), html.indexOf("</dialog>", html.indexOf('id="bnDialog"')));
    expect(dialog).not.toMatch(/\bMacs?\b|computer/);
    expect(html).not.toMatch(/your Mac\b/);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\bsrc=/.test(m[1])).map((m) => m[2]);
    for (const sc of scripts) expect(() => new vm.Script(sc)).not.toThrow();
    // The cloud form's spec, run on a stand-in form.
    const page = scripts.find((sc) => sc.includes("function cloudSpec"))!;
    const ctx: Record<string, any> = {};
    vm.createContext(ctx);
    vm.runInContext(page.slice(page.indexOf("function cloudSpec"), page.indexOf("function fillCloudEdit")), ctx);
    const field = (value: unknown, checked = false) => ({ value, checked });
    const form = { cloudCompute: field("mine:qwen3.5:9b"), cloudWeb: field("", true), cloudSchedKind: field("daily"), cloudEvery: field("60"), cloudDaily: field("09:30"), cloudRepo: field(" acme/site "), cloudToken: field(""), cTrigPr: field("", true), cTrigCi: field("", false), cTrigIssue: field("", true), cTrigIssueLabel: field("") };
    ctx.form = form;
    expect(JSON.parse(JSON.stringify(vm.runInContext("cloudSpec(form, true)", ctx)))).toEqual({ compute: "mine:qwen3.5:9b", web: true, schedule: { dailyAtUtc: "09:30" }, github: { repo: "acme/site", triggers: [{ kind: "pr_opened" }, { kind: "issue_labeled", label: "bot" }] } });
    expect(vm.runInContext("cloudCheck(form)", ctx)).toBe("");
    form.cloudSchedKind.value = "every";
    form.cloudEvery.value = "5";
    expect(vm.runInContext("cloudCheck(form)", ctx)).toMatch(/15 minutes/);
  });
});
