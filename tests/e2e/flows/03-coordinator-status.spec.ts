import { test, expect } from "@playwright/test";

const COORDINATOR_URL = process.env.E2E_COORDINATOR_URL ?? "http://localhost:4301";

test.describe("Coordinator Status", () => {
  test("coordinator /status endpoint is reachable", async () => {
    const res = await fetch(`${COORDINATOR_URL}/status`);
    expect(res.ok).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty("status");
  });

  test("coordinator reports its configuration", async () => {
    const res = await fetch(`${COORDINATOR_URL}/status`);
    const body = await res.json();
    // Coordinator should report it's running
    expect(body.status).toBeTruthy();
  });
});
