import { describe, expect, it } from "vitest";
import { SwarmQueue, type AbandonedClaim } from "../../src/swarm/queue.js";
import { AgentBehaviorTracker } from "../../src/security/behavior-tracker.js";
import { AnomalyDetector } from "../../src/security/anomaly-detector.js";
import { AutoBlacklister, type BlacklistAction } from "../../src/security/auto-blacklister.js";
import type { ExecutionPolicy } from "../../src/common/types.js";

/*
 * BHV006 end to end without the app: the queue reports lapsed claims, the tracker counts them,
 * the detector looks for a pattern, the auto-blacklister acts on it.
 */

const policy: ExecutionPolicy = { cpuCapPercent: 50, memoryLimitMb: 2048, idleOnly: false, maxConcurrentTasks: 1, allowedHours: { startHourUtc: 0, endHourUtc: 24 } };
const enqueue = (q: SwarmQueue, timeoutMs = 60_000) =>
  q.enqueueSubtask({ taskId: "t-1", kind: "micro_loop", language: "python", input: "x", timeoutMs, snapshotRef: "commit:abc", projectMeta: { projectId: "p-1", resourceClass: "cpu", priority: 50 } });

function harness() {
  const queue = new SwarmQueue(undefined, { livenessMs: 1_000, graceMs: 0 });
  const tracker = new AgentBehaviorTracker();
  const detector = new AnomalyDetector();
  const actions: BlacklistAction[] = [];
  const blacklister = new AutoBlacklister((a) => actions.push(a));
  const abandoned: AbandonedClaim[] = [];
  queue.onClaimAbandoned((c) => {
    abandoned.push(c);
    tracker.recordAbandonedClaim(c.agentId, { whileActive: c.holderLive }, c.atMs);
    const stats = tracker.getStats(c.agentId, c.atMs);
    if (stats) blacklister.processAnomalies(c.agentId, detector.evaluate(stats), c.atMs);
  });
  queue.registerAgent("mac", policy);
  return { queue, tracker, actions, abandoned };
}

describe("queue: abandoned claims and clean release", () => {
  it("a lapsed lease requeues the claim and reports one abandoned claim (holder quiet)", () => {
    const { queue, abandoned, actions } = harness();
    const st = enqueue(queue);
    const now = Date.now();
    expect(queue.claim("mac")?.id).toBe(st.id);
    // A 495 s gap (an update restart): one abandoned claim, requeued, nobody blacklisted.
    const exp = queue.expireLeases(now + 495_000);
    expect(exp.requeued).toEqual([st.id]);
    expect(queue.isUnclaimed(st.id)).toBe(true);
    expect(abandoned).toMatchObject([{ subtaskId: st.id, agentId: "mac", holderLive: false }]);
    expect(actions).toEqual([]);
  });

  it("a claim past its hard deadline while heartbeating is reported as holderLive", () => {
    const { queue, abandoned } = harness();
    // A 200 ms job, liveness 1 s: at +500 ms the agent is still live but the job is past its deadline.
    const st = enqueue(queue, 200);
    queue.claim("mac");
    queue.heartbeat("mac");
    queue.expireLeases(Date.now() + 500);
    expect(abandoned[0]).toMatchObject({ subtaskId: st.id, holderLive: true });
  });

  it("releaseClaimsOf hands every claim back at once, reports nothing abandoned and refuses a late result", () => {
    const { queue, abandoned } = harness();
    const st = enqueue(queue);
    queue.claim("mac");
    expect(queue.releaseClaimsOf("mac")).toEqual([st.id]);
    expect(queue.isUnclaimed(st.id)).toBe(true);
    expect(queue.leaseExpiredFor(st.id, "mac")).toBe(true);
    queue.expireLeases(Date.now() + 10 * 60_000);
    expect(abandoned).toEqual([]);
    // The agent is not barred: it may take the subtask again when it is back.
    expect(queue.claim("mac")?.id).toBe(st.id);
  });
});

describe("BHV006 pattern leads to a blacklist", () => {
  it("claiming and abandoning without ever returning a result blacklists at the threshold", () => {
    const { queue, actions } = harness();
    let t = Date.now();
    for (let i = 0; i < 7 && actions.length === 0; i++) {
      enqueue(queue);
      queue.claim("mac");
      t += 60_000;
      queue.expireLeases(t);
    }
    expect(actions).toHaveLength(1);
    expect(actions[0].reason).toContain("BHV006");
    expect(actions[0].reason).toContain("abandoned in a row");
  });

  it("abandoned claims with completed work in between never add up", () => {
    const { queue, tracker, actions } = harness();
    let t = Date.now();
    for (let i = 0; i < 12; i++) {
      enqueue(queue);
      queue.claim("mac");
      t += 60_000;
      queue.expireLeases(t);
      tracker.recordTaskResult("mac", { ok: true, output: "done", durationMs: 4000 }, t + 1);
    }
    expect(tracker.getStats("mac", t + 2)!.abandonedClaimCount).toBe(12);
    expect(actions).toEqual([]);
  });
});
