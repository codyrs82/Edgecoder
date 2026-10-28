import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwarmQueue, leaseConfigFromEnv, DEFAULT_LEASE } from "../../src/swarm/queue.js";
import type { Subtask } from "../../src/common/types.js";

// #51: claim leases = timeoutMs + grace, renewed by heartbeat, retry cap.
const policy = { allowIdleOnly: false, maxCpuPercent: 100, maxMemoryMb: 4096 } as any;
const LEASE = { graceMs: 10_000, livenessMs: 20_000, maxAttempts: 3 };

function subtask(timeoutMs: number): Omit<Subtask, "id"> {
  return {
    taskId: "task-1",
    kind: "micro_loop",
    language: "python",
    input: "print(1)",
    timeoutMs,
    snapshotRef: "commit:test",
    projectMeta: { projectId: "p", resourceClass: "cpu", priority: 10 }
  };
}

function setup(timeoutMs = 120_000) {
  const q = new SwarmQueue(null, LEASE);
  q.registerAgent("A", policy);
  q.registerAgent("B", policy);
  const st = q.enqueueSubtask(subtask(timeoutMs));
  return { q, st };
}

describe("claim leases (#51)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => vi.useRealTimers());

  it("a long task is not reassigned while the claimant keeps heartbeating", () => {
    const { q, st } = setup(120_000);
    expect(q.claim("A")?.id).toBe(st.id);
    for (let t = 0; t < 105_000; t += 15_000) {
      vi.advanceTimersByTime(15_000);
      q.heartbeat("A");
      expect(q.expireLeases().requeued).toEqual([]);
      expect(q.claim("B")).toBeUndefined();
    }
    expect(q.getClaim(st.id)?.claimedBy).toBe("A");
  });

  it("a silent claimant loses the lease after livenessMs and B can take over", () => {
    const { q, st } = setup(120_000);
    q.claim("A");
    vi.advanceTimersByTime(LEASE.livenessMs + 1);
    expect(q.expireLeases().requeued).toEqual([st.id]);
    expect(q.claim("B")?.id).toBe(st.id);
  });

  it("heartbeats can't extend a lease beyond timeoutMs + grace", () => {
    const { q, st } = setup(30_000);
    q.claim("A");
    for (let i = 0; i < 4; i += 1) { vi.advanceTimersByTime(10_000); q.heartbeat("A"); }
    expect(q.getClaim(st.id)?.claimedBy).toBe("A"); // exactly at timeout + grace
    vi.advanceTimersByTime(1);
    expect(q.getClaim(st.id)?.claimedBy).toBeUndefined();
  });

  it("a late result from an expired lease is flagged; the new holder's is not", () => {
    const { q, st } = setup(120_000);
    q.claim("A");
    vi.advanceTimersByTime(LEASE.livenessMs + 1);
    q.claim("B");
    expect(q.leaseExpiredFor(st.id, "A")).toBe(true);
    expect(q.leaseExpiredFor(st.id, "B")).toBe(false);
    expect(q.getClaim(st.id)?.claimedBy).toBe("B");
  });

  it("an expired holder that re-claims the task is the valid holder again", () => {
    const { q, st } = setup(120_000);
    q.claim("A");
    vi.advanceTimersByTime(LEASE.livenessMs + 1);
    q.expireLeases();
    expect(q.leaseExpiredFor(st.id, "A")).toBe(true);
    expect(q.claim("A")?.id).toBe(st.id);
    expect(q.leaseExpiredFor(st.id, "A")).toBe(false);
  });

  it("a stale heartbeat after expiry doesn't revive the lease", () => {
    const { q, st } = setup(120_000);
    q.claim("A");
    vi.advanceTimersByTime(LEASE.livenessMs + 1);
    q.heartbeat("A");
    expect(q.getClaim(st.id)?.claimedBy).toBeUndefined();
    expect(q.leaseExpiredFor(st.id, "A")).toBe(true);
  });

  it("retry cap: after maxAttempts expired claims the subtask fails", () => {
    const { q, st } = setup(120_000);
    const agents = ["A", "B", "A"];
    for (let i = 0; i < LEASE.maxAttempts; i += 1) {
      expect(q.claim(agents[i])?.id).toBe(st.id);
      vi.advanceTimersByTime(LEASE.livenessMs + 1);
      const r = q.expireLeases();
      if (i < LEASE.maxAttempts - 1) expect(r).toEqual({ requeued: [st.id], failed: [] });
      else expect(r).toEqual({ requeued: [], failed: [st.id] });
    }
    expect(q.claim("B")).toBeUndefined();
    expect(q.status().queued).toBe(0);
    expect(q.status().results).toBe(1);
  });

  it("a coordinator-side requeue (power policy) doesn't count against the cap", () => {
    const { q, st } = setup(120_000);
    for (let i = 0; i < 5; i += 1) { q.claim("A"); q.requeue(st.id); }
    q.claim("A");
    vi.advanceTimersByTime(LEASE.livenessMs + 1);
    expect(q.expireLeases().requeued).toEqual([st.id]);
  });

  it("env config parses and falls back on bad values", () => {
    expect(leaseConfigFromEnv({})).toEqual(DEFAULT_LEASE);
    expect(leaseConfigFromEnv({ CLAIM_LEASE_GRACE_MS: "5000", CLAIM_LEASE_LIVENESS_MS: "60000", CLAIM_MAX_ATTEMPTS: "5" }))
      .toEqual({ graceMs: 5000, livenessMs: 60000, maxAttempts: 5 });
    expect(leaseConfigFromEnv({ CLAIM_LEASE_LIVENESS_MS: "10", CLAIM_MAX_ATTEMPTS: "0", CLAIM_LEASE_GRACE_MS: "x" }))
      .toEqual(DEFAULT_LEASE);
  });
});
