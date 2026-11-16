import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutoRestart, COUNTDOWN_S, LATER_MS, POLL_MS, STUCK_BUSY_MS, AUTO_RESTART_KEY, autoRestartEnabled,
  networkJobBusy, restartWithDrain, restartDecision, sessionsBusy, takeUpdatedTo, rememberUpdatingTo, setBusy, busyReasons, type BusyReason,
} from "../src/lib/auto-restart";

const base = { autoUpdate: true, autoRestart: true, ready: true, busy: [] as BusyReason[], nowMs: 1_000, postponedUntilMs: 0, readySinceMs: 0 };

describe("restartDecision", () => {
  it("counts down when idle", () => expect(restartDecision(base).action).toBe("countdown"));
  it.each<BusyReason>(["streaming", "approval", "unsaved", "network-job", "session", "install", "model-pull"])("waits while %s", (r) => {
    expect(restartDecision({ ...base, busy: [r] })).toEqual({ action: "wait", reasons: [r] });
  });
  it("setting off means manual only", () => expect(restartDecision({ ...base, autoRestart: false }).action).toBe("manual"));
  it("auto-update off means nothing", () => expect(restartDecision({ ...base, autoUpdate: false }).action).toBe("none"));
  it("nothing without a ready update", () => expect(restartDecision({ ...base, ready: false }).action).toBe("none"));
  it("Later postpones", () => expect(restartDecision({ ...base, postponedUntilMs: 2_000 }).action).toBe("wait"));
  it("busy for over a day: never forced, falls back to the manual row", () => {
    expect(restartDecision({ ...base, busy: ["streaming"], nowMs: STUCK_BUSY_MS + 1 }).action).toBe("manual");
  });
});

describe("signals", () => {
  it("network job: queued tasks or a task within 30 s", () => {
    expect(networkJobBusy(1, [], 0)).toBe(true);
    expect(networkJobBusy(0, [100_000 - 29_000], 100_000)).toBe(true);
    expect(networkJobBusy(0, [100_000 - 31_000], 100_000)).toBe(false);
    expect(networkJobBusy(undefined, [], 0)).toBe(false);
    // The agent is running a network job: restarting would abandon it (BHV006).
    expect(networkJobBusy(0, [], 0, 1)).toBe(true);
    expect(networkJobBusy(0, [], 0, 0)).toBe(false);
  });
  it("sessions: a running turn or pending approval", () => {
    expect(sessionsBusy([{ running: false, pending: 0 }])).toBe(false);
    expect(sessionsBusy([{ running: true }])).toBe(true);
    expect(sessionsBusy([{ pending: 1 }])).toBe(true);
  });
  it("registry", () => {
    setBusy("x", "unsaved");
    expect(busyReasons()).toContain("unsaved");
    setBusy("x", false);
    expect(busyReasons()).not.toContain("unsaved");
  });
  it("setting is on by default", () => {
    expect(autoRestartEnabled(null)).toBe(true);
    expect(autoRestartEnabled({ getItem: (k) => (k === AUTO_RESTART_KEY ? "off" : null) })).toBe(false);
  });
  it("Updated to x shows once", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    rememberUpdatingTo("1.4.2", store);
    expect(takeUpdatedTo("1.4.2", store)).toBe("1.4.2");
    expect(takeUpdatedTo("1.4.2", store)).toBeNull();
  });
});

describe("AutoRestart", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make(opts: { busy?: BusyReason[]; autoRestart?: boolean; autoUpdate?: boolean } = {}) {
    const state = { busy: opts.busy ?? [], autoRestart: opts.autoRestart ?? true, autoUpdate: opts.autoUpdate ?? true };
    const restart = vi.fn(async () => {});
    const ar = new AutoRestart({
      autoUpdate: () => state.autoUpdate, autoRestart: () => state.autoRestart,
      readyVersion: () => "1.4.2", checkBusy: async () => state.busy, restart,
    });
    return { ar, restart, state };
  }

  it("restarts when idle after the 60 s countdown", async () => {
    const { ar, restart } = make();
    await ar.evaluate();
    expect(ar.state).toEqual({ phase: "countdown", version: "1.4.2", secondsLeft: COUNTDOWN_S });
    await vi.advanceTimersByTimeAsync((COUNTDOWN_S - 1) * 1000);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(restart).toHaveBeenCalledWith("1.4.2");
  });

  it.each<BusyReason>(["streaming", "approval", "unsaved", "network-job"])("does not restart while %s", async (r) => {
    const { ar, restart } = make({ busy: [r] });
    await ar.evaluate();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(restart).not.toHaveBeenCalled();
    expect(ar.state.phase).toBe("waiting");
  });

  it("re-checks at zero and waits for the next safe moment", async () => {
    const { ar, restart, state } = make();
    await ar.evaluate();
    state.busy = ["streaming"];
    await vi.advanceTimersByTimeAsync(COUNTDOWN_S * 1000);
    expect(restart).not.toHaveBeenCalled();
    expect(ar.state.phase).toBe("waiting");
    state.busy = [];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(ar.state.phase).toBe("countdown");
    await vi.advanceTimersByTimeAsync(COUNTDOWN_S * 1000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("Later postpones by an hour, then restarts when idle", async () => {
    const { ar, restart } = make();
    await ar.evaluate();
    ar.later();
    await vi.advanceTimersByTimeAsync(LATER_MS - 1000);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000 + COUNTDOWN_S * 1000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("setting off: manual only", async () => {
    const { ar, restart } = make({ autoRestart: false });
    await ar.evaluate();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(restart).not.toHaveBeenCalled();
    expect(ar.state.phase).toBe("off");
  });

  it("auto-update off: nothing", async () => {
    const { ar, restart } = make({ autoUpdate: false });
    await ar.evaluate();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(restart).not.toHaveBeenCalled();
    expect(ar.state.phase).toBe("off");
  });

  it("busy over 24 h: still not forced", async () => {
    const { ar, restart } = make({ busy: ["unsaved"] });
    await ar.evaluate();
    await vi.advanceTimersByTimeAsync(STUCK_BUSY_MS + POLL_MS);
    expect(restart).not.toHaveBeenCalled();
    expect(ar.state).toMatchObject({ phase: "waiting", stuck: true });
  });

  it("Restart now restarts immediately", async () => {
    const { ar, restart } = make();
    await ar.evaluate();
    await ar.restartNow();
    expect(restart).toHaveBeenCalledWith("1.4.2");
  });
});

describe("restartWithDrain (BHV006: no network job left abandoned by an update restart)", () => {
  it("drains the agent before installing", async () => {
    const order: string[] = [];
    const restart = restartWithDrain(
      async (resume) => { order.push(resume ? "resume" : "drain"); },
      async (v) => { order.push(`install ${v}`); },
    );
    await restart("1.4.44");
    expect(order).toEqual(["drain", "install 1.4.44"]);
  });

  it("a failing or slow drain never blocks the update", async () => {
    const install = vi.fn(async () => {});
    await restartWithDrain(async () => { throw new Error("agent down"); }, install)("1");
    expect(install).toHaveBeenCalledTimes(1);
    await restartWithDrain(() => new Promise(() => {}), install, 10)("1");
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("takes work again when the install fails", async () => {
    const calls: boolean[] = [];
    const restart = restartWithDrain(async (resume) => { calls.push(resume); }, async () => { throw new Error("install failed"); });
    await expect(restart("1")).rejects.toThrow("install failed");
    expect(calls).toEqual([false, true]);
  });
});
