import { describe, expect, it } from "vitest";
import { agentLine, elapsedText, liveSummary, requesterText, runningWhere, slotsText, tokensText } from "../src/lib/activity-view";
import type { AgentActivity } from "../src/lib/api";

const AGENT: AgentActivity = { reachable: true, agentId: "a", coordinatorUrl: "https://coordinator.edgecoder.io", registered: true, region: "us-east", paused: null, draining: false, claims: 0, slots: { total: 2, busy: 1 }, computeClass: "apple", tier: "apple.m", jobs: [], jobsUnknown: false };

describe("Active work text", () => {
  it("the agent's state", () => {
    expect(agentLine(AGENT)).toMatchObject({ title: "Connected to coordinator.edgecoder.io · us-east", tone: "on" });
    expect(agentLine(AGENT).detail).toContain("Apple (apple.m)");
    expect(agentLine({ ...AGENT, paused: { reason: "x", sinceMs: 1 } })).toMatchObject({ title: "Paused by the network", tone: "err" });
    expect(agentLine({ ...AGENT, draining: true }).tone).toBe("warn");
    expect(agentLine({ ...AGENT, reachable: false }).title).toBe("The agent isn't answering");
    expect(agentLine(null).title).toBe("Not on the network");
  });

  it("slots, elapsed, tokens, who asked", () => {
    expect(slotsText(AGENT)).toBe("1 of 2 slots in use · 1 free");
    expect(slotsText({ ...AGENT, slots: { total: 0, busy: 0 } })).toMatch(/No model slots/);
    expect(slotsText(null)).toBeNull();
    expect(elapsedText(4_200)).toBe("4 s");
    expect(elapsedText(65_000)).toBe("1 min 05 s");
    expect(elapsedText(7_380_000)).toBe("2 h 03 min");
    expect(tokensText(340)).toBe("≈340");
    expect(tokensText(1_250)).toBe("≈1.3k");
    expect(requesterText({ requester: "you" })).toBe("You");
    expect(requesterText({ requester: "network" })).toBe("Someone on the network");
  });

  it("where one of your requests is running", () => {
    expect(runningWhere({ calls: [], model: "network/qwen3:32b" })).toMatch(/^qwen3.* · waiting for the first reply$/);
    expect(runningWhere({ calls: [{ cSats: 0, where: "This computer · llama3.2:3b" }] })).toBe("This computer · llama3.2:3b");
    expect(runningWhere({ calls: [{ cSats: 1, model: "network/qwen3:32b", served: { label: "m", own: false, computeClass: "gpu", tier: "24gb", hardware: "GPU", region: "us-east", country: "US" } }] })).toContain("us-east");
    expect(runningWhere({ calls: [] })).toBe("Starting…");
  });

  it("the live summary", () => {
    expect(liveSummary({ atMs: 0, agent: { ...AGENT, jobs: [{ id: "j", kind: "inference", model: null, startedAtMs: 0, elapsedMs: 0, outputTokens: 0, requester: "network" }] }, mine: [] })).toBe("1 network job on this computer, 0 of your requests running.");
  });
});
