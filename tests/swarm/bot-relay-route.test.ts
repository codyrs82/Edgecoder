import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { signMeshWsBind } from "../../src/mesh/ws-auth.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { BotManager, type BotRunner } from "../../src/apps/ide/bots.js";
import { botsSnapshot, runRemoteBotCommand } from "../../src/apps/ide/bot-remote.js";
import { BotRelayAgent, type ProviderClient } from "../../src/swarm/bot-relay-agent.js";
import { botControlRequestSchema, createBotControlFrame, webBotId, type RelayControls } from "../../src/common/bot-relay.js";
import { existsSync } from "node:fs";
import { ACCOUNT_BOT_CREATES_PER_WINDOW } from "../../src/swarm/coordinator/bot-relay.js";
import { createPeerKeys as keysFor } from "../../src/mesh/peer.js";

/*
 * Bots on the web through the real coordinator app: the agent publishes its Mac's bots (signed),
 * only the machine's verified owning account reads them or commands them, commands go down the
 * agent's authenticated mesh socket signed by the coordinator, the agent hands them to a fake
 * provider (a real BotManager), and the signed result comes back for the portal to read.
 */

const accounts = vi.hoisted(() => new Map<string, string>());
vi.mock("../../src/swarm/coordinator/agent-accounts.js", () => ({
  verifiedAccountOf: async (agentId: string) => accounts.get(agentId) ?? null
}));

const PORTAL_TOKEN = "p".repeat(40);
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.89";
const mine = createPeerKeys("agent-bot-mine");
const theirs = createPeerKeys("agent-bot-theirs");
const viewOnly = createPeerKeys("agent-bot-view");
const offline = createPeerKeys("agent-bot-offline");
let portal: Server;
let app: any;
const frames = new Map<string, string[]>();
const sockets: any[] = [];
let coordinatorIdentity: { peerId: string; publicKeyPem: string };
const managers: BotManager[] = [];
const approvals: boolean[] = [];

function signedPost(keys: PeerKeys, url: string, body: unknown) {
  const payload = JSON.stringify(body);
  const headers = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", ...headers }, payload });
}
const portalPost = (url: string, body: unknown, token: string | null = PORTAL_TOKEN) =>
  app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", ...(token ? { "x-portal-service-token": token } : {}) }, payload: JSON.stringify(body) });
const command = (agentId: string, accountId: string, botId: string, action: string, args: unknown = {}, token?: string | null) =>
  portalPost(`/agent-control/agents/${agentId}/bot-commands`, { accountId, botId, action, args }, token);
const result = (commandId: string, accountId: string) => portalPost(`/agent-control/bot-commands/${commandId}`, { accountId });
const list = (accountId: string, agentIds: string[]) => portalPost("/agent-control/bots", { accountId, agentIds });
const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond()) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

/** A Mac: a real BotManager behind the provider routes' functions, and its agent. */
function mac(keys: PeerKeys, mode: RelayControls, name: string) {
  const runner: BotRunner = async (ctx) => {
    if (ctx.messages.at(-1)?.content.includes("run the tests")) approvals.push(await ctx.waitForApproval("tc_web", "run_shell", { command: "npm test" }));
    ctx.sendEvent({ type: "text", content: "Done." });
  };
  const m = new BotManager({ runner, file: join(mkdtempSync(join(tmpdir(), "relay-")), "bots.json"), approvals: new Map() });
  managers.push(m);
  const bot = m.create({ name: "Harry", role: "Lead Developer", projectRoot: mkdtempSync(join(tmpdir(), "harry-")), enabled: false });
  const provider: ProviderClient = {
    snapshot: async (machine, controls) => botsSnapshot(m, machine, controls),
    command: async (b) => (b.requestedBy === accounts.get(keys.peerId) ? runRemoteBotCommand(m, b.botId, botControlRequestSchema.parse({ action: b.action, args: b.args }), b.controls, { requestedBy: b.requestedBy }) : { status: "refused", error: "not_this_account" })
  };
  const agent = new BotRelayAgent({
    agentId: keys.peerId,
    mode,
    machineName: name,
    provider,
    report: async (body) => {
      const res = await signedPost(keys, `/agent-control/agents/${keys.peerId}/bots/report`, body);
      if (res.statusCode !== 200) throw new Error(`report ${res.statusCode} ${res.body}`);
    }
  });
  return { m, bot, agent };
}
let A: ReturnType<typeof mac>;
let V: ReturnType<typeof mac>;
let T: ReturnType<typeof mac>;
let O: ReturnType<typeof mac>;

/** The agent's socket loop: every bot_control frame it receives is verified and handled. */
async function pump(keys: PeerKeys, agent: BotRelayAgent) {
  const list = frames.get(keys.peerId)!;
  while (list.length) {
    const f = JSON.parse(list.shift()!);
    if (f.type === "bot_control") await agent.handleFrame(f, coordinatorIdentity);
  }
}
async function run(keys: PeerKeys, agent: BotRelayAgent, accountId: string, botId: string, action: string, args: unknown = {}) {
  const res = await command(keys.peerId, accountId, botId, action, args);
  expect(res.statusCode, res.body).toBe(200);
  const id = res.json().commandId;
  await until(() => (frames.get(keys.peerId)?.length ?? 0) > 0);
  await pump(keys, agent);
  return (await result(id, accountId)).json();
}

beforeAll(async () => {
  accounts.set(mine.peerId, "acct-owner");
  accounts.set(viewOnly.peerId, "acct-owner");
  accounts.set(offline.peerId, "acct-owner");
  accounts.set(theirs.peerId, "acct-other");
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body.registrationToken === VALID_TOKEN ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((r) => portal.listen(0, "127.0.0.1", r));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.PORTAL_SERVICE_TOKEN = PORTAL_TOKEN;
  process.env.MESH_AUTH_TOKEN = "mesh-secret-bots";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  const id = (await app.inject({ method: "GET", url: "/identity" })).json();
  coordinatorIdentity = { peerId: id.peerId, publicKeyPem: id.publicKeyPem };
  for (const k of [mine, theirs, viewOnly, offline]) {
    const res = await signedPost(k, "/register", { os: "macos", version: "1", mode: "swarm-only", agentId: k.peerId, registrationToken: VALID_TOKEN, publicKeyPem: k.publicKeyPem });
    expect(res.statusCode, res.body).toBe(200);
  }
  for (const k of [mine, theirs, viewOnly]) {
    const ws = await app.injectWS(`/mesh/ws?peerId=${k.peerId}`, { headers: signMeshWsBind(k.peerId, k.privateKeyPem) });
    frames.set(k.peerId, []);
    ws.on("message", (d: Buffer) => frames.get(k.peerId)!.push(d.toString()));
    sockets.push(ws);
  }
  frames.set(offline.peerId, []);
  A = mac(mine, "on", "MAW-MB-02");
  V = mac(viewOnly, "view", "MAW-MB-03");
  T = mac(theirs, "on", "THEIR-MAC");
  O = mac(offline, "on", "MAW-MB-04");
  for (const x of [A, V, T, O]) await x.agent.publish(true);
}, 60_000);

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  for (const m of managers) await m.shutdown();
  await app?.close();
  await new Promise<void>((r) => portal.close(() => r()));
});

const botFrames = (k: PeerKeys) => (frames.get(k.peerId) ?? []).map((f) => JSON.parse(f)).filter((f) => f.type === "bot_control");

describe("publish and relay", () => {
  test("the owner sees each Mac's bots, with the conversation tail and who is connected", async () => {
    const res = await list("acct-owner", [mine.peerId, viewOnly.peerId, offline.peerId, theirs.peerId]);
    expect(res.statusCode).toBe(200);
    const machines = res.json().machines;
    expect(machines.map((m: any) => m.agentId).sort()).toEqual([mine.peerId, offline.peerId, viewOnly.peerId].sort());
    const a = machines.find((m: any) => m.agentId === mine.peerId);
    expect(a.connected).toBe(true);
    expect(a.snapshot).toMatchObject({ machineName: "MAW-MB-02", controls: "on", bots: [{ name: "Harry", role: "Lead Developer" }] });
    // The Mac that is off still shows its last snapshot, marked not connected (the portal shows it offline).
    expect(machines.find((m: any) => m.agentId === offline.peerId)).toMatchObject({ connected: false, snapshot: { machineName: "MAW-MB-04" } });
  });

  test("an agent can publish only under its own id, and a snapshot without a verified owner is not kept", async () => {
    const forged = await signedPost(theirs, `/agent-control/agents/${mine.peerId}/bots/report`, { snapshot: { v: 1, machineName: "x", controls: "on", generatedAtMs: 1, bots: [] } });
    expect([401, 403]).toContain(forged.statusCode);
    const stranger = keysFor("agent-bot-stranger");
    await signedPost(stranger, "/register", { os: "macos", version: "1", mode: "swarm-only", agentId: stranger.peerId, registrationToken: VALID_TOKEN, publicKeyPem: stranger.publicKeyPem });
    const r = await signedPost(stranger, `/agent-control/agents/${stranger.peerId}/bots/report`, { snapshot: { v: 1, machineName: "x", controls: "on", generatedAtMs: 1, bots: [] } });
    expect(r.statusCode).toBe(403);
  });

  test("a heartbeat re-sends nothing when nothing changed; a change is sent", async () => {
    let sent = 0;
    const agent = new BotRelayAgent({ agentId: "x", mode: "on", machineName: "m", provider: { snapshot: async () => botsSnapshot(A.m, "m", "on"), command: async () => ({ status: "done" }) }, report: async () => void sent++ });
    await agent.publish();
    await agent.publish();
    expect(sent).toBe(1);
    A.m.update(A.bot.id, { role: "Lead Dev" });
    await agent.publish();
    expect(sent).toBe(2);
    A.m.update(A.bot.id, { role: "Lead Developer" });
  });
});

describe("ownership: another account can't read or command", () => {
  test("another account sees none of my machines", async () => {
    const res = await list("acct-other", [mine.peerId, viewOnly.peerId]);
    expect(res.json().machines.map((m: any) => m.agentId)).toEqual([]);
  });

  test("another account's command is refused and nothing reaches my agent", async () => {
    const res = await command(mine.peerId, "acct-other", A.bot.id, "pause");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_your_machine");
    expect(botFrames(mine)).toEqual([]);
  });

  test("no service token: refused; bad commands are refused before anything is signed", async () => {
    expect((await command(mine.peerId, "acct-owner", A.bot.id, "pause", {}, null)).statusCode).toBe(401);
    expect((await list("acct-owner", [mine.peerId]).then(() => portalPost("/agent-control/bots", { accountId: "acct-owner" }, null))).statusCode).toBe(401);
    expect((await command(mine.peerId, "acct-owner", A.bot.id, "rm_rf", {})).statusCode).toBe(400);
    expect((await command(mine.peerId, "acct-owner", A.bot.id, "update_settings", { projectRoot: "/" })).statusCode).toBe(400);
    expect((await command(mine.peerId, "acct-owner", "../etc", "pause")).statusCode).toBe(400);
    expect(botFrames(mine)).toEqual([]);
  });

  test("another account can't read my command's result", async () => {
    const res = await command(mine.peerId, "acct-owner", A.bot.id, "memory");
    const id = res.json().commandId;
    expect((await result(id, "acct-other")).statusCode).toBe(404);
    await until(() => (frames.get(mine.peerId)?.length ?? 0) > 0);
    await pump(mine, A.agent);
    expect((await result(id, "acct-owner")).json()).toMatchObject({ status: "done", result: { data: { memory: "" } } });
  });

  test("an agent refuses a frame signed by anyone but its pinned coordinator, or meant for another agent", async () => {
    const forger = keysFor("evil-coordinator");
    const forged = createBotControlFrame({ request: { action: "pause", args: {} }, botId: A.bot.id, agentId: mine.peerId, coordinatorId: coordinatorIdentity.peerId, requestedBy: "acct-owner", privateKeyPem: forger.privateKeyPem });
    expect(await A.agent.handleFrame(forged, coordinatorIdentity)).toMatchObject({ status: "ignored", error: "invalid_signature" });
    expect(A.m.get(A.bot.id).enabled).toBe(false);
  });
});

describe("commands round-trip with a fake provider", () => {
  test("resume, message, pause, settings: signed down the socket, carried out on the Mac, result read back", async () => {
    expect(await run(mine, A.agent, "acct-owner", A.bot.id, "resume")).toMatchObject({ status: "done" });
    expect(A.m.get(A.bot.id).enabled).toBe(true);
    await A.m.idle(A.bot.id);
    const sent = await run(mine, A.agent, "acct-owner", A.bot.id, "message", { content: "Hello from the web" });
    expect(sent.status).toBe("done");
    expect(A.m.messages(A.bot.id).some((m) => m.content === "Hello from the web")).toBe(true);
    await A.m.idle(A.bot.id);
    expect(await run(mine, A.agent, "acct-owner", A.bot.id, "pause")).toMatchObject({ status: "done" });
    expect(A.m.get(A.bot.id).enabled).toBe(false);
    expect(await run(mine, A.agent, "acct-owner", A.bot.id, "update_settings", { budgetCSatsPerDay: 25 })).toMatchObject({ status: "done" });
    expect(A.m.get(A.bot.id).budgetCSatsPerDay).toBe(25);
    // The change shows on the web right away (the agent re-publishes after a change).
    await until(async () => (await list("acct-owner", [mine.peerId])).json().machines[0].snapshot.bots[0].budgetCSatsPerDay === 25);
    const tail = (await list("acct-owner", [mine.peerId])).json().machines[0].snapshot.bots[0].tail;
    expect(tail.some((m: any) => m.content === "Hello from the web")).toBe(true);
    const page = await run(mine, A.agent, "acct-owner", A.bot.id, "messages", { limit: 2 });
    expect(page.result.data.items.length).toBe(2);
  });

  test("a frame is not carried out twice (replay)", async () => {
    const res = await command(mine.peerId, "acct-owner", A.bot.id, "check_now");
    await until(() => (frames.get(mine.peerId)?.length ?? 0) > 0);
    const raw = frames.get(mine.peerId)![0];
    await pump(mine, A.agent);
    expect((await A.agent.handleFrame(JSON.parse(raw), coordinatorIdentity)) as any).toMatchObject({ status: "ignored", error: "replayed" });
    expect(res.statusCode).toBe(200);
    await A.m.idle(A.bot.id);
  });
});

describe("approvals and the offline state", () => {
  test("an approval the bot raises shows on the web and is answered from there", async () => {
    A.m.message(A.bot.id, "run the tests");
    await until(() => A.m.get(A.bot.id).status === "needs_approval");
    await A.agent.publish(true);
    const snap = (await list("acct-owner", [mine.peerId])).json().machines[0].snapshot.bots[0];
    expect(snap.pending).toEqual([{ callId: "tc_web", tool: "run_shell", detail: "npm test" }]);
    expect(await run(mine, A.agent, "acct-owner", A.bot.id, "approve", { callId: "tc_web", approved: true })).toMatchObject({ status: "done" });
    await A.m.idle(A.bot.id);
    expect(approvals).toEqual([true]);
  });

  test("a read-only Mac shows its approvals but takes the answer only on the Mac", async () => {
    const snap = (await list("acct-owner", [viewOnly.peerId])).json().machines[0].snapshot;
    expect(snap.controls).toBe("view");
    expect(await run(viewOnly, V.agent, "acct-owner", V.bot.id, "approve", { callId: "tc_x", approved: true })).toMatchObject({ status: "refused", result: { error: "view_only" } });
    expect(await run(viewOnly, V.agent, "acct-owner", V.bot.id, "memory")).toMatchObject({ status: "done" });
  });

  test("an offline Mac: its last snapshot is readable, commands are refused", async () => {
    const res = await command(offline.peerId, "acct-owner", O.bot.id, "message", { content: "hi" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("agent_not_connected");
    const m = (await list("acct-owner", [offline.peerId])).json().machines[0];
    expect(m).toMatchObject({ connected: false, snapshot: { bots: [{ name: "Harry" }] } });
  });
});

describe("new bots from the web (create, #409)", () => {
  const spec = (requestId: string, extra: Record<string, unknown> = {}) => ({ requestId, name: "Web Harry", role: "Engineer", instructions: "Fix the issues", mode: "auto", ...extra });

  test("the owner's create makes a bot on the Mac without a folder: Needs folder, Accept edits, the suggestion untouched", async () => {
    const requestId = "11111111-2222-4333-8444-555555555555";
    const botId = webBotId("acct-owner", requestId);
    const suggested = join(tmpdir(), `web-suggested-${Date.now()}`);
    const r = await run(mine, A.agent, "acct-owner", botId, "create", spec(requestId, { suggestedFolder: suggested }));
    expect(r).toMatchObject({ status: "done", result: { data: { botId, created: true, status: "needs_folder" } } });
    const bot = A.m.get(botId);
    expect(bot).toMatchObject({ projectRoot: "", status: "needs_folder", mode: "auto-edits", setup: { requestedBy: "acct-owner", requestedMode: "auto", suggestedFolder: suggested } });
    // The web's folder is never created or used by the Mac on its own.
    expect(existsSync(suggested)).toBe(false);
    expect(A.m.runNow(botId).started).toBe(false);
    // It shows on the web with its status, and the Mac says it can take new bots.
    await until(async () => (await list("acct-owner", [mine.peerId])).json().machines[0].snapshot.bots.some((b: any) => b.id === botId));
    const snap = (await list("acct-owner", [mine.peerId])).json().machines[0].snapshot;
    expect(snap.features).toEqual(["create"]);
    expect(snap.bots.find((b: any) => b.id === botId)).toMatchObject({ status: "needs_folder", folderName: "", setup: { autoRequested: true } });
    // The web can't give it a folder either.
    expect((await command(mine.peerId, "acct-owner", botId, "update_settings", { projectRoot: suggested })).statusCode).toBe(400);
  });

  test("idempotent: a retry gets the same command and no second frame; the Mac makes one bot per request", async () => {
    const requestId = "22222222-2222-4333-8444-555555555555";
    const botId = webBotId("acct-owner", requestId);
    const first = await command(mine.peerId, "acct-owner", botId, "create", spec(requestId));
    const again = await command(mine.peerId, "acct-owner", botId, "create", spec(requestId));
    expect(again.json().commandId).toBe(first.json().commandId);
    await until(() => (frames.get(mine.peerId)?.length ?? 0) > 0);
    expect(botFrames(mine).length).toBe(1);
    await pump(mine, A.agent);
    // Done: still the same command, nothing sent again.
    expect((await command(mine.peerId, "acct-owner", botId, "create", spec(requestId))).json().commandId).toBe(first.json().commandId);
    expect(botFrames(mine)).toEqual([]);
    const count = A.m.list().filter((b) => b.id === botId).length;
    // The Mac itself: the same request again (another portal machine) returns the bot it made.
    const direct = runRemoteBotCommand(A.m, botId, botControlRequestSchema.parse({ action: "create", args: spec(requestId) }), "on", { requestedBy: "acct-owner" });
    expect(direct).toMatchObject({ status: "done", data: { botId, created: false } });
    expect(A.m.list().filter((b) => b.id === botId).length).toBe(count);
    expect(count).toBe(1);
  });

  test("refused: another account, a bot id that isn't the request's, a frontier model, a folder field, a view-only Mac", async () => {
    const requestId = "33333333-2222-4333-8444-555555555555";
    expect((await command(mine.peerId, "acct-other", webBotId("acct-other", requestId), "create", spec(requestId))).statusCode).toBe(403);
    expect((await command(mine.peerId, "acct-owner", "bot_wdeadbeef0000", "create", spec(requestId))).statusCode).toBe(400);
    expect((await command(mine.peerId, "acct-owner", webBotId("acct-owner", requestId), "create", spec(requestId, { compute: { policy: "model", model: "frontier/anthropic/claude" } }))).statusCode).toBe(400);
    expect((await command(mine.peerId, "acct-owner", webBotId("acct-owner", requestId), "create", spec(requestId, { projectRoot: "/tmp" }))).statusCode).toBe(400);
    expect(botFrames(mine)).toEqual([]);
    const v = await run(viewOnly, V.agent, "acct-owner", webBotId("acct-owner", requestId), "create", spec(requestId));
    expect(v).toMatchObject({ status: "refused", result: { error: "view_only" } });
  });

  test("rate limited per account", async () => {
    const codes: number[] = [];
    for (let i = 0; i <= ACCOUNT_BOT_CREATES_PER_WINDOW; i++) {
      const requestId = `44444444-0000-4000-8000-${String(i).padStart(12, "0")}`;
      codes.push((await command(theirs.peerId, "acct-other", webBotId("acct-other", requestId), "create", spec(requestId))).statusCode);
    }
    expect(codes.slice(0, ACCOUNT_BOT_CREATES_PER_WINDOW).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});

describe("an older coordinator", () => {
  test("refuses a snapshot with features: the agent sends it without them, from then on", async () => {
    const got: any[] = [];
    const agent = new BotRelayAgent({
      agentId: "x",
      mode: "on",
      machineName: "m",
      provider: { snapshot: async () => botsSnapshot(A.m, "m", "on"), command: async () => ({ status: "done" }) },
      report: async (body) => {
        if (body.snapshot?.features) throw new Error('POST /agent-control/agents/x/bots/report failed (400): {"error":"invalid_report"}');
        got.push(body.snapshot);
      },
    });
    await agent.publish(true);
    await agent.publish(true);
    expect(got.length).toBe(2);
    expect(got.every((s) => s.features === undefined)).toBe(true);
  });
});
