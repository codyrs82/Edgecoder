import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwarmQueue } from "../../src/swarm/queue.js";
import type { Subtask } from "../../src/common/types.js";

/*
 * DoS, claim hoarding: one agent must not be able to hold the whole queue, nor fail any subtask by
 * claiming it and letting every lease lapse (an expired holder may re-claim, which burned retries).
 */
const policy = { allowIdleOnly: false, maxCpuPercent: 100, maxMemoryMb: 4096 } as any;
const LEASE = { graceMs: 10_000, livenessMs: 20_000, maxAttempts: 3 };

function subtask(i: number): Omit<Subtask, "id"> {
  return { taskId: `task-${i}`, kind: "micro_loop", language: "python", input: "print(1)", timeoutMs: 120_000, snapshotRef: "commit:test", projectMeta: { projectId: "p", resourceClass: "cpu", priority: 10 } };
}

describe("claim hoarding", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => vi.useRealTimers());

  it("an agent holds at most maxOpenClaims at once; others still get work", () => {
    const q = new SwarmQueue(null, LEASE);
    q.registerAgent("hoarder", policy);
    q.registerAgent("honest", policy);
    for (let i = 0; i < 40; i++) q.enqueueSubtask(subtask(i));
    let held = 0;
    while (q.claim("hoarder", undefined, "hoarder", undefined, 16)) held += 1;
    expect(held).toBe(16);
    expect(q.claim("honest", undefined, "honest", undefined, 16)).toBeDefined();
  });

  it("one agent cannot burn every retry of a subtask by letting its leases lapse", () => {
    const q = new SwarmQueue(null, LEASE);
    q.registerAgent("hoarder", policy);
    q.registerAgent("honest", policy);
    const st = q.enqueueSubtask(subtask(0));
    for (let i = 0; i < 3; i++) {
      q.claim("hoarder");
      vi.advanceTimersByTime(LEASE.livenessMs + 1);
      q.expireLeases();
    }
    // After two lapses the hoarder is barred: the subtask is still queued for someone else.
    expect(q.getResult(st.id)).toBeUndefined();
    expect(q.claim("hoarder")).toBeUndefined();
    expect(q.claim("honest")?.id).toBe(st.id);
  });
});
