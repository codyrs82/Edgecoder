import { describe, it, expect, vi, beforeEach } from "vitest";

// Set required env var before module loads (vi.hoisted runs before all imports)
vi.hoisted(() => {
  process.env.INFERENCE_AUTH_TOKEN = "test-token";
});

import { parseDecomposition } from "../../src/inference/service.js";

// Mock undici before importing the service (which uses `request` at module scope in route handlers)
const mockRequest = vi.fn();
vi.mock("undici", () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));

// Mock peer verification — not needed for these tests
vi.mock("../../src/mesh/peer.js", () => ({
  verifyPayload: () => true,
}));

// Mock model swap routes to avoid side effects
vi.mock("../../src/model/swap-routes.js", () => ({
  buildModelSwapRoutes: () => {},
}));

// Mock dashboard routes to avoid side effects
vi.mock("../../src/inference/dashboard.js", () => ({
  buildDashboardRoutes: () => {},
}));

// Import the app after mocks are set up
const { inferenceService: app } = await import("../../src/inference/service.js");

const AUTH_HEADER = { "x-inference-token": "test-token" };

// Helper to create a mock Ollama response
function ollamaResponse(response: string) {
  return {
    body: {
      json: async () => ({ response }),
    },
  };
}

beforeEach(() => {
  mockRequest.mockReset();
});

// ---------------------------------------------------------------------------
// parseDecomposition unit tests
// ---------------------------------------------------------------------------
describe("parseDecomposition", () => {
  const base = {
    taskId: "task-1",
    prompt: "Build a calculator",
    language: "python",
    snapshotRef: "snap-abc",
  };

  it("parses a valid JSON array", () => {
    const raw = JSON.stringify([
      { input: "Create add function", language: "python" },
      { input: "Create subtract function" },
    ]);
    const result = parseDecomposition(raw, base);
    expect(result).toHaveLength(2);
    expect(result[0].input).toBe("Create add function");
    expect(result[0].kind).toBe("micro_loop");
    expect(result[0].taskId).toBe("task-1");
    expect(result[0].snapshotRef).toBe("snap-abc");
    expect(result[0].language).toBe("python");
    expect(result[1].language).toBe("python"); // defaults from request
  });

  it("extracts JSON from markdown fences", () => {
    const raw = `Here is the decomposition:
\`\`\`json
[{"input": "Step one"}, {"input": "Step two"}]
\`\`\`
Done.`;
    const result = parseDecomposition(raw, base);
    expect(result).toHaveLength(2);
    expect(result[0].input).toBe("Step one");
    expect(result[1].input).toBe("Step two");
  });

  it("falls back to single subtask on malformed JSON", () => {
    const result = parseDecomposition("this is not json at all", base);
    expect(result).toHaveLength(1);
    expect(result[0].input).toBe("Build a calculator");
    expect(result[0].timeoutMs).toBe(30_000);
  });

  it("falls back to single subtask on empty response", () => {
    const result = parseDecomposition("", base);
    expect(result).toHaveLength(1);
    expect(result[0].input).toBe("Build a calculator");
  });

  it("falls back to single subtask on empty array", () => {
    const result = parseDecomposition("[]", base);
    expect(result).toHaveLength(1);
    expect(result[0].input).toBe("Build a calculator");
  });

  it("limits to 10 subtasks", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      input: `Subtask ${i}`,
    }));
    const raw = JSON.stringify(items);
    const result = parseDecomposition(raw, base);
    expect(result).toHaveLength(10);
    expect(result[9].input).toBe("Subtask 9");
  });

  it("estimates timeout based on input length", () => {
    const shortInput = "Do X"; // 4 chars -> 5000 + floor(4/50)*1000 = 5000
    const longInput = "A".repeat(300); // 300 chars -> 5000 + floor(300/50)*1000 = 5000 + 6000 = 11000
    const hugeInput = "B".repeat(5000); // 5000 chars -> 5000 + 100*1000 = 105000 => capped to 60000

    const raw = JSON.stringify([
      { input: shortInput },
      { input: longInput },
      { input: hugeInput },
    ]);
    const result = parseDecomposition(raw, base);
    expect(result[0].timeoutMs).toBe(5000);
    expect(result[1].timeoutMs).toBe(11000);
    expect(result[2].timeoutMs).toBe(60_000);
  });

  it("uses per-subtask language when provided", () => {
    const raw = JSON.stringify([
      { input: "Write tests", language: "javascript" },
    ]);
    const result = parseDecomposition(raw, base);
    expect(result[0].language).toBe("javascript");
  });
});

// ---------------------------------------------------------------------------
// POST /decompose
// ---------------------------------------------------------------------------
describe("POST /decompose", () => {
  it("returns subtasks from successful Ollama decomposition", async () => {
    mockRequest.mockResolvedValueOnce(
      ollamaResponse(
        JSON.stringify([
          { input: "Parse input" },
          { input: "Compute result" },
        ]),
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/decompose",
      headers: AUTH_HEADER,
      payload: {
        taskId: "t1",
        prompt: "Build a calculator",
        snapshotRef: "snap-1",
        language: "python",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.subtasks).toHaveLength(2);
    expect(body.subtasks[0].input).toBe("Parse input");
    expect(body.subtasks[0].kind).toBe("micro_loop");
    expect(body.subtasks[1].input).toBe("Compute result");
  });

  it("falls back to single subtask when Ollama fails", async () => {
    mockRequest.mockRejectedValueOnce(new Error("connection refused"));

    const res = await app.inject({
      method: "POST",
      url: "/decompose",
      headers: AUTH_HEADER,
      payload: {
        taskId: "t2",
        prompt: "Handle error",
        snapshotRef: "snap-2",
        language: "javascript",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.subtasks).toHaveLength(1);
    expect(body.subtasks[0].input).toBe("Handle error");
    expect(body.subtasks[0].language).toBe("javascript");
    expect(body.subtasks[0].timeoutMs).toBe(30_000);
  });

  it("rejects request with missing required fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/decompose",
      headers: AUTH_HEADER,
      payload: { taskId: "t3" }, // missing prompt and snapshotRef
    });

    expect(res.statusCode).toBe(500); // Zod throws before handler logic
  });
});

// ---------------------------------------------------------------------------
// POST /escalate
// ---------------------------------------------------------------------------
describe("POST /escalate", () => {
  it("returns improved code on successful escalation", async () => {
    mockRequest.mockResolvedValueOnce(
      ollamaResponse("def add(a, b):\n    return a + b"),
    );

    const res = await app.inject({
      method: "POST",
      url: "/escalate",
      headers: AUTH_HEADER,
      payload: {
        task: "Implement add function",
        failedCode: "def add(a, b): return a - b",
        errorHistory: ["AssertionError: expected 3 got -1"],
        language: "python",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.improvedCode).toContain("return a + b");
    expect(body.explanation).toContain("Escalated");
  });

  it("returns 502 when Ollama is unreachable", async () => {
    mockRequest.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "POST",
      url: "/escalate",
      headers: AUTH_HEADER,
      payload: {
        task: "Fix bug",
        failedCode: "x = 1/0",
        errorHistory: [],
        language: "python",
      },
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.improvedCode).toBe("");
    expect(body.explanation).toContain("Escalation inference failed");
  });

  it("extracts code from markdown fences in response", async () => {
    mockRequest.mockResolvedValueOnce(
      ollamaResponse(
        "Here is the fix:\n```python\nprint('hello')\n```\nThat should work.",
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/escalate",
      headers: AUTH_HEADER,
      payload: {
        task: "Print hello",
        failedCode: "prnt('hello')",
        errorHistory: ["NameError: prnt"],
        language: "python",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.improvedCode).toBe("print('hello')");
  });
});

// ---------------------------------------------------------------------------
// GET /metrics
// ---------------------------------------------------------------------------
describe("GET /metrics", () => {
  it("returns metric counters", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.decomposeRequests).toBe("number");
    expect(typeof body.decomposeSuccesses).toBe("number");
    expect(typeof body.decomposeModelCalls).toBe("number");
    expect(typeof body.decomposeFallbacks).toBe("number");
    expect(typeof body.escalateRequests).toBe("number");
    expect(typeof body.escalateSuccesses).toBe("number");
    expect(typeof body.escalateFailures).toBe("number");
    expect(typeof body.totalLatencyMs).toBe("number");
  });

  it("increments counters after requests", async () => {
    // Get baseline metrics
    const baseline = JSON.parse(
      (await app.inject({ method: "GET", url: "/metrics" })).body,
    );

    // Make a successful decompose request
    mockRequest.mockResolvedValueOnce(
      ollamaResponse(JSON.stringify([{ input: "step" }])),
    );
    await app.inject({
      method: "POST",
      url: "/decompose",
      headers: AUTH_HEADER,
      payload: {
        taskId: "m1",
        prompt: "Test metrics",
        snapshotRef: "snap-m",
        language: "python",
      },
    });

    // Make a failed escalate request
    mockRequest.mockRejectedValueOnce(new Error("timeout"));
    await app.inject({
      method: "POST",
      url: "/escalate",
      headers: AUTH_HEADER,
      payload: {
        task: "Metric test",
        failedCode: "x",
        errorHistory: [],
        language: "python",
      },
    });

    const after = JSON.parse(
      (await app.inject({ method: "GET", url: "/metrics" })).body,
    );

    expect(after.decomposeRequests).toBe(baseline.decomposeRequests + 1);
    expect(after.decomposeSuccesses).toBe(baseline.decomposeSuccesses + 1);
    expect(after.decomposeModelCalls).toBe(baseline.decomposeModelCalls + 1);
    expect(after.escalateRequests).toBe(baseline.escalateRequests + 1);
    expect(after.escalateFailures).toBe(baseline.escalateFailures + 1);
    expect(after.totalLatencyMs).toBeGreaterThanOrEqual(baseline.totalLatencyMs);
  });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
describe("GET /health", () => {
  it("returns ok: true", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
  });
});
