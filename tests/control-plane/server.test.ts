import { describe, expect, test, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
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

function makeAgentPayload(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-test-001",
    os: "macos",
    version: "1.2.3",
    mode: "swarm-only",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Agent Registration & Upsert
// ---------------------------------------------------------------------------

describe("POST /agents/upsert -- agent registration", () => {
  test("registers a new agent with valid payload", async () => {
    const payload = makeAgentPayload();
    const res = await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentId).toBe("agent-test-001");
    expect(body.os).toBe("macos");
    expect(body.version).toBe("1.2.3");
    expect(body.mode).toBe("swarm-only");
    expect(body.health).toBe("healthy");
    expect(body.localModelEnabled).toBe(false);
    expect(typeof body.lastSeenMs).toBe("number");
  });

  test("upsert updates existing agent version", async () => {
    // First registration
    await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload: makeAgentPayload({ agentId: "agent-upsert-v2" }),
    });
    // Second registration with new version
    const res = await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload: makeAgentPayload({ agentId: "agent-upsert-v2", version: "2.0.0" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe("2.0.0");
  });

  test("registers agents with all valid OS types", async () => {
    const osTypes = ["debian", "ubuntu", "windows", "macos", "ios"] as const;
    for (const os of osTypes) {
      const res = await app.inject({
        method: "POST",
        url: "/agents/upsert",
        headers: adminHeaders(),
        payload: makeAgentPayload({ agentId: `agent-os-${os}`, os }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().os).toBe(os);
    }
  });

  test("rejects registration with invalid OS", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload: makeAgentPayload({ os: "android" }),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  test("rejects registration with missing agentId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload: { os: "macos", version: "1.0.0", mode: "swarm-only" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  test("rejects registration with missing version", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload: { agentId: "a1", os: "macos", mode: "swarm-only" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  test("rejects registration with invalid mode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload: makeAgentPayload({ mode: "unknown-mode" }),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// GET /agents -- agent listing
// ---------------------------------------------------------------------------

describe("GET /agents -- list agents", () => {
  beforeEach(async () => {
    // Seed an agent for listing
    await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload: makeAgentPayload({ agentId: "agent-list-1" }),
    });
  });

  test("returns agents list with health status", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents).toBeDefined();
    expect(Array.isArray(body.agents)).toBe(true);
    const found = body.agents.find((a: any) => a.agentId === "agent-list-1");
    expect(found).toBeDefined();
    expect(found.health).toBe("healthy");
  });

  test("requires admin authentication", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /agents/:agentId/mode -- mode management
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/mode -- mode toggle", () => {
  const AGENT_ID = "agent-mode-test";

  beforeEach(async () => {
    await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload: makeAgentPayload({ agentId: AGENT_ID, mode: "swarm-only" }),
    });
  });

  test("toggles mode from swarm-only to ide-enabled", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/mode`,
      headers: adminHeaders(),
      payload: { mode: "ide-enabled" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe("ide-enabled");
    expect(body.agentId).toBe(AGENT_ID);
  });

  test("toggles mode from ide-enabled back to swarm-only", async () => {
    // First set to ide-enabled
    await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/mode`,
      headers: adminHeaders(),
      payload: { mode: "ide-enabled" },
    });
    // Then back to swarm-only
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/mode`,
      headers: adminHeaders(),
      payload: { mode: "swarm-only" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe("swarm-only");
  });

  test("returns 404 for unknown agent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/nonexistent-agent/mode",
      headers: adminHeaders(),
      payload: { mode: "ide-enabled" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("agent_not_found");
  });

  test("rejects invalid mode value", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/mode`,
      headers: adminHeaders(),
      payload: { mode: "invalid-mode" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  test("updates lastSeenMs on mode change", async () => {
    const before = Date.now();
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/mode`,
      headers: adminHeaders(),
      payload: { mode: "ide-enabled" },
    });
    const after = Date.now();
    const body = res.json();
    expect(body.lastSeenMs).toBeGreaterThanOrEqual(before);
    expect(body.lastSeenMs).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// POST /agents/:agentId/local-model -- local model & manifest management
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/local-model -- model manifest rollout", () => {
  const AGENT_ID = "agent-manifest-test";

  const validManifest = {
    modelId: "qwen2.5-coder-7b",
    sourceUrl: "https://models.edgecoder.local/qwen2.5-coder-7b.gguf",
    checksumSha256: "a".repeat(64),
    signature: "valid-signature-at-least-16-chars",
    provider: "edgecoder-local",
  };

  beforeEach(async () => {
    await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload: makeAgentPayload({ agentId: AGENT_ID }),
    });
  });

  test("enables local model with valid manifest", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/local-model`,
      headers: adminHeaders(),
      payload: { enabled: true, manifest: validManifest },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent.localModelEnabled).toBe(true);
    expect(body.manifest).toEqual(validManifest);
  });

  test("enables local model with ollama-local provider", async () => {
    const ollamaManifest = {
      ...validManifest,
      provider: "ollama-local",
    };
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/local-model`,
      headers: adminHeaders(),
      payload: { enabled: true, manifest: ollamaManifest },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().manifest.provider).toBe("ollama-local");
  });

  test("disables local model and removes manifest", async () => {
    // First enable
    await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/local-model`,
      headers: adminHeaders(),
      payload: { enabled: true, manifest: validManifest },
    });
    // Then disable
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/local-model`,
      headers: adminHeaders(),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent.localModelEnabled).toBe(false);
    expect(body.manifest).toBeNull();
  });

  test("rejects manifest with disallowed source URL", async () => {
    const badManifest = {
      ...validManifest,
      sourceUrl: "https://evil.com/model.bin",
    };
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/local-model`,
      headers: adminHeaders(),
      payload: { enabled: true, manifest: badManifest },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("source_not_allowed");
  });

  test("rejects manifest with invalid checksum", async () => {
    const badManifest = {
      ...validManifest,
      checksumSha256: "not-hex",
    };
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/local-model`,
      headers: adminHeaders(),
      payload: { enabled: true, manifest: badManifest },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_checksum_format");
  });

  test("rejects manifest with too-short signature", async () => {
    const badManifest = {
      ...validManifest,
      signature: "short",
    };
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/local-model`,
      headers: adminHeaders(),
      payload: { enabled: true, manifest: badManifest },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_signature");
  });

  test("returns 404 for unknown agent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/nonexistent-agent/local-model",
      headers: adminHeaders(),
      payload: { enabled: true, manifest: validManifest },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("agent_not_found");
  });

  test("enabling without manifest keeps manifest null", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/local-model`,
      headers: adminHeaders(),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.localModelEnabled).toBe(true);
    expect(res.json().manifest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /agents/:agentId/manifest -- manifest retrieval
// ---------------------------------------------------------------------------

describe("GET /agents/:agentId/manifest", () => {
  const AGENT_ID = "agent-manifest-read";

  const validManifest = {
    modelId: "qwen2.5-coder-7b",
    sourceUrl: "https://models.edgecoder.local/qwen2.5-coder-7b.gguf",
    checksumSha256: "b".repeat(64),
    signature: "another-valid-signature-16ch",
    provider: "edgecoder-local",
  };

  beforeAll(async () => {
    await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload: makeAgentPayload({ agentId: AGENT_ID }),
    });
    await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/local-model`,
      headers: adminHeaders(),
      payload: { enabled: true, manifest: validManifest },
    });
  });

  test("returns stored manifest for agent", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/manifest`,
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().modelId).toBe(validManifest.modelId);
    expect(res.json().sourceUrl).toBe(validManifest.sourceUrl);
  });

  test("returns 404 for agent with no manifest", async () => {
    // Register agent without manifest
    await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload: makeAgentPayload({ agentId: "agent-no-manifest" }),
    });
    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-no-manifest/manifest",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("manifest_not_found");
  });
});

// ---------------------------------------------------------------------------
// Network Mode Management
// ---------------------------------------------------------------------------

describe("GET /network/mode -- read network mode", () => {
  test("returns current network mode", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/network/mode",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(["public_mesh", "enterprise_overlay"]).toContain(body.networkMode);
  });

  test("requires admin auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/network/mode",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /network/mode -- toggle network mode", () => {
  test("switches to enterprise_overlay", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/network/mode",
      headers: adminHeaders(),
      payload: { networkMode: "enterprise_overlay" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().networkMode).toBe("enterprise_overlay");
  });

  test("switches back to public_mesh", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/network/mode",
      headers: adminHeaders(),
      payload: { networkMode: "public_mesh" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().networkMode).toBe("public_mesh");
  });

  test("rejects invalid network mode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/network/mode",
      headers: adminHeaders(),
      payload: { networkMode: "invalid_mode" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  test("persists mode across reads", async () => {
    await app.inject({
      method: "POST",
      url: "/network/mode",
      headers: adminHeaders(),
      payload: { networkMode: "enterprise_overlay" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/network/mode",
      headers: adminHeaders(),
    });
    expect(res.json().networkMode).toBe("enterprise_overlay");
    // Reset to default
    await app.inject({
      method: "POST",
      url: "/network/mode",
      headers: adminHeaders(),
      payload: { networkMode: "public_mesh" },
    });
  });
});

// ---------------------------------------------------------------------------
// Admin API Authentication -- token-based
// ---------------------------------------------------------------------------

describe("Admin API authentication -- token", () => {
  test("correct token via x-admin-token header succeeds", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(res.statusCode).toBe(200);
  });

  test("correct token via Authorization Bearer header succeeds", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  test("missing token returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agents",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("admin_token_required");
  });

  test("wrong token returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: { "x-admin-token": "wrong-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("admin_token_required");
  });

  test("empty Bearer token returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: { authorization: "Bearer " },
    });
    expect(res.statusCode).toBe(401);
  });

  test("non-Bearer auth scheme is rejected", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: { authorization: `Basic ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Admin API Authentication -- IP allowlist
// ---------------------------------------------------------------------------

describe("Admin API authentication -- IP allowlist", () => {
  const savedIps = process.env.ALLOWED_ADMIN_IPS;

  beforeEach(() => {
    delete process.env.ALLOWED_ADMIN_IPS;
  });

  afterAll(() => {
    if (savedIps !== undefined) {
      process.env.ALLOWED_ADMIN_IPS = savedIps;
    } else {
      delete process.env.ALLOWED_ADMIN_IPS;
    }
  });

  test("allows request when no IP allowlist is set", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
  });

  test("blocks request from non-allowlisted IP", async () => {
    process.env.ALLOWED_ADMIN_IPS = "10.0.0.1,10.0.0.2";
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: adminHeaders({ "x-forwarded-for": "192.168.1.100" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("admin_ip_forbidden");
  });

  test("allows request from allowlisted IP via x-forwarded-for", async () => {
    process.env.ALLOWED_ADMIN_IPS = "10.0.0.1,10.0.0.2";
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: adminHeaders({ "x-forwarded-for": "10.0.0.1" }),
    });
    expect(res.statusCode).toBe(200);
  });

  test("extracts first IP from multi-value x-forwarded-for", async () => {
    process.env.ALLOWED_ADMIN_IPS = "10.0.0.1";
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: adminHeaders({ "x-forwarded-for": "10.0.0.1, 172.16.0.1" }),
    });
    expect(res.statusCode).toBe(200);
  });

  test("prefers fly-client-ip over x-forwarded-for", async () => {
    process.env.ALLOWED_ADMIN_IPS = "10.0.0.1";
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: adminHeaders({
        "fly-client-ip": "10.0.0.1",
        "x-forwarded-for": "192.168.1.100",
      }),
    });
    expect(res.statusCode).toBe(200);
  });

  test("IP check runs before token check", async () => {
    process.env.ALLOWED_ADMIN_IPS = "10.0.0.1";
    // Send wrong token but also wrong IP
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: {
        "x-admin-token": "wrong-token",
        "x-forwarded-for": "192.168.1.100",
      },
    });
    // Should get 403 (IP) not 401 (token)
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Portal service token bypass
// ---------------------------------------------------------------------------

describe("Admin API authentication -- portal service token", () => {
  test("portal service token bypasses admin auth (no admin token needed)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: { "x-portal-service-token": PORTAL_TOKEN },
    });
    expect(res.statusCode).toBe(200);
  });

  test("wrong portal service token does not bypass auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agents",
      headers: { "x-portal-service-token": "wrong-portal-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  test("portal service token bypasses IP allowlist too", async () => {
    const savedIps = process.env.ALLOWED_ADMIN_IPS;
    process.env.ALLOWED_ADMIN_IPS = "10.0.0.1";
    try {
      const res = await app.inject({
        method: "GET",
        url: "/agents",
        headers: {
          "x-portal-service-token": PORTAL_TOKEN,
          "x-forwarded-for": "192.168.1.100",
        },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      if (savedIps !== undefined) {
        process.env.ALLOWED_ADMIN_IPS = savedIps;
      } else {
        delete process.env.ALLOWED_ADMIN_IPS;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// GET /deployment/plan
// ---------------------------------------------------------------------------

describe("GET /deployment/plan", () => {
  test("returns the deployment plan without admin auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/deployment/plan",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.coordinatorUiHome).toBeDefined();
    expect(body.firstCoordinatorRuntime).toBeDefined();
    expect(body.sqlBackend).toBeDefined();
    expect(body.coordinatorUiHome.service).toBe("control-plane");
  });
});

// ---------------------------------------------------------------------------
// Credits endpoints (in-memory engine, no pgStore)
// ---------------------------------------------------------------------------

describe("Credits endpoints (in-memory)", () => {
  test("GET /credits/:accountId/balance returns zero for unknown account", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/credits/unknown-account/balance",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().balance).toBe(0);
  });

  test("GET /credits/:accountId/history returns empty for unknown account", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/credits/unknown-account/history",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().history).toEqual([]);
  });

  test("POST /credits/:accountId/faucet calls adjustCredits and returns tx", async () => {
    const { adjustCredits } = await import("../../src/credits/store.js");
    const res = await app.inject({
      method: "POST",
      url: "/credits/test-account-1/faucet",
      headers: adminHeaders(),
      payload: { credits: 50 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tx).toBeDefined();
    expect(body.tx.accountId).toBe("test-account-1");
    expect(adjustCredits).toHaveBeenCalled();
  });

  test("POST /credits/:accountId/faucet uses default 100 when credits omitted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credits/default-faucet-acct/faucet",
      headers: adminHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  test("POST /credits/:accountId/faucet rejects negative credits", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credits/negative-acct/faucet",
      headers: adminHeaders(),
      payload: { credits: -10 },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  test("POST /credits/:accountId/faucet rejects credits above 10000", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credits/bigacct/faucet",
      headers: adminHeaders(),
      payload: { credits: 10001 },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// Postgres-dependent endpoints return 503 when pgStore is null
// ---------------------------------------------------------------------------

describe("Postgres-dependent endpoints without pgStore", () => {
  test("POST /credits/accounts returns 503", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credits/accounts",
      headers: adminHeaders(),
      payload: { accountId: "acct-1", displayName: "Test", ownerUserId: "user-1" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("postgres_required");
  });

  test("POST /credits/accounts/:accountId/members returns 503", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credits/accounts/acct-1/members",
      headers: adminHeaders(),
      payload: { userId: "user-2" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("postgres_required");
  });

  test("POST /credits/accounts/:accountId/agents/link returns 503", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credits/accounts/acct-1/agents/link",
      headers: adminHeaders(),
      payload: { agentId: "agent-1", ownerUserId: "user-1" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("postgres_required");
  });

  test("GET /credits/accounts/:accountId/agents returns 503", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/credits/accounts/acct-1/agents",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("postgres_required");
  });

  test("GET /credits/users/:userId/accounts returns 503", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/credits/users/user-1/accounts",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("postgres_required");
  });

  test("POST /economy/wallets/register returns 503", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/economy/wallets/register",
      headers: adminHeaders(),
      payload: { accountId: "acct-1", walletType: "lightning" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("postgres_required");
  });

  test("GET /economy/wallets/:accountId returns 503", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/economy/wallets/acct-1",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("postgres_required");
  });

  test("GET /wallets/:accountId returns 503", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/wallets/acct-1",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("postgres_required");
  });
});

// ---------------------------------------------------------------------------
// Coordinator proxy endpoints -- mocked undici
// ---------------------------------------------------------------------------

describe("Coordinator proxy endpoints with mocked undici", () => {
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const undici = await import("undici");
    mockRequest = undici.request as unknown as ReturnType<typeof vi.fn>;
    mockRequest.mockReset();
  });

  function mockCoordinatorResponse(statusCode: number, body: unknown) {
    mockRequest.mockResolvedValueOnce({
      statusCode,
      body: { json: async () => body },
    });
  }

  test("GET /network/coordinators calls coordinator identity and mesh peers", async () => {
    // Mock identity call
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ peerId: "coord-1", coordinatorUrl: "http://127.0.0.1:4301" }) },
    });
    // Mock peers call
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ peers: [{ peerId: "coord-2", coordinatorUrl: "http://10.0.0.2:4301" }] }) },
    });

    const res = await app.inject({
      method: "GET",
      url: "/network/coordinators",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.coordinators).toBeDefined();
    expect(Array.isArray(body.coordinators)).toBe(true);
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(typeof body.generatedAt).toBe("number");
  });

  test("GET /network/coordinators includes bootstrap when mesh unreachable", async () => {
    // Both calls fail
    mockRequest.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    mockRequest.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "GET",
      url: "/network/coordinators",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Should still have bootstrap
    expect(body.coordinators.length).toBeGreaterThanOrEqual(1);
    const bootstrap = body.coordinators.find((c: any) => c.source === "bootstrap");
    expect(bootstrap).toBeDefined();
  });

  test("GET /mesh/peers returns 502 when coordinator is unreachable", async () => {
    mockRequest.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "GET",
      url: "/mesh/peers",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("coordinator_unreachable");
  });

  test("GET /mesh/peers proxies coordinator response", async () => {
    mockCoordinatorResponse(200, { peers: [{ peerId: "p1" }] });

    const res = await app.inject({
      method: "GET",
      url: "/mesh/peers",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().peers).toHaveLength(1);
  });

  test("GET /health/runtime proxies coordinator response", async () => {
    mockCoordinatorResponse(200, { uptime: 3600, version: "1.0.0" });

    const res = await app.inject({
      method: "GET",
      url: "/health/runtime",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().uptime).toBe(3600);
  });

  test("GET /health/runtime returns 502 when coordinator unreachable", async () => {
    mockRequest.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "GET",
      url: "/health/runtime",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(502);
  });

  test("GET /security/blacklist proxies response", async () => {
    mockCoordinatorResponse(200, { version: 1, records: [] });

    const res = await app.inject({
      method: "GET",
      url: "/security/blacklist",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().records).toEqual([]);
  });

  test("POST /security/blacklist forwards body to coordinator", async () => {
    mockCoordinatorResponse(200, { ok: true });

    const res = await app.inject({
      method: "POST",
      url: "/security/blacklist",
      headers: adminHeaders(),
      payload: {
        agentId: "bad-agent",
        reasonCode: "abuse_spam",
        reason: "Spamming the network",
        evidenceHashSha256: "c".repeat(64),
      },
    });
    expect(res.statusCode).toBe(200);
    // Verify the coordinator was called
    expect(mockRequest).toHaveBeenCalled();
  });

  test("GET /orchestration/rollouts proxies response", async () => {
    mockCoordinatorResponse(200, { rollouts: [{ id: "r1", status: "active" }] });

    const res = await app.inject({
      method: "GET",
      url: "/orchestration/rollouts",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rollouts).toHaveLength(1);
  });

  test("GET /economy/price/current proxies response", async () => {
    mockCoordinatorResponse(200, { cpu: 0.5, gpu: 2.0 });

    const res = await app.inject({
      method: "GET",
      url: "/economy/price/current",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cpu).toBe(0.5);
  });

  test("GET /economy/issuance/current proxies response", async () => {
    mockCoordinatorResponse(200, { totalIssued: 1000 });

    const res = await app.inject({
      method: "GET",
      url: "/economy/issuance/current",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
  });

  test("GET /economy/issuance/history accepts limit query param", async () => {
    mockCoordinatorResponse(200, { history: [] });

    const res = await app.inject({
      method: "GET",
      url: "/economy/issuance/history?limit=10",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /orchestration/install-model -- coordinator target and agent target
// ---------------------------------------------------------------------------

describe("POST /orchestration/install-model", () => {
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const undici = await import("undici");
    mockRequest = undici.request as unknown as ReturnType<typeof vi.fn>;
    mockRequest.mockReset();
  });

  test("coordinator target routes to coordinator endpoint", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ ok: true, installed: "qwen2.5-coder:latest" }) },
    });

    const res = await app.inject({
      method: "POST",
      url: "/orchestration/install-model",
      headers: adminHeaders(),
      payload: { target: "coordinator" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringContaining("/orchestration/coordinator/ollama-install"),
      expect.any(Object)
    );
  });

  test("agent target requires agentId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/orchestration/install-model",
      headers: adminHeaders(),
      payload: { target: "agent" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("agentId_required_for_agent_target");
  });

  test("agent target with agentId routes to agent endpoint", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ ok: true }) },
    });

    const res = await app.inject({
      method: "POST",
      url: "/orchestration/install-model",
      headers: adminHeaders(),
      payload: { target: "agent", agentId: "agent-42" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringContaining("/orchestration/agents/agent-42/ollama-install"),
      expect.any(Object)
    );
  });

  test("returns 502 when coordinator unreachable for coordinator target", async () => {
    mockRequest.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "POST",
      url: "/orchestration/install-model",
      headers: adminHeaders(),
      payload: { target: "coordinator" },
    });
    expect(res.statusCode).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// POST /bootstrap/coordinator
// ---------------------------------------------------------------------------

describe("POST /bootstrap/coordinator", () => {
  test("returns success when model bootstrap is skipped", async () => {
    const { ensureOllamaModelInstalled } = await import("../../src/model/ollama-installer.js");
    (ensureOllamaModelInstalled as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/bootstrap/coordinator",
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().database).toBe("database_disabled");
  });

  test("returns 500 if bootstrap fails", async () => {
    const { ensureOllamaModelInstalled } = await import("../../src/model/ollama-installer.js");
    (ensureOllamaModelInstalled as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("ollama binary not found")
    );

    const res = await app.inject({
      method: "POST",
      url: "/bootstrap/coordinator",
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().ok).toBe(false);
  });

  test("requires admin auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/bootstrap/coordinator",
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// UI retired endpoints
// ---------------------------------------------------------------------------

describe("Retired UI endpoints", () => {
  test("GET /ui/data returns 410 with redirect", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/ui/data",
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("ui_retired_use_portal");
    expect(res.json().redirectTo).toBeDefined();
  });

  test("POST /ui/actions/coordinator-ollama returns 410", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ui/actions/coordinator-ollama",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("ui_retired_use_portal");
  });

  test("POST /ui/actions/node-approval returns 410", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ui/actions/node-approval",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(410);
  });

  test("GET /ui redirects to portal", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/ui",
    });
    // Fastify inject returns 302 for redirect
    expect(res.statusCode).toBe(302);
  });
});

// ---------------------------------------------------------------------------
// Agent approval endpoints -- portal service not configured
// ---------------------------------------------------------------------------

describe("Approval endpoints without portal service", () => {
  const savedPortalUrl = process.env.PORTAL_SERVICE_URL;

  beforeEach(() => {
    delete process.env.PORTAL_SERVICE_URL;
  });

  afterAll(() => {
    if (savedPortalUrl !== undefined) {
      process.env.PORTAL_SERVICE_URL = savedPortalUrl;
    }
  });

  test("POST /agents/:agentId/approval returns 503 without portal service", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/test-agent/approval",
      headers: adminHeaders(),
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("portal_service_not_configured");
  });

  test("POST /coordinators/:coordinatorId/approval returns 503 without portal service", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/coordinators/coord-1/approval",
      headers: adminHeaders(),
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("portal_service_not_configured");
  });
});

// ---------------------------------------------------------------------------
// Network summary and ops summary (proxy endpoints)
// ---------------------------------------------------------------------------

describe("GET /network/summary", () => {
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const undici = await import("undici");
    mockRequest = undici.request as unknown as ReturnType<typeof vi.fn>;
    mockRequest.mockReset();
  });

  test("aggregates capacity, status, and pricing from coordinator", async () => {
    // capacity
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ totals: { cpu: 4 }, agents: [] }) },
    });
    // status
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ queued: 2, agents: 1, results: 5 }) },
    });
    // pricing
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ cpu: 1.0, gpu: 3.0 }) },
    });

    const res = await app.inject({
      method: "GET",
      url: "/network/summary",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.generatedAt).toBeDefined();
    expect(body.networkMode).toBeDefined();
    expect(body.capacity).toBeDefined();
    expect(body.status).toBeDefined();
    expect(body.pricing).toBeDefined();
  });

  test("returns 502 when coordinator completely unreachable", async () => {
    mockRequest.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "GET",
      url: "/network/summary",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("coordinator_unreachable");
  });
});

// ---------------------------------------------------------------------------
// Economy proxy endpoints
// ---------------------------------------------------------------------------

describe("Economy proxy endpoints", () => {
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const undici = await import("undici");
    mockRequest = undici.request as unknown as ReturnType<typeof vi.fn>;
    mockRequest.mockReset();
  });

  test("POST /economy/price/propose forwards to coordinator", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ proposed: true }) },
    });

    const res = await app.inject({
      method: "POST",
      url: "/economy/price/propose",
      headers: adminHeaders(),
      payload: {
        coordinatorId: "c1",
        cpuCapacity: 8,
        gpuCapacity: 2,
        queuedTasks: 10,
        activeAgents: 3,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  test("POST /economy/price/consensus forwards to coordinator", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ consensus: true }) },
    });

    const res = await app.inject({
      method: "POST",
      url: "/economy/price/consensus",
      headers: adminHeaders(),
      payload: {
        cpuCapacity: 8,
        gpuCapacity: 2,
        queuedTasks: 10,
        activeAgents: 3,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  test("GET /economy/credits/:accountId/quote proxies response", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ quote: 42 }) },
    });

    const res = await app.inject({
      method: "GET",
      url: "/economy/credits/acct-1/quote",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().quote).toBe(42);
  });

  test("POST /economy/payments/intents forwards to coordinator", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ intentId: "intent-1" }) },
    });

    const res = await app.inject({
      method: "POST",
      url: "/economy/payments/intents",
      headers: adminHeaders(),
      payload: { accountId: "acct-1", amountSats: 1000 },
    });
    expect(res.statusCode).toBe(200);
  });

  test("GET /economy/payments/intents/:intentId proxies response", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ intentId: "intent-1", status: "pending" }) },
    });

    const res = await app.inject({
      method: "GET",
      url: "/economy/payments/intents/intent-1",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
  });

  test("POST /economy/payments/intents/:intentId/confirm forwards to coordinator", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ confirmed: true }) },
    });

    const res = await app.inject({
      method: "POST",
      url: "/economy/payments/intents/intent-1/confirm",
      headers: adminHeaders(),
      payload: { txRef: "tx-ref-1234" },
    });
    expect(res.statusCode).toBe(200);
  });

  test("POST /economy/payments/reconcile forwards to coordinator", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ reconciled: 5 }) },
    });

    const res = await app.inject({
      method: "POST",
      url: "/economy/payments/reconcile",
      headers: adminHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  test("POST /economy/treasury/policies forwards to coordinator", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ policyId: "pol-1" }) },
    });

    const res = await app.inject({
      method: "POST",
      url: "/economy/treasury/policies",
      headers: adminHeaders(),
      payload: {
        treasuryAccountId: "treasury-1",
        multisigDescriptor: "wsh(multi(2,xpub1,xpub2))",
        quorumThreshold: 2,
        totalCustodians: 3,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  test("GET /economy/treasury proxies response", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ balance: 100000 }) },
    });

    const res = await app.inject({
      method: "GET",
      url: "/economy/treasury",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Agent catalog with mocked coordinator
// ---------------------------------------------------------------------------

describe("GET /agents/catalog", () => {
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const undici = await import("undici");
    mockRequest = undici.request as unknown as ReturnType<typeof vi.fn>;
    mockRequest.mockReset();
  });

  test("returns 502 when coordinator is unreachable", async () => {
    mockRequest.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "GET",
      url: "/agents/catalog",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("coordinator_unreachable");
  });

  test("returns catalog with agent data from coordinator", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        json: async () => ({
          agents: [
            { agentId: "catalog-agent-1", os: "macos", version: "1.0.0" },
          ],
        }),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/agents/catalog",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents).toBeDefined();
    expect(Array.isArray(body.agents)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Direct work audit with query param
// ---------------------------------------------------------------------------

describe("GET /agent-mesh/direct-work/audit", () => {
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const undici = await import("undici");
    mockRequest = undici.request as unknown as ReturnType<typeof vi.fn>;
    mockRequest.mockReset();
  });

  test("passes limit query to coordinator", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ events: [] }) },
    });

    const res = await app.inject({
      method: "GET",
      url: "/agent-mesh/direct-work/audit?limit=50",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringContaining("limit=50"),
      expect.any(Object)
    );
  });

  test("defaults limit to 100", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ events: [] }) },
    });

    const res = await app.inject({
      method: "GET",
      url: "/agent-mesh/direct-work/audit",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringContaining("limit=100"),
      expect.any(Object)
    );
  });
});

// ---------------------------------------------------------------------------
// Agent mesh models available with provider filter
// ---------------------------------------------------------------------------

describe("GET /agent-mesh/models/available", () => {
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const undici = await import("undici");
    mockRequest = undici.request as unknown as ReturnType<typeof vi.fn>;
    mockRequest.mockReset();
  });

  test("passes provider query to coordinator", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ models: [] }) },
    });

    const res = await app.inject({
      method: "GET",
      url: "/agent-mesh/models/available?provider=ollama-local",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringContaining("provider=ollama-local"),
      expect.any(Object)
    );
  });

  test("works without provider filter", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ models: [] }) },
    });

    const res = await app.inject({
      method: "GET",
      url: "/agent-mesh/models/available",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /ops/coordinator-ollama
// ---------------------------------------------------------------------------

describe("POST /ops/coordinator-ollama", () => {
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const undici = await import("undici");
    mockRequest = undici.request as unknown as ReturnType<typeof vi.fn>;
    mockRequest.mockReset();
  });

  test("forwards to coordinator ollama install endpoint", async () => {
    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { json: async () => ({ ok: true }) },
    });

    const res = await app.inject({
      method: "POST",
      url: "/ops/coordinator-ollama",
      headers: adminHeaders(),
      payload: { model: "codellama:7b" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringContaining("/orchestration/coordinator/ollama-install"),
      expect.any(Object)
    );
  });

  test("returns 502 when coordinator unreachable", async () => {
    mockRequest.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "POST",
      url: "/ops/coordinator-ollama",
      headers: adminHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// GET /ops/summary (admin protected)
// ---------------------------------------------------------------------------

describe("GET /ops/summary", () => {
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const undici = await import("undici");
    mockRequest = undici.request as unknown as ReturnType<typeof vi.fn>;
    mockRequest.mockReset();
  });

  test("requires admin auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/ops/summary",
    });
    expect(res.statusCode).toBe(401);
  });

  test("returns aggregated dashboard data", async () => {
    // loadDashboardData makes multiple coordinator calls; mock them all
    const stubResponse = (body: unknown) => ({
      statusCode: 200,
      body: { json: async () => body },
    });
    mockRequest
      .mockResolvedValueOnce(stubResponse({ totals: {}, agents: [] })) // capacity
      .mockResolvedValueOnce(stubResponse({ queued: 0, agents: 0 })) // status
      .mockResolvedValueOnce(stubResponse({ version: 0, records: [] })) // blacklist
      .mockResolvedValueOnce(stubResponse({ version: 0, events: [] })) // blacklist audit
      .mockResolvedValueOnce(stubResponse({ events: [] })) // direct work audit
      .mockResolvedValueOnce(stubResponse({ provider: "ollama-local" })) // coordinator model
      .mockResolvedValueOnce(stubResponse({ rollouts: [] })) // rollouts
      .mockResolvedValueOnce(stubResponse({ cpu: null, gpu: null })); // pricing

    const res = await app.inject({
      method: "GET",
      url: "/ops/summary",
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.generatedAt).toBeDefined();
    expect(body.deploymentPlan).toBeDefined();
    expect(body.capacity).toBeDefined();
    expect(body.status).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Auth edge cases: multiple admin routes require token
// ---------------------------------------------------------------------------

describe("Auth required on all admin routes", () => {
  const adminGetRoutes = [
    "/agents",
    "/network/mode",
    "/security/blacklist",
    "/security/blacklist/audit",
    "/economy/price/current",
    "/economy/issuance/current",
    "/orchestration/rollouts",
    "/ops/summary",
  ];

  const adminPostRoutes = [
    "/agents/upsert",
    "/network/mode",
  ];

  for (const route of adminGetRoutes) {
    test(`GET ${route} rejects unauthenticated requests`, async () => {
      const res = await app.inject({
        method: "GET",
        url: route,
      });
      expect(res.statusCode).toBe(401);
    });
  }

  for (const route of adminPostRoutes) {
    test(`POST ${route} rejects unauthenticated requests`, async () => {
      const res = await app.inject({
        method: "POST",
        url: route,
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// Blacklist POST -- schema validation
// ---------------------------------------------------------------------------

describe("POST /security/blacklist -- schema validation", () => {
  test("rejects missing required fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/security/blacklist",
      headers: adminHeaders(),
      payload: { agentId: "bad-agent" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  test("rejects invalid reasonCode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/security/blacklist",
      headers: adminHeaders(),
      payload: {
        agentId: "bad-agent",
        reasonCode: "invalid_code",
        reason: "test reason",
        evidenceHashSha256: "a".repeat(64),
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  test("rejects evidence hash of wrong length", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/security/blacklist",
      headers: adminHeaders(),
      payload: {
        agentId: "bad-agent",
        reasonCode: "abuse_spam",
        reason: "test reason",
        evidenceHashSha256: "tooshort",
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// Integration: full registration -> mode change -> manifest flow
// ---------------------------------------------------------------------------

describe("Integration: registration -> mode change -> manifest flow", () => {
  const AGENT = "agent-integration-flow";

  test("full lifecycle: register, set mode, enable local model, get manifest", async () => {
    // Step 1: Register
    const regRes = await app.inject({
      method: "POST",
      url: "/agents/upsert",
      headers: adminHeaders(),
      payload: makeAgentPayload({ agentId: AGENT, mode: "swarm-only" }),
    });
    expect(regRes.statusCode).toBe(200);
    expect(regRes.json().mode).toBe("swarm-only");

    // Step 2: Switch to ide-enabled
    const modeRes = await app.inject({
      method: "POST",
      url: `/agents/${AGENT}/mode`,
      headers: adminHeaders(),
      payload: { mode: "ide-enabled" },
    });
    expect(modeRes.statusCode).toBe(200);
    expect(modeRes.json().mode).toBe("ide-enabled");

    // Step 3: Enable local model with manifest
    const manifest = {
      modelId: "integration-model",
      sourceUrl: "https://huggingface.co/models/test-model.gguf",
      checksumSha256: "d".repeat(64),
      signature: "integration-test-signature-long",
      provider: "ollama-local" as const,
    };
    const modelRes = await app.inject({
      method: "POST",
      url: `/agents/${AGENT}/local-model`,
      headers: adminHeaders(),
      payload: { enabled: true, manifest },
    });
    expect(modelRes.statusCode).toBe(200);
    expect(modelRes.json().agent.localModelEnabled).toBe(true);
    expect(modelRes.json().manifest.modelId).toBe("integration-model");

    // Step 4: Read manifest
    const readRes = await app.inject({
      method: "GET",
      url: `/agents/${AGENT}/manifest`,
      headers: adminHeaders(),
    });
    expect(readRes.statusCode).toBe(200);
    expect(readRes.json().modelId).toBe("integration-model");

    // Step 5: Verify the agent shows up in listing
    const listRes = await app.inject({
      method: "GET",
      url: "/agents",
      headers: adminHeaders(),
    });
    expect(listRes.statusCode).toBe(200);
    const found = listRes.json().agents.find((a: any) => a.agentId === AGENT);
    expect(found).toBeDefined();
    expect(found.mode).toBe("ide-enabled");
    expect(found.localModelEnabled).toBe(true);

    // Step 6: Disable local model
    const disableRes = await app.inject({
      method: "POST",
      url: `/agents/${AGENT}/local-model`,
      headers: adminHeaders(),
      payload: { enabled: false },
    });
    expect(disableRes.statusCode).toBe(200);
    expect(disableRes.json().agent.localModelEnabled).toBe(false);
    expect(disableRes.json().manifest).toBeNull();

    // Step 7: Manifest should be gone
    const goneRes = await app.inject({
      method: "GET",
      url: `/agents/${AGENT}/manifest`,
      headers: adminHeaders(),
    });
    expect(goneRes.statusCode).toBe(404);
  });
});
