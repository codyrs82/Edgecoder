import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { closeForRebind, MESH_WS_REBIND_CLOSE_CODE } from "../../src/swarm/registration-policy.js";
import {
  CoordinatorRestartWindow,
  MESH_WS_REBIND_RECONNECT_MS,
  MESH_WS_REBIND_TERMINATE_MS,
  isDrainingError,
  isRestartClose,
  isRestartTransientError,
  nextMeshWsDelay,
  RESTART_FAILOVER_AFTER_MS,
  RESTART_RETRY_JITTER_MS,
  RESTART_RETRY_MS,
  RESTART_WINDOW_MS,
  RESTART_WS_MAX_DELAY_MS
} from "../../src/mesh/coordinator-reconnect.js";

/*
 * After a coordinator restart (run 3, 3b) agents came back 10-20 s after the new instance was up:
 * a register that failed while the machine restarted went into the 3/6/12 s backoff and offline
 * mode, and the mesh WebSocket's wait doubled while it waited for that registration. During a
 * restart the agent now retries every ~1-2 s and the socket follows within ~0.5 s.
 */
const NOW = 1_800_000_000_000;

describe("CoordinatorRestartWindow", () => {
  it("opens, stays open until registered, and is bounded", () => {
    const w = new CoordinatorRestartWindow(() => 0);
    expect(w.active(NOW)).toBe(false);
    w.open(NOW);
    expect(w.active(NOW + 10_000)).toBe(true);
    w.close();
    expect(w.active(NOW + 10_000)).toBe(false);
    w.open(NOW);
    expect(w.active(NOW + RESTART_WINDOW_MS)).toBe(true);
    expect(w.active(NOW + RESTART_WINDOW_MS + 1)).toBe(false);
  });

  it("a second signal in the same restart does not extend the window", () => {
    const w = new CoordinatorRestartWindow();
    w.open(NOW);
    w.open(NOW + 60_000);
    expect(w.active(NOW + RESTART_WINDOW_MS + 1)).toBe(false);
  });

  it("retries every RESTART_RETRY_MS plus jitter", () => {
    expect(new CoordinatorRestartWindow(() => 0).retryMs()).toBe(RESTART_RETRY_MS);
    expect(new CoordinatorRestartWindow(() => 0.999).retryMs()).toBe(RESTART_RETRY_MS + RESTART_RETRY_JITTER_MS - 1);
  });

  it("looks for another coordinator only after the home one had time to come back", () => {
    const w = new CoordinatorRestartWindow();
    w.open(NOW);
    expect(w.mayFailOver(NOW + 5_000)).toBe(false);
    expect(w.mayFailOver(NOW + RESTART_FAILOVER_AFTER_MS)).toBe(true);
  });

  it("registers within ~2 s of the new instance coming up, wherever the frame delay lands", () => {
    // Frame at 0 with delay 2-10 s; the machine is down from 0.5 s until `upAt` (run 3: about 7 s).
    for (const upAt of [3_000, 7_000, 12_000, 25_000]) {
      for (const r of [0, 0.5, 0.99]) {
        const w = new CoordinatorRestartWindow(() => r);
        w.open(0);
        let t = 2_000 + Math.floor(r * 8_000);
        while (t < upAt) t += w.retryMs();
        expect(t - Math.max(upAt, 2_000 + Math.floor(r * 8_000))).toBeLessThan(RESTART_RETRY_MS + RESTART_RETRY_JITTER_MS);
      }
    }
  });
});

describe("restart signals", () => {
  it("1012 and the reconnect-frame close are restarts; other closes are not", () => {
    expect(isRestartClose(1012, "coordinator_restart")).toBe(true);
    expect(isRestartClose(1012, "")).toBe(true);
    expect(isRestartClose(1000, "coordinator_reconnect")).toBe(true);
    expect(isRestartClose(1006, "")).toBe(false);
    expect(isRestartClose(4005, "agent_not_registered")).toBe(false);
  });

  it("a draining coordinator's 503 opens the window", () => {
    const e = Object.assign(new Error('POST /register failed (503): {"error":"coordinator_draining","retryable":true}'), { statusCode: 503 });
    expect(isDrainingError(e)).toBe(true);
    expect(isDrainingError(Object.assign(new Error("POST /register failed (503): busy"), { statusCode: 503 }))).toBe(false);
    expect(isDrainingError(new Error("ECONNREFUSED"))).toBe(false);
  });

  it("only no-answer and 5xx failures get the fast retry; a 4xx takes the usual path", () => {
    expect(isRestartTransientError(new Error("connect ECONNREFUSED"))).toBe(true);
    expect(isRestartTransientError(Object.assign(new Error("x"), { statusCode: 502 }))).toBe(true);
    expect(isRestartTransientError(Object.assign(new Error("x"), { statusCode: 400 }))).toBe(false);
    expect(isRestartTransientError(Object.assign(new Error("x"), { statusCode: 401 }))).toBe(false);
  });
});

describe("nextMeshWsDelay", () => {
  const max = 30_000;
  it("polls the agent's own registration every 500 ms without growing the wait", () => {
    expect(nextMeshWsDelay(16_000, { waitingForRegistration: true, restarting: false, maxMs: max })).toEqual({ waitMs: 500, next: 16_000 });
    expect(nextMeshWsDelay(1_000, { waitingForRegistration: true, restarting: true, maxMs: max })).toEqual({ waitMs: 500, next: 1_000 });
  });
  it("caps failed opens during a restart", () => {
    expect(nextMeshWsDelay(16_000, { waitingForRegistration: false, restarting: true, maxMs: max })).toEqual({ waitMs: RESTART_WS_MAX_DELAY_MS, next: RESTART_WS_MAX_DELAY_MS });
    expect(nextMeshWsDelay(1_000, { waitingForRegistration: false, restarting: true, maxMs: max })).toEqual({ waitMs: 1_000, next: RESTART_WS_MAX_DELAY_MS });
  });
  it("run 12: a socket the agent closed to bind again reopens at once, whatever the restart state", () => {
    expect(nextMeshWsDelay(8_000, { waitingForRegistration: false, restarting: false, rebind: true, maxMs: max })).toEqual({ waitMs: MESH_WS_REBIND_RECONNECT_MS, next: 8_000 });
    expect(nextMeshWsDelay(1_000, { waitingForRegistration: false, restarting: true, rebind: true, maxMs: max })).toEqual({ waitMs: MESH_WS_REBIND_RECONNECT_MS, next: 1_000 });
  });
  it("doubles up to the cap otherwise (as before)", () => {
    expect(nextMeshWsDelay(1_000, { waitingForRegistration: false, restarting: false, maxMs: max })).toEqual({ waitMs: 1_000, next: 2_000 });
    expect(nextMeshWsDelay(20_000, { waitingForRegistration: false, restarting: false, maxMs: max })).toEqual({ waitMs: 20_000, next: max });
  });
});

/*
 * Network run 12 (3b): an agent registered with the peer ~2 s after the drain notice, but its mesh
 * socket reached the peer only ~6 s later: the old socket's graceful close took ~5 s
 * ("registered again: reopening the mesh WebSocket" 01:07:44, "mesh WebSocket closed" 01:07:49).
 */
describe("closing the mesh socket to bind again (run 12)", () => {
  it("sends the rebind close, then drops the socket if the close has not completed", () => {
    const calls: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const ws = { readyState: 2, close: (code: number, reason: string) => calls.push(`close ${code} ${reason}`), terminate: () => calls.push("terminate") };
    closeForRebind(ws, { closedState: 3, terminateAfterMs: MESH_WS_REBIND_TERMINATE_MS, setTimer: (fn, ms) => timers.push({ fn, ms }) });
    expect(calls).toEqual([`close ${MESH_WS_REBIND_CLOSE_CODE} rebind_after_register`]);
    expect(timers.map((t) => t.ms)).toEqual([MESH_WS_REBIND_TERMINATE_MS]);
    timers[0].fn();
    expect(calls).toEqual([`close ${MESH_WS_REBIND_CLOSE_CODE} rebind_after_register`, "terminate"]);
  });
  it("leaves a socket that already closed", () => {
    const calls: string[] = [];
    const ws = { readyState: 0, close: () => { ws.readyState = 3; calls.push("close"); }, terminate: () => calls.push("terminate") };
    closeForRebind(ws, { closedState: 3, terminateAfterMs: 10, setTimer: (fn) => fn() });
    expect(calls).toEqual(["close"]);
  });
  it("a peer that never answers the close: the socket is closed within the bound, not ws's 30 s", async () => {
    const wss = new WebSocketServer({ port: 0 });
    // The server stops reading: the client's close frame is never answered.
    wss.on("connection", (s) => (s as unknown as { _socket: { pause(): void } })._socket.pause());
    const port = (wss.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    const started = Date.now();
    const closed = new Promise<number>((resolve) => ws.once("close", () => resolve(Date.now() - started)));
    closeForRebind(ws, { closedState: WebSocket.CLOSED, terminateAfterMs: MESH_WS_REBIND_TERMINATE_MS });
    const ms = await closed;
    expect(ms).toBeLessThan(MESH_WS_REBIND_TERMINATE_MS + 1_000);
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});

describe("worker wiring", () => {
  const src = readFileSync(new URL("../../src/swarm/worker-runner.ts", import.meta.url), "utf8");
  it("opens the window on a reconnect frame, a 1012 close and a draining refusal, and closes it on registering", () => {
    // All three are planned drain signals (drain-failover.ts): onPlannedDrain opens the window as planned.
    expect(src).toMatch(/if \(delayMs === null\) return;\s*onPlannedDrain\("reconnect_frame", coordinatorUrl\);/);
    expect(src).toMatch(/if \(isRestartClose\(code, reason\)\) \{[\s\S]{0,300}onPlannedDrain\("restart_close", coordinatorUrl\);\s*else restartWindow\.open\(Date\.now\(\), true\);/);
    expect(src).toContain('if (coordinatorOnline && isDrainingError(error)) onPlannedDrain("register_draining", coordinator.url);');
    expect(src).toMatch(/function onPlannedDrain[\s\S]{0,300}restartWindow\.open\(Date\.now\(\), true\);/);
    expect(src.match(/coordinatorReconnect\.registered\(\);[\s\S]{0,200}restartWindow\.close\(\);/g)?.length).toBe(2);
  });
  it("run 12: the rebind close is bounded and its socket reopens at once", () => {
    expect(src).toContain("closeForRebind(ws, { closedState: WebSocket.CLOSED, terminateAfterMs: MESH_WS_REBIND_TERMINATE_MS });");
    expect(src).toMatch(/rebindingMeshWs\.add\(ws\);\s*closeForRebind/);
    expect(src).toContain("rebind: rebindingMeshWs.has(ws)");
  });
  it("retries fast inside the window before counting a failure", () => {
    const i = src.indexOf("if (coordinatorOnline && restartWindow.active() && isRestartTransientError(error)) {");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(src.indexOf("consecutiveFailures++;"));
  });
});
