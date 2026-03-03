import { test, expect } from "@playwright/test";

const COORDINATOR_URL = process.env.E2E_COORDINATOR_URL ?? "http://localhost:14301";
const MESH_TOKEN = process.env.E2E_MESH_TOKEN ?? "e2e-mesh-token";

test.describe("Coordinator Status", () => {
  test("coordinator /status endpoint is reachable", async () => {
    const res = await fetch(`${COORDINATOR_URL}/status`, {
      headers: { "x-mesh-token": MESH_TOKEN },
    });
    expect(res.ok).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty("queued");
    expect(body).toHaveProperty("agents");
  });

  test("coordinator reports queue state", async () => {
    const res = await fetch(`${COORDINATOR_URL}/status`, {
      headers: { "x-mesh-token": MESH_TOKEN },
    });
    expect(res.ok).toBeTruthy();
    const body = await res.json();
    expect(typeof body.queued).toBe("number");
    expect(typeof body.agents).toBe("number");
  });
});
