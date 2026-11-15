import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * Agent attacker model: a user's own valid registration token must not bind someone else's agent
 * id. The portal's /internal/nodes/validate falls back to the device's canonical node when the
 * named node is not enrolled, so it can validate a different node (owned by the caller) than the
 * agent id the caller names. The coordinator then linked ownership to, and accepted a new key for,
 * the named agent.
 */

const VICTIM_TOKEN = "victim-registration-token";
const ATTACKER_TOKEN = "attacker-registration-token";
const REMOTE = "203.0.113.41";
let portal: Server;
let app: any;

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "content-type": "application/json" });
      if (body.registrationToken === VICTIM_TOKEN) {
        res.end(JSON.stringify({ allowed: true, reason: "ok", node: { nodeId: body.nodeId, ownerUserId: "victim-user" } }));
      } else if (body.registrationToken === ATTACKER_TOKEN) {
        // The device fallback: the attacker's own enrolled node answers for an unenrolled id.
        res.end(JSON.stringify({ allowed: true, reason: "ok", node: { nodeId: "attacker-node", ownerUserId: "attacker-user" } }));
      } else {
        res.end(JSON.stringify({ allowed: false, reason: "invalid_token" }));
      }
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = "mesh-secret-takeover";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

function register(agentId: string, key: PeerKeys, token: string, remoteAddress = REMOTE) {
  const payload = JSON.stringify({ os: "macos", version: "1", mode: "swarm-only", agentId, registrationToken: token, publicKeyPem: key.publicKeyPem });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: key.privateKeyPem, agentId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url: "/register", remoteAddress, headers: { "content-type": "application/json", ...signed }, payload });
}
function heartbeat(agentId: string, keys: PeerKeys) {
  const payload = JSON.stringify({ agentId });
  const signed = signRequest({ method: "POST", path: "/heartbeat", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url: "/heartbeat", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
}

describe("another user's token cannot take over a known agent id", () => {
  test("re-keying a victim's agent through the attacker's node is refused and the victim keeps its key", async () => {
    const victim = createPeerKeys("agent-victim-1");
    const attacker = createPeerKeys("agent-victim-1");
    expect((await register("agent-victim-1", victim, VICTIM_TOKEN)).statusCode).toBe(200);
    const res = await register("agent-victim-1", attacker, ATTACKER_TOKEN);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("node_id_mismatch_for_known_agent");
    expect((await heartbeat("agent-victim-1", attacker)).statusCode).toBe(401);
    expect((await heartbeat("agent-victim-1", victim)).statusCode).toBe(200);
  });

  test("an embedded (loopback-registered) worker cannot be taken over either", async () => {
    const owner = createPeerKeys("node-embedded1");
    const attacker = createPeerKeys("node-embedded1");
    expect((await register("node-embedded1", owner, "unused-token-loopback", "127.0.0.1")).statusCode).toBe(200);
    expect((await register("node-embedded1", attacker, ATTACKER_TOKEN)).statusCode).toBe(403);
  });

  test("the caller's own new agent via its device's node still registers", async () => {
    const fresh = createPeerKeys("agent-new-device");
    expect((await register("agent-new-device", fresh, ATTACKER_TOKEN)).statusCode).toBe(200);
  });
});

describe("portalBindDecision", () => {
  test("ownership never moves between portal users; another node needs proof of the stored key", async () => {
    const { portalBindDecision } = await import("../../src/swarm/coordinator/enrollment.js");
    const base = { requestedAgentId: "a1", knownAgent: true, proofOfKey: false };
    expect(portalBindDecision({ ...base, validatedNodeId: "a1", validatedOwnerUserId: "u2", existingOwnerUserId: "u1" })).toEqual({ ok: false, reason: "agent_owned_by_another_account" });
    expect(portalBindDecision({ ...base, validatedNodeId: "a1", validatedOwnerUserId: "u2", existingOwnerUserId: "u1", proofOfKey: true })).toEqual({ ok: false, reason: "agent_owned_by_another_account" });
    expect(portalBindDecision({ ...base, validatedNodeId: "a1", validatedOwnerUserId: "u1", existingOwnerUserId: "u1" })).toEqual({ ok: true });
    expect(portalBindDecision({ ...base, validatedNodeId: "dev-node", validatedOwnerUserId: "u1" })).toEqual({ ok: false, reason: "node_id_mismatch_for_known_agent" });
    expect(portalBindDecision({ ...base, validatedNodeId: "dev-node", validatedOwnerUserId: "u1", proofOfKey: true })).toEqual({ ok: true });
    expect(portalBindDecision({ ...base, knownAgent: false, validatedNodeId: "dev-node", validatedOwnerUserId: "u1" })).toEqual({ ok: true });
    // Same node, a re-install with a new key and its own token: allowed (the portal owns that node).
    expect(portalBindDecision({ ...base, validatedNodeId: "a1", validatedOwnerUserId: "u1" })).toEqual({ ok: true });
  });
});
