import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createPeerKeys, signPayload } from "../../src/mesh/peer.js";
import { buildBlacklistEventHash } from "../../src/security/blacklist.js";
import type { BlacklistRecord } from "../../src/common/types.js";

// ---------------------------------------------------------------------------
// Mock undici — every test configures its own HTTP responses.
// ---------------------------------------------------------------------------

const mockRequest = vi.fn();
vi.mock("undici", () => ({ request: (...args: unknown[]) => mockRequest(...args) }));

// ---------------------------------------------------------------------------
// The verify-blacklist-audit module executes `main()` at import time and
// calls `process.exit(1)` on failure.  We stub process.exit and console
// methods to capture the output without killing the test runner.
// ---------------------------------------------------------------------------

let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers — build a valid blacklist chain that the verifier will accept.
// ---------------------------------------------------------------------------

function makeBlacklistEvent(input: {
  prevEventHash: string;
  coordinatorId: string;
  coordinatorPrivateKey: string;
}): BlacklistRecord {
  const eventId = randomUUID();
  const timestampMs = Date.now();
  const eventHash = buildBlacklistEventHash({
    eventId,
    agentId: "agent-bad",
    reasonCode: "policy_violation",
    reason: "submitted forged outputs",
    evidenceHashSha256: "a".repeat(64),
    reporterId: "reporter-1",
    sourceCoordinatorId: input.coordinatorId,
    timestampMs,
    prevEventHash: input.prevEventHash,
    evidenceSignatureVerified: true
  });

  return {
    eventId,
    agentId: "agent-bad",
    reason: "submitted forged outputs",
    reasonCode: "policy_violation",
    evidenceHashSha256: "a".repeat(64),
    reporterId: "reporter-1",
    evidenceSignatureVerified: true,
    sourceCoordinatorId: input.coordinatorId,
    reportedBy: "policy-engine",
    timestampMs,
    prevEventHash: input.prevEventHash,
    eventHash,
    coordinatorSignature: signPayload(eventHash, input.coordinatorPrivateKey)
  };
}

function jsonBody<T>(data: T) {
  return { json: () => Promise.resolve(data) };
}

/** Configure mockRequest to return the right JSON for each URL pattern. */
function setupHttpResponses(responses: {
  audit: { chainHead: string; events: BlacklistRecord[] };
  identity: { peerId: string; publicKeyPem: string };
  peers?: { peers: Array<{ peerId: string; publicKeyPem: string }> };
}) {
  mockRequest.mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/security/blacklist/audit")) {
      return Promise.resolve({ statusCode: 200, body: jsonBody(responses.audit) });
    }
    if (typeof url === "string" && url.includes("/identity")) {
      return Promise.resolve({ statusCode: 200, body: jsonBody(responses.identity) });
    }
    if (typeof url === "string" && url.includes("/mesh/peers")) {
      return Promise.resolve({
        statusCode: 200,
        body: jsonBody(responses.peers ?? { peers: [] })
      });
    }
    return Promise.resolve({ statusCode: 404, body: jsonBody({ error: "not found" }) });
  });
}

async function runVerifier() {
  vi.resetModules();
  try {
    await import("../../src/bootstrap/verify-blacklist-audit.js");
  } catch {
    // process.exit stub — expected
  }
  // Allow microtasks / Promises to settle
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verify-blacklist-audit", () => {
  beforeEach(() => {
    mockRequest.mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    setEnv({
      CONTROL_PLANE_URL: "http://127.0.0.1:4303",
      COORDINATOR_URL: "http://127.0.0.1:4301",
      ADMIN_API_TOKEN: undefined,
      MESH_AUTH_TOKEN: undefined,
      COORDINATOR_MESH_TOKEN: undefined
    });
  });

  afterEach(() => {
    restoreEnv();
    exitSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // ---- Audit verification pass scenarios ----

  it("passes verification with an empty event chain", async () => {
    const coord = createPeerKeys("coord-1");

    setupHttpResponses({
      audit: { chainHead: "BLACKLIST_GENESIS", events: [] },
      identity: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem }
    });

    await runVerifier();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalled();
    const logged = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(logged.ok).toBe(true);
    expect(logged.eventsVerified).toBe(0);
    expect(logged.chainHead).toBe("BLACKLIST_GENESIS");
  });

  it("passes verification with a single valid event", async () => {
    const coord = createPeerKeys("coord-1");
    const event = makeBlacklistEvent({
      prevEventHash: "BLACKLIST_GENESIS",
      coordinatorId: coord.peerId,
      coordinatorPrivateKey: coord.privateKeyPem
    });

    setupHttpResponses({
      audit: { chainHead: event.eventHash, events: [event] },
      identity: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem }
    });

    await runVerifier();

    expect(exitSpy).not.toHaveBeenCalled();
    const logged = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(logged.ok).toBe(true);
    expect(logged.eventsVerified).toBe(1);
  });

  it("passes verification with a multi-event chain", async () => {
    const coord = createPeerKeys("coord-1");
    const first = makeBlacklistEvent({
      prevEventHash: "BLACKLIST_GENESIS",
      coordinatorId: coord.peerId,
      coordinatorPrivateKey: coord.privateKeyPem
    });
    const second = makeBlacklistEvent({
      prevEventHash: first.eventHash,
      coordinatorId: coord.peerId,
      coordinatorPrivateKey: coord.privateKeyPem
    });
    const third = makeBlacklistEvent({
      prevEventHash: second.eventHash,
      coordinatorId: coord.peerId,
      coordinatorPrivateKey: coord.privateKeyPem
    });

    setupHttpResponses({
      audit: { chainHead: third.eventHash, events: [first, second, third] },
      identity: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem }
    });

    await runVerifier();

    expect(exitSpy).not.toHaveBeenCalled();
    const logged = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(logged.ok).toBe(true);
    expect(logged.eventsVerified).toBe(3);
  });

  it("resolves coordinator key from peers list (not just identity)", async () => {
    const localCoord = createPeerKeys("local-coord");
    const remoteCoord = createPeerKeys("remote-coord");

    // Event signed by the remote coordinator
    const event = makeBlacklistEvent({
      prevEventHash: "BLACKLIST_GENESIS",
      coordinatorId: remoteCoord.peerId,
      coordinatorPrivateKey: remoteCoord.privateKeyPem
    });

    setupHttpResponses({
      audit: { chainHead: event.eventHash, events: [event] },
      identity: { peerId: localCoord.peerId, publicKeyPem: localCoord.publicKeyPem },
      peers: {
        peers: [{ peerId: remoteCoord.peerId, publicKeyPem: remoteCoord.publicKeyPem }]
      }
    });

    await runVerifier();

    expect(exitSpy).not.toHaveBeenCalled();
    const logged = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(logged.ok).toBe(true);
  });

  // ---- Audit verification fail scenarios ----

  it("fails on hash chain break (prevEventHash mismatch)", async () => {
    const coord = createPeerKeys("coord-1");
    const first = makeBlacklistEvent({
      prevEventHash: "BLACKLIST_GENESIS",
      coordinatorId: coord.peerId,
      coordinatorPrivateKey: coord.privateKeyPem
    });
    const second = makeBlacklistEvent({
      prevEventHash: "WRONG_PREV_HASH", // chain break!
      coordinatorId: coord.peerId,
      coordinatorPrivateKey: coord.privateKeyPem
    });

    setupHttpResponses({
      audit: { chainHead: second.eventHash, events: [first, second] },
      identity: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem }
    });

    await runVerifier();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorJson = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
    expect(errorJson.ok).toBe(false);
    expect(errorJson.error).toContain("hash_chain_break");
  });

  it("fails on event hash mismatch (tampered event)", async () => {
    const coord = createPeerKeys("coord-1");
    const event = makeBlacklistEvent({
      prevEventHash: "BLACKLIST_GENESIS",
      coordinatorId: coord.peerId,
      coordinatorPrivateKey: coord.privateKeyPem
    });
    // Tamper with the reason after the hash was computed
    const tampered = { ...event, reason: "tampered reason" };

    setupHttpResponses({
      audit: { chainHead: event.eventHash, events: [tampered] },
      identity: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem }
    });

    await runVerifier();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorJson = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
    expect(errorJson.ok).toBe(false);
    expect(errorJson.error).toContain("event_hash_mismatch");
  });

  it("fails when coordinator key is missing for an event", async () => {
    const coord = createPeerKeys("coord-1");
    const unknownCoord = createPeerKeys("unknown-coord");

    // Event signed by a coordinator whose key is not in identity or peers
    const event = makeBlacklistEvent({
      prevEventHash: "BLACKLIST_GENESIS",
      coordinatorId: unknownCoord.peerId,
      coordinatorPrivateKey: unknownCoord.privateKeyPem
    });

    setupHttpResponses({
      audit: { chainHead: event.eventHash, events: [event] },
      identity: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem },
      peers: { peers: [] }
    });

    await runVerifier();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorJson = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
    expect(errorJson.ok).toBe(false);
    expect(errorJson.error).toContain("missing_coordinator_key");
  });

  it("fails when coordinator signature is invalid (forged)", async () => {
    const coord = createPeerKeys("coord-1");
    const rogue = createPeerKeys("rogue");

    const event = makeBlacklistEvent({
      prevEventHash: "BLACKLIST_GENESIS",
      coordinatorId: coord.peerId,
      coordinatorPrivateKey: coord.privateKeyPem
    });
    // Replace the signature with one from a different key pair
    const forgedEvent = {
      ...event,
      coordinatorSignature: signPayload(event.eventHash, rogue.privateKeyPem)
    };

    setupHttpResponses({
      audit: { chainHead: event.eventHash, events: [forgedEvent] },
      identity: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem }
    });

    await runVerifier();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorJson = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
    expect(errorJson.ok).toBe(false);
    expect(errorJson.error).toContain("coordinator_signature_invalid");
  });

  it("fails when chain head does not match last event hash", async () => {
    const coord = createPeerKeys("coord-1");
    const event = makeBlacklistEvent({
      prevEventHash: "BLACKLIST_GENESIS",
      coordinatorId: coord.peerId,
      coordinatorPrivateKey: coord.privateKeyPem
    });

    setupHttpResponses({
      audit: {
        chainHead: "completely_wrong_chain_head", // mismatch
        events: [event]
      },
      identity: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem }
    });

    await runVerifier();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorJson = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
    expect(errorJson.ok).toBe(false);
    expect(errorJson.error).toContain("chain_head_mismatch");
  });

  // ---- Blacklist check integration / HTTP error handling ----

  it("fails when audit endpoint returns non-2xx", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/security/blacklist/audit")) {
        return Promise.resolve({ statusCode: 500, body: jsonBody({ error: "internal" }) });
      }
      if (typeof url === "string" && url.includes("/identity")) {
        return Promise.resolve({
          statusCode: 200,
          body: jsonBody({ peerId: "c", publicKeyPem: "pem" })
        });
      }
      if (typeof url === "string" && url.includes("/mesh/peers")) {
        return Promise.resolve({ statusCode: 200, body: jsonBody({ peers: [] }) });
      }
      return Promise.resolve({ statusCode: 404, body: jsonBody({}) });
    });

    await runVerifier();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorJson = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
    expect(errorJson.ok).toBe(false);
    expect(errorJson.error).toContain("request_failed");
  });

  it("fails when identity endpoint returns non-2xx", async () => {
    const coord = createPeerKeys("coord-1");
    mockRequest.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/security/blacklist/audit")) {
        return Promise.resolve({
          statusCode: 200,
          body: jsonBody({ chainHead: "BLACKLIST_GENESIS", events: [] })
        });
      }
      if (typeof url === "string" && url.includes("/identity")) {
        return Promise.resolve({ statusCode: 401, body: jsonBody({ error: "unauthorized" }) });
      }
      if (typeof url === "string" && url.includes("/mesh/peers")) {
        return Promise.resolve({ statusCode: 200, body: jsonBody({ peers: [] }) });
      }
      return Promise.resolve({ statusCode: 404, body: jsonBody({}) });
    });

    await runVerifier();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorJson = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
    expect(errorJson.ok).toBe(false);
  });

  it("gracefully degrades when /mesh/peers endpoint fails (uses empty list)", async () => {
    const coord = createPeerKeys("coord-1");
    const event = makeBlacklistEvent({
      prevEventHash: "BLACKLIST_GENESIS",
      coordinatorId: coord.peerId,
      coordinatorPrivateKey: coord.privateKeyPem
    });

    // /mesh/peers returns error — the source code catches and defaults to { peers: [] }
    mockRequest.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/security/blacklist/audit")) {
        return Promise.resolve({
          statusCode: 200,
          body: jsonBody({ chainHead: event.eventHash, events: [event] })
        });
      }
      if (typeof url === "string" && url.includes("/identity")) {
        return Promise.resolve({
          statusCode: 200,
          body: jsonBody({ peerId: coord.peerId, publicKeyPem: coord.publicKeyPem })
        });
      }
      if (typeof url === "string" && url.includes("/mesh/peers")) {
        return Promise.reject(new Error("connection refused"));
      }
      return Promise.resolve({ statusCode: 404, body: jsonBody({}) });
    });

    await runVerifier();

    // Should still pass because the coordinator key comes from /identity
    expect(exitSpy).not.toHaveBeenCalled();
    const logged = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(logged.ok).toBe(true);
  });

  // ---- Evidence collection (env var configuration) ----

  it("sends admin token header when ADMIN_API_TOKEN is set", async () => {
    const coord = createPeerKeys("coord-1");
    setEnv({ ADMIN_API_TOKEN: "admin-tok-xyz" });

    setupHttpResponses({
      audit: { chainHead: "BLACKLIST_GENESIS", events: [] },
      identity: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem }
    });

    await runVerifier();

    // Find the audit call
    const auditCall = mockRequest.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("/blacklist/audit")
    );
    expect(auditCall).toBeDefined();
    const headers = auditCall![1]?.headers;
    expect(headers?.["x-admin-token"]).toBe("admin-tok-xyz");
  });

  it("sends mesh token header when MESH_AUTH_TOKEN is set", async () => {
    const coord = createPeerKeys("coord-1");
    setEnv({ MESH_AUTH_TOKEN: "mesh-tok-abc" });

    setupHttpResponses({
      audit: { chainHead: "BLACKLIST_GENESIS", events: [] },
      identity: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem }
    });

    await runVerifier();

    // Find the identity call
    const identityCall = mockRequest.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("/identity")
    );
    expect(identityCall).toBeDefined();
    const headers = identityCall![1]?.headers;
    expect(headers?.["x-mesh-token"]).toBe("mesh-tok-abc");
  });

  it("falls back to COORDINATOR_MESH_TOKEN when MESH_AUTH_TOKEN is not set", async () => {
    const coord = createPeerKeys("coord-1");
    setEnv({
      MESH_AUTH_TOKEN: undefined,
      COORDINATOR_MESH_TOKEN: "coord-mesh-tok"
    });

    setupHttpResponses({
      audit: { chainHead: "BLACKLIST_GENESIS", events: [] },
      identity: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem }
    });

    await runVerifier();

    const identityCall = mockRequest.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("/identity")
    );
    expect(identityCall).toBeDefined();
    const headers = identityCall![1]?.headers;
    expect(headers?.["x-mesh-token"]).toBe("coord-mesh-tok");
  });

  it("uses custom CONTROL_PLANE_URL and COORDINATOR_URL from env", async () => {
    const coord = createPeerKeys("coord-1");
    setEnv({
      CONTROL_PLANE_URL: "http://custom-cp:9000",
      COORDINATOR_URL: "http://custom-coord:9001"
    });

    setupHttpResponses({
      audit: { chainHead: "BLACKLIST_GENESIS", events: [] },
      identity: { peerId: coord.peerId, publicKeyPem: coord.publicKeyPem }
    });

    await runVerifier();

    const urls = mockRequest.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls.some((u) => u.startsWith("http://custom-cp:9000"))).toBe(true);
    expect(urls.some((u) => u.startsWith("http://custom-coord:9001"))).toBe(true);
  });
});
