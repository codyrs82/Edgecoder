import { describe, expect, test, beforeAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { RolloutPolicy, AgentRolloutState, RolloutStage, AgentRolloutStatus } from "../../src/common/types.js";

// ---------------------------------------------------------------------------
// In-memory mock stores for rollout data
// ---------------------------------------------------------------------------
const rolloutPolicies = new Map<string, RolloutPolicy>();
const agentRolloutStates = new Map<string, AgentRolloutState[]>();

function resetStores() {
  rolloutPolicies.clear();
  agentRolloutStates.clear();
}

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock("undici", () => ({
  request: vi.fn(),
}));

vi.mock("../../src/db/store.js", () => ({
  pgStore: {
    migrate: vi.fn(async () => {}),

    upsertRolloutPolicy: vi.fn(async (policy: RolloutPolicy) => {
      rolloutPolicies.set(policy.rolloutId, { ...policy });
    }),

    getRolloutPolicy: vi.fn(async (rolloutId: string) => {
      return rolloutPolicies.get(rolloutId) ?? null;
    }),

    listRolloutPolicies: vi.fn(async (_limit = 100) => {
      return [...rolloutPolicies.values()].sort(
        (a, b) => b.updatedAtMs - a.updatedAtMs
      );
    }),

    updateRolloutStage: vi.fn(async (rolloutId: string, stage: RolloutStage) => {
      const p = rolloutPolicies.get(rolloutId);
      if (p) {
        p.stage = stage;
        p.updatedAtMs = Date.now();
        rolloutPolicies.set(rolloutId, p);
      }
    }),

    upsertAgentRolloutState: vi.fn(async (state: AgentRolloutState) => {
      const list = agentRolloutStates.get(state.rolloutId) ?? [];
      const idx = list.findIndex((s) => s.agentId === state.agentId);
      if (idx >= 0) {
        list[idx] = { ...state };
      } else {
        list.push({ ...state });
      }
      agentRolloutStates.set(state.rolloutId, list);
    }),

    listAgentRolloutStates: vi.fn(async (rolloutId: string) => {
      return agentRolloutStates.get(rolloutId) ?? [];
    }),

    // stubs for other pgStore methods that may be called
    listOllamaRollouts: vi.fn(async () => []),
    upsertOllamaRollout: vi.fn(async () => {}),
    upsertAgent: vi.fn(async () => {}),
    getAgentOwnership: vi.fn(async () => null),
    creditBalance: vi.fn(async () => 0),
    creditHistory: vi.fn(async () => []),
    upsertCreditAccount: vi.fn(async () => {}),
    upsertAccountMembership: vi.fn(async () => {}),
    linkAgentOwnership: vi.fn(async () => ({})),
    listAgentOwnershipByAccount: vi.fn(async () => []),
    listAccountsByUser: vi.fn(async () => []),
    upsertWalletAccount: vi.fn(async () => {}),
    getWalletAccount: vi.fn(async () => null),
    listPaymentIntentsByAccount: vi.fn(async () => []),
  },
}));

vi.mock("../../src/credits/store.js", () => {
  return {
    creditEngine: {
      balance: () => 0,
      history: () => [],
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

vi.mock("../../src/model/ollama-installer.js", () => ({
  ensureOllamaModelInstalled: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Env vars
// ---------------------------------------------------------------------------
const ADMIN_TOKEN = "test-admin-token-secret";
const MESH_TOKEN = "test-mesh-token";
const PORTAL_TOKEN = "test-portal-service-token";

process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
process.env.COORDINATOR_MESH_TOKEN = MESH_TOKEN;
process.env.COORDINATOR_URL = "http://127.0.0.1:4301";
process.env.PORTAL_SERVICE_TOKEN = PORTAL_TOKEN;
delete process.env.ALLOWED_ADMIN_IPS;
delete process.env.ALLOWED_UI_IPS;
delete process.env.PORTAL_SERVICE_URL;

// ---------------------------------------------------------------------------
// Import the Fastify app
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
    ...extra,
  };
}

function adminJsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-admin-token": ADMIN_TOKEN,
    "content-type": "application/json",
    ...extra,
  };
}

/** Pre-register some agents so the rollout has targets. */
async function registerAgents(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const agentId = `agent-rollout-${i}`;
    ids.push(agentId);
    await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminJsonHeaders(),
      payload: {
        agentId,
        os: "macos",
        version: "1.0.0",
        mode: "swarm-only",
      },
    });
  }
  return ids;
}

async function createRollout(overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/rollouts",
    headers: adminJsonHeaders(),
    payload: {
      modelId: "deepseek-coder:6.7b",
      targetProvider: "ollama-local",
      canaryPercent: 20,
      batchSize: 3,
      ...overrides,
    },
  });
  return { res, body: res.json() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Staged Rollout Endpoints", () => {
  beforeEach(() => {
    resetStores();
  });

  // 1. Create rollout starts in canary stage
  test("POST /rollouts creates a rollout in canary stage", async () => {
    await registerAgents(10);

    const { res, body } = await createRollout();

    expect(res.statusCode).toBe(201);
    expect(body.stage).toBe("canary");
    expect(body.modelId).toBe("deepseek-coder:6.7b");
    expect(body.targetProvider).toBe("ollama-local");
    expect(body.canaryPercent).toBe(20);
    expect(body.rolloutId).toMatch(/^rollout-/);
    // 20% of 10 agents = 2 canary agents
    expect(body.canaryAgents).toHaveLength(2);
  });

  // 2. Promote from canary to batch
  test("POST /rollouts/:rolloutId/promote goes canary -> batch", async () => {
    await registerAgents(10);
    const { body: created } = await createRollout();
    const rolloutId = created.rolloutId;

    // Mark canary agents as healthy so health check passes
    const states = await (await import("../../src/db/store.js")).pgStore!.listAgentRolloutStates(rolloutId);
    for (const state of states) {
      await (await import("../../src/db/store.js")).pgStore!.upsertAgentRolloutState({
        ...state,
        status: "healthy" as AgentRolloutStatus,
      });
    }

    const promoteRes = await app.inject({
      method: "POST",
      url: `/rollouts/${rolloutId}/promote`,
      headers: adminHeaders(),
    });

    expect(promoteRes.statusCode).toBe(200);
    const promoteBody = promoteRes.json();
    expect(promoteBody.stage).toBe("batch");
    expect(promoteBody.previousStage).toBe("canary");
  });

  // 3. Promote from batch to full
  test("POST /rollouts/:rolloutId/promote goes batch -> full", async () => {
    await registerAgents(10);
    const { body: created } = await createRollout();
    const rolloutId = created.rolloutId;

    // Mark canary agents healthy
    let states = await (await import("../../src/db/store.js")).pgStore!.listAgentRolloutStates(rolloutId);
    for (const state of states) {
      await (await import("../../src/db/store.js")).pgStore!.upsertAgentRolloutState({
        ...state,
        status: "healthy" as AgentRolloutStatus,
      });
    }

    // Promote canary -> batch
    await app.inject({
      method: "POST",
      url: `/rollouts/${rolloutId}/promote`,
      headers: adminHeaders(),
    });

    // Mark batch agents healthy
    states = await (await import("../../src/db/store.js")).pgStore!.listAgentRolloutStates(rolloutId);
    for (const state of states) {
      await (await import("../../src/db/store.js")).pgStore!.upsertAgentRolloutState({
        ...state,
        status: "healthy" as AgentRolloutStatus,
      });
    }

    // Promote batch -> full
    const promoteRes = await app.inject({
      method: "POST",
      url: `/rollouts/${rolloutId}/promote`,
      headers: adminHeaders(),
    });

    expect(promoteRes.statusCode).toBe(200);
    const promoteBody = promoteRes.json();
    expect(promoteBody.stage).toBe("full");
    expect(promoteBody.previousStage).toBe("batch");
  });

  // 4. Rollback sets stage correctly
  test("POST /rollouts/:rolloutId/rollback sets stage to rolled_back", async () => {
    await registerAgents(5);
    const { body: created } = await createRollout({ canaryPercent: 40 });
    const rolloutId = created.rolloutId;

    const rollbackRes = await app.inject({
      method: "POST",
      url: `/rollouts/${rolloutId}/rollback`,
      headers: adminHeaders(),
    });

    expect(rollbackRes.statusCode).toBe(200);
    const rollbackBody = rollbackRes.json();
    expect(rollbackBody.stage).toBe("rolled_back");
    expect(Array.isArray(rollbackBody.rolledBackAgents)).toBe(true);
  });

  // 5. Cannot promote from rolled_back
  test("cannot promote from rolled_back stage", async () => {
    await registerAgents(5);
    const { body: created } = await createRollout({ canaryPercent: 40 });
    const rolloutId = created.rolloutId;

    // Rollback first
    await app.inject({
      method: "POST",
      url: `/rollouts/${rolloutId}/rollback`,
      headers: adminHeaders(),
    });

    // Try to promote
    const promoteRes = await app.inject({
      method: "POST",
      url: `/rollouts/${rolloutId}/promote`,
      headers: adminHeaders(),
    });

    expect(promoteRes.statusCode).toBe(400);
    expect(promoteRes.json().error).toBe("cannot_promote_rolled_back");
  });

  // 6. Health check gate prevents promotion when failures exceed threshold
  test("health check gate prevents promotion when too many failures", async () => {
    await registerAgents(10);
    const { body: created } = await createRollout({
      canaryPercent: 50,
      rollbackOnFailurePercent: 30,
    });
    const rolloutId = created.rolloutId;

    // Mark all canary agents as failed (100% failure > 30% threshold)
    const states = await (await import("../../src/db/store.js")).pgStore!.listAgentRolloutStates(rolloutId);
    for (const state of states) {
      await (await import("../../src/db/store.js")).pgStore!.upsertAgentRolloutState({
        ...state,
        status: "failed" as AgentRolloutStatus,
        error: "model_load_failure",
      });
    }

    const promoteRes = await app.inject({
      method: "POST",
      url: `/rollouts/${rolloutId}/promote`,
      headers: adminHeaders(),
    });

    expect(promoteRes.statusCode).toBe(400);
    const body = promoteRes.json();
    expect(body.error).toBe("health_check_failed");
    expect(body.failurePercent).toBe(100);
    expect(body.threshold).toBe(30);
  });

  // 7. List rollouts returns all with correct stages
  test("GET /rollouts lists all rollouts with correct stages", async () => {
    await registerAgents(10);

    // Create two rollouts
    const { body: r1 } = await createRollout({ modelId: "model-a" });
    const { body: r2 } = await createRollout({ modelId: "model-b" });

    // Rollback the second
    await app.inject({
      method: "POST",
      url: `/rollouts/${r2.rolloutId}/rollback`,
      headers: adminHeaders(),
    });

    const listRes = await app.inject({
      method: "GET",
      url: "/rollouts",
      headers: adminHeaders(),
    });

    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    expect(listBody.rollouts).toHaveLength(2);

    const stages = listBody.rollouts.map((r: any) => r.stage);
    expect(stages).toContain("canary");
    expect(stages).toContain("rolled_back");

    // Each rollout should have progressPercent and agentCount
    for (const r of listBody.rollouts) {
      expect(typeof r.progressPercent).toBe("number");
      expect(typeof r.agentCount).toBe("number");
    }
  });

  // 8. GET /rollouts/:rolloutId returns details with agent states
  test("GET /rollouts/:rolloutId returns rollout with agent states", async () => {
    await registerAgents(5);
    const { body: created } = await createRollout({ canaryPercent: 40 });

    const getRes = await app.inject({
      method: "GET",
      url: `/rollouts/${created.rolloutId}`,
      headers: adminHeaders(),
    });

    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();
    expect(body.rolloutId).toBe(created.rolloutId);
    expect(body.stage).toBe("canary");
    expect(Array.isArray(body.agentStates)).toBe(true);
    expect(body.agentStates.length).toBeGreaterThan(0);
  });

  // 9. Agent status reporting endpoint
  test("POST /rollouts/:rolloutId/agents/:agentId/status updates agent state", async () => {
    const agentIds = await registerAgents(5);
    const { body: created } = await createRollout({ canaryPercent: 40 });

    const targetAgent = agentIds[0];
    const statusRes = await app.inject({
      method: "POST",
      url: `/rollouts/${created.rolloutId}/agents/${targetAgent}/status`,
      headers: adminJsonHeaders(),
      payload: {
        status: "healthy",
        modelVersion: "deepseek-coder:6.7b",
      },
    });

    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().ok).toBe(true);
  });

  // 10. Cannot promote when already fully rolled out
  test("cannot promote from full stage", async () => {
    await registerAgents(5);
    const { body: created } = await createRollout({ canaryPercent: 100 });
    const rolloutId = created.rolloutId;

    // Mark all healthy and promote twice to reach full
    const markHealthyAndPromote = async () => {
      const states = await (await import("../../src/db/store.js")).pgStore!.listAgentRolloutStates(rolloutId);
      for (const state of states) {
        await (await import("../../src/db/store.js")).pgStore!.upsertAgentRolloutState({
          ...state,
          status: "healthy" as AgentRolloutStatus,
        });
      }
      return app.inject({
        method: "POST",
        url: `/rollouts/${rolloutId}/promote`,
        headers: adminHeaders(),
      });
    };

    await markHealthyAndPromote(); // canary -> batch
    await markHealthyAndPromote(); // batch -> full

    // Try to promote again
    const res = await markHealthyAndPromote();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("already_fully_rolled_out");
  });

  // 11. 404 for nonexistent rollout
  test("returns 404 for nonexistent rollout", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rollouts/nonexistent-id",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("rollout_not_found");
  });

  // 12. Requires admin auth
  test("rollout endpoints require admin auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rollouts",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(401);
  });
});
