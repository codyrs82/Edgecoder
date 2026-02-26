import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EscalationResolver } from "../../src/escalation/server.js";
import type { EscalationRequest, EscalationResult } from "../../src/escalation/types.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<EscalationRequest> = {}): EscalationRequest {
  return {
    taskId: "esc-1",
    agentId: "agent-a",
    task: "implement fibonacci",
    failedCode: "def fib(n): return n",
    errorHistory: ["AssertionError: fib(5) != 5"],
    language: "python",
    iterationsAttempted: 3,
    ...overrides,
  };
}

/** Spin up a tiny HTTP server that replies with a predetermined response. */
function createMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve({ server, url: `http://127.0.0.1:${addr.port}` });
      }
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EscalationResolver", () => {
  describe("constructor defaults", () => {
    it("uses sensible defaults when no config is provided", () => {
      const resolver = new EscalationResolver();
      // No crash; defaults are applied internally
      expect(resolver).toBeDefined();
    });
  });

  describe("resolve — parent coordinator path", () => {
    let parentServer: Server;
    let parentUrl: string;

    afterEach(async () => {
      if (parentServer) await closeServer(parentServer);
    });

    it("resolves via parent coordinator when it returns completed", async () => {
      const result: EscalationResult = {
        taskId: "esc-1",
        status: "completed",
        improvedCode: "def fib(n):\n  if n <= 1: return n\n  return fib(n-1) + fib(n-2)",
        explanation: "Fixed recursion",
        resolvedByModel: "big-model",
      };
      ({ server: parentServer, url: parentUrl } = await createMockServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      }));

      const resolver = new EscalationResolver({
        parentCoordinatorUrl: parentUrl,
        maxRetries: 0,
      });

      const out = await resolver.resolve(makeRequest());
      expect(out.status).toBe("completed");
      expect(out.improvedCode).toContain("fib(n-1)");
      expect(out.resolvedByModel).toBe("big-model");
    });

    it("sends x-mesh-token header when parentMeshToken is set", async () => {
      let receivedToken = "";
      ({ server: parentServer, url: parentUrl } = await createMockServer(async (req, res) => {
        receivedToken = req.headers["x-mesh-token"] as string;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ taskId: "esc-1", status: "completed", improvedCode: "ok" }));
      }));

      const resolver = new EscalationResolver({
        parentCoordinatorUrl: parentUrl,
        parentMeshToken: "secret-mesh-abc",
        maxRetries: 0,
      });

      await resolver.resolve(makeRequest());
      expect(receivedToken).toBe("secret-mesh-abc");
    });

    it("sanitizes the request before sending to parent", async () => {
      let receivedBody = "";
      ({ server: parentServer, url: parentUrl } = await createMockServer(async (req, res) => {
        receivedBody = await readBody(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ taskId: "esc-1", status: "completed", improvedCode: "ok" }));
      }));

      const resolver = new EscalationResolver({
        parentCoordinatorUrl: parentUrl,
        maxRetries: 0,
      });

      await resolver.resolve(
        makeRequest({ task: "connect to AKIAIOSFODNN7EXAMPLE bucket" })
      );

      expect(receivedBody).toContain("[REDACTED]");
      expect(receivedBody).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });
  });

  describe("resolve — cloud inference path", () => {
    let cloudServer: Server;
    let cloudUrl: string;

    afterEach(async () => {
      if (cloudServer) await closeServer(cloudServer);
    });

    it("falls back to cloud inference when no parent coordinator is configured", async () => {
      ({ server: cloudServer, url: cloudUrl } = await createMockServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            improvedCode: "def fib(n): return n if n<=1 else fib(n-1)+fib(n-2)",
            explanation: "Cloud-fixed",
          })
        );
      }));

      const resolver = new EscalationResolver({
        cloudInferenceUrl: cloudUrl,
        maxRetries: 0,
      });

      const out = await resolver.resolve(makeRequest());
      expect(out.status).toBe("completed");
      expect(out.improvedCode).toContain("fib");
      expect(out.resolvedByModel).toBe("cloud-inference");
    });

    it("sends x-inference-token header when cloudInferenceToken is set", async () => {
      let receivedToken = "";
      ({ server: cloudServer, url: cloudUrl } = await createMockServer(async (req, res) => {
        receivedToken = req.headers["x-inference-token"] as string;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ improvedCode: "ok" }));
      }));

      const resolver = new EscalationResolver({
        cloudInferenceUrl: cloudUrl,
        cloudInferenceToken: "cloud-tok-xyz",
        maxRetries: 0,
      });

      await resolver.resolve(makeRequest());
      expect(receivedToken).toBe("cloud-tok-xyz");
    });

    it("extracts code from rawResponse when improvedCode is not provided", async () => {
      ({ server: cloudServer, url: cloudUrl } = await createMockServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            rawResponse:
              "Here is the solution:\n```python\ndef fib(n):\n  if n <= 1: return n\n  return fib(n-1) + fib(n-2)\n```",
          })
        );
      }));

      const resolver = new EscalationResolver({
        cloudInferenceUrl: cloudUrl,
        maxRetries: 0,
      });

      const out = await resolver.resolve(makeRequest());
      expect(out.status).toBe("completed");
      expect(out.improvedCode).toContain("def fib");
      expect(out.improvedCode).not.toContain("```");
    });

    it("sends only task/failedCode/errorHistory/language to cloud endpoint", async () => {
      let receivedBody: Record<string, unknown> = {};
      ({ server: cloudServer, url: cloudUrl } = await createMockServer(async (req, res) => {
        const raw = await readBody(req);
        receivedBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ improvedCode: "ok" }));
      }));

      const resolver = new EscalationResolver({
        cloudInferenceUrl: cloudUrl,
        maxRetries: 0,
      });

      await resolver.resolve(makeRequest());

      expect(receivedBody).toHaveProperty("task");
      expect(receivedBody).toHaveProperty("failedCode");
      expect(receivedBody).toHaveProperty("errorHistory");
      expect(receivedBody).toHaveProperty("language");
      // Should NOT forward taskId/agentId/iterationsAttempted
      expect(receivedBody).not.toHaveProperty("taskId");
      expect(receivedBody).not.toHaveProperty("agentId");
      expect(receivedBody).not.toHaveProperty("iterationsAttempted");
    });
  });

  describe("resolve — waterfall order", () => {
    let parentServer: Server;
    let cloudServer: Server;
    let parentUrl: string;
    let cloudUrl: string;

    afterEach(async () => {
      if (parentServer) await closeServer(parentServer);
      if (cloudServer) await closeServer(cloudServer);
    });

    it("prefers parent coordinator over cloud inference", async () => {
      ({ server: parentServer, url: parentUrl } = await createMockServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ taskId: "esc-1", status: "completed", improvedCode: "parent-code" })
        );
      }));
      ({ server: cloudServer, url: cloudUrl } = await createMockServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ improvedCode: "cloud-code" }));
      }));

      const resolver = new EscalationResolver({
        parentCoordinatorUrl: parentUrl,
        cloudInferenceUrl: cloudUrl,
        maxRetries: 0,
      });

      const out = await resolver.resolve(makeRequest());
      expect(out.improvedCode).toBe("parent-code");
    });

    it("falls to cloud when parent coordinator returns 500", async () => {
      ({ server: parentServer, url: parentUrl } = await createMockServer((_req, res) => {
        res.writeHead(500);
        res.end("Internal Server Error");
      }));
      ({ server: cloudServer, url: cloudUrl } = await createMockServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ improvedCode: "cloud-fallback" }));
      }));

      const resolver = new EscalationResolver({
        parentCoordinatorUrl: parentUrl,
        cloudInferenceUrl: cloudUrl,
        maxRetries: 0,
      });

      const out = await resolver.resolve(makeRequest());
      expect(out.status).toBe("completed");
      expect(out.improvedCode).toBe("cloud-fallback");
    });

    it("returns pending_human when both backends are unreachable", async () => {
      const resolver = new EscalationResolver({
        parentCoordinatorUrl: "http://127.0.0.1:1",
        cloudInferenceUrl: "http://127.0.0.1:1",
        maxRetries: 0,
        requestTimeoutMs: 500,
      });

      const out = await resolver.resolve(makeRequest());
      expect(out.status).toBe("pending_human");
      expect(out.explanation).toContain("exhausted");
      expect(out.escalationId).toBeDefined();
    });

    it("returns pending_human when no backends are configured", async () => {
      const resolver = new EscalationResolver({});
      const out = await resolver.resolve(makeRequest());
      expect(out.status).toBe("pending_human");
      expect(out.escalationId).toBeDefined();
    });
  });

  describe("retry with exponential backoff", () => {
    let server: Server;
    let serverUrl: string;

    afterEach(async () => {
      if (server) await closeServer(server);
    });

    it("retries on failure and succeeds on a later attempt", async () => {
      let attempt = 0;
      ({ server, url: serverUrl } = await createMockServer((_req, res) => {
        attempt++;
        if (attempt < 3) {
          res.writeHead(503);
          res.end("Unavailable");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ taskId: "esc-1", status: "completed", improvedCode: "retry-ok" })
          );
        }
      }));

      const resolver = new EscalationResolver({
        parentCoordinatorUrl: serverUrl,
        maxRetries: 2,
        retryBaseDelayMs: 50, // fast for tests
      });

      const out = await resolver.resolve(makeRequest());
      expect(out.status).toBe("completed");
      expect(out.improvedCode).toBe("retry-ok");
      expect(attempt).toBe(3);
    });

    it("exhausts retries and falls to next backend", async () => {
      let parentAttempts = 0;
      ({ server, url: serverUrl } = await createMockServer((_req, res) => {
        parentAttempts++;
        res.writeHead(500);
        res.end("fail");
      }));

      const resolver = new EscalationResolver({
        parentCoordinatorUrl: serverUrl,
        maxRetries: 1,
        retryBaseDelayMs: 10,
      });

      const out = await resolver.resolve(makeRequest());
      // Parent exhausted (initial + 1 retry = 2), no cloud configured
      expect(parentAttempts).toBe(2);
      expect(out.status).toBe("pending_human");
    });
  });

  describe("result callback", () => {
    let parentServer: Server;
    let callbackServer: Server;
    let parentUrl: string;
    let callbackUrl: string;

    afterEach(async () => {
      if (parentServer) await closeServer(parentServer);
      if (callbackServer) await closeServer(callbackServer);
    });

    it("posts the result to the callback URL on success", async () => {
      let callbackReceived: Record<string, unknown> | null = null;
      let callbackPath = "";

      ({ server: parentServer, url: parentUrl } = await createMockServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ taskId: "esc-cb", status: "completed", improvedCode: "fixed" })
        );
      }));

      ({ server: callbackServer, url: callbackUrl } = await createMockServer(async (req, res) => {
        callbackPath = req.url ?? "";
        const raw = await readBody(req);
        callbackReceived = JSON.parse(raw);
        res.writeHead(200);
        res.end("ok");
      }));

      const resolver = new EscalationResolver({
        parentCoordinatorUrl: parentUrl,
        callbackUrl: callbackUrl,
        maxRetries: 0,
      });

      await resolver.resolve(makeRequest({ taskId: "esc-cb" }));

      expect(callbackPath).toBe("/escalate/esc-cb/result");
      expect(callbackReceived).not.toBeNull();
      expect((callbackReceived as Record<string, unknown>).status).toBe("completed");
    });

    it("sends x-mesh-token with callback when callbackToken is set", async () => {
      let callbackToken = "";
      ({ server: parentServer, url: parentUrl } = await createMockServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ taskId: "esc-1", status: "completed", improvedCode: "ok" }));
      }));

      ({ server: callbackServer, url: callbackUrl } = await createMockServer(async (req, res) => {
        callbackToken = req.headers["x-mesh-token"] as string;
        res.writeHead(200);
        res.end("ok");
      }));

      const resolver = new EscalationResolver({
        parentCoordinatorUrl: parentUrl,
        callbackUrl: callbackUrl,
        callbackToken: "cb-secret",
        maxRetries: 0,
      });

      await resolver.resolve(makeRequest());
      expect(callbackToken).toBe("cb-secret");
    });

    it("does not fail if callback endpoint is unreachable", async () => {
      ({ server: parentServer, url: parentUrl } = await createMockServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ taskId: "esc-1", status: "completed", improvedCode: "resilient" })
        );
      }));

      const resolver = new EscalationResolver({
        parentCoordinatorUrl: parentUrl,
        callbackUrl: "http://127.0.0.1:1", // unreachable
        maxRetries: 0,
      });

      // Should not throw — callback failures are non-fatal
      const out = await resolver.resolve(makeRequest());
      expect(out.status).toBe("completed");
      expect(out.improvedCode).toBe("resilient");
    });

    it("posts the result to callback on failure too", async () => {
      let callbackReceived: Record<string, unknown> | null = null;

      ({ server: callbackServer, url: callbackUrl } = await createMockServer(async (req, res) => {
        const raw = await readBody(req);
        callbackReceived = JSON.parse(raw);
        res.writeHead(200);
        res.end("ok");
      }));

      const resolver = new EscalationResolver({
        callbackUrl: callbackUrl,
        maxRetries: 0,
      });

      await resolver.resolve(makeRequest());
      expect(callbackReceived).not.toBeNull();
      expect((callbackReceived as Record<string, unknown>).status).toBe("pending_human");
    });
  });

  describe("timeout handling", () => {
    let slowServer: Server;
    let slowUrl: string;

    afterEach(async () => {
      if (slowServer) await closeServer(slowServer);
    });

    it("times out when the server is too slow", async () => {
      ({ server: slowServer, url: slowUrl } = await createMockServer((_req, res) => {
        // Never respond — let the timeout fire
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ taskId: "esc-1", status: "completed", improvedCode: "late" }));
        }, 5000);
      }));

      const resolver = new EscalationResolver({
        parentCoordinatorUrl: slowUrl,
        requestTimeoutMs: 200,
        maxRetries: 0,
      });

      const out = await resolver.resolve(makeRequest());
      // Should exhaust (timeout) and escalate to human since no cloud configured
      expect(out.status).toBe("pending_human");
    });
  });
});
