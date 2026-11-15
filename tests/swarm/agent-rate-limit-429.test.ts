import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * A signed agent request over the per-identity rate limit (real coordinator app, Fastify inject)
 * is answered 429 with Retry-After and `agent_rate_limited`, and is not a protocol violation:
 * it must not look like a bad signature (401), which sends honest clients re-registering into
 * the registration-storm rule (BHV008).
 */

const MESH = "mesh-secret-ratelimit";
const VALID_TOKEN = "valid-registration-token";
const AGENT_IP = "203.0.113.71";
const LIMIT = 4;
let portal: Server;
let app: any;
let behaviorTracker: any;
let activeBlacklistRecord: (id: string) => unknown;
const agent = createPeerKeys("agent-ratelimit-honest");
const other = createPeerKeys("agent-ratelimit-other");

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const allowed = req.url === "/internal/nodes/validate" && body.registrationToken === VALID_TOKEN;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(allowed ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = MESH;
  process.env.AGENT_RATE_LIMIT_MAX = String(LIMIT);
  process.env.AGENT_RATE_LIMIT_WINDOW_MS = "60000";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  ({ behaviorTracker, activeBlacklistRecord } = await import("../../src/swarm/coordinator/agent-state.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  delete process.env.AGENT_RATE_LIMIT_MAX;
  delete process.env.AGENT_RATE_LIMIT_WINDOW_MS;
});

function register(a: PeerKeys, signer: PeerKeys = a) {
  const payload = JSON.stringify({ os: "linux", version: "1", mode: "swarm-only", agentId: a.peerId, registrationToken: VALID_TOKEN, publicKeyPem: a.publicKeyPem });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: a.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url: "/register", remoteAddress: AGENT_IP, headers: { "content-type": "application/json", ...signed }, payload });
}

function heartbeat(a: PeerKeys, signer: PeerKeys = a) {
  const payload = JSON.stringify({ agentId: a.peerId });
  const signed = signRequest({ method: "POST", path: "/heartbeat", bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: a.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url: "/heartbeat", remoteAddress: AGENT_IP, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

describe("signed agent requests over the rate limit", () => {
  test("get 429 agent_rate_limited with Retry-After, and count as no protocol violation", async () => {
    expect((await register(agent)).statusCode).toBe(200);
    for (let i = 0; i < LIMIT; i++) expect((await heartbeat(agent)).statusCode).toBe(200);
    for (let i = 0; i < 20; i++) {
      const res = await heartbeat(agent);
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ error: "agent_rate_limited" });
      const retryAfter = Number(res.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
    }
    const stats = behaviorTracker.getStats(agent.peerId);
    expect(stats.rateLimitHitCount).toBe(0);
    expect(stats.signatureFailureCount).toBe(0);
    expect(stats.replayAttemptCount).toBe(0);
    expect(activeBlacklistRecord(agent.peerId)).toBeUndefined();
  });

  test("a rate-limited /register is refused with 429 and is not counted as a registration", async () => {
    // The limit is still exhausted from the previous test; a signed re-register proves the key
    // (verifyAgentRequest) and so meets the limit too.
    const before = behaviorTracker.getStats(agent.peerId).registrationCount;
    for (let i = 0; i < 12; i++) expect((await register(agent)).statusCode).toBe(429);
    expect(behaviorTracker.getStats(agent.peerId).registrationCount).toBe(before);
    expect(activeBlacklistRecord(agent.peerId)).toBeUndefined();
  });

  test("a real signature failure is still 401", async () => {
    expect((await register(other)).statusCode).toBe(200);
    const res = await heartbeat(other, agent); // signed with the wrong key
    expect(res.statusCode).toBe(401);
  });
});
