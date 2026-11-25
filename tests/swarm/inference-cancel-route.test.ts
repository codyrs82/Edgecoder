import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, earnedMsat, grantCredits } from "../../src/credits/store.js";

/*
 * A requester that goes away cancels its call (real coordinator app, Fastify inject): unclaimed, it
 * is taken off the queue and refunded in full; claimed, the agent is told to stop and what it
 * produced is billed (within the one reserve); an agent that does not stop has its call ended unpaid
 * after the grace, with the reserve back in full. Only the requester may cancel.
 */

const MESH = "mesh-secret-cancel";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.51";
const MODEL = "qwen-cancel:1.5b";
let portal: Server;
let app: any;
let cancelMod: any;
const requester = createPeerKeys("agent-cancel-requester");
const stranger = createPeerKeys("agent-cancel-stranger");
const agent = createPeerKeys("agent-cancel-host");

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
  // Run 5 prior speed off: completion admission is not what these test (start-eta.ts; tests/swarm/completion-run5.test.ts).
  process.env.INFERENCE_COMPLETION_PRIOR_SPEED = "off";
  // A configured portal token, so a request without it is not taken for the portal's (development default).
  process.env.PORTAL_SERVICE_TOKEN = "portal-token-cancel-test";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  cancelMod = await import("../../src/swarm/coordinator/inference-cancel.js");
  await app.ready();
  await register(requester, []);
  await register(stranger, []);
  await register(agent, [MODEL]);
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  delete process.env.PORTAL_SERVICE_TOKEN;
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

const submit = async () => {
  const taskId = `inf-${randomUUID()}`;
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "write a long story" }], timeoutMs: 60_000 }, requester);
  expect(r.statusCode, r.body).toBe(200);
  return { taskId, subtaskId: r.json().subtaskId as string, reservedCSats: r.json().reservedCSats as number };
};
const pull = async () => {
  const r = (await post("/pull", { agentId: agent.peerId }, agent)).json();
  return (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null;
};
const cancel = (c: { taskId: string; subtaskId: string }, by = requester) => post("/inference/cancel", { taskId: c.taskId, subtaskId: c.subtaskId }, by);

describe("a requester that goes away", () => {
  test("an unclaimed call is taken off the queue and refunded in full", async () => {
    const before = creditEngine.balance(requester.peerId);
    const c = await submit();
    expect(creditEngine.balance(requester.peerId)).toBeLessThan(before);
    expect((await cancel(c, stranger)).statusCode).toBe(403);
    const r = await cancel(c);
    expect(r.json()).toMatchObject({ ok: true, outcome: "cancelled" });
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
    expect(await pull()).toBeNull();
    // Idempotent.
    expect((await cancel(c)).json()).toMatchObject({ ok: true, outcome: "already_done" });
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
  });

  test("a running call: the agent is told to stop, and what it produced is billed within the reserve", async () => {
    const before = creditEngine.balance(requester.peerId);
    const c = await submit();
    expect(await pull()).toBe(c.subtaskId);
    expect((await post("/inference/chunks", { subtaskId: c.subtaskId, seq: 0, delta: "Once upon", done: false }, agent)).json().cancelled).toBeUndefined();
    expect((await cancel(c)).json()).toMatchObject({ ok: true, outcome: "stopping" });
    const next = await post("/inference/chunks", { subtaskId: c.subtaskId, seq: 1, delta: " a time", done: false }, agent);
    expect(next.json()).toMatchObject({ cancelled: true });
    // The agent stops and reports what it produced.
    expect((await post("/inference/chunks", { subtaskId: c.subtaskId, seq: 2, delta: "", done: true, promptTokens: 6, outputTokens: 4 }, agent)).statusCode).toBe(200);
    expect((await post("/result", { subtaskId: c.subtaskId, taskId: c.taskId, agentId: agent.peerId, ok: true, output: "Once upon a time", durationMs: 400, model: MODEL }, agent)).statusCode).toBe(200);
    // Settled once, within the reserve; the grace end finds nothing to do.
    expect(await cancelMod.endIfStillOpen(c.taskId, c.subtaskId)).toBe(false);
    const after = creditEngine.balance(requester.peerId);
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThan(before - c.reservedCSats);
  });

  test("an agent that does not stop: the call is ended unpaid after the grace, the reserve back in full", async () => {
    const before = creditEngine.balance(requester.peerId);
    const earned = await earnedMsat(agent.peerId);
    const c = await submit();
    expect(await pull()).toBe(c.subtaskId);
    expect((await cancel(c)).json().outcome).toBe("stopping");
    expect(await cancelMod.endIfStillOpen(c.taskId, c.subtaskId)).toBe(true);
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
    // Its later pieces and result are refused; it is paid nothing; the call is never retried.
    expect((await post("/inference/chunks", { subtaskId: c.subtaskId, seq: 0, delta: "the end", done: true }, agent)).statusCode).toBe(403);
    expect((await post("/result", { subtaskId: c.subtaskId, taskId: c.taskId, agentId: agent.peerId, ok: true, output: "the end", durationMs: 90_000, model: MODEL }, agent)).statusCode).toBeGreaterThanOrEqual(400);
    expect(await earnedMsat(agent.peerId)).toBe(earned);
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
    expect(await pull()).toBeNull();
  });
});
