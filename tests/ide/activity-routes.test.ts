// Settings → Active work and Logs: the read-only local routes (auth, loopback, size cap, no paths).
import Fastify from "fastify";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityTracker } from "../../src/apps/ide/activity.js";
import { registerActivityRoutes } from "../../src/apps/ide/activity-routes.js";
import { createIdeAuthHook } from "../../src/apps/ide/ide-auth.js";
import { readLogTail, redactLogLine } from "../../src/apps/ide/log-tail.js";

const TOKEN = "route-test-token-0123456789";
const HOST = "127.0.0.1:4304";
const AUTH = { host: HOST, authorization: `Bearer ${TOKEN}` };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "logs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeApp(health: Record<string, unknown> | null = null, opts: { enrolled?: boolean } = {}) {
  const app = Fastify();
  app.addHook("onRequest", createIdeAuthHook({ token: TOKEN, port: 4304, enforceLoopbackHost: true }));
  const tracker = new ActivityTracker();
  registerActivityRoutes(app, {
    tracker,
    agentHealth: opts.enrolled === false ? null : async () => health,
    ownTaskIds: () => new Set(["inf-mine"]),
    extra: [() => { throw new Error("store down"); }],
    logDir: dir,
  });
  return { app, tracker };
}

describe("GET /v1/ide/logs", () => {
  it("needs the IDE token and a loopback caller", async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: "GET", url: "/v1/ide/logs", headers: { host: HOST } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/ide/logs", headers: { host: HOST, authorization: "Bearer nope" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/ide/logs", headers: { ...AUTH, host: "evil.example:4304" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/ide/logs", headers: AUTH, remoteAddress: "10.0.0.7" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/ide/logs", headers: AUTH })).statusCode).toBe(200);
    await app.close();
  });

  it("names sources, never paths: traversal and file names are refused", async () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "secret.txt"), "do not read\n");
    const { app } = makeApp();
    for (const source of ["../secret.txt", "secret.txt", "agent.log", "/etc/passwd", "..%2Fsecret.txt", "agent/../secret"]) {
      const res = await app.inject({ method: "GET", url: `/v1/ide/logs?source=${encodeURIComponent(source)}`, headers: AUTH });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("do not read");
    }
    await app.close();
  });

  it("returns the last N KB as whole lines, then only what was appended (follow)", async () => {
    const line = (i: number) => JSON.stringify({ level: 30, time: i, service: "coordinator", msg: `line ${i}` });
    writeFileSync(join(dir, "agent.log"), Array.from({ length: 200 }, (_, i) => line(i)).join("\n") + "\n");
    const { app } = makeApp();
    const first = (await app.inject({ method: "GET", url: "/v1/ide/logs?source=agent&maxKb=1", headers: AUTH })).json();
    expect(first.truncated).toBe(true);
    expect(first.lines.length).toBeGreaterThan(5);
    expect(first.lines.join("\n").length).toBeLessThanOrEqual(1024);
    expect(first.lines.at(-1)).toBe(line(199));
    expect(() => JSON.parse(first.lines[0])).not.toThrow(); // no partial first line
    expect(first.sources.find((s: { id: string }) => s.id === "agent")).toMatchObject({ exists: true });

    appendFileSync(join(dir, "agent.log"), `${line(200)}\n[agent:mac] half a li`);
    const next = (await app.inject({ method: "GET", url: `/v1/ide/logs?source=agent&after=${first.next}`, headers: AUTH })).json();
    expect(next.lines).toEqual([line(200)]);
    appendFileSync(join(dir, "agent.log"), "ne\n");
    const rest = (await app.inject({ method: "GET", url: `/v1/ide/logs?source=agent&after=${next.next}`, headers: AUTH })).json();
    expect(rest.lines).toEqual(["[agent:mac] half a line"]);

    // The app truncates the log at a restart: an offset past the end reads from the end again.
    writeFileSync(join(dir, "agent.log"), "fresh\n");
    const reset = (await app.inject({ method: "GET", url: `/v1/ide/logs?source=agent&after=${rest.next}`, headers: AUTH })).json();
    expect(reset).toMatchObject({ reset: true, lines: ["fresh"] });
    await app.close();
  });

  it("caps the size: maxKb beyond the limit is refused, and a missing file is not an error", async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: "GET", url: "/v1/ide/logs?maxKb=99999", headers: AUTH })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/ide/logs?source=ollama", headers: AUTH })).json()).toMatchObject({ exists: false, lines: [] });
    writeFileSync(join(dir, "agent.log"), "x".repeat(3 * 1024 * 1024) + "\nlast\n");
    const big = readLogTail(join(dir, "agent.log"), { maxBytes: 50 * 1024 * 1024 });
    expect(big.lines).toEqual(["last"]); // at most 1 MB read; the 3 MB line before it is cut off
    await app.close();
  });

  it("masks credentials before they leave the process", async () => {
    writeFileSync(join(dir, "agent.log"), [
      `[agent:mac] offline probe failed (Error: POST /register failed (403): {"error":"bad","registrationToken":"rt_9f8e7d6c5b4a"})`,
      `{"level":50,"msg":"call failed","authorization":"Bearer abcdefghijklmnopqrstuvwxyz012345"}`,
      `paying lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu now`,
      `key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA and ec_live_abcdef123456 token=abc123def456`,
    ].join("\n") + "\n");
    const { app } = makeApp();
    const text = (await app.inject({ method: "GET", url: "/v1/ide/logs", headers: AUTH })).json().lines.join("\n");
    for (const secret of ["rt_9f8e7d6c5b4a", "abcdefghijklmnopqrstuvwxyz012345", "lnbc2500u1pvjlue", "sk-ant-api03", "ec_live_abcdef", "abc123def456"]) expect(text).not.toContain(secret);
    expect(text).toContain("offline probe failed");
    expect(redactLogLine("Bearer token required")).toBe("Bearer token required");
    await app.close();
  });
});

describe("GET /v1/ide/activity", () => {
  it("not enrolled: agent null; enrolled: the agent's state and the owner's running requests", async () => {
    const solo = makeApp(null, { enrolled: false });
    expect((await solo.app.inject({ method: "GET", url: "/v1/ide/activity", headers: AUTH })).json()).toMatchObject({ agent: null, mine: [] });
    await solo.app.close();

    const { app, tracker } = makeApp({ ok: true, registered: true, coordinatorUrl: "https://coordinator.edgecoder.io", paused: { reason: "Auto-blacklisted by behavioral monitoring: x", sinceMs: 1 }, serving: { slots: { total: 1, busy: 1 }, jobs: [{ id: "s", taskId: "inf-mine", kind: "inference", model: "m", startedAtMs: 1, outputTokens: 1 }] } });
    tracker.begin({ kind: "code", title: "Add a test" });
    const body = (await app.inject({ method: "GET", url: "/v1/ide/activity", headers: AUTH })).json();
    expect(body.agent).toMatchObject({ reachable: true, paused: { reason: "Auto-blacklisted by behavioral monitoring: x" }, jobs: [{ requester: "you" }] });
    expect(body.mine).toMatchObject([{ kind: "code", title: "Add a test", status: "running" }]);
    expect((await app.inject({ method: "GET", url: "/v1/ide/activity", headers: { host: HOST } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/ide/activity/recent?kind=nope", headers: AUTH })).statusCode).toBe(400);
    await app.close();
  });
});
