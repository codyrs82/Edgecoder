import { describe, it, expect } from "vitest";
import { InteractiveAgent } from "../../../src/agent/interactive.js";
import { EdgeCoderLocalProvider } from "../../../src/model/providers.js";
import { BLEMeshManager } from "../../../src/mesh/ble/ble-mesh-manager.js";
import { MockBLETransport } from "../../../src/mesh/ble/ble-transport.js";

describe("Agent BLE integration", () => {
  it("agent accepts optional bleMeshManager", () => {
    const provider = new EdgeCoderLocalProvider();
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("agent-a", network);
    const bleMesh = new BLEMeshManager("agent-a", "account-a", transport);
    const agent = new InteractiveAgent(provider, { bleMeshManager: bleMesh });
    expect(agent).toBeDefined();
  });
});
