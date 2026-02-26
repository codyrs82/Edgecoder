import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { signRequest } from "../../src/security/request-signing.js";
import {
  registerHandshakeRoutes,
  SessionStore,
  type CloudModelProvider,
  type CloudModelResponse,
  type HandshakeSession,
} from "../../src/handshake/server.js";

// ---------------------------------------------------------------------------
// Key Generation Helpers
// ---------------------------------------------------------------------------

function generateAgentKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = "agent-test-001";
const agentKeys = generateAgentKeys();

function makeCloudProvider(
  response?: CloudModelResponse,
  delayMs = 0,
  shouldThrow = false
): CloudModelProvider {
  return {
    execute: vi.fn(async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (shouldThrow) throw new Error("cloud_model_unavailable");
      return response ?? { improvedCode: "// fixed code", notes: "Applied fix" };
    }),
  };
}

function bodyHash(body: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function signedHeaders(
  method: string,
  path: string,
  body: Record<string, unknown>
) {
  const hash = bodyHash(body);
  return signRequest({
    method,
    path,
    bodyHash: hash,
    privateKeyPem: agentKeys.privateKeyPem,
    agentId: AGENT_ID,
  });
}

const EMPTY_BODY_HASH = createHash("sha256").update("").digest("hex");

// Produce signed headers for GET requests (no body)
function signedHeadersGet(path: string) {
  return signRequest({
    method: "GET",
    path,
    bodyHash: EMPTY_BODY_HASH,
    privateKeyPem: agentKeys.privateKeyPem,
    agentId: AGENT_ID,
  });
}

// ---------------------------------------------------------------------------
// Test App Factory
// ---------------------------------------------------------------------------

async function buildApp(
  cloudModel?: CloudModelProvider,
  opts: {
    sessionTimeoutMs?: number;
    cleanupIntervalMs?: number;
    maxSessionsPerAgent?: number;
  } = {}
) {
  const app = Fastify({ logger: false });
  const provider = cloudModel ?? makeCloudProvider();
  const keyMap = new Map<string, string>();
  keyMap.set(AGENT_ID, agentKeys.publicKeyPem);

  const { store, stopCleanup } = registerHandshakeRoutes(app, {
    cloudModel: provider,
    resolvePublicKey: (id) => keyMap.get(id),
    ...opts,
  });

  await app.ready();
  return { app, store, stopCleanup, provider, keyMap };
}

function reviewPayload(overrides: Record<string, unknown> = {}) {
  return {
    task: "fix flaky test",
    snippet: 'const x = "hello";',
    queueReason: "timeout",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handshake server", () => {
  let app: FastifyInstance;
  let store: SessionStore;
  let stopCleanup: () => void;
  let provider: CloudModelProvider;
  let keyMap: Map<string, string>;

  afterEach(async () => {
    stopCleanup?.();
    await app?.close();
  });

  // -----------------------------------------------------------------------
  // POST /review — handshake phase
  // -----------------------------------------------------------------------

  describe("POST /review", () => {
    beforeEach(async () => {
      ({ app, store, stopCleanup, provider, keyMap } = await buildApp());
    });

    it("creates a session and returns reviewId", async () => {
      const body = reviewPayload();
      const headers = signedHeaders("POST", "/review", body);
      const res = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.reviewId).toBeDefined();
      expect(json.phase).toBe("handshake");
      expect(store.get(json.reviewId)).toBeDefined();
    });

    it("rejects requests without agent id", async () => {
      const body = reviewPayload();
      const res = await app.inject({
        method: "POST",
        url: "/review",
        headers: { "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("missing_agent_id");
    });

    it("rejects requests from unknown agents", async () => {
      const unknownKeys = generateAgentKeys();
      const body = reviewPayload();
      const hash = bodyHash(body);
      const headers = signRequest({
        method: "POST",
        path: "/review",
        bodyHash: hash,
        privateKeyPem: unknownKeys.privateKeyPem,
        agentId: "unknown-agent",
      });
      const res = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("unknown_agent");
    });

    it("rejects invalid signatures", async () => {
      const otherKeys = generateAgentKeys();
      const body = reviewPayload();
      const hash = bodyHash(body);
      // Sign with wrong keys but known agent id
      const headers = signRequest({
        method: "POST",
        path: "/review",
        bodyHash: hash,
        privateKeyPem: otherKeys.privateKeyPem,
        agentId: AGENT_ID,
      });
      const res = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_signature");
    });

    it("rejects body hash mismatch", async () => {
      const body = reviewPayload();
      const headers = signedHeaders("POST", "/review", body);
      // Tamper with the body after signing
      const tampered = { ...body, task: "tampered task" };
      const res = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...headers, "content-type": "application/json" },
        payload: tampered,
      });
      // The body hash check in the route verifies the hash header against the actual body.
      // Since the signed hash was for the original body, and the body is now different,
      // the body hash comparison fails.
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("body_hash_mismatch");
    });

    it("rejects invalid payload (missing task)", async () => {
      const body = { queueReason: "timeout" };
      const headers = signedHeaders("POST", "/review", body);
      const res = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("validation_error");
    });

    it("rejects invalid queueReason", async () => {
      const body = { task: "fix something", queueReason: "invalid_reason" };
      const headers = signedHeaders("POST", "/review", body);
      const res = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("validation_error");
    });

    it("enforces per-agent session limit", async () => {
      const builtApp = await buildApp(undefined, { maxSessionsPerAgent: 2 });
      app = builtApp.app;
      store = builtApp.store;
      stopCleanup = builtApp.stopCleanup;

      // Create 2 sessions (at the limit)
      for (let i = 0; i < 2; i++) {
        const body = reviewPayload({ task: `task-${i}` });
        const headers = signedHeaders("POST", "/review", body);
        const res = await app.inject({
          method: "POST",
          url: "/review",
          headers: { ...headers, "content-type": "application/json" },
          payload: body,
        });
        expect(res.statusCode).toBe(201);
      }

      // 3rd should be rejected
      const body = reviewPayload({ task: "task-3" });
      const headers = signedHeaders("POST", "/review", body);
      const res = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe("too_many_sessions");
    });

    it("accepts all valid queueReason codes", async () => {
      for (const reason of ["outside_subset", "timeout", "model_limit", "manual"]) {
        const body = reviewPayload({ queueReason: reason, task: `task-${reason}` });
        const headers = signedHeaders("POST", "/review", body);
        const res = await app.inject({
          method: "POST",
          url: "/review",
          headers: { ...headers, "content-type": "application/json" },
          payload: body,
        });
        expect(res.statusCode).toBe(201);
      }
    });
  });

  // -----------------------------------------------------------------------
  // POST /negotiate — negotiate phase
  // -----------------------------------------------------------------------

  describe("POST /negotiate", () => {
    let sessionId: string;

    beforeEach(async () => {
      ({ app, store, stopCleanup, provider, keyMap } = await buildApp());

      // Create a session first
      const body = reviewPayload();
      const headers = signedHeaders("POST", "/review", body);
      const res = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      sessionId = res.json().reviewId;
    });

    it("accepts negotiation and transitions to execute phase", async () => {
      const body = { sessionId, accept: true };
      const headers = signedHeaders("POST", "/negotiate", body);
      const res = await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().phase).toBe("execute");
    });

    it("rejects negotiation and transitions to failed phase", async () => {
      const body = { sessionId, accept: false };
      const headers = signedHeaders("POST", "/negotiate", body);
      const res = await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().phase).toBe("failed");
      expect(store.get(sessionId)!.failureReason).toBe("agent_rejected");
    });

    it("returns 404 for non-existent session", async () => {
      const fakeId = randomUUID();
      const body = { sessionId: fakeId, accept: true };
      const headers = signedHeaders("POST", "/negotiate", body);
      const res = await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 409 if session is not in handshake phase", async () => {
      // First accept the session to move it to execute
      const acceptBody = { sessionId, accept: true };
      const acceptHeaders = signedHeaders("POST", "/negotiate", acceptBody);
      await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...acceptHeaders, "content-type": "application/json" },
        payload: acceptBody,
      });

      // Try to negotiate again
      const body = { sessionId, accept: true };
      const headers = signedHeaders("POST", "/negotiate", body);
      const res = await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("invalid_phase_transition");
    });

    it("rejects negotiation from a different agent", async () => {
      const otherAgent = "agent-other";
      const otherKeys = generateAgentKeys();
      keyMap.set(otherAgent, otherKeys.publicKeyPem);

      const body = { sessionId, accept: true };
      const hash = bodyHash(body);
      const headers = signRequest({
        method: "POST",
        path: "/negotiate",
        bodyHash: hash,
        privateKeyPem: otherKeys.privateKeyPem,
        agentId: otherAgent,
      });
      const res = await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("session_owner_mismatch");
    });

    it("rejects invalid negotiate body (missing sessionId)", async () => {
      const body = { accept: true };
      const headers = signedHeaders("POST", "/negotiate", body);
      const res = await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("validation_error");
    });
  });

  // -----------------------------------------------------------------------
  // GET /result/:id — poll for result
  // -----------------------------------------------------------------------

  describe("GET /result/:id", () => {
    it("returns 202 while session is still executing", async () => {
      // Use a cloud model with a delay so we can poll before it completes
      const slowProvider = makeCloudProvider(undefined, 500);
      ({ app, store, stopCleanup, provider, keyMap } = await buildApp(slowProvider));

      // Create and negotiate
      const reviewBody = reviewPayload();
      const reviewHeaders = signedHeaders("POST", "/review", reviewBody);
      const createRes = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...reviewHeaders, "content-type": "application/json" },
        payload: reviewBody,
      });
      const sid = createRes.json().reviewId;

      const negBody = { sessionId: sid, accept: true };
      const negHeaders = signedHeaders("POST", "/negotiate", negBody);
      await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...negHeaders, "content-type": "application/json" },
        payload: negBody,
      });

      // Poll immediately — should be 202
      const path = `/result/${sid}`;
      const getHeaders = signedHeadersGet(path);
      const pollRes = await app.inject({
        method: "GET",
        url: path,
        headers: getHeaders,
      });
      expect(pollRes.statusCode).toBe(202);
      expect(pollRes.json().phase).toBe("execute");
    });

    it("returns result after cloud model completes", async () => {
      const cloudResponse: CloudModelResponse = {
        improvedCode: "// better code",
        codeDiff: "- old\n+ new",
        notes: "Fixed the issue",
      };
      const fastProvider = makeCloudProvider(cloudResponse, 0);
      ({ app, store, stopCleanup, provider, keyMap } = await buildApp(fastProvider));

      // Create and negotiate
      const reviewBody = reviewPayload();
      const reviewHeaders = signedHeaders("POST", "/review", reviewBody);
      const createRes = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...reviewHeaders, "content-type": "application/json" },
        payload: reviewBody,
      });
      const sid = createRes.json().reviewId;

      const negBody = { sessionId: sid, accept: true };
      const negHeaders = signedHeaders("POST", "/negotiate", negBody);
      await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...negHeaders, "content-type": "application/json" },
        payload: negBody,
      });

      // Wait for async execution to complete
      await new Promise((r) => setTimeout(r, 50));

      const path = `/result/${sid}`;
      const getHeaders = signedHeadersGet(path);
      const pollRes = await app.inject({
        method: "GET",
        url: path,
        headers: getHeaders,
      });
      expect(pollRes.statusCode).toBe(200);
      const json = pollRes.json();
      expect(json.phase).toBe("result");
      expect(json.result.improvedCode).toBe("// better code");
      expect(json.result.codeDiff).toBe("- old\n+ new");
      expect(json.result.notes).toBe("Fixed the issue");
    });

    it("returns 404 for non-existent session", async () => {
      ({ app, store, stopCleanup, provider, keyMap } = await buildApp());
      const fakeId = randomUUID();
      const path = `/result/${fakeId}`;
      const headers = signedHeadersGet(path);
      const res = await app.inject({
        method: "GET",
        url: path,
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns failed phase info for failed sessions", async () => {
      ({ app, store, stopCleanup, provider, keyMap } = await buildApp());

      // Create and reject
      const reviewBody = reviewPayload();
      const reviewHeaders = signedHeaders("POST", "/review", reviewBody);
      const createRes = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...reviewHeaders, "content-type": "application/json" },
        payload: reviewBody,
      });
      const sid = createRes.json().reviewId;

      const negBody = { sessionId: sid, accept: false };
      const negHeaders = signedHeaders("POST", "/negotiate", negBody);
      await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...negHeaders, "content-type": "application/json" },
        payload: negBody,
      });

      const path = `/result/${sid}`;
      const getHeaders = signedHeadersGet(path);
      const pollRes = await app.inject({
        method: "GET",
        url: path,
        headers: getHeaders,
      });
      expect(pollRes.statusCode).toBe(200);
      expect(pollRes.json().phase).toBe("failed");
      expect(pollRes.json().failureReason).toBe("agent_rejected");
    });
  });

  // -----------------------------------------------------------------------
  // GET /session/:id — session status
  // -----------------------------------------------------------------------

  describe("GET /session/:id", () => {
    it("returns session metadata", async () => {
      ({ app, store, stopCleanup, provider, keyMap } = await buildApp());

      const reviewBody = reviewPayload();
      const reviewHeaders = signedHeaders("POST", "/review", reviewBody);
      const createRes = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...reviewHeaders, "content-type": "application/json" },
        payload: reviewBody,
      });
      const sid = createRes.json().reviewId;

      const path = `/session/${sid}`;
      const getHeaders = signedHeadersGet(path);
      const res = await app.inject({
        method: "GET",
        url: path,
        headers: getHeaders,
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.sessionId).toBe(sid);
      expect(json.agentId).toBe(AGENT_ID);
      expect(json.phase).toBe("handshake");
      expect(json.queueReason).toBe("timeout");
      expect(json.createdAtMs).toBeGreaterThan(0);
    });

    it("returns 403 if different agent queries session", async () => {
      ({ app, store, stopCleanup, provider, keyMap } = await buildApp());

      const reviewBody = reviewPayload();
      const reviewHeaders = signedHeaders("POST", "/review", reviewBody);
      const createRes = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...reviewHeaders, "content-type": "application/json" },
        payload: reviewBody,
      });
      const sid = createRes.json().reviewId;

      const otherAgent = "agent-intruder";
      const otherKeys = generateAgentKeys();
      keyMap.set(otherAgent, otherKeys.publicKeyPem);

      const path = `/session/${sid}`;
      const otherHeaders = signRequest({
        method: "GET",
        path,
        bodyHash: EMPTY_BODY_HASH,
        privateKeyPem: otherKeys.privateKeyPem,
        agentId: otherAgent,
      });
      const res = await app.inject({
        method: "GET",
        url: path,
        headers: otherHeaders,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("session_owner_mismatch");
    });
  });

  // -----------------------------------------------------------------------
  // Cloud model failure handling
  // -----------------------------------------------------------------------

  describe("cloud model failure", () => {
    it("marks session as failed when cloud model throws", async () => {
      const failProvider = makeCloudProvider(undefined, 0, true);
      ({ app, store, stopCleanup, provider, keyMap } = await buildApp(failProvider));

      // Create and negotiate
      const reviewBody = reviewPayload();
      const reviewHeaders = signedHeaders("POST", "/review", reviewBody);
      const createRes = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...reviewHeaders, "content-type": "application/json" },
        payload: reviewBody,
      });
      const sid = createRes.json().reviewId;

      const negBody = { sessionId: sid, accept: true };
      const negHeaders = signedHeaders("POST", "/negotiate", negBody);
      await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...negHeaders, "content-type": "application/json" },
        payload: negBody,
      });

      // Wait for async execution to complete
      await new Promise((r) => setTimeout(r, 50));

      const session = store.get(sid)!;
      expect(session.phase).toBe("failed");
      expect(session.failureReason).toContain("cloud_model_error");
      expect(session.failureReason).toContain("cloud_model_unavailable");
    });
  });

  // -----------------------------------------------------------------------
  // Session timeout and cleanup
  // -----------------------------------------------------------------------

  describe("session timeout and cleanup", () => {
    it("expires stale sessions", async () => {
      ({ app, store, stopCleanup, provider, keyMap } = await buildApp(
        makeCloudProvider(undefined, 10_000), // very slow — won't complete
        { sessionTimeoutMs: 100, cleanupIntervalMs: 50 }
      ));

      // Create and negotiate
      const reviewBody = reviewPayload();
      const reviewHeaders = signedHeaders("POST", "/review", reviewBody);
      const createRes = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...reviewHeaders, "content-type": "application/json" },
        payload: reviewBody,
      });
      const sid = createRes.json().reviewId;

      const negBody = { sessionId: sid, accept: true };
      const negHeaders = signedHeaders("POST", "/negotiate", negBody);
      await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...negHeaders, "content-type": "application/json" },
        payload: negBody,
      });

      // Wait for cleanup to run
      await new Promise((r) => setTimeout(r, 200));

      const session = store.get(sid)!;
      expect(session.phase).toBe("expired");
      expect(session.failureReason).toBe("session_timeout");
    });

    it("does not expire completed sessions", async () => {
      const fastProvider = makeCloudProvider({ improvedCode: "// ok" }, 0);
      ({ app, store, stopCleanup, provider, keyMap } = await buildApp(fastProvider, {
        sessionTimeoutMs: 100,
        cleanupIntervalMs: 50,
      }));

      // Create and negotiate
      const reviewBody = reviewPayload();
      const reviewHeaders = signedHeaders("POST", "/review", reviewBody);
      const createRes = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...reviewHeaders, "content-type": "application/json" },
        payload: reviewBody,
      });
      const sid = createRes.json().reviewId;

      const negBody = { sessionId: sid, accept: true };
      const negHeaders = signedHeaders("POST", "/negotiate", negBody);
      await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...negHeaders, "content-type": "application/json" },
        payload: negBody,
      });

      // Wait for cloud model to finish and cleanup to run
      await new Promise((r) => setTimeout(r, 200));

      const session = store.get(sid)!;
      expect(session.phase).toBe("result");
    });

    it("stopCleanup halts the interval", async () => {
      ({ app, store, stopCleanup, provider, keyMap } = await buildApp(
        makeCloudProvider(undefined, 10_000),
        { sessionTimeoutMs: 50, cleanupIntervalMs: 30 }
      ));

      // Create a session
      const reviewBody = reviewPayload();
      const reviewHeaders = signedHeaders("POST", "/review", reviewBody);
      const createRes = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...reviewHeaders, "content-type": "application/json" },
        payload: reviewBody,
      });
      const sid = createRes.json().reviewId;

      // Stop cleanup before it can expire the session
      stopCleanup();

      // Wait longer than the timeout + cleanup interval
      await new Promise((r) => setTimeout(r, 150));

      const session = store.get(sid)!;
      // Session should still be in handshake since cleanup was stopped
      expect(session.phase).toBe("handshake");
    });
  });

  // -----------------------------------------------------------------------
  // SessionStore unit tests
  // -----------------------------------------------------------------------

  describe("SessionStore", () => {
    it("tracks sessions per agent", () => {
      const s = new SessionStore();
      const session: HandshakeSession = {
        sessionId: randomUUID(),
        agentId: "a1",
        phase: "handshake",
        task: "test",
        queueReason: "manual",
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };
      s.set(session);
      expect(s.activeCountForAgent("a1")).toBe(1);
      expect(s.activeCountForAgent("a2")).toBe(0);
      expect(s.size).toBe(1);
    });

    it("delete removes session and cleans up agent index", () => {
      const s = new SessionStore();
      const sid = randomUUID();
      s.set({
        sessionId: sid,
        agentId: "a1",
        phase: "handshake",
        task: "test",
        queueReason: "manual",
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      expect(s.delete(sid)).toBe(true);
      expect(s.get(sid)).toBeUndefined();
      expect(s.activeCountForAgent("a1")).toBe(0);
      expect(s.delete(sid)).toBe(false);
    });

    it("does not count terminal-phase sessions as active", () => {
      const s = new SessionStore();
      for (const phase of ["result", "failed", "expired"] as const) {
        s.set({
          sessionId: randomUUID(),
          agentId: "a1",
          phase,
          task: "test",
          queueReason: "manual",
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        });
      }
      expect(s.activeCountForAgent("a1")).toBe(0);
      expect(s.size).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Full handshake lifecycle (integration)
  // -----------------------------------------------------------------------

  describe("full handshake lifecycle", () => {
    it("completes handshake -> negotiate -> execute -> result", async () => {
      const cloudResponse: CloudModelResponse = {
        revisedPlan: "Better plan",
        improvedCode: 'console.log("fixed");',
        notes: "Done",
      };
      const fastProvider = makeCloudProvider(cloudResponse, 0);
      ({ app, store, stopCleanup, provider, keyMap } = await buildApp(fastProvider));

      // Step 1: Create session (handshake phase)
      const reviewBody = reviewPayload({ task: "fix the widget", queueReason: "model_limit" });
      const reviewHeaders = signedHeaders("POST", "/review", reviewBody);
      const createRes = await app.inject({
        method: "POST",
        url: "/review",
        headers: { ...reviewHeaders, "content-type": "application/json" },
        payload: reviewBody,
      });
      expect(createRes.statusCode).toBe(201);
      const sid = createRes.json().reviewId;

      // Step 2: Negotiate (accept)
      const negBody = { sessionId: sid, accept: true };
      const negHeaders = signedHeaders("POST", "/negotiate", negBody);
      const negRes = await app.inject({
        method: "POST",
        url: "/negotiate",
        headers: { ...negHeaders, "content-type": "application/json" },
        payload: negBody,
      });
      expect(negRes.statusCode).toBe(200);
      expect(negRes.json().phase).toBe("execute");

      // Step 3: Wait for async cloud model
      await new Promise((r) => setTimeout(r, 50));

      // Step 4: Poll for result
      const resultPath = `/result/${sid}`;
      const resultHeaders = signedHeadersGet(resultPath);
      const resultRes = await app.inject({
        method: "GET",
        url: resultPath,
        headers: resultHeaders,
      });
      expect(resultRes.statusCode).toBe(200);
      const result = resultRes.json();
      expect(result.phase).toBe("result");
      expect(result.result.revisedPlan).toBe("Better plan");
      expect(result.result.improvedCode).toBe('console.log("fixed");');

      // Verify cloud model was called with correct args
      expect(fastProvider.execute).toHaveBeenCalledOnce();
      const callArgs = (fastProvider.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.task).toBe("fix the widget");
      expect(callArgs.queueReason).toBe("model_limit");
      expect(callArgs.sessionId).toBe(sid);
    });
  });
});
