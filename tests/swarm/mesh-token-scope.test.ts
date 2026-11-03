import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { publicKeyFingerprint, signRegistration } from "../../src/mesh/peer-trust.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * The shared mesh token is a transport gate only (real coordinator app, Fastify inject):
 * - operator routes (treasury, issuance, prices, forced model rollouts) need the admin token;
 * - agent-self routes need the named agent's own signature;
 * - market orders are limited to the signer's own account (the portal may name any account);
 * - coordinator registration needs an allowlisted, signed peer key.
 */

const MESH = "mesh-secret-scope";
const ADMIN = "admin-secret-scope";
const PORTAL = "portal-secret-scope";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.20";
const peerKey = createPeerKeys("coord-allowed");
let portal: Server;
let app: any;
const agentA = createPeerKeys("agent-scope-a");
const agentB = createPeerKeys("agent-scope-b");

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
  process.env.ADMIN_API_TOKEN = ADMIN;
  process.env.PORTAL_SERVICE_TOKEN = PORTAL;
  process.env.MESH_PEER_ALLOWLIST = `coord-allowed:${publicKeyFingerprint(peerKey.publicKeyPem)}@https://peer.invalid`;
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  for (const keys of [agentA, agentB]) {
    const payload = JSON.stringify({ os: "macos", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem });
    const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
    const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
    expect(res.statusCode).toBe(200);
  }
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  delete process.env.MESH_PEER_ALLOWLIST;
});

/** POST with the mesh token; `signer` signs the exact body bytes for `url`. */
function post(url: string, body: unknown, opts: { signer?: PeerKeys; headers?: Record<string, string> } = {}) {
  const payload = JSON.stringify(body);
  const signed = opts.signer
    ? (signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: opts.signer.privateKeyPem, agentId: opts.signer.peerId }) as unknown as Record<string, string>)
    : {};
  return app.inject({
    method: "POST",
    url,
    remoteAddress: REMOTE,
    headers: { "content-type": "application/json", "x-mesh-token": MESH, ...(opts.headers ?? {}), ...signed },
    payload
  });
}

describe("operator routes refuse the bare mesh token", () => {
  const routes: Array<[string, unknown]> = [
    ["/economy/treasury/policies", { treasuryAccountId: "treasury-1", multisigDescriptor: "wsh(multi(2,a,b,c))", quorumThreshold: 1, totalCustodians: 1, approvedCoordinatorIds: ["attacker"] }],
    ["/economy/treasury/policies/policy-1/activate", {}],
    ["/economy/issuance/quorum/vote", { epochId: "epoch-1", vote: "approve" }],
    ["/economy/issuance/recalculate", {}],
    ["/economy/price/propose", { coordinatorId: "c", cpuCapacity: 1, gpuCapacity: 0, queuedTasks: 0, activeAgents: 1 }],
    ["/economy/price/consensus", { cpuCapacity: 1, gpuCapacity: 0, queuedTasks: 0, activeAgents: 1 }],
    ["/economy/payments/intents", { accountId: "acct-victim", amountSats: 1000 }],
    ["/economy/payments/reconcile", {}],
    ["/orchestration/coordinator/ollama-install", { model: "attacker/model" }],
    ["/orchestration/agents/agent-scope-b/ollama-install", { model: "attacker/model" }]
  ];
  test.each(routes)("%s: 401 with the mesh token alone", async (url, body) => {
    const res = await post(url, body);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_admin_token");
  });

  test.each(routes)("%s: an agent's own signature is not admin either", async (url, body) => {
    expect((await post(url, body, { signer: agentA })).statusCode).toBe(401);
  });

  test("with the admin token a forced rollout and a treasury policy go through", async () => {
    const rollout = await post("/orchestration/agents/agent-scope-b/ollama-install", { model: "qwen3.5:9b" }, { headers: { "x-admin-token": ADMIN } });
    expect(rollout.statusCode).toBe(200);
    expect(rollout.json().agentId).toBe("agent-scope-b");
    const policy = await post("/economy/treasury/policies", routes[0][1], { headers: { "x-admin-token": ADMIN } });
    expect(policy.statusCode).toBe(200);
  });
});

describe("agent-self routes take the agent from its signature", () => {
  const offer = { fromAgentId: "agent-scope-a", toAgentId: "agent-scope-b", workType: "code_task", language: "python", input: "print(1)" };

  test("unsigned (mesh token only) is refused", async () => {
    const res = await post("/agent-mesh/direct-work/offer", offer);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("agent_signature_required");
    expect((await post("/agent-mesh/models/request", { fromAgentId: "agent-scope-a", toAgentId: "agent-scope-b", prompt: "hi" })).statusCode).toBe(401);
    expect((await post("/agent-mesh/connect", { fromAgentId: "agent-scope-a", toAgentId: "agent-scope-b" })).statusCode).toBe(401);
    expect((await post("/orchestration/agents/agent-scope-b/ack", { ok: true })).statusCode).toBe(401);
  });

  test("an agent cannot act as another agent", async () => {
    const res = await post("/agent-mesh/direct-work/offer", offer, { signer: agentB });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("agent_identity_mismatch");
    expect((await post("/agent-mesh/models/request", { fromAgentId: "agent-scope-a", toAgentId: "agent-scope-b", prompt: "hi" }, { signer: agentB })).statusCode).toBe(403);
    expect((await post("/orchestration/agents/agent-scope-b/status", { phase: "done", message: "spoofed" }, { signer: agentA })).statusCode).toBe(403);
    expect((await post("/orchestration/agents/agent-scope-b/ack", { ok: true }, { signer: agentA })).statusCode).toBe(403);
  });

  test("a signed offer from the agent itself works, and only the target may accept it", async () => {
    const res = await post("/agent-mesh/direct-work/offer", offer, { signer: agentA });
    expect(res.statusCode).toBe(200);
    const { offerId } = res.json();
    expect((await post("/agent-mesh/direct-work/accept", { offerId, byAgentId: "agent-scope-b" }, { signer: agentA })).statusCode).toBe(403);
    expect((await post("/agent-mesh/direct-work/accept", { offerId, byAgentId: "agent-scope-b" })).statusCode).toBe(401);
    expect((await post("/agent-mesh/direct-work/accept", { offerId, byAgentId: "agent-scope-b" }, { signer: agentB })).statusCode).toBe(200);
    expect((await post("/agent-mesh/direct-work/result", { offerId, byAgentId: "agent-scope-b", ok: true, output: "forged", durationMs: 1 }, { signer: agentA })).statusCode).toBe(403);
    expect((await post("/agent-mesh/direct-work/result", { offerId, byAgentId: "agent-scope-b", ok: true, output: "1", durationMs: 1 }, { signer: agentB })).statusCode).toBe(200);
  });

  test("the rolled-out agent acks its own rollout with its signature", async () => {
    await post("/orchestration/agents/agent-scope-b/ollama-install", { model: "qwen3.5:9b" }, { headers: { "x-admin-token": ADMIN } });
    expect((await post("/orchestration/agents/agent-scope-b/status", { phase: "pulling", message: "50%" }, { signer: agentB })).statusCode).toBe(200);
    expect((await post("/orchestration/agents/agent-scope-b/ack", { ok: true }, { signer: agentB })).statusCode).toBe(200);
  });
});

describe("market orders are limited to the caller's own account", () => {
  const order = (accountId: string) => ({ accountId, side: "sell", computeClass: "any", msatPerCredit: 0 });

  test("the mesh token alone cannot set any account's orders", async () => {
    expect((await post("/economy/market/orders", order("acct-victim"))).statusCode).toBe(401);
  });

  test("a signed agent may set its own account's orders but not another's", async () => {
    // No ownership link in this test (no Postgres), so the agent's account is its own id.
    expect((await post("/economy/market/orders", order("agent-scope-a"), { signer: agentA })).statusCode).toBe(200);
    const other = await post("/economy/market/orders", order("acct-victim"), { signer: agentA });
    expect(other.statusCode).toBe(403);
    expect(other.json().error).toBe("account_mismatch");
  });

  test("the portal (service token) names the account it bound from the session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/economy/market/orders",
      remoteAddress: REMOTE,
      headers: { "content-type": "application/json", "x-portal-service-token": PORTAL },
      payload: JSON.stringify(order("acct-user-1"))
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("coordinator-to-coordinator registration needs an allowlisted signed key", () => {
  const fields = (keys: PeerKeys, peerId = keys.peerId) => ({
    peerId,
    publicKeyPem: keys.publicKeyPem,
    coordinatorUrl: "https://peer.invalid",
    networkMode: "public_mesh" as const,
    role: "coordinator" as const
  });

  test("a key that is not allowlisted is refused even with the mesh token", async () => {
    const stranger = createPeerKeys("coord-stranger");
    const body = { ...fields(stranger), ...signRegistration(fields(stranger), stranger.privateKeyPem) };
    const res = await post("/mesh/register-peer", body);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("peer_not_allowlisted");
  });

  test("an allowlisted peer id with someone else's key is refused", async () => {
    const impostor = createPeerKeys("coord-allowed");
    const body = { ...fields(impostor), ...signRegistration(fields(impostor), impostor.privateKeyPem) };
    expect((await post("/mesh/register-peer", body)).statusCode).toBe(403);
  });

  test("an allowlisted key without a signature is refused", async () => {
    const res = await post("/mesh/register-peer", fields(peerKey));
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("peer_signature_required");
  });

  test("an allowlisted key with a valid signature is admitted", async () => {
    const body = { ...fields(peerKey), ...signRegistration(fields(peerKey), peerKey.privateKeyPem) };
    expect((await post("/mesh/register-peer", body)).statusCode).toBe(200);
  });
});
