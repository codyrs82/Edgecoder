import { describe, expect, it } from "vitest";
import { RTT_MAX_PLAUSIBLE_MS, RttTracker, startRttPings, type PingTimers } from "../../src/swarm/agent-rtt.js";

describe("RttTracker", () => {
  it("measures a ping/pong round trip and smooths later ones", () => {
    const t = new RttTracker(100, 0.5);
    t.sent("a", 1_000);
    expect(t.received("a", 1_040)).toMatchObject({ rttMs: 40, lastMs: 40, samples: 1 });
    t.sent("a", 2_000);
    expect(t.received("a", 2_080)).toMatchObject({ rttMs: 60, lastMs: 80, samples: 2 });
    expect(t.rttMs("a", 2_080)).toBe(60);
  });

  it("ignores a pong with no ping outstanding, a negative or an implausible round trip", () => {
    const t = new RttTracker();
    expect(t.received("a", 10)).toBeNull();
    t.sent("a", 100);
    expect(t.received("a", 50)).toBeNull();
    t.sent("a", 0);
    expect(t.received("a", RTT_MAX_PLAUSIBLE_MS + 1)).toBeNull();
    expect(t.get("a", 0)).toBeNull();
  });

  it("reports nothing for a figure older than maxAge, and restarts smoothing after it", () => {
    const t = new RttTracker(100, 0.5, 1_000);
    t.record("a", 100, 0);
    expect(t.rttMs("a", 500)).toBe(100);
    expect(t.rttMs("a", 1_500)).toBeNull();
    expect(t.record("a", 20, 2_000)).toMatchObject({ rttMs: 20, samples: 1 });
  });

  it("is bounded: the oldest peers are dropped first", () => {
    const t = new RttTracker(3);
    for (const id of ["a", "b", "c", "d"]) t.record(id, 10, 0);
    expect(t.size).toBe(3);
    expect(t.get("a", 0)).toBeNull();
    expect(t.get("d", 0)).not.toBeNull();
  });
});

describe("startRttPings", () => {
  function fakeSocket() {
    const listeners: Record<string, Array<() => void>> = {};
    return {
      readyState: 1,
      pings: 0,
      ping() {
        this.pings++;
      },
      on(event: string, fn: () => void) {
        (listeners[event] ??= []).push(fn);
      },
      emit(event: string) {
        for (const fn of listeners[event] ?? []) fn();
      }
    };
  }
  function fakeTimers() {
    let now = 0;
    let tick: (() => void) | null = null;
    const timers: PingTimers & { advance(ms: number): void; cleared: boolean } = {
      cleared: false,
      now: () => now,
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        timers.cleared = true;
        tick = null;
      },
      advance(ms) {
        now += ms;
      }
    };
    return { timers, fire: () => tick?.() };
  }

  it("pings at once and on every interval, and records each pong's round trip", () => {
    const socket = fakeSocket();
    const { timers, fire } = fakeTimers();
    const tracker = new RttTracker(100, 1);
    startRttPings(socket, "agent-1", tracker, 20_000, timers);
    expect(socket.pings).toBe(1);
    timers.advance(35);
    socket.emit("pong");
    expect(tracker.rttMs("agent-1", timers.now())).toBe(35);
    fire();
    expect(socket.pings).toBe(2);
    timers.advance(12);
    socket.emit("pong");
    expect(tracker.rttMs("agent-1", timers.now())).toBe(12);
  });

  it("stops when the socket closes and never pings a socket that is not open", () => {
    const socket = fakeSocket();
    const { timers, fire } = fakeTimers();
    const tracker = new RttTracker();
    startRttPings(socket, "agent-1", tracker, 1_000, timers);
    socket.emit("close");
    expect(timers.cleared).toBe(true);
    fire();
    expect(socket.pings).toBe(1);

    const closed = fakeSocket();
    closed.readyState = 3;
    startRttPings(closed, "agent-2", tracker, 1_000, fakeTimers().timers);
    expect(closed.pings).toBe(0);
  });

  it("does nothing when the interval is 0 (pings off)", () => {
    const socket = fakeSocket();
    startRttPings(socket, "agent-1", new RttTracker(), 0, fakeTimers().timers);
    expect(socket.pings).toBe(0);
  });
});

describe("with real sockets", () => {
  it("an agent's ws client answers the coordinator's pings on its own (no agent change needed)", async () => {
    const { WebSocketServer, default: WebSocket } = await import("ws");
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => server.once("listening", () => r()));
    const tracker = new RttTracker();
    const measured = new Promise<void>((resolve) => {
      server.on("connection", (socket) => {
        startRttPings(socket, "agent-real", tracker, 50);
        socket.on("pong", () => setImmediate(resolve));
      });
    });
    // Built the way src/swarm/worker-runner.ts builds its mesh socket (default options: autoPong on).
    const client = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/mesh/ws`);
    try {
      await measured;
      expect(tracker.rttMs("agent-real", Date.now())).toBeGreaterThanOrEqual(0);
    } finally {
      client.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
