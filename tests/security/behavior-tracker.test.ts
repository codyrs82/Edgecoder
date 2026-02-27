import { describe, expect, it } from "vitest";
import { AgentBehaviorTracker } from "../../src/security/behavior-tracker.js";

describe("AgentBehaviorTracker", () => {
  const WINDOW_MS = 60 * 60 * 1000; // 1 hour

  it("returns null for unknown agent", () => {
    const tracker = new AgentBehaviorTracker();
    expect(tracker.getStats("unknown-agent")).toBeNull();
  });

  it("accumulates task results", () => {
    const tracker = new AgentBehaviorTracker();
    const now = Date.now();
    tracker.recordTaskResult("agent-1", { ok: true, output: "result A", durationMs: 2000 }, now);
    tracker.recordTaskResult("agent-1", { ok: true, output: "result B", durationMs: 3000 }, now + 100);
    tracker.recordTaskResult("agent-1", { ok: false, output: "", durationMs: 1000 }, now + 200);

    const stats = tracker.getStats("agent-1", now + 300)!;
    expect(stats.totalTasks).toBe(3);
    expect(stats.successCount).toBe(2);
    expect(stats.successRate).toBeCloseTo(2 / 3);
    expect(stats.emptyOutputCount).toBe(1);
    expect(stats.avgDurationMs).toBe(2000);
  });

  it("tracks empty outputs correctly", () => {
    const tracker = new AgentBehaviorTracker();
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      tracker.recordTaskResult("agent-1", { ok: true, output: "", durationMs: 1000 }, now + i);
    }
    const stats = tracker.getStats("agent-1", now + 10)!;
    expect(stats.emptyOutputCount).toBe(6);
    expect(stats.avgOutputLength).toBe(0);
  });

  it("detects consecutive identical output hashes", () => {
    const tracker = new AgentBehaviorTracker();
    const now = Date.now();
    tracker.recordTaskResult("agent-1", { ok: true, output: "unique", durationMs: 1000 }, now);
    tracker.recordTaskResult("agent-1", { ok: true, output: "same", durationMs: 1000 }, now + 1);
    tracker.recordTaskResult("agent-1", { ok: true, output: "same", durationMs: 1000 }, now + 2);
    tracker.recordTaskResult("agent-1", { ok: true, output: "same", durationMs: 1000 }, now + 3);

    const stats = tracker.getStats("agent-1", now + 10)!;
    expect(stats.identicalOutputCount).toBe(3);
  });

  it("limits recent output hashes ring buffer", () => {
    const tracker = new AgentBehaviorTracker();
    const now = Date.now();
    for (let i = 0; i < 25; i++) {
      tracker.recordTaskResult("agent-1", { ok: true, output: `output-${i}`, durationMs: 1000 }, now + i);
    }
    const stats = tracker.getStats("agent-1", now + 30)!;
    expect(stats.recentOutputHashes.length).toBe(20);
  });

  it("tracks suspiciously fast tasks", () => {
    const tracker = new AgentBehaviorTracker();
    const now = Date.now();
    tracker.recordTaskResult("agent-1", { ok: true, output: "fast", durationMs: 100 }, now);
    tracker.recordTaskResult("agent-1", { ok: true, output: "fast2", durationMs: 200 }, now + 1);
    tracker.recordTaskResult("agent-1", { ok: true, output: "slow", durationMs: 5000 }, now + 2);

    const stats = tracker.getStats("agent-1", now + 10)!;
    expect(stats.suspiciouslyFastCount).toBe(2);
    expect(stats.minDurationMs).toBe(100);
  });

  it("computes duration standard deviation", () => {
    const tracker = new AgentBehaviorTracker();
    const now = Date.now();
    // All exactly 1000ms → stddev 0
    for (let i = 0; i < 5; i++) {
      tracker.recordTaskResult("agent-1", { ok: true, output: `o-${i}`, durationMs: 1000 }, now + i);
    }
    const stats = tracker.getStats("agent-1", now + 10)!;
    expect(stats.durationStdDev).toBe(0);
    expect(stats.avgDurationMs).toBe(1000);
  });

  it("tracks protocol violations", () => {
    const tracker = new AgentBehaviorTracker();
    const now = Date.now();
    tracker.recordProtocolViolation("agent-1", "signature_failure", now);
    tracker.recordProtocolViolation("agent-1", "signature_failure", now + 1);
    tracker.recordProtocolViolation("agent-1", "replay_attempt", now + 2);
    tracker.recordProtocolViolation("agent-1", "rate_limit_hit", now + 3);

    const stats = tracker.getStats("agent-1", now + 10)!;
    expect(stats.signatureFailureCount).toBe(2);
    expect(stats.replayAttemptCount).toBe(1);
    expect(stats.rateLimitHitCount).toBe(1);
  });

  it("tracks registrations", () => {
    const tracker = new AgentBehaviorTracker();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      tracker.recordRegistration("agent-1", now + i);
    }
    const stats = tracker.getStats("agent-1", now + 10)!;
    expect(stats.registrationCount).toBe(5);
  });

  it("tracks heartbeats and computes max gap", () => {
    const tracker = new AgentBehaviorTracker();
    const now = Date.now();
    tracker.recordHeartbeat("agent-1", now);
    tracker.recordHeartbeat("agent-1", now + 10_000);
    tracker.recordHeartbeat("agent-1", now + 350_000); // 340s gap
    tracker.recordHeartbeat("agent-1", now + 360_000);

    const stats = tracker.getStats("agent-1", now + 370_000)!;
    expect(stats.heartbeatGapMaxMs).toBe(340_000);
  });

  it("tracks task claims", () => {
    const tracker = new AgentBehaviorTracker();
    const now = Date.now();
    tracker.recordTaskClaim("agent-1", now);
    tracker.recordTaskClaim("agent-1", now + 1000);

    const stats = tracker.getStats("agent-1", now + 2000)!;
    expect(stats.taskClaimCount).toBe(2);
    expect(stats.taskClaimRate).toBeGreaterThan(0);
  });

  it("prunes events outside window", () => {
    const tracker = new AgentBehaviorTracker(1000); // 1 second window
    const now = Date.now();
    tracker.recordTaskResult("agent-1", { ok: true, output: "old", durationMs: 500 }, now);
    tracker.recordTaskResult("agent-1", { ok: true, output: "new", durationMs: 600 }, now + 1500);

    const stats = tracker.getStats("agent-1", now + 1500)!;
    expect(stats.totalTasks).toBe(1);
    expect(stats.avgDurationMs).toBe(600);
  });

  it("tracks requeue and concurrent claim counts", () => {
    const tracker = new AgentBehaviorTracker();
    tracker.recordRequeue("agent-1");
    tracker.recordRequeue("agent-1");
    tracker.setConcurrentClaimCount("agent-1", 5);

    const stats = tracker.getStats("agent-1")!;
    expect(stats.requeueCount).toBe(2);
    expect(stats.concurrentClaimCount).toBe(5);
  });

  it("isolates stats between agents", () => {
    const tracker = new AgentBehaviorTracker();
    const now = Date.now();
    tracker.recordTaskResult("agent-1", { ok: true, output: "a", durationMs: 1000 }, now);
    tracker.recordTaskResult("agent-2", { ok: false, output: "b", durationMs: 2000 }, now);

    const stats1 = tracker.getStats("agent-1", now + 10)!;
    const stats2 = tracker.getStats("agent-2", now + 10)!;
    expect(stats1.totalTasks).toBe(1);
    expect(stats1.successRate).toBe(1);
    expect(stats2.totalTasks).toBe(1);
    expect(stats2.successRate).toBe(0);
  });
});
