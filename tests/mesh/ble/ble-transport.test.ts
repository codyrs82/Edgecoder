import { describe, it, expect } from "vitest";
import { MockBLETransport } from "../../../src/mesh/ble/ble-transport.js";

describe("MockBLETransport", () => {
  it("two transports discover each other", async () => {
    const network = new Map<string, MockBLETransport>();
    const a = new MockBLETransport("agent-a", network);
    const b = new MockBLETransport("agent-b", network);
    a.startAdvertising({ agentId: "agent-a", model: "qwen2.5-coder:1.5b", modelParamSize: 1.5, memoryMB: 4096, batteryPct: 100, currentLoad: 0, deviceType: "laptop" });
    b.startAdvertising({ agentId: "agent-b", model: "qwen2.5-coder:7b", modelParamSize: 7, memoryMB: 8192, batteryPct: 80, currentLoad: 0, deviceType: "workstation" });
    a.startScanning();
    const peers = a.discoveredPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0].agentId).toBe("agent-b");
  });

  it("sends task request and receives response", async () => {
    const network = new Map<string, MockBLETransport>();
    const a = new MockBLETransport("agent-a", network);
    const b = new MockBLETransport("agent-b", network);
    a.startAdvertising({ agentId: "agent-a", model: "small", modelParamSize: 0.5, memoryMB: 2048, batteryPct: 100, currentLoad: 0, deviceType: "phone" });
    b.startAdvertising({ agentId: "agent-b", model: "big", modelParamSize: 7, memoryMB: 8192, batteryPct: 90, currentLoad: 0, deviceType: "laptop" });

    b.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "agent-b",
      status: "completed" as const,
      generatedCode: "print('hello')",
      output: "hello",
      cpuSeconds: 0.5,
      providerSignature: "sig-b"
    }));

    const response = await a.sendTaskRequest("agent-b", {
      requestId: "req-1",
      requesterId: "agent-a",
      task: "print hello",
      language: "python" as const,
      requesterSignature: "sig-a"
    });

    expect(response.status).toBe("completed");
    expect(response.generatedCode).toBe("print('hello')");
  });

  it("propagates meshTokenHash from advertisement to discovered peer", () => {
    const network = new Map<string, MockBLETransport>();
    const a = new MockBLETransport("agent-a", network);
    const b = new MockBLETransport("agent-b", network);
    b.startAdvertising({ agentId: "agent-b", model: "qwen", modelParamSize: 7, memoryMB: 8192, batteryPct: 100, currentLoad: 0, deviceType: "laptop", meshTokenHash: "deadbeef" });
    a.startScanning();
    const peers = a.discoveredPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0].meshTokenHash).toBe("deadbeef");
  });

  it("defaults meshTokenHash to empty string when not advertised", () => {
    const network = new Map<string, MockBLETransport>();
    const a = new MockBLETransport("agent-a", network);
    const b = new MockBLETransport("agent-b", network);
    b.startAdvertising({ agentId: "agent-b", model: "qwen", modelParamSize: 7, memoryMB: 8192, batteryPct: 100, currentLoad: 0, deviceType: "laptop" });
    a.startScanning();
    const peers = a.discoveredPeers();
    expect(peers[0].meshTokenHash).toBe("");
  });

  it("returns failed response when peer has no handler", async () => {
    const network = new Map<string, MockBLETransport>();
    const a = new MockBLETransport("agent-a", network);
    const b = new MockBLETransport("agent-b", network);
    b.startAdvertising({ agentId: "agent-b", model: "big", modelParamSize: 7, memoryMB: 8192, batteryPct: 90, currentLoad: 0, deviceType: "laptop" });

    const response = await a.sendTaskRequest("agent-b", {
      requestId: "req-2",
      requesterId: "agent-a",
      task: "test",
      language: "python" as const,
      requesterSignature: "sig-a"
    });
    expect(response.status).toBe("failed");
  });
});
