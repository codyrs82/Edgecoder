import { describe, expect, it } from "vitest";
import { filterRows, isRoutineRequest, LogParser, plainLevel, rowText, supportText, type LogLevel } from "../src/lib/log-parse";

const j = (o: Record<string, unknown>) => JSON.stringify(o);
const ALL = new Set<LogLevel>(["error", "warn", "info"]);

describe("log parser: JSON lines", () => {
  it("joins a request's two lines into one row: method, url, status, ms", () => {
    const p = new LogParser();
    const rows = p.push([
      j({ level: 30, time: 1_000, service: "ide-provider", requestId: "a", req: { method: "POST", url: "/v1/ide/chat", host: "127.0.0.1" }, msg: "incoming request" }),
      j({ level: 30, time: 1_900, service: "ide-provider", requestId: "a", res: { statusCode: 200 }, responseTime: 812.4, msg: "request completed" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ time: 1_000, service: "ide-provider", level: "info", message: "POST /v1/ide/chat → 200 · 812 ms", request: { method: "POST", url: "/v1/ide/chat", status: 200 }, routine: false, plain: false });
  });

  it("4xx is a warning, 5xx an error; a completion without its start is still shown", () => {
    const p = new LogParser();
    const rows = p.push([
      j({ level: 30, service: "coordinator", requestId: "b", req: { method: "POST", url: "/register" }, msg: "incoming request" }),
      j({ level: 30, service: "coordinator", requestId: "b", res: { statusCode: 403 }, responseTime: 2, msg: "request completed" }),
      j({ level: 30, service: "coordinator", requestId: "zz", res: { statusCode: 502 }, responseTime: 12.3, msg: "request completed" }),
    ]);
    expect(rows.map((r) => [r.level, r.message])).toEqual([["warn", "POST /register → 403 · 2.0 ms"], ["error", "? (request) → 502 · 12 ms"]]);
  });

  it("other JSON lines: pino level, message and the useful extras", () => {
    const rows = new LogParser().push([j({ level: 50, time: 5, service: "inference", msg: "pull failed", err: { type: "Error", message: "ECONNREFUSED" } }), j({ level: 40, service: "coordinator", msg: "mesh_bootstrap_start", reason: "no peers" })]);
    expect(rows.map((r) => [r.level, r.message])).toEqual([["error", "pull failed · Error: ECONNREFUSED"], ["warn", "mesh_bootstrap_start · reason=no peers"]]);
  });
});

describe("log parser: plain lines", () => {
  it("[agent:…] lines: the service, warnings and errors by what they say", () => {
    const rows = new LogParser().push([
      "[agent:desktop-mac-1] offline probe failed (Error: POST /register failed (403): {\"error\":\"agent_blacklisted\"})",
      "[agent:desktop-mac-1] registered with https://coordinator.edgecoder.io (class=apple tier=apple.m verification=unverified)",
      "[BLE] could not read 4f2a's EdgeCoder service: timed out",
      "[agent:desktop-mac-1] lease heartbeat skipped: coordinator unavailable",
      "Node.js 22+ not found; not starting the agent",
    ]);
    expect(rows.map((r) => [r.service, r.level, r.plain])).toEqual([
      ["agent", "error", true], ["agent", "info", true], ["ble", "warn", true], ["agent", "warn", true], ["app", "warn", true],
    ]);
    expect(rows[0].message.startsWith("offline probe failed")).toBe(true);
    expect(plainLevel("all good")).toBe("info");
  });

  it("broken JSON is shown as a plain line, empty lines are skipped", () => {
    const rows = new LogParser().push(["{not json", "", "   "]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ plain: true, message: "{not json" });
  });
});

describe("routine requests", () => {
  it("polling (pull progress, bots every 8 s, health, preflights) is routine; failures and writes are not", () => {
    expect(isRoutineRequest({ method: "GET", url: "/model/pull/progress", status: 200 })).toBe(true);
    expect(isRoutineRequest({ method: "GET", url: "/v1/ide/bots", status: 200 })).toBe(true);
    expect(isRoutineRequest({ method: "OPTIONS", url: "/anything", status: 204 })).toBe(true);
    expect(isRoutineRequest({ method: "GET", url: "/health/runtime?x=1", status: 200 })).toBe(true);
    expect(isRoutineRequest({ method: "GET", url: "/model/pull/progress", status: 500 })).toBe(false);
    expect(isRoutineRequest({ method: "POST", url: "/v1/ide/bots", status: 200 })).toBe(false);
    expect(isRoutineRequest({ method: "GET", url: "/v1/ide/fs/read", status: 200 })).toBe(false);
  });

  it("is folded away by the filter, and searchable by level, service and text", () => {
    const p = new LogParser();
    const rows = p.push([
      j({ level: 30, service: "inference", requestId: "1", req: { method: "GET", url: "/model/pull/progress" }, msg: "incoming request" }),
      j({ level: 30, service: "inference", requestId: "1", res: { statusCode: 200 }, responseTime: 0.3, msg: "request completed" }),
      j({ level: 30, service: "ide-provider", requestId: "2", req: { method: "GET", url: "/v1/ide/bots" }, msg: "incoming request" }),
      j({ level: 30, service: "ide-provider", requestId: "2", res: { statusCode: 200 }, responseTime: 0.3, msg: "request completed" }),
      "[agent:x] offline probe failed",
      j({ level: 30, service: "coordinator", msg: "mesh_bootstrap_start" }),
    ]);
    expect(filterRows(rows, { levels: ALL, service: "", query: "", hideRoutine: true }).map((r) => r.message)).toEqual(["offline probe failed", "mesh_bootstrap_start"]);
    expect(filterRows(rows, { levels: ALL, service: "", query: "", hideRoutine: false })).toHaveLength(4);
    expect(filterRows(rows, { levels: new Set<LogLevel>(["error"]), service: "", query: "", hideRoutine: false }).map((r) => r.service)).toEqual(["agent"]);
    expect(filterRows(rows, { levels: ALL, service: "coordinator", query: "", hideRoutine: false })).toHaveLength(1);
    expect(filterRows(rows, { levels: ALL, service: "", query: "PULL/PROGRESS", hideRoutine: false })).toHaveLength(1);
  });
});

describe("Copy for support", () => {
  it("the last relevant lines as time · service · level · message, credentials masked", () => {
    const p = new LogParser();
    const rows = p.push([
      j({ level: 30, time: Date.UTC(2026, 10, 16, 9, 0, 0), service: "ide-provider", msg: "call", authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123" }),
      "[agent:x] POST /register failed (403): {\"registrationToken\":\"rt_0123456789abcdef\"} for owner@example.com",
      ...Array.from({ length: 300 }, (_, i) => `[agent:x] line ${i}`),
    ]);
    const text = supportText(rows, { max: 200, emails: true, now: new Date(0) });
    const lines = text.trim().split("\n");
    expect(lines[0]).toContain("200 lines");
    expect(lines).toHaveLength(203);
    expect(lines.at(-1)).toBe("--:--:-- · agent · INFO · line 299");
    const all = supportText(rows, { max: 1000, emails: true });
    expect(all).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(all).not.toContain("rt_0123456789abcdef");
    expect(all).not.toContain("owner@example.com");
    expect(rowText(rows[0])).toBe("2026-11-16T09:00:00.000Z · ide-provider · INFO · call");
  });
});
