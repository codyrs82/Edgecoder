import { describe, it, expect } from "vitest";
import type { CapabilitySummaryPayload } from "../../src/common/types.js";

describe("federated capabilities query", () => {
  it("finds coordinators with matching model", () => {
    const federated = new Map<string, CapabilitySummaryPayload>();
    federated.set("coord-a", {
      coordinatorId: "coord-a",
      agentCount: 5,
      modelAvailability: {
        "qwen2.5-coder:7b": { agentCount: 3, totalParamCapacity: 21, avgLoad: 1.0 },
      },
      timestamp: Date.now(),
    });
    federated.set("coord-b", {
      coordinatorId: "coord-b",
      agentCount: 2,
      modelAvailability: {
        "qwen2.5-coder:1.5b": { agentCount: 2, totalParamCapacity: 3, avgLoad: 0.5 },
      },
      timestamp: Date.now(),
    });

    const with7B = [...federated.values()].filter(
      (c) => c.modelAvailability["qwen2.5-coder:7b"]?.agentCount > 0
    );
    expect(with7B).toHaveLength(1);
    expect(with7B[0].coordinatorId).toBe("coord-a");
  });

  it("sorts by available capacity descending", () => {
    const federated = new Map<string, CapabilitySummaryPayload>();
    federated.set("coord-a", {
      coordinatorId: "coord-a",
      agentCount: 2,
      modelAvailability: {
        "qwen2.5-coder:7b": { agentCount: 2, totalParamCapacity: 14, avgLoad: 0.5 },
      },
      timestamp: Date.now(),
    });
    federated.set("coord-b", {
      coordinatorId: "coord-b",
      agentCount: 5,
      modelAvailability: {
        "qwen2.5-coder:7b": { agentCount: 5, totalParamCapacity: 35, avgLoad: 0.2 },
      },
      timestamp: Date.now(),
    });

    const sorted = [...federated.values()]
      .filter((c) => c.modelAvailability["qwen2.5-coder:7b"])
      .sort(
        (a, b) =>
          b.modelAvailability["qwen2.5-coder:7b"].totalParamCapacity -
          a.modelAvailability["qwen2.5-coder:7b"].totalParamCapacity
      );
    expect(sorted[0].coordinatorId).toBe("coord-b");
  });
});
