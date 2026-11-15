import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerMachineRoutes } from "../../src/portal/routes/machines.js";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { machinesPageScript } from "../../src/portal/pages/settings-machines.js";

/*
 * Settings > Nodes > machines' models: the portal names the account from the session only, checks
 * the machine is enrolled to that user, and asks the coordinators with the service token; the
 * coordinator that holds the machine's connection answers.
 */
const SERVICE = "s".repeat(40);
let coordA: Server;
let coordB: Server;
const seen: Array<{ coord: string; url: string; token: unknown; body: any }> = [];

function fakeCoordinator(name: string, connectedAgents: string[]): Server {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ coord: name, url: req.url ?? "", token: req.headers["x-portal-service-token"], body });
      if (req.url === "/agent-control/machines") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ machines: (body.agentIds as string[]).map((agentId) => ({ agentId, connected: connectedAgents.includes(agentId), state: connectedAgents.includes(agentId) ? { activeModel: "qwen3.5:9b", from: name } : null, stateAtMs: connectedAgents.includes(agentId) ? 2 : null, lastSeenMs: 1, coordinatorId: name, audit: [{ commandId: `${name}-c1`, requestedAtMs: 5, accountId: body.accountId }] })) }));
        return;
      }
      const m = /^\/agent-control\/agents\/([^/]+)\/commands$/.exec(req.url ?? "");
      if (m && !connectedAgents.includes(decodeURIComponent(m[1]))) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "agent_not_connected" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, commandId: `cmd-from-${name}` }));
    });
  });
}

let app: ReturnType<typeof Fastify>;
beforeAll(async () => {
  coordA = fakeCoordinator("A", []);
  coordB = fakeCoordinator("B", ["mac-1"]);
  await Promise.all([coordA, coordB].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
  const urls = [coordA, coordB].map((s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`);
  app = Fastify();
  registerMachineRoutes(app, {
    PORTAL_SERVICE_TOKEN: SERVICE,
    EXTERNAL_HTTP_TIMEOUT_MS: 3000,
    discoverCoordinatorUrlsForPortal: async () => urls,
    getCurrentUser: async (req) => (req.headers["x-test-user"] ? { userId: String(req.headers["x-test-user"]) } : null),
    store: {
      listNodesByOwner: async (userId) =>
        userId === "u1" ? [{ nodeId: "mac-1", nodeKind: "agent" }, { nodeId: "gpu-1", nodeKind: "agent" }, { nodeId: "coord-x", nodeKind: "coordinator" }] : [{ nodeId: "other-1", nodeKind: "agent" }]
    }
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await Promise.all([coordA, coordB].map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe("portal machine routes", () => {
  it("need a session", async () => {
    expect((await app.inject({ method: "GET", url: "/portal/api/machines" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/portal/api/machines/mac-1/commands", payload: { action: "refresh", args: {} } })).statusCode).toBe(401);
  });

  it("list the user's agent machines from every coordinator, the connected one winning", async () => {
    seen.length = 0;
    const res = await app.inject({ method: "GET", url: "/portal/api/machines", headers: { "x-test-user": "u1" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accountId).toBe("acct-u1");
    expect(body.machines.map((m: any) => m.agentId).sort()).toEqual(["gpu-1", "mac-1"]);
    const mac = body.machines.find((m: any) => m.agentId === "mac-1");
    expect(mac).toMatchObject({ connected: true, state: { from: "B" } });
    expect(mac.audit.map((e: any) => e.commandId).sort()).toEqual(["A-c1", "B-c1"]);
    expect(body.catalog.length).toBeGreaterThan(5);
    // The account comes from the session and the service token goes along; coordinators are not listed.
    expect(seen.every((s) => s.token === SERVICE && s.body.accountId === "acct-u1")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
  });

  it("send a command for the user's own machine to the coordinator holding it", async () => {
    seen.length = 0;
    const res = await app.inject({ method: "POST", url: "/portal/api/machines/mac-1/commands", headers: { "x-test-user": "u1" }, payload: { action: "pull", args: { model: "qwen3.5:4b" }, accountId: "acct-attacker" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().commandId).toBe("cmd-from-B");
    const sent = seen.filter((s) => s.url.endsWith("/commands"));
    expect(sent.map((s) => s.body)).toEqual([
      { accountId: "acct-u1", action: "pull", args: { model: "qwen3.5:4b" } },
      { accountId: "acct-u1", action: "pull", args: { model: "qwen3.5:4b" } }
    ]);
  });

  it("refuse another user's machine, a coordinator node, and malformed commands without calling a coordinator", async () => {
    seen.length = 0;
    expect((await app.inject({ method: "POST", url: "/portal/api/machines/other-1/commands", headers: { "x-test-user": "u1" }, payload: { action: "refresh", args: {} } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/portal/api/machines/coord-x/commands", headers: { "x-test-user": "u1" }, payload: { action: "refresh", args: {} } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/portal/api/machines/mac-1/commands", headers: { "x-test-user": "u1" }, payload: { action: "pull", args: { model: "x.y/z" } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/portal/api/machines/mac-1/commands", headers: { "x-test-user": "u1" }, payload: { action: "set_settings", args: { contextWindow: 8192, evil: 1 } } })).statusCode).toBe(400);
    expect(seen).toEqual([]);
  });

  it("answer agent_not_connected when no coordinator holds the machine", async () => {
    const res = await app.inject({ method: "POST", url: "/portal/api/machines/gpu-1/commands", headers: { "x-test-user": "u1" }, payload: { action: "restart_model", args: {} } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("agent_not_connected");
  });
});

describe("Settings > Nodes page", () => {
  it("renders the machines section and its script parses", async () => {
    const pages = Fastify();
    registerPortalPages(pages);
    const res = await pages.inject({ url: "/portal/settings/nodes" });
    expect(res.statusCode).toBe(200);
    for (const id of ["machinesGroup", "machinesList", "machinesReloadBtn", "nodesBody"]) expect(res.body).toContain(`id="${id}"`);
    expect(res.body).toContain("/portal/api/machines");
    expect(res.body).not.toMatch(/\sstyle\s*=\s*\\?["']/i);
    expect(() => new Function(machinesPageScript())).not.toThrow();
    await pages.close();
  });

  it("escapes what machines report", () => {
    const script = machinesPageScript();
    // Agent-supplied strings reach innerHTML only through escapeHtml (or as numbers).
    for (const field of ["m.agentId", "im.name", "st.ollamaVersion", "e.action", "e.args", "n)"]) {
      expect(script).toContain(`escapeHtml(${field}`);
    }
  });
});
