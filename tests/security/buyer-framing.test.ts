import { describe, expect, it } from "vitest";
import { AgentBehaviorTracker } from "../../src/security/behavior-tracker.js";
import { AnomalyDetector } from "../../src/security/anomaly-detector.js";
import { AutoBlacklister } from "../../src/security/auto-blacklister.js";

/*
 * Agent attacker model, DoS: a buyer controls what an honest worker's code results print. Output-
 * content rules must not let a buyer get honest workers blacklisted (network-wide, via gossip).
 */
function pipeline() {
  const tracker = new AgentBehaviorTracker();
  const detector = new AnomalyDetector();
  const actions: string[] = [];
  const blacklister = new AutoBlacklister((a) => actions.push(a.agentId));
  const record = (agentId: string, output: string, t: number) => {
    tracker.recordTaskResult(agentId, { ok: true, output, durationMs: 2_000 + ((t / 5_000) % 7) * 300, kind: "single_step" }, t); // server-measured: jittered
    const events = detector.evaluate(tracker.getStats(agentId, t)!);
    blacklister.processAnomalies(agentId, events, t);
    return events;
  };
  return { record, actions };
}

describe("a buyer cannot get an honest worker blacklisted through its program's output", () => {
  it("identical outputs (print('OK') jobs) flag the worker for verification, never blacklist it", () => {
    const { record, actions } = pipeline();
    let events: ReturnType<typeof record> = [];
    for (let i = 0; i < 20; i++) events = record("honest-1", "OK\n", 1_000_000 + i * 5_000);
    const bhv003 = events.find((e) => e.ruleId === "BHV003");
    expect(bhv003).toBeDefined();
    expect(bhv003!.enforcement).toBe("flag");
    expect(actions).toEqual([]);
  });

  it("empty and tiny outputs (programs that print nothing or one char) do not blacklist either", () => {
    const { record, actions } = pipeline();
    for (let i = 0; i < 20; i++) record("honest-2", "", 2_000_000 + i * 5_000);
    for (let i = 0; i < 20; i++) record("honest-3", String(i % 10), 3_000_000 + i * 5_000);
    expect(actions).toEqual([]);
  });
});

describe("failure-rate rules (BHV004): program errors and the per-submitter cap", () => {
  function run(results: Array<{ outcome: "ok" | "program_error" | "agent_failure"; submitter: string }>) {
    const tracker = new AgentBehaviorTracker(undefined, { submitterFailureCap: 3 });
    const detector = new AnomalyDetector();
    const actions: string[] = [];
    const blacklister = new AutoBlacklister((a) => actions.push(a.agentId));
    let t = 5_000_000;
    let events: ReturnType<AnomalyDetector["evaluate"]> = [];
    results.forEach((r, i) => {
      t += 5_000;
      tracker.recordTaskResult("w", { ok: r.outcome === "ok", output: "", durationMs: 2_000 + (i % 7) * 300, kind: "single_step", outcome: r.outcome, submitter: r.submitter, subtaskId: `s${i}` }, t);
      events = detector.evaluate(tracker.getStats("w", t)!);
      blacklister.processAnomalies("w", events, t);
    });
    return { events, actions, tracker, t };
  }

  it("programs that exit non-zero are correctly executed jobs", () => {
    const { events, actions } = run(Array.from({ length: 20 }, () => ({ outcome: "program_error" as const, submitter: "acct:framer" })));
    expect(events.find((e) => e.ruleId === "BHV004")).toBeUndefined();
    expect(actions).toEqual([]);
  });

  it("one submitter's failures count at most the cap", () => {
    const { events, actions, tracker, t } = run(Array.from({ length: 20 }, () => ({ outcome: "agent_failure" as const, submitter: "acct:framer" })));
    expect(events.find((e) => e.ruleId === "BHV004")).toBeUndefined();
    expect(actions).toEqual([]);
    expect(tracker.getStats("w", t)).toMatchObject({ rateTasks: 3, cappedFailureCount: 17 });
  });

  it("failures across many submitters still collapse the rate (a broken agent is caught)", () => {
    const { actions } = run(Array.from({ length: 20 }, (_, i) => ({ outcome: "agent_failure" as const, submitter: `acct:b${i}` })));
    expect(actions).toContain("w");
  });

  it("a verification verdict that the job fails excuses the recorded failure", () => {
    const tracker = new AgentBehaviorTracker();
    tracker.recordTaskResult("w", { ok: false, output: "", durationMs: 2_000, subtaskId: "s1" }, 1_000);
    expect(tracker.getStats("w", 1_000)!.successRate).toBe(0);
    expect(tracker.excuseFailure("w", "s1")).toBe(true);
    expect(tracker.getStats("w", 1_000)!.successRate).toBe(1);
  });
});
