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
const enqueue = (q: SwarmQueue, timeoutMs = 60_000, kind: "micro_loop" | "inference" = "micro_loop") =>
  q.enqueueSubtask({ taskId: "t-1", kind, language: "python", input: "x", timeoutMs, snapshotRef: "commit:abc", projectMeta: { projectId: "p-1", resourceClass: "cpu", priority: 50 } });

function harness() {
  const queue = new SwarmQueue(undefined, { livenessMs: 1_000, graceMs: 0 });
  const tracker = new AgentBehaviorTracker();
  const detector = new AnomalyDetector();
  const actions: BlacklistAction[] = [];
  const blacklister = new AutoBlacklister((a) => actions.push(a));
  const abandoned: AbandonedClaim[] = [];
  queue.onClaimAbandoned((c) => {
    abandoned.push(c);
    tracker.recordAbandonedClaim(c.agentId, { whileActive: c.holderLive, subtaskId: c.subtaskId }, c.atMs);
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

  it("network run 17: a finished result in flight during the hand-back may take the call back while nobody else has", () => {
    const { queue } = harness();
    queue.registerAgent("syd", policy);
    const st = enqueue(queue, 60_000, "inference");
    queue.claim("mac");
    const claimedAt = queue.getClaim(st.id)?.claimedAt;
    queue.releaseClaimsOf("mac");
    // Not a lapse for the late-result hold or re-run budget, and not for a failure or a streamed piece.
    expect(queue.lapsedClaim(st.id)).toBeUndefined();
    expect(queue.holdForLateResult(st.id, Date.now() + 30_000)).toBe(false);
    expect(queue.reclaimLapsed(st.id, "mac", 60_000)).toBe(false);
    expect(queue.reclaimLapsed(st.id, "syd", 60_000, Date.now(), { acceptHandedBack: true })).toBe(false);
    // A completed result, within the grace: the claim goes back to it with its claim time.
    expect(queue.reclaimLapsed(st.id, "mac", 60_000, Date.now(), { acceptHandedBack: true })).toBe(true);
    expect(queue.getClaim(st.id)).toMatchObject({ claimedBy: "mac", claimedAt });
    expect(queue.leaseExpiredFor(st.id, "mac")).toBe(false);
  });

  it("network run 17: once another agent claimed the handed-back call, the first one's result cannot take it", () => {
    const { queue } = harness();
    queue.registerAgent("syd", policy);
    const st = enqueue(queue, 60_000, "inference");
    queue.claim("mac");
    queue.releaseClaimsOf("mac");
    expect(queue.claim("syd")?.id).toBe(st.id);
    expect(queue.reclaimLapsed(st.id, "mac", 60_000, Date.now(), { acceptHandedBack: true })).toBe(false);
    expect(queue.getClaim(st.id)?.claimedBy).toBe("syd");
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

/*
 * 2026-11-25: a 16-slot cloud host returning model calls in seconds was blacklisted for "5 claims
 * abandoned in a row" when several claims it held at once lapsed together. One stall of an agent
 * running calls side by side is one lapse, and a result that arrives late was returned, not abandoned.
 */
describe("BHV006 under concurrent claims", () => {
  it("claims held at once that lapse together are one lapse: no blacklist", () => {
    const { queue, tracker, actions, abandoned } = harness();
    for (let i = 0; i < 8; i++) enqueue(queue, 60_000, "inference");
    for (let i = 0; i < 8; i++) expect(queue.claim("mac")).toBeDefined();
    queue.expireLeases(Date.now() + 5_000);
    expect(abandoned).toHaveLength(8);
    const stats = tracker.getStats("mac", Date.now() + 5_001)!;
    expect(stats.abandonedClaimCount).toBe(8);
    expect(stats.abandonedClaimStreak).toBe(1);
    expect(actions).toEqual([]);
  });

  it("lapses spread over a sweep window are still one lapse", () => {
    const tracker = new AgentBehaviorTracker();
    const t0 = 1_000_000_000;
    for (let i = 0; i < 6; i++) tracker.recordAbandonedClaim("host", { subtaskId: `s-${i}` }, t0 + i * 2_000);
    expect(tracker.getStats("host", t0 + 20_000)!.abandonedClaimStreak).toBe(1);
  });

  it("a late result withdraws that claim's lapse (it was returned, not abandoned)", () => {
    const { queue, tracker, abandoned } = harness();
    let t = Date.now();
    for (let i = 0; i < 4; i++) {
      enqueue(queue, 60_000, "inference");
      queue.claim("mac");
      t += 60_000;
      queue.expireLeases(t);
    }
    expect(tracker.getStats("mac", t)!.abandonedClaimStreak).toBe(4);
    // The results come in after their leases lapsed: refused as late, but returned, not abandoned.
    const ids = [...new Set(abandoned.map((c) => c.subtaskId))];
    for (const id of ids) expect(tracker.forgiveAbandonedClaim("mac", id)).toBe(true);
    expect(tracker.forgiveAbandonedClaim("mac", ids[0])).toBe(false);
    expect(tracker.forgiveAbandonedClaim("someone-else", ids[0])).toBe(false);
    expect(tracker.getStats("mac", t)!.abandonedClaimStreak).toBe(0);
  });

  it("claims the coordinator hands back (retry elsewhere, requeue, cancel or re-place) are never abandoned", () => {
    const { queue, abandoned } = harness();
    const a = enqueue(queue, 60_000, "inference");
    const b = enqueue(queue, 60_000, "inference");
    const c = enqueue(queue, 60_000, "inference");
    queue.claim("mac");
    queue.claim("mac");
    queue.claim("mac");
    expect(queue.releaseForRetry(a.id, "mac")).toBe(true);
    expect(queue.requeue(b.id)).toBe(true);
    queue.complete({ subtaskId: c.id, taskId: c.taskId, agentId: "coordinator", ok: false, output: "", error: "cancelled_by_requester", durationMs: 0 });
    // Re-placement only ever changes an unclaimed call.
    expect(queue.reassignUnclaimed(b.id, { requestedModel: "other" })).toBeDefined();
    queue.expireLeases(Date.now() + 10 * 60_000);
    expect(abandoned).toEqual([]);
  });

  it("still blacklists an agent that claims many at once and never returns, round after round", () => {
    const { queue, actions } = harness();
    let t = Date.now();
    let rounds = 0;
    for (; rounds < 10 && actions.length === 0; rounds++) {
      for (let i = 0; i < 16; i++) enqueue(queue, 60_000, "inference");
      while (queue.claim("mac")) { /* take everything */ }
      t += 60_000;
      queue.expireLeases(t);
    }
    expect(rounds).toBe(5);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].reason).toContain("BHV006");
    expect(actions[0].reason).toContain("abandoned in a row");
  });
});
