import { describe, it, expect } from "vitest";
import {
  buildCapabilitySummary,
  type AgentCapabilityInfo,
} from "../../src/mesh/capability-gossip.js";

describe("buildCapabilitySummary", () => {
  it("aggregates model availability from agents", () => {
    const agents: AgentCapabilityInfo[] = [
      { agentId: "a1", activeModel: "qwen2.5-coder:7b", activeModelParamSize: 7, currentLoad: 1 },
      { agentId: "a2", activeModel: "qwen2.5-coder:7b", activeModelParamSize: 7, currentLoad: 3 },
      { agentId: "a3", activeModel: "qwen2.5-coder:1.5b", activeModelParamSize: 1.5, currentLoad: 0 },
    ];

    const summary = buildCapabilitySummary("coord-1", agents);

    expect(summary.coordinatorId).toBe("coord-1");
    expect(summary.agentCount).toBe(3);
    expect(summary.modelAvailability["qwen2.5-coder:7b"].agentCount).toBe(2);
    expect(summary.modelAvailability["qwen2.5-coder:7b"].totalParamCapacity).toBe(14);
    expect(summary.modelAvailability["qwen2.5-coder:7b"].avgLoad).toBe(2);
    expect(summary.modelAvailability["qwen2.5-coder:1.5b"].agentCount).toBe(1);
    expect(summary.modelAvailability["qwen2.5-coder:1.5b"].totalParamCapacity).toBe(1.5);
    expect(summary.modelAvailability["qwen2.5-coder:1.5b"].avgLoad).toBe(0);
    expect(summary.timestamp).toBeGreaterThan(0);
  });

  it("returns empty availability for no agents", () => {
    const summary = buildCapabilitySummary("coord-1", []);
    expect(summary.agentCount).toBe(0);
    expect(Object.keys(summary.modelAvailability)).toHaveLength(0);
  });

  it("excludes agents with no active model", () => {
    const agents: AgentCapabilityInfo[] = [
      { agentId: "a1", activeModel: "", activeModelParamSize: 0, currentLoad: 0 },
      { agentId: "a2", activeModel: "qwen2.5-coder:7b", activeModelParamSize: 7, currentLoad: 0 },
    ];

    const summary = buildCapabilitySummary("coord-1", agents);
    expect(summary.agentCount).toBe(2);
    expect(Object.keys(summary.modelAvailability)).toHaveLength(1);
  });
});
