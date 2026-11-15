import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * Agent attacker model (docs/security/agent-threat-model.md): whoever installs the agent controls
 * everything it holds. The coordinators' MESH_AUTH_TOKEN must therefore never reach an agent, and
 * an agent must pass the coordinator's global gate with its own key, only on agent routes.
 */

const MESH = "mesh-secret-no-agent";
const PORTAL = "portal-secret-no-agent";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.30";
let portal: Server;
let app: any;
let ctx: any;
const agentA = createPeerKeys("agent-nomesh-a");
const agentB = createPeerKeys("agent-nomesh-b");
const registerResponses: Record<string, any> = {};

function signed(keys: PeerKeys, method: string, path: string, raw: string): Record<string, string> {
  return signRequest({ method, path, bodyHash: hashRequestBody(raw), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
}

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
  process.env.PORTAL_SERVICE_TOKEN = PORTAL;
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  ctx = await import("../../src/swarm/coordinator/context.js");
  await app.ready();
  for (const keys of [agentA, agentB]) {
    const payload = JSON.stringify({ os: "macos", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem });
    const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed(keys, "POST", "/register", payload) }, payload });
    expect(res.statusCode).toBe(200);
    registerResponses[keys.peerId] = res.json();
  }
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

function signedPost(keys: PeerKeys, url: string, body: unknown) {
  const payload = JSON.stringify(body);
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed(keys, "POST", url, payload) }, payload });
}
function signedGet(keys: PeerKeys, url: string) {
  return app.inject({ method: "GET", url, remoteAddress: REMOTE, headers: signed(keys, "GET", url.split("?")[0], "") });
}

describe("agents never receive the coordinators' mesh token", () => {
  test("/register answers without a meshToken", () => {
    expect(registerResponses[agentA.peerId].accepted).toBe(true);
    expect(registerResponses[agentA.peerId].meshToken).toBeUndefined();
    expect(JSON.stringify(registerResponses[agentA.peerId])).not.toContain(MESH);
  });
});

describe("a registered agent passes the gate with its own key, on agent routes only", () => {
  test("signed heartbeat and pull work without any token", async () => {
    expect((await signedPost(agentA, "/heartbeat", { agentId: agentA.peerId })).statusCode).toBe(200);
    expect((await signedPost(agentA, "/pull", { agentId: agentA.peerId })).statusCode).toBe(200);
  });

  test("an unsigned or wrongly signed request is refused at the gate", async () => {
    const payload = JSON.stringify({ agentId: agentA.peerId });
    const unsigned = await app.inject({ method: "POST", url: "/heartbeat", remoteAddress: REMOTE, headers: { "content-type": "application/json" }, payload });
    expect(unsigned.statusCode).toBe(401);
    // B's key naming A
    const forged = signRequest({ method: "POST", path: "/heartbeat", bodyHash: hashRequestBody(payload), privateKeyPem: agentB.privateKeyPem, agentId: agentA.peerId }) as unknown as Record<string, string>;
    const res = await app.inject({ method: "POST", url: "/heartbeat", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...forged }, payload });
    expect(res.statusCode).toBe(401);
  });

  test.each([
    ["GET", "/capacity"],
    ["GET", "/mesh/peers"],
    ["GET", "/mesh/reputation"],
    ["GET", "/status"],
    ["GET", "/economy/market/orders/acct-victim"],
    ["GET", "/economy/hardware/verifications"],
    ["GET", "/economy/hardware/verifications/agent-nomesh-b"],
    ["GET", "/agent/diagnostics/agent-nomesh-b"],
    ["GET", "/security/blacklist/audit"],
    ["GET", "/receipts/since"],
    ["GET", "/stats/network/summary"],
    ["GET", "/agent-mesh/models/available"],
    ["GET", "/orchestration/rollouts"],
    ["GET", "/ledger/snapshot"]
  ])("%s %s (fleet-wide or another user's data) is coordinator-only", async (method, url) => {
    const res = method === "GET" ? await signedGet(agentA, url) : await signedPost(agentA, url, {});
    expect(res.statusCode).toBe(401);
  });

  test("POST /escalate (unbilled coordinator inference) and gossip ingest are coordinator-only", async () => {
    const esc = await signedPost(agentA, "/escalate", { taskId: "t-esc", task: "x", failedCode: "x", errorHistory: [], language: "python", iterationsAttempted: 1 });
    expect(esc.statusCode).toBe(401);
    expect((await signedPost(agentA, "/mesh/ingest", {})).statusCode).toBe(401);
    expect((await signedPost(agentA, "/mesh/relay-gossip", { targetPeerId: "x", message: "{}" })).statusCode).toBe(401);
  });

  test("the coordinators' token still opens fleet reads (coordinator↔coordinator and operator tooling)", async () => {
    const res = await app.inject({ method: "GET", url: "/capacity", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
    expect(res.statusCode).toBe(200);
  });
});

describe("agent GET routes are scoped to the signer", () => {
  test("/agent-mesh/peers/:agentId only for the agent itself", async () => {
    expect((await signedGet(agentA, `/agent-mesh/peers/${agentA.peerId}`)).statusCode).toBe(200);
    expect((await signedGet(agentA, `/agent-mesh/peers/${agentB.peerId}`)).statusCode).toBe(401);
  });

  test("/inference/models is readable by a signed agent", async () => {
    expect((await signedGet(agentA, "/inference/models")).statusCode).toBe(200);
  });

  test("a task result is readable by the submitting account, not by another agent", async () => {
    ctx.taskBilling.set("task-scope-1", { accountId: agentA.peerId, reservedMsat: 0, perSubtaskReserveMsat: 0, costMsat: 0, refunded: false });
    ctx.queue.complete({ subtaskId: "sub-scope-1", taskId: "task-scope-1", agentId: "agent-x", ok: true, output: "secret-output", durationMs: 1 });
    const url = "/tasks/task-scope-1/subtasks/sub-scope-1/result";
    const own = await signedGet(agentA, url);
    expect(own.statusCode).toBe(200);
    expect(own.json().output).toBe("secret-output");
    const other = await signedGet(agentB, url);
    expect(other.statusCode).toBe(404);
    expect(other.body).not.toContain("secret-output");
    const portalRead = await app.inject({ method: "GET", url, remoteAddress: REMOTE, headers: { "x-portal-service-token": PORTAL } });
    // The portal is not on the global hook's list for this path; the mesh token is.
    const meshRead = await app.inject({ method: "GET", url, remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
    expect(meshRead.statusCode).toBe(200);
    expect([200, 401]).toContain(portalRead.statusCode);
  });
});

describe("mesh WebSocket admits agents by their own key", () => {
  async function ws(peerId: string, headers: Record<string, string>) {
    const socket = await app.injectWS(`/mesh/ws?peerId=${encodeURIComponent(peerId)}`, { headers });
    return await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve(null);
      }, 300);
      socket.on("close", (code: number) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
  test("signed bind by a registered agent connects without the token; unsigned does not", async () => {
    const { signMeshWsBind } = await import("../../src/mesh/ws-auth.js");
    expect(await ws(agentA.peerId, signMeshWsBind(agentA.peerId, agentA.privateKeyPem))).toBeNull(); // stays open
    expect(await ws(agentB.peerId, {})).toBe(4003);
    expect(await ws("not-registered", signMeshWsBind("not-registered", createPeerKeys("nr").privateKeyPem))).toBe(4001);
  });
});

describe("diagnostics are written by the agent itself", () => {
  test("an agent cannot write another agent's diagnostics", async () => {
    const forged = await signedPost(agentA, "/agent/diagnostics", { agentId: agentB.peerId, events: [{ message: "forged" }] });
    expect(forged.statusCode).toBe(403);
    const own = await signedPost(agentA, "/agent/diagnostics", { agentId: agentA.peerId, events: [{ message: "ok" }] });
    expect(own.statusCode).toBe(200);
  });
});

describe("invoice flood", () => {
  test("an account holds at most 5 open invoices", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await signedPost(agentB, "/account/buy", { amountSats: 1000 })).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
  });
});
