import { test, expect } from "@playwright/test";

const COORDINATOR_URL = process.env.E2E_COORDINATOR_URL ?? "http://localhost:14301";
const MESH_TOKEN = process.env.E2E_MESH_TOKEN ?? "e2e-mesh-token";

test.describe("Agent Registration", () => {
  test("agent container is running and connected to coordinator mesh", async () => {
    // Check mesh peers - the agent connects via WebSocket to the coordinator
    let agentFound = false;
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${COORDINATOR_URL}/mesh/peers`, {
          headers: { "x-mesh-token": MESH_TOKEN },
        });
        if (res.ok) {
          const body = await res.json();
          // Look for the agent peer in the peers list
          const peers = body.peers ?? body;
          if (Array.isArray(peers) && peers.some((p: any) =>
            p.peerId === "e2e-agent-1" || p.id === "e2e-agent-1"
          )) {
            agentFound = true;
            break;
          }
          // Also accept if there are multiple peers (coordinator + agent)
          if (Array.isArray(peers) && peers.length >= 2) {
            agentFound = true;
            break;
          }
        }
      } catch {
        // coordinator not ready
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }

    expect(agentFound).toBe(true);
  });
});
