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
