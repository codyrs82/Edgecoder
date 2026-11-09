import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * REQUIRE_VERIFIED_AGENTS (real coordinator app, Fastify inject): an agent /register refuses for a
 * missing binary attestation gets no work from /pull, even though its key was stored.
 */

const MESH = "mesh-secret-verified";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.80";
let portal: Server;
let app: any;
const agent = createPeerKeys("agent-unverified-binary");

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
  process.env.REQUIRE_VERIFIED_AGENTS = "true";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  delete process.env.REQUIRE_VERIFIED_AGENTS;
});

function signedPost(url: string, body: unknown) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: agent.privateKeyPem, agentId: agent.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

describe("REQUIRE_VERIFIED_AGENTS", () => {
  test("an agent refused for a missing attestation gets no work", async () => {
    const reg = await signedPost("/register", { os: "linux", version: "1", mode: "swarm-only", agentId: agent.peerId, registrationToken: VALID_TOKEN, publicKeyPem: agent.publicKeyPem, sandboxMode: "docker" });
    expect(reg.statusCode).toBe(403);
    const pull = await signedPost("/pull", { agentId: agent.peerId });
    expect(pull.statusCode).toBe(403);
    expect(pull.json().error).toBe("binary_integrity_required");
  });
});
