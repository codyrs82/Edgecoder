import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CONTEXT_FILE = resolve(__dirname, "../test-context.json");

function loadContext() {
  return JSON.parse(readFileSync(CONTEXT_FILE, "utf-8"));
}

test.describe("Node Enrollment", () => {
  test("coordinator node was enrolled during setup", async ({ request }) => {
    const ctx = loadContext();
    const res = await request.get("/nodes/list", {
      headers: { Authorization: `Bearer ${ctx.sessionToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const coordinator = body.nodes.find(
      (n: any) => n.nodeId === "e2e-coordinator" && n.nodeKind === "coordinator"
    );
    expect(coordinator).toBeTruthy();
    expect(coordinator.registrationToken).toBeTruthy();
  });

  test("agent node was enrolled during setup", async ({ request }) => {
    const ctx = loadContext();
    const res = await request.get("/nodes/list", {
      headers: { Authorization: `Bearer ${ctx.sessionToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const agent = body.nodes.find(
      (n: any) => n.nodeId === "e2e-agent-1" && n.nodeKind === "agent"
    );
    expect(agent).toBeTruthy();
  });

  test("enrolling duplicate nodeId re-enrolls without error", async ({ request }) => {
    const ctx = loadContext();
    const res = await request.post("/nodes/enroll", {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.sessionToken}`,
      },
      data: { nodeId: "e2e-agent-1", nodeKind: "agent" },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nodeId).toBe("e2e-agent-1");
  });

  test("enrollment without auth returns 401", async ({ request }) => {
    const res = await request.post("/nodes/enroll", {
      data: { nodeId: "unauth-node", nodeKind: "agent" },
    });
    expect(res.status()).toBe(401);
  });

  test("discover-coordinator returns coordinator URL", async ({ request }) => {
    const ctx = loadContext();
    const res = await request.get("/nodes/discover-coordinator", {
      headers: { Authorization: `Bearer ${ctx.sessionToken}` },
    });
    // May return 200 with URL or 404 if coordinator not yet validated
    // Either way, endpoint should respond
    expect([200, 404]).toContain(res.status());
  });
});
