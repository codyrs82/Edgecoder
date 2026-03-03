import { test, expect } from "@playwright/test";

const COORDINATOR_URL = process.env.E2E_COORDINATOR_URL ?? "http://localhost:4301";

test.describe("Agent Registration", () => {
  test("agent container is running and connected to coordinator", async () => {
    // Give the agent time to register (it may still be starting up)
    let agentFound = false;
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${COORDINATOR_URL}/status`);
        if (res.ok) {
          const body = await res.json();
          // Check if any agents are registered
          if (body.agents?.length > 0 || body.connectedAgents > 0 || body.workerCount > 0) {
            agentFound = true;
            break;
          }
        }
      } catch {
        // coordinator not ready
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }

    expect(agentFound).toBe(true);
  });
});
