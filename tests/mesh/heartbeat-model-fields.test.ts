import { describe, it, expect } from "vitest";

describe("heartbeat active model fields", () => {
  it("agentCapabilities shape supports activeModel field", () => {
    const cap = {
      os: "macos",
      version: "1.0.0",
      mode: "swarm-only" as const,
      localModelEnabled: true,
      localModelProvider: "ollama-local" as const,
      localModelCatalog: ["qwen2.5-coder:7b"],
      clientType: "node",
      swarmEnabled: true,
      ideEnabled: false,
      maxConcurrentTasks: 1,
      connectedPeers: new Set<string>(),
      lastSeenMs: Date.now(),
      activeModel: "qwen2.5-coder:7b",
      activeModelParamSize: 7,
      modelSwapInProgress: false,
    };
    expect(cap.activeModel).toBe("qwen2.5-coder:7b");
    expect(cap.activeModelParamSize).toBe(7);
    expect(cap.modelSwapInProgress).toBe(false);
  });

  it("heartbeat payload includes model fields for gossip aggregation", () => {
    const heartbeatPayload = {
      agentId: "agent-1",
      powerTelemetry: {
        onExternalPower: true,
        batteryLevelPct: 100,
        lowPowerMode: false,
        updatedAtMs: Date.now(),
      },
      activeModel: "qwen2.5-coder:7b",
      activeModelParamSize: 7,
      modelSwapInProgress: false,
    };
    expect(heartbeatPayload.activeModel).toBe("qwen2.5-coder:7b");
  });
});
