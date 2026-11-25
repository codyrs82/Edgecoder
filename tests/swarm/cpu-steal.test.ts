import { describe, expect, it } from "vitest";
import { CpuStealGuard, modelSlotReport, parseProcStatCpu, stealShare, type CpuTimes } from "../../src/swarm/cpu-steal.js";

/** A fake /proc/stat counter: each step adds `busy` and `steal` ticks (of `total`) across the host. */
function fakeHost() {
  let t: CpuTimes = { total: 0, idle: 0, steal: 0 };
  return {
    read: () => t,
    step(total: number, busy: number, steal: number) {
      t = { total: t.total + total, idle: t.idle + (total - busy - steal), steal: t.steal + steal };
    }
  };
}

describe("parseProcStatCpu", () => {
  it("reads the aggregate cpu line (guest time is already in user/nice)", () => {
    const text = "cpu  100 5 20 800 10 1 2 60 7 0\ncpu0 25 1 5 200 2 0 0 15 0 0\nintr 1 2 3\n";
    expect(parseProcStatCpu(text)).toEqual({ total: 100 + 5 + 20 + 800 + 10 + 1 + 2 + 60, idle: 810, steal: 60 });
  });

  it("accepts an old kernel line without steal, and rejects junk", () => {
    expect(parseProcStatCpu("cpu 1 2 3 4\n")).toEqual({ total: 10, idle: 4, steal: 0 });
    expect(parseProcStatCpu("intr 1 2\n")).toBeNull();
    expect(parseProcStatCpu("cpu a b c d\n")).toBeNull();
  });
});

describe("stealShare", () => {
  it("is the stolen share of the busy time", () => {
    // Run 6 on a throttled shared-cpu-4x: ~370% of 400% stolen, ~30% user.
    expect(stealShare({ total: 0, idle: 0, steal: 0 }, { total: 400, idle: 0, steal: 370 })).toBeCloseTo(0.925);
  });

  it("says nothing for an idle span (an idle throttled VM shows no steal)", () => {
    expect(stealShare({ total: 0, idle: 0, steal: 0 }, { total: 400, idle: 399, steal: 0 })).toBeNull();
  });
});

describe("CpuStealGuard", () => {
  it("holds the host back from the first throttled span until the hold has passed", () => {
    const host = fakeHost();
    const g = new CpuStealGuard({ read: host.read, holdMs: 60_000, windowMs: 5_000 });
    expect(g.sample(0)).toMatchObject({ throttled: false, changed: false });
    host.step(2000, 1900, 0); // busy, nothing stolen: an unthrottled host at full load
    expect(g.sample(5_000)).toMatchObject({ throttled: false, share: 0 });
    host.step(2000, 150, 1850); // credits spent: almost all of it stolen
    const hit = g.sample(10_000);
    expect(hit.throttled).toBe(true);
    expect(hit.changed).toBe(true);
    expect(hit.share).toBeCloseTo(1850 / 2000);
    // Idle afterwards (it takes no new call): no steal, but the hold keeps it back.
    host.step(2000, 0, 0);
    expect(g.sample(40_000)).toMatchObject({ throttled: true, changed: false, share: null });
    host.step(2000, 0, 0);
    expect(g.sample(70_001)).toMatchObject({ throttled: false, changed: true });
  });

  it("ignores ordinary shared-host noise", () => {
    const host = fakeHost();
    const g = new CpuStealGuard({ read: host.read, windowMs: 5_000 });
    g.sample(0);
    host.step(2000, 1800, 150); // ~8% stolen
    expect(g.sample(5_000).throttled).toBe(false);
  });

  it("computes a share only over a full window", () => {
    const host = fakeHost();
    const g = new CpuStealGuard({ read: host.read, windowMs: 5_000 });
    g.sample(0);
    host.step(400, 20, 370);
    expect(g.sample(1_000)).toMatchObject({ throttled: false, share: null }); // too short a span
    expect(g.sample(5_000).throttled).toBe(true);
  });

  it("does nothing where /proc/stat cannot be read", () => {
    const g = new CpuStealGuard({ read: () => null });
    expect(g.sample(0).throttled).toBe(false);
    expect(g.sample(60_000).throttled).toBe(false);
  });
});

describe("modelSlotReport", () => {
  it("reports idle slots as free normally", () => {
    expect(modelSlotReport({ slots: 2, inflight: 1, available: true, cpuThrottled: false })).toEqual({ free: 1, reportAnyway: false });
  });

  it("a throttled host reports no free slot, and still pulls to say so while it has idle slots", () => {
    expect(modelSlotReport({ slots: 2, inflight: 0, available: true, cpuThrottled: true })).toEqual({ free: 0, reportAnyway: true });
    // Every slot busy: the coordinator's own count already says it is full.
    expect(modelSlotReport({ slots: 2, inflight: 2, available: true, cpuThrottled: true })).toEqual({ free: 0, reportAnyway: false });
  });

  it("an engine that is down or a host short of memory reports no slot and skips the pull, as before", () => {
    expect(modelSlotReport({ slots: 2, inflight: 0, available: false, cpuThrottled: true })).toEqual({ free: 0, reportAnyway: false });
  });
});
