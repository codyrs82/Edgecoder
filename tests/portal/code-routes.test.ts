import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerCodeRoutes } from "../../src/portal/routes/code.js";

/*
 * Code from your phone, portal side: the account comes from the session only, only the user's
 * enrolled machines are asked about or commanded, a command goes to whichever coordinator holds the
 * Mac's connection, a command's state reads back only for the account that sent it, and every
 * answer is no-store.
 */
const SERVICE = "s".repeat(40);
const NOW = Date.now();
const SESSION = "11111111-1111-4111-8111-111111111111";
const PROJECT = "0123456789abcdef";
const CMD = "cmd-12345678";

type Seen = { coord: string; url: string; token: unknown; body: any };
const seen: Seen[] = [];

const snapshot = (controls: "on" | "view", name: string) => ({
  v: 1,
  machineName: name,
  controls,
  account: "acct-u1",
  generatedAtMs: NOW - 10,
  projects: [{ projectId: PROJECT, name: "Edgecoder", parent: "Code", branch: "main" }, { projectId: "fedcba9876543210", name: "Notes", parent: "Docs" }],
  sessions: [
    { id: SESSION, title: "Fix the tests", projectId: PROJECT, projectName: "Edgecoder", branch: "main", model: "m", mode: "ask", origin: "remote", published: true, running: true, pending: 2, queued: 0, messages: 4, cSats: 1, createdAt: 1, updatedAt: NOW - 5 },
    { id: "22222222-2222-4222-8222-222222222222", title: "Idle one", projectId: PROJECT, projectName: "Edgecoder", branch: null, model: "m", mode: "ask", origin: "desktop", published: true, running: false, pending: 0, queued: 0, messages: 1, cSats: 0, createdAt: 1, updatedAt: 7 },
  ],
});

/**
 * Coordinator A holds no connection (stale snapshot of mac-1 only); coordinator B holds mac-1 (on),
 * mac-3 (view) and mac-4 (connected, relay off: no snapshot). mac-2 is enrolled but nobody knows it.
 */
function fakeCoordinator(name: "A" | "B"): Server {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ coord: name, url: req.url ?? "", token: req.headers["x-portal-service-token"], body });
      const send = (status: number, j: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(j));
      };
      if (req.url === "/agent-control/code") {
        if (body.accountId !== "acct-u1") return send(200, { machines: [] });
        const machines =
          name === "A"
            ? [{ agentId: "mac-1", connected: false, reportedAtMs: NOW - 60_000, snapshot: snapshot("view", "Old name"), audit: [] }]
            : [
                { agentId: "mac-1", connected: true, reportedAtMs: NOW, snapshot: snapshot("on", "MAW-MB-02"), audit: [] },
                { agentId: "mac-3", connected: true, reportedAtMs: NOW, snapshot: snapshot("view", "Viewer"), audit: [] },
                { agentId: "mac-4", connected: true, reportedAtMs: null, snapshot: null, audit: [] },
                // A coordinator that (wrongly) names a machine the user doesn't own: never shown.
                { agentId: "not-mine", connected: true, reportedAtMs: NOW, snapshot: { ...snapshot("on", "Mallory"), account: "acct-u1" }, audit: [] },
              ];
        return send(200, { coordinatorId: name, machines: machines.filter((m) => body.agentIds.includes(m.agentId)) });
      }
      const m = /^\/agent-control\/agents\/([^/]+)\/code-commands$/.exec(req.url ?? "");
      if (m) {
        if (name === "A" || m[1] !== "mac-1") return send(409, { error: "agent_not_connected" });
        return send(200, { ok: true, commandId: CMD, coordinatorId: "B" });
      }
      if (req.url === `/agent-control/code-commands/${CMD}`) {
        if (name === "A" || body.accountId !== "acct-u1") return send(404, { error: "unknown_command" });
        return send(200, { status: "done", agentId: "mac-1", action: "snapshot", result: { commandId: CMD, status: "done", data: { seq: 3, tail: [] } } });
      }
      if (req.url === "/agent-control/code-commands/cmd-refused1") {
        return send(200, { status: "refused", agentId: "mac-1", action: "message", result: { commandId: "cmd-refused1", status: "refused", error: "view_only", message: "no" } });
      }
      if (req.url === "/agent-control/code-commands/cmd-pending1") return send(200, { status: "sent", agentId: "mac-1", action: "message" });
      send(404, {});
    });
  });
}

let coordA: Server;
let coordB: Server;
let app: ReturnType<typeof Fastify>;
const as = (user: string | null) => (user ? { "x-test-user": user } : {});
const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
beforeAll(async () => {
  coordA = fakeCoordinator("A");
  coordB = fakeCoordinator("B");
  await Promise.all([coordA, coordB].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
  app = Fastify();
  registerCodeRoutes(app, {
    PORTAL_SERVICE_TOKEN: SERVICE,
    EXTERNAL_HTTP_TIMEOUT_MS: 3000,
    discoverCoordinatorUrlsForPortal: async () => [url(coordA), url(coordB)],
    getCurrentUser: async (req) => (req.headers["x-test-user"] ? { userId: String(req.headers["x-test-user"]) } : null),
    store: {
      listNodesByOwner: async (userId) =>
        userId === "u1" ? ["mac-1", "mac-2", "mac-3", "mac-4"].map((nodeId) => ({ nodeId, nodeKind: "agent" })).concat([{ nodeId: "coord-x", nodeKind: "coordinator" }]) : [{ nodeId: "other-1", nodeKind: "agent" }],
    },
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await Promise.all([coordA, coordB].map((s) => new Promise<void>((r) => s.close(() => r()))));
});
beforeEach(() => {
  seen.length = 0;
});

describe("portal code API", () => {
  it("needs a session (401, no-store), and asks no coordinator", async () => {
    for (const r of [
      await app.inject({ url: "/portal/api/code/machines" }),
      await app.inject({ method: "POST", url: "/portal/api/code/mac-1/commands", payload: { action: "sessions" } }),
      await app.inject({ url: `/portal/api/code/commands/${CMD}` }),
    ]) {
      expect(r.statusCode).toBe(401);
      expect(r.headers["cache-control"]).toBe("no-store");
    }
    expect(seen).toEqual([]);
  });

  it("lists every enrolled machine with projects and sessions in the contract's shape", async () => {
    const res = await app.inject({ url: "/portal/api/code/machines", headers: as("u1") });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { machines } = res.json();
    expect(machines.map((m: any) => m.agentId)).toEqual(["mac-1", "mac-2", "mac-3", "mac-4"]);
    // The connected coordinator's snapshot wins over a stale one elsewhere.
    expect(machines[0]).toEqual({
      agentId: "mac-1",
      name: "MAW-MB-02",
      online: true,
      controls: "on",
      projects: [{ projectId: PROJECT, name: "Edgecoder", parent: "Code", branch: "main" }, { projectId: "fedcba9876543210", name: "Notes", parent: "Docs" }],
      sessions: [
        { sessionId: SESSION, projectId: PROJECT, title: "Fix the tests", status: "waiting", updatedAtMs: NOW - 5, pendingApprovals: 2, startedFrom: "phone" },
        { sessionId: "22222222-2222-4222-8222-222222222222", projectId: PROJECT, title: "Idle one", status: "idle", updatedAtMs: 7, pendingApprovals: 0, startedFrom: "mac" },
      ],
      updatedAtMs: NOW,
    });
    // Unknown to every coordinator: offline, off, empty.
    expect(machines[1]).toEqual({ agentId: "mac-2", name: "mac-2", online: false, controls: "off", projects: [], sessions: [], updatedAtMs: 0 });
    expect(machines[2]).toMatchObject({ name: "Viewer", online: true, controls: "view" });
    // Connected with no snapshot (relay off on the Mac).
    expect(machines[3]).toMatchObject({ agentId: "mac-4", online: true, controls: "off", projects: [], sessions: [] });
    expect(JSON.stringify(machines)).not.toContain("Mallory");
    // Each coordinator was asked for the session's account and enrolled agents only, with the service token.
    const asked = seen.filter((s) => s.url === "/agent-control/code");
    expect(asked).toHaveLength(2);
    for (const s of asked) expect(s).toMatchObject({ token: SERVICE, body: { accountId: "acct-u1", agentIds: ["mac-1", "mac-2", "mac-3", "mac-4"] } });
  });

  it("another user sees none of my machines", async () => {
    const res = await app.inject({ url: "/portal/api/code/machines", headers: as("u2") });
    expect(res.json().machines).toEqual([{ agentId: "other-1", name: "other-1", online: false, controls: "off", projects: [], sessions: [], updatedAtMs: 0 }]);
    expect(seen.every((s) => s.body.accountId === "acct-u2")).toBe(true);
  });

  it("refuses a machine not enrolled to me (403) without sending anything", async () => {
    const r = await app.inject({ method: "POST", url: "/portal/api/code/mac-1/commands", headers: as("u2"), payload: { action: "sessions" } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "not_your_machine" });
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(seen).toEqual([]);
  });

  it("sends { action, ...args } to the coordinator holding the connection (falls back past one that doesn't): 202 { commandId }", async () => {
    const r = await app.inject({ method: "POST", url: "/portal/api/code/mac-1/commands", headers: as("u1"), payload: { action: "message", sessionId: SESSION, text: "run the tests" } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ commandId: CMD });
    expect(r.headers["cache-control"]).toBe("no-store");
    const sent = seen.filter((s) => s.url === "/agent-control/agents/mac-1/code-commands");
    expect(sent.map((s) => s.coord)).toEqual(["A", "B"]);
    for (const s of sent) expect(s).toMatchObject({ token: SERVICE, body: { accountId: "acct-u1", action: "message", args: { sessionId: SESSION, text: "run the tests" } } });
  });

  it("a message with images (over the default 1 MB body) is passed on; a mislabelled or oversized one is refused here", async () => {
    const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n - 8, 5)]).toString("base64");
    const attachments = [{ name: "shot.png", mediaType: "image/png", data: png(3 * 1024 * 1024) }];
    const r = await app.inject({ method: "POST", url: "/portal/api/code/mac-1/commands", headers: as("u1"), payload: { action: "message", sessionId: SESSION, text: "what's wrong?", attachments } });
    expect(r.statusCode).toBe(202);
    const sent = seen.filter((x) => x.url === "/agent-control/agents/mac-1/code-commands").at(-1)!;
    expect(sent.body).toMatchObject({ action: "message", args: { sessionId: SESSION, text: "what's wrong?", attachments } });
    seen.length = 0;
    for (const bad of [[{ ...attachments[0], mediaType: "image/gif" }], [{ name: "x.png", mediaType: "image/png", data: Buffer.from("<svg/>").toString("base64") }], [{ name: "big.png", mediaType: "image/png", data: png(5 * 1024 * 1024 + 1) }]]) {
      const b = await app.inject({ method: "POST", url: "/portal/api/code/mac-1/commands", headers: as("u1"), payload: { action: "message", sessionId: SESSION, text: "x", attachments: bad } });
      expect(b.statusCode).toBe(400);
    }
    expect(seen.filter((x) => x.url.includes("code-commands"))).toEqual([]);
  });

  it("ignores account fields in the body: the session decides the account", async () => {
    const r = await app.inject({ method: "POST", url: "/portal/api/code/mac-1/commands", headers: as("u1"), payload: { action: "cancel", sessionId: SESSION, accountId: "acct-evil", account: "acct-evil", requestedBy: "acct-evil" } });
    expect(r.statusCode).toBe(202);
    const sent = seen.filter((s) => s.url.endsWith("/code-commands"));
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) expect(s.body).toEqual({ accountId: "acct-u1", action: "cancel", args: { sessionId: SESSION } });
    expect(JSON.stringify(seen)).not.toContain("acct-evil");
  });

  it("forwards every command the web Code page sends, in the contract's shape (the same as the phone's)", async () => {
    const TURN = "33333333-3333-4333-8333-333333333333";
    const QUEUED = "44444444-4444-4444-8444-444444444444";
    const bodies: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ action: "snapshot", sessionId: SESSION }, { sessionId: SESSION }],
      [{ action: "messages", sessionId: SESSION, beforeId: TURN }, { sessionId: SESSION, beforeId: TURN }],
      [{ action: "changes", sessionId: SESSION, turnId: TURN }, { sessionId: SESSION, turnId: TURN }],
      [{ action: "approve", sessionId: SESSION, callId: "tc_1", approved: true }, { sessionId: SESSION, callId: "tc_1", approved: true }],
      [{ action: "approve", sessionId: SESSION, callId: "tc_1", approved: false }, { sessionId: SESSION, callId: "tc_1", approved: false }],
      [{ action: "plan", sessionId: SESSION, mode: "auto-edits" }, { sessionId: SESSION, mode: "auto-edits" }],
      [{ action: "settings", sessionId: SESSION, mode: "plan" }, { sessionId: SESSION, mode: "plan" }],
      [{ action: "unqueue", sessionId: SESSION, queuedId: QUEUED }, { sessionId: SESSION, queuedId: QUEUED }],
      [{ action: "undo", sessionId: SESSION, turnId: TURN }, { sessionId: SESSION, turnId: TURN }],
      [{ action: "create", projectId: PROJECT, mode: "ask", title: "From the web" }, { projectId: PROJECT, mode: "ask", title: "From the web" }],
    ];
    for (const [payload, args] of bodies) {
      seen.length = 0;
      const r = await app.inject({ method: "POST", url: "/portal/api/code/mac-1/commands", headers: as("u1"), payload });
      expect(r.statusCode, String(payload.action)).toBe(202);
      const sent = seen.filter((s) => s.coord === "B" && s.url === "/agent-control/agents/mac-1/code-commands");
      expect(sent, String(payload.action)).toHaveLength(1);
      expect(sent[0].body).toEqual({ accountId: "acct-u1", action: payload.action, args });
    }
  });

  it("an approval can't carry an always-allow rule from the web (the relay approves one call only)", async () => {
    for (const extra of [{ always: true }, { scope: "always" }, { remember: true }]) {
      const r = await app.inject({ method: "POST", url: "/portal/api/code/mac-1/commands", headers: as("u1"), payload: { action: "approve", sessionId: SESSION, callId: "tc_1", approved: true, ...extra } });
      expect(r.statusCode).toBe(400);
    }
    expect(seen.filter((s) => s.url.endsWith("/code-commands"))).toEqual([]);
  });

  it("400 bad_request for an unknown action, a bad argument, or a field the action doesn't name", async () => {
    for (const payload of [{ action: "rm" }, { action: "message", sessionId: "nope", text: "x" }, { action: "create", projectId: PROJECT, path: "/etc" }, { sessionId: SESSION }]) {
      const r = await app.inject({ method: "POST", url: "/portal/api/code/mac-1/commands", headers: as("u1"), payload });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("bad_request");
    }
    expect(seen.filter((s) => s.url.endsWith("/code-commands"))).toEqual([]);
  });

  it("409 agent_not_connected when no coordinator holds the machine", async () => {
    const r = await app.inject({ method: "POST", url: "/portal/api/code/mac-2/commands", headers: as("u1"), payload: { action: "sessions" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("agent_not_connected");
    expect(seen.filter((s) => s.url.endsWith("/code-commands")).map((s) => s.coord)).toEqual(["A", "B"]);
  });

  it("409 view_only / relay_off from the machine's own setting, without sending", async () => {
    const view = await app.inject({ method: "POST", url: "/portal/api/code/mac-3/commands", headers: as("u1"), payload: { action: "sessions" } });
    expect(view.statusCode).toBe(409);
    expect(view.json().error).toBe("view_only");
    const off = await app.inject({ method: "POST", url: "/portal/api/code/mac-4/commands", headers: as("u1"), payload: { action: "sessions" } });
    expect(off.statusCode).toBe(409);
    expect(off.json().error).toBe("relay_off");
    expect(seen.filter((s) => s.url.endsWith("/code-commands"))).toEqual([]);
  });

  it("polls a command with the session's account: mine reads back, anyone else's is unknown", async () => {
    const mine = await app.inject({ url: `/portal/api/code/commands/${CMD}`, headers: as("u1") });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers["cache-control"]).toBe("no-store");
    expect(mine.json()).toEqual({ status: "done", result: { seq: 3, tail: [] } });
    // Coordinator A doesn't know it; B does.
    expect(seen.filter((s) => s.url === `/agent-control/code-commands/${CMD}`).map((s) => [s.coord, s.body.accountId])).toEqual([["A", "acct-u1"], ["B", "acct-u1"]]);
    seen.length = 0;
    const theirs = await app.inject({ url: `/portal/api/code/commands/${CMD}`, headers: as("u2") });
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json()).toEqual({ error: "unknown_command" });
    expect(theirs.headers["cache-control"]).toBe("no-store");
    expect(seen.every((s) => s.body.accountId === "acct-u2")).toBe(true);
  });

  it("maps the coordinator's states: sent is pending, refused is failed with its error", async () => {
    expect((await app.inject({ url: "/portal/api/code/commands/cmd-pending1", headers: as("u1") })).json()).toEqual({ status: "pending" });
    expect((await app.inject({ url: "/portal/api/code/commands/cmd-refused1", headers: as("u1") })).json()).toEqual({ status: "failed", error: "view_only", message: "no" });
    expect((await app.inject({ url: "/portal/api/code/commands/bad!", headers: as("u1") })).statusCode).toBe(400);
  });
});
