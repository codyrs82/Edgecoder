import { describe, expect, it } from "vitest";
import { AnomalyDetector, DEFAULT_ANOMALY_CONFIG } from "../../src/security/anomaly-detector.js";
import { type AgentBehaviorStats } from "../../src/security/behavior-tracker.js";

function baseStats(overrides: Partial<AgentBehaviorStats> = {}): AgentBehaviorStats {
  return {
    totalTasks: 0,
    successCount: 0,
    successRate: 1,
    emptyOutputCount: 0,
    identicalOutputCount: 0,
    recentOutputHashes: [],
    avgOutputLength: 100,
    avgDurationMs: 5000,
    minDurationMs: 3000,
    durationStdDev: 500,
    suspiciouslyFastCount: 0,
    signatureFailureCount: 0,
    replayAttemptCount: 0,
    rateLimitHitCount: 0,
    registrationCount: 0,
    taskClaimCount: 0,
    taskClaimRate: 0,
    requeueCount: 0,
    concurrentClaimCount: 0,
    heartbeatGapMaxMs: 0,
    windowStartMs: Date.now() - 3600_000,
    windowEndMs: Date.now(),
    // Code results by default, as before model calls were left out of the output-content rules.
    outputTasks: overrides.totalTasks ?? 0,
    ...overrides,
  };
}

describe("AnomalyDetector", () => {
  const detector = new AnomalyDetector();

  it("returns no anomalies for clean stats", () => {
    const stats = baseStats({ totalTasks: 20, successCount: 18, successRate: 0.9 });
    expect(detector.evaluate(stats)).toEqual([]);
  });

  describe("BHV001 — Suspiciously fast (server-measured, graduated)", () => {
    it("a few fast results only flag the agent for verification: never CRITICAL, never a strike", () => {
      const stats = baseStats({
        totalTasks: 5,
        suspiciouslyFastCount: 3,
        fastResultsByKind: { single_step: { fast: 3, ok: 5 } },
        avgDurationMs: 200,
      });
      const bhv001 = detector.evaluate(stats).find(e => e.ruleId === "BHV001");
      expect(bhv001).toBeDefined();
      expect(bhv001!.severity).toBe("WARN");
      expect(bhv001!.enforcement).toBe("flag");
    });

    it("does not trigger with too few fast results", () => {
      const stats = baseStats({ suspiciouslyFastCount: 2, fastResultsByKind: { single_step: { fast: 2, ok: 2 } }, avgDurationMs: 200 });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV001")).toBeUndefined();
    });

    it("a sustained pattern of fast results the coordinator cannot verify is a HIGH strike", () => {
      const stats = baseStats({ suspiciouslyFastCount: 20, fastResultsByKind: { inference: { fast: 20, ok: 22 } } });
      const bhv001 = detector.evaluate(stats).find(e => e.ruleId === "BHV001");
      expect(bhv001!.severity).toBe("HIGH");
      expect(bhv001!.enforcement).toBeUndefined();
      expect(bhv001!.blacklistReason).toBe("forged_results");
    });

    it("no strike while fast results are a minority of the unverifiable ones", () => {
      const stats = baseStats({ suspiciouslyFastCount: 20, fastResultsByKind: { inference: { fast: 20, ok: 40 } } });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV001")!.enforcement).toBe("flag");
    });

    it("fast results of kinds the coordinator verifies never strike, however many", () => {
      const verifying = new AnomalyDetector({ suspiciouslyFastVerifiableKinds: ["micro_loop", "single_step"] });
      const stats = baseStats({ suspiciouslyFastCount: 200, fastResultsByKind: { single_step: { fast: 150, ok: 150 }, micro_loop: { fast: 50, ok: 50 } } });
      const bhv001 = verifying.evaluate(stats).find(e => e.ruleId === "BHV001");
      expect(bhv001!.enforcement).toBe("flag");
      // ...while with verification off the same pattern is a strike.
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV001")!.severity).toBe("HIGH");
    });
  });

  describe("BHV002 — Mass empty outputs", () => {
    it("triggers with high empty ratio", () => {
      const stats = baseStats({
        totalTasks: 8,
        emptyOutputCount: 6,
      });
      const events = detector.evaluate(stats);
      const bhv002 = events.find(e => e.ruleId === "BHV002");
      expect(bhv002).toBeDefined();
      expect(bhv002!.blacklistReason).toBe("forged_results");
    });

    it("does not trigger with low empty count", () => {
      const stats = baseStats({
        totalTasks: 10,
        emptyOutputCount: 2,
      });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV002")).toBeUndefined();
    });

    it("does not trigger with zero tasks", () => {
      const stats = baseStats({ totalTasks: 0, emptyOutputCount: 0 });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV002")).toBeUndefined();
    });
  });

  describe("BHV003 — Duplicate forgery", () => {
    it("triggers on 3+ consecutive identical hashes", () => {
      const stats = baseStats({ identicalOutputCount: 3 });
      const events = detector.evaluate(stats);
      expect(events.find(e => e.ruleId === "BHV003")).toBeDefined();
    });

    it("does not trigger with fewer than 3 consecutive", () => {
      const stats = baseStats({ identicalOutputCount: 2 });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV003")).toBeUndefined();
    });
  });

  describe("BHV004 — Success collapse", () => {
    it("triggers with low success rate over many tasks", () => {
      const stats = baseStats({
        totalTasks: 15,
        successCount: 1,
        successRate: 1 / 15,
      });
      const events = detector.evaluate(stats);
      const bhv004 = events.find(e => e.ruleId === "BHV004");
      expect(bhv004).toBeDefined();
      expect(bhv004!.blacklistReason).toBe("policy_violation");
    });

    it("does not trigger with few tasks", () => {
      const stats = baseStats({
        totalTasks: 5,
        successRate: 0.05,
      });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV004")).toBeUndefined();
    });

    it("does not trigger with acceptable success rate", () => {
      const stats = baseStats({
        totalTasks: 20,
        successRate: 0.5,
      });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV004")).toBeUndefined();
    });
  });

  describe("BHV005 — Protocol abuse", () => {
    it("triggers with combined sig failures + replays >= threshold", () => {
      const stats = baseStats({
        signatureFailureCount: 3,
        replayAttemptCount: 2,
      });
      const events = detector.evaluate(stats);
      const bhv005 = events.find(e => e.ruleId === "BHV005");
      expect(bhv005).toBeDefined();
      expect(bhv005!.blacklistReason).toBe("credential_abuse");
    });

    it("does not trigger below threshold", () => {
      const stats = baseStats({
        signatureFailureCount: 2,
        replayAttemptCount: 1,
      });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV005")).toBeUndefined();
    });
  });

  describe("BHV006 — Heartbeat manipulation", () => {
    it("triggers with large gap and active claims", () => {
      const stats = baseStats({
        heartbeatGapMaxMs: 6 * 60 * 1000,
        taskClaimCount: 3,
      });
      const events = detector.evaluate(stats);
      expect(events.find(e => e.ruleId === "BHV006")).toBeDefined();
    });

    it("does not trigger if no task claims", () => {
      const stats = baseStats({
        heartbeatGapMaxMs: 6 * 60 * 1000,
        taskClaimCount: 0,
      });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV006")).toBeUndefined();
    });

    it("does not trigger if gap is small", () => {
      const stats = baseStats({
        heartbeatGapMaxMs: 60_000,
        taskClaimCount: 5,
      });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV006")).toBeUndefined();
    });
  });

  describe("BHV007 — Task hoarding", () => {
    it("triggers on excessive concurrent claims", () => {
      const stats = baseStats({ concurrentClaimCount: 5 });
      const events = detector.evaluate(stats);
      expect(events.find(e => e.ruleId === "BHV007")).toBeDefined();
    });

    it("triggers on excessive requeues", () => {
      const stats = baseStats({ requeueCount: 8 });
      const events = detector.evaluate(stats);
      expect(events.find(e => e.ruleId === "BHV007")).toBeDefined();
    });

    it("does not trigger under thresholds", () => {
      const stats = baseStats({ concurrentClaimCount: 1, requeueCount: 3 });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV007")).toBeUndefined();
    });
  });

  describe("BHV008 — Registration storm", () => {
    it("triggers with many registrations", () => {
      const stats = baseStats({ registrationCount: 10 });
      const events = detector.evaluate(stats);
      expect(events.find(e => e.ruleId === "BHV008")).toBeDefined();
    });

    it("does not trigger with few registrations", () => {
      const stats = baseStats({ registrationCount: 3 });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV008")).toBeUndefined();
    });
  });

  describe("BHV009 — Robot precision", () => {
    it("triggers with very low stddev and enough tasks", () => {
      const stats = baseStats({
        durationStdDev: 20,
        totalTasks: 12,
        codeDurationStdDev: 20,
        codeTimingTasks: 12,
      });
      const events = detector.evaluate(stats);
      const bhv009 = events.find(e => e.ruleId === "BHV009");
      expect(bhv009).toBeDefined();
      expect(bhv009!.severity).toBe("WARN");
    });

    it("does not trigger with higher stddev", () => {
      const stats = baseStats({
        durationStdDev: 200,
        totalTasks: 15,
        codeDurationStdDev: 200,
        codeTimingTasks: 15,
      });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV009")).toBeUndefined();
    });

    // Live regtest load test (2026-11-15): an honest CPU agent answering short, similar questions
    // with a 1.5B model was blacklisted at a 48 ms spread. Model calls don't count toward this rule.
    it("does not trigger on consistent model calls (inference only)", () => {
      const stats = baseStats({
        durationStdDev: 48,
        totalTasks: 40,
        codeDurationStdDev: 0,
        codeTimingTasks: 0,
      });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV009")).toBeUndefined();
    });

    it("does not trigger with few tasks", () => {
      const stats = baseStats({
        durationStdDev: 10,
        totalTasks: 5,
        codeDurationStdDev: 10,
        codeTimingTasks: 5,
      });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV009")).toBeUndefined();
    });
  });

  describe("BHV010 — Tiny outputs", () => {
    it("triggers with tiny avg output, enough tasks, and high success", () => {
      const stats = baseStats({
        avgOutputLength: 5,
        totalTasks: 8,
        successRate: 0.9,
      });
      const events = detector.evaluate(stats);
      const bhv010 = events.find(e => e.ruleId === "BHV010");
      expect(bhv010).toBeDefined();
      expect(bhv010!.severity).toBe("WARN");
    });

    it("does not trigger with normal output length", () => {
      const stats = baseStats({
        avgOutputLength: 500,
        totalTasks: 10,
        successRate: 0.95,
      });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV010")).toBeUndefined();
    });

    it("does not trigger with low success rate", () => {
      const stats = baseStats({
        avgOutputLength: 5,
        totalTasks: 10,
        successRate: 0.3,
      });
      expect(detector.evaluate(stats).find(e => e.ruleId === "BHV010")).toBeUndefined();
    });
  });

  describe("Custom config", () => {
    it("respects custom thresholds", () => {
      const customDetector = new AnomalyDetector({
        suspiciouslyFastMinCount: 10,
      });
      const stats = baseStats({
        suspiciouslyFastCount: 5,
        avgDurationMs: 800,
      });
      // Would trigger with default (3) but not with custom (10)
      expect(customDetector.evaluate(stats).find(e => e.ruleId === "BHV001")).toBeUndefined();
    });
  });
});
