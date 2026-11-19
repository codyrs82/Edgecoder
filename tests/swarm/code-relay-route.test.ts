import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { signMeshWsBind } from "../../src/mesh/ws-auth.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { CodeRelayAgent, type CodeProviderClient } from "../../src/swarm/code-relay-agent.js";
import type { CodeRelayMode } from "../../src/common/code-relay.js";
import { ACCOUNT_CODE_CHANGES_PER_WINDOW, ACCOUNT_CODE_CREATES_PER_HOUR, ACCOUNT_CODE_READS_PER_WINDOW, sendCodeCommand } from "../../src/swarm/coordinator/code-relay.js";

/*
 * Code from your phone through the real coordinator app: the agent publishes its Mac's projects and
 * sessions (signed), only the machine's verified owning account reads them or commands them,
 * commands go down the agent's authenticated mesh socket signed by the coordinator, the agent hands
 * them to a fake provider, and the signed result comes back for the account that asked only.
 */

const accounts = vi.hoisted(() => new Map<string, string>());
vi.mock("../../src/swarm/coordinator/agent-accounts.js", () => ({
  verifiedAccountOf: async (agentId: string) => accounts.get(agentId) ?? null
}));

const PORTAL_TOKEN = "q".repeat(40);
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.90";
const SESSION = "6f1c3c1e-3b7a-4d38-9a41-1f0e0b6c2d11";
const PROJECT = { projectId: "0123456789abcdef", name: "app", parent: "code" };
const mine = createPeerKeys("agent-code-mine");
const theirs = createPeerKeys("agent-code-theirs");
const offline = createPeerKeys("agent-code-offline");
let portal: Server;
let app: any;
let ctx: any;
const frames = new Map<string, string[]>();
const sockets: any[] = [];
let coordinatorIdentity: { peerId: string; publicKeyPem: string };
const providerCalls: Array<Record<string, unknown>> = [];

function signedPost(keys: PeerKeys, url: string, body: unknown) {
  const payload = JSON.stringify(body);
  const headers = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", ...headers }, payload });
}
const portalPost = (url: string, body: unknown, token: string | null = PORTAL_TOKEN) =>
  app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", ...(token ? { "x-portal-service-token": token } : {}) }, payload: JSON.stringify(body) });
const command = (agentId: string, accountId: string, action: string, args: unknown = {}, token?: string | null) =>
  portalPost(`/agent-control/agents/${agentId}/code-commands`, { accountId, action, args }, token);
const state = (commandId: string, accountId: string) => portalPost(`/agent-control/code-commands/${commandId}`, { accountId });
const list = (accountId: string, agentIds: string[]) => portalPost("/agent-control/code", { accountId, agentIds });
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return cond();
};
const codeFrames = (k: PeerKeys) => (frames.get(k.peerId) ?? []).map((f) => JSON.parse(f)).filter((f) => f.type === "code_control");

/** A Mac: a fake provider that, like code-remote.ts, answers only the account signed in on it. */
function mac(keys: PeerKeys, mode: CodeRelayMode, name: string) {
  const signedIn = accounts.get(keys.peerId)!;
  const provider: CodeProviderClient = {
    snapshot: async (account) => (account === signedIn ? { v: 1, generatedAtMs: Date.now(), projects: [PROJECT], sessions: [{ id: SESSION, title: "Fix the build", projectId: PROJECT.projectId, projectName: "app", running: false }] } : null),
    command: async (body) => {
      providerCalls.push(body);
      if (body.requestedBy !== signedIn) return { status: "refused", error: "not_this_account" };
      return { status: "done", data: { echo: body.action, secret: `for ${signedIn}` } };
    }
  };
  const agent = new CodeRelayAgent({
    agentId: keys.peerId,
    mode,
    machineName: name,
    account: () => accounts.get(keys.peerId) ?? null,
    provider,
    report: async (body) => {
      const res = await signedPost(keys, `/agent-control/agents/${keys.peerId}/code/report`, body);
      if (res.statusCode !== 200) throw new Error(`report ${res.statusCode} ${res.body}`);
    }
  });
  return { agent };
}
let A: ReturnType<typeof mac>;
let T: ReturnType<typeof mac>;
let O: ReturnType<typeof mac>;

async function pump(keys: PeerKeys, agent: CodeRelayAgent) {
  const l = frames.get(keys.peerId)!;
  while (l.length) {
    const f = JSON.parse(l.shift()!);
    if (f.type === "code_control") await agent.handleFrame(f, coordinatorIdentity);
  }
}
async function run(keys: PeerKeys, agent: CodeRelayAgent, accountId: string, action: string, args: unknown = {}) {
  const res = await command(keys.peerId, accountId, action, args);
  expect(res.statusCode, res.body).toBe(200);
  const id = res.json().commandId;
  await until(() => (frames.get(keys.peerId)?.length ?? 0) > 0);
  await pump(keys, agent);
  return { id, state: (await state(id, accountId)).json() };
}

beforeAll(async () => {
  accounts.set(mine.peerId, "acct-owner");
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
  process.env.MESH_AUTH_TOKEN = "mesh-secret-code";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  ctx = await import("../../src/swarm/coordinator/context.js");
  await app.ready();
  const id = (await app.inject({ method: "GET", url: "/identity" })).json();
  coordinatorIdentity = { peerId: id.peerId, publicKeyPem: id.publicKeyPem };
  for (const k of [mine, theirs, offline]) {
    const res = await signedPost(k, "/register", { os: "macos", version: "1", mode: "swarm-only", agentId: k.peerId, registrationToken: VALID_TOKEN, publicKeyPem: k.publicKeyPem });
    expect(res.statusCode, res.body).toBe(200);
  }
  for (const k of [mine, theirs]) {
    const ws = await app.injectWS(`/mesh/ws?peerId=${k.peerId}`, { headers: signMeshWsBind(k.peerId, k.privateKeyPem) });
    frames.set(k.peerId, []);
    ws.on("message", (d: Buffer) => frames.get(k.peerId)!.push(d.toString()));
    sockets.push(ws);
  }
  frames.set(offline.peerId, []);
  A = mac(mine, "on", "MAW-MB-02");
  T = mac(theirs, "on", "THEIR-MAC");
  O = mac(offline, "on", "MAW-MB-04");
  for (const x of [A, T, O]) await x.agent.publish(true);
}, 60_000);

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await app?.close();
  await new Promise<void>((r) => portal.close(() => r()));
});

describe("publish and relay", () => {
  test("the owner sees each Mac's projects and sessions, with who is connected", async () => {
    const res = await list("acct-owner", [mine.peerId, offline.peerId, theirs.peerId]);
    expect(res.statusCode).toBe(200);
    const machines = res.json().machines;
    expect(machines.map((m: any) => m.agentId).sort()).toEqual([mine.peerId, offline.peerId].sort());
    expect(machines.find((m: any) => m.agentId === mine.peerId)).toMatchObject({ connected: true, snapshot: { machineName: "MAW-MB-02", controls: "on", account: "acct-owner", projects: [PROJECT], sessions: [{ id: SESSION }] } });
    expect(machines.find((m: any) => m.agentId === offline.peerId)).toMatchObject({ connected: false, snapshot: { machineName: "MAW-MB-04" } });
  });

  test("a snapshot is kept only under the agent's own id, for its verified owner, with no path fields on projects", async () => {
    const snap = { v: 1, machineName: "x", controls: "on", account: "acct-owner", generatedAtMs: 1, projects: [], sessions: [] };
    expect([401, 403]).toContain((await signedPost(theirs, `/agent-control/agents/${mine.peerId}/code/report`, { snapshot: snap })).statusCode);
    // Their Mac claiming to publish for my account.
    expect((await signedPost(theirs, `/agent-control/agents/${theirs.peerId}/code/report`, { snapshot: snap })).json()).toEqual({ error: "not_the_owner" });
    const withPath = { ...snap, projects: [{ ...PROJECT, path: "/Users/me/code/app" }] };
    expect((await signedPost(mine, `/agent-control/agents/${mine.peerId}/code/report`, { snapshot: withPath })).statusCode).toBe(400);
  });

  test("the owner's command reaches the provider with requestedBy = that account, and the result comes back", async () => {
    const before = providerCalls.length;
    const { state: s } = await run(mine, A.agent, "acct-owner", "message", { sessionId: SESSION, text: "fix it" });
    expect(s).toMatchObject({ status: "done", action: "message", result: { status: "done", data: { echo: "message" } } });
    expect(providerCalls.slice(before)).toEqual([{ sessionId: SESSION, text: "fix it", requestedBy: "acct-owner", action: "message" }]);
  });
});

describe("ownership", () => {
  test("a non-owner's command is refused 403, logged as a security event, and nothing reaches the agent", async () => {
    const spy = vi.spyOn(ctx.securityLog, "log");
    const res = await command(mine.peerId, "acct-other", "message", { sessionId: SESSION, text: "hi" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_your_machine");
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ event: "code_control_not_owner", source: { type: "system", id: "acct-other" }, details: expect.objectContaining({ agentId: mine.peerId, action: "message" }) }));
    expect(codeFrames(mine)).toEqual([]);
    spy.mockRestore();
    // A machine with no verified owner answers the same way.
    expect((await command("agent-nobody", "acct-owner", "projects")).json().error).toBe("not_your_machine");
  });

  test("another account sees none of my machines", async () => {
    expect((await list("acct-other", [mine.peerId, offline.peerId])).json().machines).toEqual([]);
  });

  test("no service token, unknown actions, and path arguments are refused before anything is signed", async () => {
    expect((await command(mine.peerId, "acct-owner", "projects", {}, null)).statusCode).toBe(401);
    expect((await command(mine.peerId, "acct-owner", "rm_rf", {})).statusCode).toBe(400);
    expect((await command(mine.peerId, "acct-owner", "create", { projectId: "../../etc" })).statusCode).toBe(400);
    expect((await command(mine.peerId, "acct-owner", "create", { projectId: PROJECT.projectId, path: "/" })).statusCode).toBe(400);
    expect(codeFrames(mine)).toEqual([]);
  });

  test("results go only to the account that asked", async () => {
    const { id } = await run(mine, A.agent, "acct-owner", "projects");
    expect((await state(id, "acct-owner")).statusCode).toBe(200);
    const other = await state(id, "acct-other");
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({ error: "unknown_command" });
    // Another agent can't settle (or overwrite) my command.
    expect((await signedPost(theirs, `/agent-control/agents/${theirs.peerId}/code/report`, { result: { commandId: id, status: "failed", error: "x" } })).statusCode).toBe(404);
    expect((await state(id, "acct-owner")).json().status).toBe("done");
  });

  test("the audit lists each command for its account only, without the message text", async () => {
    const m = (await list("acct-owner", [mine.peerId])).json().machines[0];
    const msg = m.audit.find((e: any) => e.action === "message");
    expect(msg).toMatchObject({ accountId: "acct-owner", agentId: mine.peerId, sessionId: SESSION, status: "done" });
    expect(JSON.stringify(m.audit)).not.toContain("fix it");
    expect((await list("acct-other", [theirs.peerId])).json().machines[0].audit).toEqual([]);
  });
});

describe("delivery and limits", () => {
  test("an offline Mac: last snapshot readable, commands 409 agent_not_connected", async () => {
    const res = await command(offline.peerId, "acct-owner", "message", { sessionId: SESSION, text: "hi" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("agent_not_connected");
  });

  test("per-account limits: changes and reads per 10 minutes, new sessions per hour", () => {
    const base = { agentId: mine.peerId, coordinatorId: coordinatorIdentity.peerId, privateKeyPem: "" };
    const keyed = { ...base, privateKeyPem: (ctx.coordinatorKeys as { privateKeyPem: string }).privateKeyPem };
    const send = (accountId: string, request: any, nowMs: number) => sendCodeCommand({ ...keyed, accountId, ownerAccountId: accountId, request, nowMs });
    const t0 = Date.now();
    for (let i = 0; i < ACCOUNT_CODE_CHANGES_PER_WINDOW; i++) expect(send("acct-limit-a", { action: "cancel", args: { sessionId: SESSION } }, t0).ok).toBe(true);
    expect(send("acct-limit-a", { action: "cancel", args: { sessionId: SESSION } }, t0)).toMatchObject({ ok: false, status: 429, error: "rate_limited" });
    // Reads are counted apart, and other accounts are not affected.
    expect(send("acct-limit-a", { action: "projects", args: {} }, t0).ok).toBe(true);
    expect(send("acct-limit-b", { action: "cancel", args: { sessionId: SESSION } }, t0).ok).toBe(true);
    expect(send("acct-limit-a", { action: "cancel", args: { sessionId: SESSION } }, t0 + 10 * 60_000 + 1).ok).toBe(true);

    for (let i = 0; i < ACCOUNT_CODE_READS_PER_WINDOW; i++) expect(send("acct-limit-c", { action: "sessions", args: {} }, t0).ok).toBe(true);
    expect(send("acct-limit-c", { action: "sessions", args: {} }, t0)).toMatchObject({ status: 429 });

    for (let i = 0; i < ACCOUNT_CODE_CREATES_PER_HOUR; i++) expect(send("acct-limit-d", { action: "create", args: { projectId: PROJECT.projectId } }, t0).ok).toBe(true);
    expect(send("acct-limit-d", { action: "create", args: { projectId: PROJECT.projectId } }, t0)).toMatchObject({ status: 429, message: expect.stringContaining("new sessions") });
    expect(send("acct-limit-d", { action: "create", args: { projectId: PROJECT.projectId } }, t0 + 30 * 60_000)).toMatchObject({ status: 429 });
    expect(send("acct-limit-d", { action: "create", args: { projectId: PROJECT.projectId } }, t0 + 60 * 60_000 + 1).ok).toBe(true);
    frames.get(mine.peerId)!.length = 0;
  });
});
