import { describe, expect, it } from "vitest";
import { describeSlots, PULL_SKIP_REPEAT_MS, PullSkipLog, pullSkipReason, type PullGateState } from "../../src/swarm/pull-skip.js";
import { modelSlotReport } from "../../src/swarm/cpu-steal.js";

/*
 * Network run 10: the coordinator showed 2-slot CPU hosts "1 of 2 free" with no pull for 44-127 s.
 * In 71 of 73 such samples the agent's own log showed two calls running: one had been taken back by
 * the coordinator and the agent was still generating it. An agent with a slot free does pull; one with
 * none says so in its log.
 */

/** An inference-only host's gate, its slot report computed the way the loop does. */
function gate(o: { slots?: number; inflight: number; throttled?: boolean; engine?: boolean; memoryOk?: boolean } & Partial<PullGateState>): PullGateState {
  const slots = o.slots ?? 2;
  const memoryOk = o.memoryOk ?? true;
  const report = modelSlotReport({ slots, inflight: o.inflight, available: (o.engine ?? true) && memoryOk, cpuThrottled: o.throttled ?? false });
  return {
    pullsFromCoordinator: true, sandboxDown: false, lifecycleCanPull: true, memoryOk, shuttingDown: false, inferenceOnly: true,
    slots, inflight: o.inflight, free: report.free, reportAnyway: report.reportAnyway, drainReturnHold: false, cpuThrottled: o.throttled ?? false,
    ...o,
  };
}

describe("pull gate (run 10)", () => {
  it("a host with a free slot pulls while its other slot runs a call", () => {
    expect(pullSkipReason(gate({ inflight: 0 }))).toBeNull();
    expect(pullSkipReason(gate({ inflight: 1 }))).toBeNull();
    expect(pullSkipReason(gate({ slots: 4, inflight: 3 }))).toBeNull();
  });

  it("every slot busy: no pull, reason all_slots_busy", () => {
    expect(pullSkipReason(gate({ inflight: 2 }))).toBe("all_slots_busy");
    expect(pullSkipReason(gate({ slots: 1, inflight: 1 }))).toBe("all_slots_busy");
  });

  it("a throttled CPU with an idle slot still pulls (to report none free); fully busy and throttled does not", () => {
    expect(pullSkipReason(gate({ inflight: 1, throttled: true }))).toBeNull();
    expect(pullSkipReason(gate({ inflight: 2, throttled: true }))).toBe("all_slots_busy");
  });

  it("names the other reasons, in the loop's order", () => {
    expect(pullSkipReason(gate({ inflight: 0, engine: false }))).toBe("engine_not_ready");
    expect(pullSkipReason(gate({ inflight: 0, memoryOk: false }))).toBe("memory_pressure");
    expect(pullSkipReason(gate({ inflight: 0, shuttingDown: true }))).toBe("shutting_down");
    expect(pullSkipReason(gate({ inflight: 0, lifecycleCanPull: false }))).toBe("draining");
    expect(pullSkipReason(gate({ inflight: 0, sandboxDown: true }))).toBe("sandbox_down");
    expect(pullSkipReason(gate({ inflight: 0, pullsFromCoordinator: false }))).toBe("no_swarm_role");
    // Coming home after a drain failover: the pull goes out to report no free slot.
    expect(pullSkipReason(gate({ inflight: 2, drainReturnHold: true }))).toBeNull();
    // A sandboxed agent (not inference-only) pulls for code jobs whatever its model slots.
    expect(pullSkipReason(gate({ inflight: 2, inferenceOnly: false }))).toBeNull();
  });

  it("slot state in the line", () => {
    expect(describeSlots({ slots: 2, inflight: 2, free: 0, cpuThrottled: false })).toBe("slots 2, running 2, free 0, cpu throttled no");
  });
});

describe("pull-skipped log", () => {
  it("logs when a reason starts, then once a minute while it lasts, and again after a pull", () => {
    const log = new PullSkipLog();
    const s = "slots 2, running 2, free 0, cpu throttled no";
    expect(log.note("all_slots_busy", s, 0)).toBe(`pull skipped: all_slots_busy (${s})`);
    expect(log.note("all_slots_busy", s, 3_000)).toBeNull();
    expect(log.note("all_slots_busy", s, PULL_SKIP_REPEAT_MS - 1)).toBeNull();
    expect(log.note("all_slots_busy", s, PULL_SKIP_REPEAT_MS)).toBe(`pull skipped: all_slots_busy for 60 s, 4 ticks (${s})`);
    expect(log.note("memory_pressure", s, PULL_SKIP_REPEAT_MS + 1_000)).toMatch(/^pull skipped: memory_pressure/);
    expect(log.note(null, s, PULL_SKIP_REPEAT_MS + 2_000)).toBeNull();
    expect(log.note("memory_pressure", s, PULL_SKIP_REPEAT_MS + 3_000)).toMatch(/^pull skipped: memory_pressure \(/);
  });
});
