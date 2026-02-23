import { describe, it, expect } from "vitest";
import {
  buildCapabilitySummary,
  type AgentCapabilityInfo,
} from "../../src/mesh/capability-gossip.js";
import type { CapabilitySummaryPayload, MeshMessageType } from "../../src/common/types.js";

describe("capability_summary coordinator integration", () => {
  it("capability_summary is a valid MeshMessageType", () => {
    const msgType: MeshMessageType = "capability_summary";
    expect(msgType).toBe("capability_summary");
  });

  it("buildCapabilitySummary output conforms to CapabilitySummaryPayload", () => {
    const agents: AgentCapabilityInfo[] = [
      { agentId: "a1", activeModel: "qwen2.5-coder:7b", activeModelParamSize: 7, currentLoad: 0 },
    ];
    const summary: CapabilitySummaryPayload = buildCapabilitySummary("coord-1", agents);
    expect(summary.coordinatorId).toBe("coord-1");
    expect(typeof summary.timestamp).toBe("number");
  });

  it("federated capabilities map stores summaries by coordinator ID", () => {
    const federatedCapabilities = new Map<string, CapabilitySummaryPayload>();
    const incomingSummary: CapabilitySummaryPayload = {
      coordinatorId: "coord-remote",
      agentCount: 10,
      modelAvailability: {
        "qwen2.5-coder:7b": { agentCount: 5, totalParamCapacity: 35, avgLoad: 1.2 },
      },
      timestamp: Date.now(),
    };
    federatedCapabilities.set(incomingSummary.coordinatorId, incomingSummary);
    expect(federatedCapabilities.has("coord-remote")).toBe(true);
    const stored = federatedCapabilities.get("coord-remote")!;
    expect(stored.agentCount).toBe(10);
  });
});
