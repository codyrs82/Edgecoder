import { describe, expect, test, beforeAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// Module-level mocks -- must be hoisted before the module-under-test is loaded
// ---------------------------------------------------------------------------

// Mock undici so no real HTTP calls are made
vi.mock("undici", () => ({
  request: vi.fn(),
}));

// Mock pgStore as null (no postgres in test)
vi.mock("../../src/db/store.js", () => ({
  pgStore: null,
}));

// Mock credit engine and adjustCredits
vi.mock("../../src/credits/store.js", () => {
  const balances = new Map<string, number>();
  const histories = new Map<string, Array<any>>();
  return {
    creditEngine: {
      balance: (id: string) => balances.get(id) ?? 0,
      history: (id: string) => histories.get(id) ?? [],
    },
    adjustCredits: vi.fn(async (accountId: string, credits: number, reason: string) => ({
      txId: "mock-tx-id",
      accountId,
      type: credits >= 0 ? "earn" : "spend",
      credits: Math.abs(credits),
      reason,
      timestampMs: Date.now(),
    })),
  };
});

// Mock ollama installer
vi.mock("../../src/model/ollama-installer.js", () => ({
  ensureOllamaModelInstalled: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Env vars for the control-plane module's auth system
// ---------------------------------------------------------------------------
const ADMIN_TOKEN = "test-admin-token-secret";
const MESH_TOKEN = "test-mesh-token";
const PORTAL_TOKEN = "test-portal-service-token";

// Set env vars BEFORE module import so module-level consts capture them
process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
process.env.COORDINATOR_MESH_TOKEN = MESH_TOKEN;
process.env.COORDINATOR_URL = "http://127.0.0.1:4301";
process.env.PORTAL_SERVICE_TOKEN = PORTAL_TOKEN;
delete process.env.ALLOWED_ADMIN_IPS;
delete process.env.ALLOWED_UI_IPS;
delete process.env.PORTAL_SERVICE_URL;

// ---------------------------------------------------------------------------
// Import the Fastify app after mocks + env are configured
// ---------------------------------------------------------------------------
let app: FastifyInstance;

beforeAll(async () => {
  const mod = await import("../../src/control-plane/server.js");
  app = mod.controlPlaneServer;
  await app.ready();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-admin-token": ADMIN_TOKEN,
    "content-type": "application/json",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Dashboard HTML endpoint
// ---------------------------------------------------------------------------

describe("GET /admin/dashboard -- dashboard HTML", () => {
  test("returns 200 with HTML content when admin token is provided", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<!doctype html>");
    expect(res.body).toContain("EdgeCoder Admin Dashboard");
  });

  test("returns 401 without admin token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: {},
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe("admin_token_required");
  });

  test("HTML contains expected sections", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    // Overview section
    expect(res.body).toContain("Total Agents");
    expect(res.body).toContain("Tasks");
    expect(res.body).toContain("Network Mode");
    expect(res.body).toContain("System Uptime");
    // Agent table
    expect(res.body).toContain("Agent ID");
    expect(res.body).toContain("agent-table");
    // Rollout section
    expect(res.body).toContain("Rollout Status");
    // Credit section
    expect(res.body).toContain("Credit Economy");
    // Escalation section
    expect(res.body).toContain("Human Escalations");
    // Auto-refresh
    expect(res.body).toContain("setInterval(refresh, 10000)");
  });
});

// ---------------------------------------------------------------------------
// Dashboard data JSON endpoint
// ---------------------------------------------------------------------------

describe("GET /admin/api/dashboard-data -- dashboard data", () => {
  test("returns 401 without admin token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/api/dashboard-data",
      headers: {},
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe("admin_token_required");
  });

  test("returns valid JSON structure with correct keys", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/api/dashboard-data",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("generatedAt");
    expect(body).toHaveProperty("uptimeSeconds");
    expect(body).toHaveProperty("agents");
    expect(body).toHaveProperty("tasks");
    expect(body).toHaveProperty("rollouts");
    expect(body).toHaveProperty("network");
    expect(body).toHaveProperty("credits");
    expect(body).toHaveProperty("escalations");
  });

  test("agent summary includes correct counts in empty state", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/api/dashboard-data",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // In empty state or with some agents from other test suites,
    // the counts should be non-negative numbers
    expect(typeof body.agents.total).toBe("number");
    expect(typeof body.agents.online).toBe("number");
    expect(typeof body.agents.offline).toBe("number");
    expect(body.agents.total).toBeGreaterThanOrEqual(0);
    expect(body.agents.online + body.agents.offline).toBe(body.agents.total);
    expect(body.agents).toHaveProperty("byOs");
    expect(body.agents).toHaveProperty("localModelEnabled");
    expect(body.agents).toHaveProperty("list");
    expect(Array.isArray(body.agents.list)).toBe(true);
  });

  test("dashboard data aggregation handles empty state for all sections", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/api/dashboard-data",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Tasks should have numeric values
    expect(typeof body.tasks.active).toBe("number");
    expect(typeof body.tasks.queued).toBe("number");

    // Rollouts should be an array (empty when no pgStore)
    expect(Array.isArray(body.rollouts)).toBe(true);

    // Network should have mode and counts
    expect(typeof body.network.mode).toBe("string");
    expect(typeof body.network.coordinatorCount).toBe("number");
    expect(typeof body.network.peerCount).toBe("number");

    // Credits should have numeric values
    expect(typeof body.credits.totalCreditsIssued).toBe("number");
    expect(typeof body.credits.activeAccounts).toBe("number");
    expect(typeof body.credits.recentTransactions).toBe("number");

    // Escalations should have numeric values
    expect(typeof body.escalations.pending).toBe("number");
    expect(typeof body.escalations.resolvedToday).toBe("number");
    expect(typeof body.escalations.avgResolutionMs).toBe("number");
  });

  test("agent summary reflects registered agents", async () => {
    // Register a test agent first
    const upsertRes = await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload: {
        agentId: "dashboard-test-agent",
        os: "macos",
        version: "1.0.0",
        mode: "swarm-only",
      },
    });
    expect(upsertRes.statusCode).toBe(200);

    // Now check dashboard data
    const res = await app.inject({
      method: "GET",
      url: "/admin/api/dashboard-data",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents.total).toBeGreaterThanOrEqual(1);
    expect(body.agents.online).toBeGreaterThanOrEqual(1);

    // Check agent list contains our agent
    const found = body.agents.list.find((a: any) => a.agentId === "dashboard-test-agent");
    expect(found).toBeDefined();
    expect(found.os).toBe("macos");
    expect(found.version).toBe("1.0.0");
    expect(found.health).toBe("healthy");
  });

  test("generatedAt and uptimeSeconds are sensible values", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/api/dashboard-data",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.generatedAt).toBeGreaterThan(0);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
