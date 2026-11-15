import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { PreAuthFailureCounter } from "../../src/swarm/coordinator-utils.js";

/*
 * Requests whose signature does not verify prove nothing about the agent they name (real
 * coordinator app, Fastify inject): they are not counted against that agent, so forged requests
 * cannot get it blacklisted or use up its rate limit. They count against the sending address.
 */

const MESH = "mesh-secret-preauth";
const VALID_TOKEN = "valid-registration-token";
const VICTIM_IP = "203.0.113.60";
const ATTACKER_IP = "198.51.100.7";
let portal: Server;
let app: any;
const victim = createPeerKeys("agent-preauth-victim");
const forger = createPeerKeys("agent-preauth-forger");

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
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  expect((await register(victim, victim, VICTIM_IP, VALID_TOKEN)).statusCode).toBe(200);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

/** /register for `agent`, signed by `signer` (a different key = a forged signature). */
function register(agent: PeerKeys, signer: PeerKeys, ip: string, token?: string) {
  const payload = JSON.stringify({ os: "linux", version: "1", mode: "swarm-only", agentId: agent.peerId, ...(token ? { registrationToken: token, publicKeyPem: agent.publicKeyPem } : {}) });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: agent.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url: "/register", remoteAddress: ip, headers: { "content-type": "application/json", ...signed }, payload });
}

function heartbeat(agent: PeerKeys, ip: string) {
  const payload = JSON.stringify({ agentId: agent.peerId });
  const signed = signRequest({ method: "POST", path: "/heartbeat", bodyHash: hashRequestBody(payload), privateKeyPem: agent.privateKeyPem, agentId: agent.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url: "/heartbeat", remoteAddress: ip, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

describe("pre-authentication failures", () => {
  test("forged signatures naming an agent do not get it blacklisted", async () => {
    for (let i = 0; i < 8; i++) expect((await register(victim, forger, ATTACKER_IP)).statusCode).toBeGreaterThanOrEqual(400);
    // The victim's own requests still go through (re-registering runs the behaviour checks) and it is on no blacklist.
    expect((await register(victim, victim, VICTIM_IP, VALID_TOKEN)).statusCode).toBe(200);
    expect((await heartbeat(victim, VICTIM_IP)).statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/security/blacklist", remoteAddress: VICTIM_IP, headers: { "x-mesh-token": MESH } });
    expect(list.json().records.map((r: { agentId: string }) => r.agentId)).not.toContain(victim.peerId);
  });
});

describe("PreAuthFailureCounter", () => {
  test("blocks an address past its failures for the window, and only that address", () => {
    const c = new PreAuthFailureCounter(3, 1000);
    for (let i = 0; i < 3; i++) c.record("1.1.1.1", 0);
    expect(c.blocked("1.1.1.1", 10)).toBe(true);
    expect(c.blocked("2.2.2.2", 10)).toBe(false);
    expect(c.blocked("1.1.1.1", 1000)).toBe(false);
  });
});
