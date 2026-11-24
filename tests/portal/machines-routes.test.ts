import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerMachineRoutes } from "../../src/portal/routes/machines.js";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { machinesPageScript, sizedSettingHtml, sizedSettingNote } from "../../src/portal/pages/settings-machines.js";
import { agentSupportsSettingsAuto } from "../../src/portal/agent-release.js";

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
        res.end(JSON.stringify({ machines: (body.agentIds as string[]).map((agentId) => ({ agentId, connected: connectedAgents.includes(agentId), state: connectedAgents.includes(agentId) ? { activeModel: "qwen3.5:9b", from: name } : null, stateAtMs: connectedAgents.includes(agentId) ? 2 : null, lastSeenMs: 1, ...(connectedAgents.includes(agentId) ? { version: "1.2.0" } : {}), coordinatorId: name, audit: [{ commandId: `${name}-c1`, requestedAtMs: 5, accountId: body.accountId }] })) }));
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
    },
    latestAgentVersion: () => "1.3.0"
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
    expect(mac).toMatchObject({ connected: true, state: { from: "B" }, version: "1.2.0", updateAvailable: true, settingsAuto: false });
    expect(body.settingsAutoMinVersion).toBe("1.2.8");
    expect(body.latestAgentVersion).toBe("1.3.0");
    expect(body.machines.find((m: any) => m.agentId === "gpu-1")).toMatchObject({ version: null, updateAvailable: false });
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
    expect((await app.inject({ method: "POST", url: "/portal/api/machines/mac-1/commands", headers: { "x-test-user": "u1" }, payload: { action: "set_settings", args: { contextWindow: "automatic" } } })).statusCode).toBe(400);
    expect(seen).toEqual([]);
  });

  it("pass an Automatic setting through to the coordinator", async () => {
    seen.length = 0;
    const res = await app.inject({ method: "POST", url: "/portal/api/machines/mac-1/commands", headers: { "x-test-user": "u1" }, payload: { action: "set_settings", args: { contextWindow: "auto", parallel: "auto" } } });
    expect(res.statusCode).toBe(200);
    expect(seen.filter((s) => s.url.endsWith("/commands")).at(-1)?.body).toEqual({ accountId: "acct-u1", action: "set_settings", args: { contextWindow: "auto", parallel: "auto" } });
  });

  it("answer agent_not_connected when no coordinator holds the machine", async () => {
    const res = await app.inject({ method: "POST", url: "/portal/api/machines/gpu-1/commands", headers: { "x-test-user": "u1" }, payload: { action: "restart_model", args: {} } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("agent_not_connected");
  });
});

describe("Automatic context window and slots: offered only to agents that take it", () => {
  it("decides from the agent's reported features, else its release version", () => {
    expect(agentSupportsSettingsAuto("1.2.7", { settings: {} })).toBe(false);
    expect(agentSupportsSettingsAuto("1.2.8", null)).toBe(true);
    expect(agentSupportsSettingsAuto("1.3.0", {})).toBe(true);
    // Desktop and source builds report package.json's version: their state says it instead.
    expect(agentSupportsSettingsAuto("1.0.0", { features: ["settings_auto"] })).toBe(true);
    expect(agentSupportsSettingsAuto("1.0.0", { features: ["something_else"] })).toBe(false);
    expect(agentSupportsSettingsAuto(null, { features: "settings_auto" })).toBe(false);
    expect(agentSupportsSettingsAuto("mesh-peer", null)).toBe(false);
    expect(agentSupportsSettingsAuto(undefined, undefined)).toBe(false);
  });

  it("the field shows the effective value and who sets it; Automatic is offered only when it can apply", () => {
    const base = { id: "mac-1", min: 2048, max: 131072, can: true, autoOk: true };
    const auto = sizedSettingHtml({ ...base, key: "ctx", value: 40960, source: "default" });
    expect(auto).toContain("40960, automatic");
    expect(auto).toMatch(/id='ctx-auto-mac-1'[^>]* checked \/>/);
    expect(auto).toMatch(/id='ctx-mac-1'[^>]* disabled/); // the number is the agent's while automatic
    expect(auto).toContain("aria-label='Automatic context window'");
    const here = sizedSettingHtml({ ...base, key: "par", value: 3, source: "remote", min: 1, max: 8 });
    expect(here).toContain("3, pinned here");
    expect(here).not.toMatch(/id='par-auto-mac-1'[^>]*(checked|disabled)/);
    expect(here).not.toMatch(/id='par-mac-1'[^>]*disabled/);
    const local = sizedSettingHtml({ ...base, key: "ctx", value: 16384, source: "env" });
    expect(local).toContain("16384, pinned by this machine's config");
    expect(local).toMatch(/id='ctx-auto-mac-1'[^>]* disabled/);
    expect(sizedSettingHtml({ ...base, key: "ctx", value: 16384, source: "env", localUi: true })).toContain("pinned by this machine's EdgeCoder app");
    // An older agent: Automatic shown (what it is now) but not choosable; the number still works.
    const old = sizedSettingHtml({ ...base, autoOk: false, key: "ctx", value: 8192, source: "default" });
    expect(old).toMatch(/id='ctx-auto-mac-1'[^>]* disabled/);
    expect(old).not.toMatch(/id='ctx-mac-1'[^>]*disabled/);
    // Offline or remote control off: nothing is choosable.
    const off = sizedSettingHtml({ ...base, can: false, key: "ctx", value: 8192, source: "remote" });
    expect(off).toMatch(/id='ctx-auto-mac-1'[^>]* disabled/);
    expect(off).toMatch(/id='ctx-mac-1'[^>]*disabled/);
  });

  it("says why Automatic is unavailable: update the agent, or the machine's own config pins it", () => {
    expect(sizedSettingNote({ version: "1.2.7", settingsAuto: false }, {}, "1.2.8")).toBe(
      "Automatic context window and slots need agent 1.2.8 or later; this machine runs 1.2.7. Update its agent (it updates itself within about an hour, or now with: sudo edgecoder-install update) to choose Automatic here."
    );
    expect(sizedSettingNote({ settingsAuto: true }, { sources: { contextWindow: "default", parallel: "remote" } }, "1.2.8")).toBe("");
    expect(sizedSettingNote({ settingsAuto: true }, { sources: { contextWindow: "env", parallel: "env" } }, "1.2.8")).toContain(
      "run on the machine: sudo edgecoder-install apply --keep-config --context-window auto --parallel auto"
    );
    expect(sizedSettingNote({ settingsAuto: true }, { localUi: true, sources: { parallel: "env" } }, "1.2.8")).toBe("This machine's EdgeCoder app sets its slots; make it automatic in the app.");
  });

  it("the page sends \"auto\" only for a ticked Automatic on an agent that takes it, and pins a number otherwise", async () => {
    const sent: any[] = [];
    const els = new Map<string, any>();
    const handlers: Record<string, (e: unknown) => void> = {};
    const el = (id: string) => {
      if (!els.has(id)) els.set(id, { id, value: "", checked: false, disabled: false, innerHTML: "", addEventListener: (t: string, h: (e: unknown) => void) => { if (id === "machinesList") handlers[t] = h; } });
      return els.get(id);
    };
    const run = new Function("document", "escapeHtml", "statusBadge", "api", "showToast", "setTimeout", "clearTimeout", "window",
      machinesPageScript() + "; return { set: (d) => { machinesData = d; }, renderMachine };");
    const page = run({ getElementById: el }, (x: unknown) => String(x), (x: string) => x, async (_u: string, o: any) => sent.push(JSON.parse(o.body)), () => undefined, () => 0, () => undefined, {});
    const machine = (settingsAuto: boolean, sources: Record<string, string>) => ({
      agentId: "mac-1", connected: true, version: settingsAuto ? "1.2.8" : "1.2.7", settingsAuto, audit: [],
      state: { remoteControl: "on", settings: { contextWindow: 8192, parallel: 2, keepAlive: "30m" }, sources, bounds: { contextWindow: { min: 2048, max: 131072 }, parallel: { min: 1, max: 8 } } }
    });
    const apply = async (m: any, inputs: Record<string, { value?: string; checked?: boolean; disabled?: boolean }>) => {
      page.set({ machines: [m], settingsAutoMinVersion: "1.2.8" });
      sent.length = 0;
      for (const [id, v] of Object.entries(inputs)) Object.assign(el(id), v);
      handlers.click({ target: { classList: { contains: (c: string) => c === "mcBtn" }, getAttribute: (a: string) => (a === "data-agent" ? "mac-1" : a === "data-action" ? "set_settings" : null) } });
      await Promise.resolve();
      return sent[0]?.args;
    };
    // The rendered row: Automatic offered to a new agent, explained (update) for an old one.
    expect(page.renderMachine(machine(true, { contextWindow: "remote", parallel: "default" }))).toContain("8192, pinned here");
    expect(page.renderMachine(machine(false, {}))).toContain("need agent 1.2.8 or later; this machine runs 1.2.7");
    // Pinned here, Automatic ticked: "auto" (slots already automatic: nothing for them).
    expect(await apply(machine(true, { contextWindow: "remote", parallel: "default" }), {
      "ctx-mac-1": { value: "8192" }, "par-mac-1": { value: "2" }, "ka-mac-1": { value: "30m" },
      "ctx-auto-mac-1": { checked: true, disabled: false }, "par-auto-mac-1": { checked: true, disabled: false }
    })).toEqual({ contextWindow: "auto" });
    // Automatic unticked: pin the number shown, even unchanged.
    expect(await apply(machine(true, { contextWindow: "default", parallel: "default" }), {
      "ctx-auto-mac-1": { checked: true, disabled: false }, "par-auto-mac-1": { checked: false, disabled: false }
    })).toEqual({ parallel: 2 });
    // An older agent: its boxes are disabled, so never "auto"; a changed number still goes.
    expect(await apply(machine(false, { contextWindow: "remote", parallel: "default" }), {
      "ctx-mac-1": { value: "16384" }, "ctx-auto-mac-1": { checked: true, disabled: true }, "par-auto-mac-1": { checked: true, disabled: true }
    })).toEqual({ contextWindow: 16384 });
    // Ticking Automatic hands the number field to the agent; unticking gives it back.
    handlers.change({ target: { classList: { contains: (c: string) => c === "mcAuto" }, checked: true, getAttribute: () => "ctx-mac-1" } });
    expect(el("ctx-mac-1").disabled).toBe(true);
    handlers.change({ target: { classList: { contains: (c: string) => c === "mcAuto" }, checked: false, getAttribute: () => "ctx-mac-1" } });
    expect(el("ctx-mac-1").disabled).toBe(false);
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
    for (const field of ["m.agentId", "im.name", "st.ollamaVersion", "e.action", "e.args", "n)", "note)"]) {
      expect(script).toContain(`escapeHtml(${field}`);
    }
  });
});
