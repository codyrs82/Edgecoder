import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOWN_POLL_MS, FAILED_AFTER_MS, READY_POLL_MS, ServiceMonitor, downPollMs, nextStatus, noteServiceNetworkFailure, onServiceReady, serviceStatus,
  startServiceMonitor, stopServiceMonitor, whenServiceReady, type ServiceStatus,
} from "../src/lib/service-status";
import { fetchLocalService } from "../src/lib/local-service";

/** A probe whose answer the test sets. */
function fakeProbe(initial = false) {
  const state = { healthy: initial, calls: 0 };
  const probe = vi.fn(async () => {
    state.calls++;
    return state.healthy;
  });
  return { state, probe };
}
/** Let the probe's promise chain settle. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  stopServiceMonitor();
  vi.useRealTimers();
});

describe("nextStatus", () => {
  const starting: ServiceStatus = { phase: "starting", downSinceMs: 0 };
  it("answers: ready", () => expect(nextStatus(starting, true, 5)).toEqual({ phase: "ready", downSinceMs: null }));
  it("no answer while starting: still starting (never an error)", () => {
    expect(nextStatus(starting, false, 30_000)).toEqual({ phase: "starting", downSinceMs: 0 });
  });
  it("stops answering after it was ready: restarting", () => {
    expect(nextStatus({ phase: "ready", downSinceMs: null }, false, 100)).toEqual({ phase: "restarting", downSinceMs: 100 });
  });
  it("down for about a minute in spite of the restarts: failed", () => {
    expect(nextStatus({ phase: "restarting", downSinceMs: 100 }, false, 100 + FAILED_AFTER_MS - 1).phase).toBe("restarting");
    expect(nextStatus({ phase: "restarting", downSinceMs: 100 }, false, 100 + FAILED_AFTER_MS).phase).toBe("failed");
  });
  it("failed comes back to ready on its own", () => {
    expect(nextStatus({ phase: "failed", downSinceMs: 0 }, true, 90_000).phase).toBe("ready");
  });
});

describe("probe backoff while the service is down", () => {
  it("is quick at first, then settles", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(downPollMs)).toEqual([500, 1_000, 1_000, 2_000, 2_000, 3_000, 3_000, 3_000]);
    expect(DOWN_POLL_MS[0]).toBeLessThan(READY_POLL_MS);
  });

  it("probes on that schedule (fake timers), then every READY_POLL_MS once ready", async () => {
    const { state, probe } = fakeProbe(false);
    const m = new ServiceMonitor({ probe });
    m.start();
    await flush();
    expect(state.calls).toBe(1);
    // 500 ms, 1 s, 1 s, 2 s after each failure.
    for (const [wait, calls] of [[499, 1], [1, 2], [1_000, 3], [1_000, 4], [1_999, 4], [1, 5]] as const) {
      await vi.advanceTimersByTimeAsync(wait);
      expect(state.calls, `after +${wait} ms`).toBe(calls);
    }
    state.healthy = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.current.phase).toBe("ready");
    const at = state.calls;
    await vi.advanceTimersByTimeAsync(READY_POLL_MS - 1);
    expect(state.calls).toBe(at);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toBe(at + 1);
    m.stop();
  });
});

describe("ServiceMonitor", () => {
  it("starting → ready, and pages waiting for it are released", async () => {
    const { state, probe } = fakeProbe(false);
    const m = new ServiceMonitor({ probe });
    const phases: string[] = [];
    m.subscribe((s) => phases.push(s.phase));
    m.start();
    let released = false;
    void m.whenReady().then(() => (released = true));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(m.current.phase).toBe("starting");
    expect(released).toBe(false);
    state.healthy = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(released).toBe(true);
    expect(phases).toEqual(["starting", "ready"]);
    m.stop();
  });

  it("ready → restarting when it stops answering → failed after about a minute → ready when it is back", async () => {
    const { state, probe } = fakeProbe(true);
    const m = new ServiceMonitor({ probe });
    m.start();
    await flush();
    expect(m.current.phase).toBe("ready");
    state.healthy = false;
    await vi.advanceTimersByTimeAsync(READY_POLL_MS);
    expect(m.current.phase).toBe("restarting");
    await vi.advanceTimersByTimeAsync(FAILED_AFTER_MS - 5_000);
    expect(m.current.phase).toBe("restarting");
    await vi.advanceTimersByTimeAsync(5_000 + 3_000);
    expect(m.current.phase).toBe("failed");
    state.healthy = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(m.current.phase).toBe("ready");
    m.stop();
  });

  it("Restart now asks the shell, goes back to restarting and starts the minute over", async () => {
    const { state, probe } = fakeProbe(false);
    const restart = vi.fn(async () => undefined);
    const m = new ServiceMonitor({ probe, restart });
    m.start();
    await vi.advanceTimersByTimeAsync(FAILED_AFTER_MS + 3_000);
    expect(m.current.phase).toBe("failed");
    await m.restartNow();
    expect(restart).toHaveBeenCalledOnce();
    expect(m.current.phase).toBe("restarting");
    await vi.advanceTimersByTimeAsync(FAILED_AFTER_MS - 5_000);
    expect(m.current.phase).toBe("restarting");
    state.healthy = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(m.current.phase).toBe("ready");
    m.stop();
  });

  it("onReady (re-detecting the backend) runs before ready is announced", async () => {
    const order: string[] = [];
    const { probe } = fakeProbe(true);
    const m = new ServiceMonitor({ probe, onReady: async () => void order.push("onReady") });
    m.subscribe((s) => order.push(s.phase));
    m.start();
    await flush();
    await flush();
    expect(order).toEqual(["starting", "onReady", "ready"]);
    m.stop();
  });

  it("a request that fails at the network level makes it look at once", async () => {
    const { state, probe } = fakeProbe(true);
    startServiceMonitor({ probe });
    await flush();
    expect(get(serviceStatus).phase).toBe("ready");
    state.healthy = false;
    await fetchLocalService(async () => { throw new TypeError("Load failed"); }, { delaysMs: [] }).catch(() => undefined);
    await flush();
    expect(state.calls).toBe(2);
    expect(get(serviceStatus).phase).toBe("restarting");
  });
});

describe("the shared status", () => {
  it("is ready (inert) until the desktop app starts the monitor", async () => {
    expect(get(serviceStatus).phase).toBe("ready");
    await expect(whenServiceReady()).resolves.toBeUndefined();
    noteServiceNetworkFailure(); // no monitor: nothing happens
    expect(get(serviceStatus).phase).toBe("ready");
  });

  it("onServiceReady fires each time the service becomes ready (not for a page opened while it is)", async () => {
    const { state, probe } = fakeProbe(false);
    const fn = vi.fn();
    startServiceMonitor({ probe });
    const off = onServiceReady(fn);
    await flush();
    expect(fn).not.toHaveBeenCalled();
    state.healthy = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).toHaveBeenCalledTimes(1);
    state.healthy = false;
    await vi.advanceTimersByTimeAsync(READY_POLL_MS);
    expect(get(serviceStatus).phase).toBe("restarting");
    state.healthy = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });
});
