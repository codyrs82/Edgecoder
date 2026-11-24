import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";

/*
 * #524, restart under load (real coordinator app, Fastify inject). Right after a restart no agent has
 * registered yet: a call for a model an agent could come back with is accepted and waits for it
 * (bounded, refunded in full if none comes) instead of no_agent_has_model. And a drain refunds the
 * calls nobody claimed before the process exits, instead of leaving their reserves to the next one.
 */

const MESH = "mesh-secret-restart";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.52";
const MODEL = "qwen2.5-coder:1.5b";
let portal: Server;
let app: any;
let inference: any;
const requester = createPeerKeys("agent-restart-requester");
const late = createPeerKeys("agent-restart-late");

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
  delete process.env.COORDINATOR_STARTUP_GRACE_MS;
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  inference = await import("../../src/swarm/coordinator/routes/inference.js");
  await app.ready();
  await register(requester, []);
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

async function register(keys: PeerKeys, installedModels: string[]) {
  const payload = JSON.stringify({
    os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
    sandboxMode: "docker", installedModels,
  });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
  expect(res.statusCode, res.body).toBe(200);
}

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

const submit = (model = MODEL) => {
  const taskId = `inf-${randomUUID()}`;
  return post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester).then((r: any) => ({ taskId, r }));
};

describe("right after a restart", () => {
  test("a call waits for the agents to come back instead of no_agent_has_model", async () => {
    expect(inference.inStartupGrace()).toBe(true);
    const { taskId, r } = await submit();
    expect(r.statusCode, r.body).toBe(200);
    const sub = r.json().subtaskId;
    // The agent re-registers and takes it.
    await register(late, [MODEL]);
    const pulled = (await post("/pull", { agentId: late.peerId }, late)).json();
    expect(pulled.subtask?.id ?? pulled.envelope?.subtaskId).toBe(sub);
    expect((await post("/inference/chunks", { subtaskId: sub, seq: 0, delta: "ok", done: true, promptTokens: 2, outputTokens: 1 }, late)).statusCode).toBe(200);
    expect((await post("/result", { subtaskId: sub, taskId, agentId: late.peerId, ok: true, output: "ok", durationMs: 100, model: MODEL }, late)).statusCode).toBe(200);
  });

  test("a name no agent could ever have is still refused at once", async () => {
    const { r } = await submit("not a model");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("no_agent_has_model");
  });

  test("the grace is over after its time", () => {
    expect(inference.inStartupGrace(Date.now(), Date.now() - 91_000, 90_000)).toBe(false);
    expect(inference.inStartupGrace(Date.now(), Date.now() - 10_000, 90_000)).toBe(true);
  });
});

describe("draining for a restart", () => {
  test("calls nobody claimed are refunded in full before exit", async () => {
    const before = creditEngine.balance(requester.peerId);
    const { taskId, r } = await submit("qwen3.5:9b"); // nobody holds it (still in the grace: accepted)
    expect(r.statusCode, r.body).toBe(200);
    expect(creditEngine.balance(requester.peerId)).toBeLessThan(before);
    expect(await inference.cancelUnclaimedForDrain()).toBeGreaterThanOrEqual(1);
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
    const read = await post("/inference/stream", { taskId, subtaskId: r.json().subtaskId, waitMs: 0 }, requester);
    expect(read.statusCode).toBe(503);
    expect(read.json().error).toBe("no_capacity");
  });
});
