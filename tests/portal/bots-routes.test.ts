import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import vm from "node:vm";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerBotRoutes, mergeMachines, BOTS_STALE_MS } from "../../src/portal/routes/bots.js";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { capMarkdownSource, MAX_MARKDOWN, TRIMMED_TEXT } from "../../src/common/markdown-cap.js";
import { readFileSync } from "node:fs";

/*
 * Bots on the web, portal side: the account comes from the session only, only the user's enrolled
 * machines are asked about (and only they are shown, whatever a coordinator answers), a Mac that
 * stopped reporting is offline and read-only, commands go to the coordinator holding the Mac's
 * connection, and the page renders with the desktop's layout pieces.
 */
const SERVICE = "s".repeat(40);
const NOW = Date.now();
const seen: Array<{ url: string; token: unknown; body: any }> = [];

function bot(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, role: "Lead Developer", color: "#0090ff", status: "idle", enabled: true, instructions: "", folderName: "Harry", schedule: "", heartbeatMinutes: 30, maxRunsPerDay: 48, runsToday: 0, runCount: 1, budgetCSatsPerDay: 100, spentTodayCSats: 3, compute: { policy: "auto" }, triggers: [], maxTriggerRunsPerHour: 6, pending: [], queuedMessages: 0, tail: [{ id: "m1", role: "user", content: "hi", atMs: 1 }], messageCount: 1, updatedAtMs: 1, ...extra };
}

function fakeCoordinator(): Server {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url ?? "", token: req.headers["x-portal-service-token"], body });
      if (!(req.url === "/agent-control/bot-commands/cmd-12345678" && body.accountId !== "acct-u1")) res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/agent-control/bots") {
        res.end(JSON.stringify({ machines: [
          { agentId: "mac-1", connected: true, reportedAtMs: NOW, lastSeenMs: NOW, snapshot: { v: 1, machineName: "MAW-MB-02", controls: "on", generatedAtMs: NOW, bots: [bot("bot_h", "Harry", { status: "needs_approval", pending: [{ callId: "tc_1", tool: "run_shell", detail: "npm test" }] })] } },
          { agentId: "mac-2", connected: false, reportedAtMs: NOW - BOTS_STALE_MS - 1, lastSeenMs: null, snapshot: { v: 1, machineName: "MAW-MB-03", controls: "on", generatedAtMs: 1, bots: [bot("bot_s", "Sally")] } },
          // A coordinator that (wrongly) names a machine the user doesn't own: never shown.
          { agentId: "not-mine", connected: true, reportedAtMs: NOW, snapshot: { v: 1, machineName: "X", controls: "on", generatedAtMs: 1, bots: [bot("bot_x", "Mallory")] } }
        ] }));
        return;
      }
      if (/^\/agent-control\/agents\/[^/]+\/bot-commands$/.test(req.url ?? "")) {
        res.end(JSON.stringify({ ok: true, commandId: "cmd-12345678" }));
        return;
      }
      if (req.url === "/agent-control/bot-commands/cmd-12345678") {
        if (body.accountId !== "acct-u1") {
          res.writeHead(404);
          res.end("{}");
          return;
        }
        res.end(JSON.stringify({ status: "done", agentId: "mac-1", botId: "bot_h", action: "pause", result: { commandId: "cmd-12345678", status: "done" } }));
        return;
      }
      res.end("{}");
    });
  });
}

let coord: Server;
let app: ReturnType<typeof Fastify>;
const as = (user: string | null) => (user ? { "x-test-user": user } : {});
beforeAll(async () => {
  coord = fakeCoordinator();
  await new Promise<void>((r) => coord.listen(0, "127.0.0.1", r));
  app = Fastify();
  registerBotRoutes(app, {
    PORTAL_SERVICE_TOKEN: SERVICE,
    EXTERNAL_HTTP_TIMEOUT_MS: 3000,
    discoverCoordinatorUrlsForPortal: async () => [`http://127.0.0.1:${(coord.address() as AddressInfo).port}`],
    getCurrentUser: async (req) => (req.headers["x-test-user"] ? { userId: String(req.headers["x-test-user"]) } : null),
    store: { listNodesByOwner: async (userId) => (userId === "u1" ? [{ nodeId: "mac-1", nodeKind: "agent" }, { nodeId: "mac-2", nodeKind: "agent" }] : [{ nodeId: "other-1", nodeKind: "agent" }]) }
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => coord.close(() => r()));
});

describe("portal bots API", () => {
  it("needs a session", async () => {
    expect((await app.inject({ url: "/portal/api/bots" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/portal/api/bots/mac-1/bot_h/commands", payload: { action: "pause" } })).statusCode).toBe(401);
  });

  it("lists my machines' bots with machine and online state, from the session's account only", async () => {
    seen.length = 0;
    const res = await app.inject({ url: "/portal/api/bots", headers: as("u1") });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.bots.map((b: any) => b.name)).toEqual(["Harry", "Sally"]);
    expect(j.bots[0].machine).toMatchObject({ agentId: "mac-1", machineName: "MAW-MB-02", online: true, controls: "on" });
    // Offline: read-only with the last snapshot.
    expect(j.bots[1].machine).toMatchObject({ machineName: "MAW-MB-03", online: false, controls: "view" });
    // The list carries no conversation; the bot page does.
    expect(j.bots[0].tail).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain("Mallory");
    expect(seen[0]).toMatchObject({ url: "/agent-control/bots", token: SERVICE, body: { accountId: "acct-u1", agentIds: ["mac-1", "mac-2"] } });
  });

  it("another user sees none of it, and can't open or command my bot", async () => {
    const res = await app.inject({ url: "/portal/api/bots", headers: as("u2") });
    expect(JSON.stringify(res.json())).not.toContain("Harry");
    expect((await app.inject({ url: "/portal/api/bots/mac-1/bot_h", headers: as("u2") })).statusCode).toBe(404);
    seen.length = 0;
    const cmd = await app.inject({ method: "POST", url: "/portal/api/bots/mac-1/bot_h/commands", headers: as("u2"), payload: { action: "pause" } });
    expect(cmd.statusCode).toBe(403);
    expect(seen).toEqual([]);
    // A command's result is read with the session's account; someone else's id finds nothing.
    expect((await app.inject({ url: "/portal/api/bots/mac-1/commands/cmd-12345678", headers: as("u2") })).statusCode).toBe(404);
  });

  it("one bot with its conversation; a command goes to the coordinator for my account, and its result reads back", async () => {
    const one = await app.inject({ url: "/portal/api/bots/mac-1/bot_h", headers: as("u1") });
    expect(one.json().bot).toMatchObject({ name: "Harry", pending: [{ callId: "tc_1", tool: "run_shell" }], tail: [{ content: "hi" }] });
    seen.length = 0;
    const cmd = await app.inject({ method: "POST", url: "/portal/api/bots/mac-1/bot_h/commands", headers: as("u1"), payload: { action: "approve", args: { callId: "tc_1", approved: true } } });
    expect(cmd.json()).toEqual({ ok: true, commandId: "cmd-12345678" });
    expect(seen[0]).toMatchObject({ url: "/agent-control/agents/mac-1/bot-commands", token: SERVICE, body: { accountId: "acct-u1", botId: "bot_h", action: "approve", args: { callId: "tc_1", approved: true } } });
    const r = await app.inject({ url: "/portal/api/bots/mac-1/commands/cmd-12345678", headers: as("u1") });
    expect(r.json()).toMatchObject({ status: "done" });
    expect((await app.inject({ method: "POST", url: "/portal/api/bots/mac-1/bot_h/commands", headers: as("u1"), payload: { action: "update_settings", args: { allowedTools: ["run_shell"] } } })).statusCode).toBe(400);
  });

  it("merging: the connected coordinator wins; a stale report is offline", () => {
    const snap = (name: string) => ({ v: 1 as const, machineName: name, controls: "on" as const, generatedAtMs: 1, bots: [] });
    const [m] = mergeMachines([[{ agentId: "a", connected: false, reportedAtMs: 10, lastSeenMs: null, snapshot: snap("old") }], [{ agentId: "a", connected: true, reportedAtMs: 5, lastSeenMs: null, snapshot: snap("live") }]], 6);
    expect(m.machine).toMatchObject({ machineName: "live", online: true });
    const [s] = mergeMachines([[{ agentId: "a", connected: true, reportedAtMs: 0, lastSeenMs: null, snapshot: snap("x") }]], BOTS_STALE_MS + 1);
    expect(s.machine).toMatchObject({ online: false, controls: "view" });
  });
});

describe("the Bots page", () => {
  async function page(url: string) {
    const a = Fastify();
    registerPortalPages(a);
    const res = await a.inject({ url });
    await a.close();
    return res;
  }

  it("renders the list and the bot page shell: header, conversation, composer, details, Runs and Memory", async () => {
    const res = await page("/portal/bots");
    expect(res.statusCode).toBe(200);
    const html = res.body;
    for (const id of ["botList", "botPage", "bpName", "bpChip", "bpWhere", "bpAuto", "bpCheck", "bpPause", "bpEdit", "bpMessages", "bpOlder", "bpInput", "bpSend", "bpDetails", "tabRuns", "dTabMemory", "bpEditDialog", "bpOffline"]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Approve on your machine");
    expect(html).toContain("offline. This is the last conversation it shared");
    // The shared markdown cap (issue 333) is in the page.
    expect(html).toContain(`var MAX_MARKDOWN = ${MAX_MARKDOWN};`);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) if (!/\bsrc=/.test(m[1])) expect(() => new vm.Script(m[2])).not.toThrow();
  });

  it("the sidebar has a Bots section on every app page", async () => {
    for (const url of ["/portal/dashboard", "/portal/chat", "/portal/bots"]) {
      const html = (await page(url)).body;
      expect(html, url).toContain('id="botNavList"');
      expect(html, url).toContain('href="/portal/bots"');
    }
  });

  it("the page script runs: a bot renders, read-only and offline when its Mac is off", async () => {
    const html = (await page("/portal/bots")).body;
    const scripts = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    // Run only the helper functions (no DOM): status words and the avatar markup.
    const ctx: Record<string, any> = { escapeHtml: (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`) };
    vm.createContext(ctx);
    const helpers = scripts.find((s) => s.includes("function botAvatarHtml"))!;
    vm.runInContext(helpers.slice(helpers.indexOf("var BOT_SCHEDULE_PRESETS"), helpers.indexOf("async function loadBotsNav")), ctx);
    expect(vm.runInContext(`botStatusChip({ status: "needs_approval" }).text`, ctx)).toBe("Needs approval");
    expect(vm.runInContext(`botRoutineText({ schedule: "", heartbeatMinutes: 30, role: "Dev", instructions: "" })`, ctx)).toBe("Checks in every 30 minutes");
    const ava = vm.runInContext(`botAvatarHtml({ name: "<b>Harry", status: "idle", color: "red;x" }, false)`, ctx);
    expect(ava).not.toContain("<b>");
    expect(ava).toContain('data-bot-color=""');
    expect(ava).toContain("offline");
    // A Bits avatar is its picture; an unknown shape never reaches the URL.
    const bit = vm.runInContext(`botAvatarHtml({ name: "Zed", status: "idle", avatarShape: "bolt" }, true, "lg")`, ctx);
    expect(bit).toContain('<img src="/assets/bits/bolt.svg"');
    expect(bit).toContain("bit-ava lg");
    const odd = vm.runInContext(`botAvatarHtml({ name: "Zed", status: "idle", avatarShape: 'x"><script>' }, true)`, ctx);
    expect(odd).not.toContain("/assets/bits/");
    expect(odd).not.toContain("<script>");
  });
});

describe("the shared markdown cap", () => {
  it("matches the desktop's numbers", () => {
    const desktop = readFileSync(new URL("../../desktop/src/lib/markdown.ts", import.meta.url), "utf8");
    expect(desktop).toContain(`export const MAX_MARKDOWN = ${MAX_MARKDOWN.toLocaleString("en-US").replace(",", "_")};`);
    expect(desktop).toContain(`export const TRIMMED_TEXT = "${TRIMMED_TEXT}";`);
    const capped = capMarkdownSource("a".repeat(50_000));
    expect(capped.length).toBeLessThanOrEqual(MAX_MARKDOWN);
    expect(capped).toContain(TRIMMED_TEXT);
  });
});
