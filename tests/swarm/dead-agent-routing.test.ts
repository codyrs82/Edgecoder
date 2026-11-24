import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { signMeshWsBind } from "../../src/mesh/ws-auth.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, earnedMsat, grantCredits } from "../../src/credits/store.js";
import { agentSocketLost } from "../../src/swarm/coordinator/agent-liveness.js";
import { requeueLostAgentClaims } from "../../src/swarm/coordinator/lost-agent-claims.js";
import { localAgentViews } from "../../src/swarm/coordinator/routing.js";
import { circuitState } from "../../src/swarm/coordinator/memory-admission.js";

/*
 * #524 (real coordinator app, Fastify inject + injectWS): an agent whose authenticated socket closes
 * is offered no new work at once (not 2 minutes later), its free slots leave /inference/models and
 * best fit, and a model call it held that streamed nothing is run by another agent once, with one
 * reserve and no payment for the lost run. An agent that never had a socket (HTTP pull only) is
 * unaffected, and an agent whose socket dropped but that keeps pulling over HTTP stays routable.
 */

const MESH = "mesh-secret-dead-agent";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.48";
const MODEL = "qwen-dead:1.5b";
const SOLO = "qwen-solo:7b";
let portal: Server;
let app: any;
const requester = createPeerKeys("agent-dead-requester");
const a = createPeerKeys("agent-dead-a");
const b = createPeerKeys("agent-dead-b");
const pullOnly = createPeerKeys("agent-dead-pull-only");
const sockets = new Map<string, any>();

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
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  await register(requester, []);
  await register(a, [MODEL, SOLO]);
  await register(b, [MODEL]);
  await register(pullOnly, [MODEL]);
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
  for (const k of [a, b]) await openSocket(k);
  for (const k of [a, b, pullOnly]) expect(await pull(k)).toBeNull();
}, 60_000);

afterAll(async () => {
  for (const ws of sockets.values()) ws.terminate();
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(5);
  return cond();
};
async function openSocket(k: PeerKeys) {
  const ws = await app.injectWS(`/mesh/ws?peerId=${k.peerId}`, { headers: { "x-mesh-token": MESH, ...signMeshWsBind(k.peerId, k.privateKeyPem) } });
  sockets.set(k.peerId, ws);
}
/** The machine stops: its socket goes away and it sends nothing more. */
async function kill(k: PeerKeys) {
  await sleep(3); // its last request is strictly before the socket goes
  sockets.get(k.peerId)?.terminate();
  sockets.delete(k.peerId);
  expect(await until(() => agentSocketLost(k.peerId))).toBe(true);
}
const pull = async (k: PeerKeys) => {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: 2, freeInferenceSlots: 2, wake: k !== pullOnly }, k)).json();
  return (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null;
};
const submit = async (model = MODEL) => {
  const taskId = `inf-${randomUUID()}`;
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester);
  expect(r.statusCode, r.body).toBe(200);
  return { taskId, subtaskId: r.json().subtaskId as string, reservedCSats: r.json().reservedCSats as number };
};
const finish = async (k: PeerKeys, c: { taskId: string; subtaskId: string }, model = MODEL) => {
  expect((await post("/inference/chunks", { subtaskId: c.subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 5, outputTokens: 1 }, k)).statusCode).toBe(200);
  return post("/result", { subtaskId: c.subtaskId, taskId: c.taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model }, k);
};
const modelsRow = async (model = MODEL) => {
  const res = await app.inject({ method: "GET", url: "/inference/models", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
  return res.json().models.find((m: { model: string }) => m.model === model) as { agents: number; freeSlots: number } | undefined;
};
const view = (k: PeerKeys) => localAgentViews().find((v) => v.agentId === k.peerId);

describe("a dead agent (socket closed, nothing heard since)", () => {
  test("is offered no new work at once; it comes back as soon as it pulls over HTTP", async () => {
    expect((await modelsRow())?.agents).toBe(3);
    await kill(a);
    // At once, not when its last heartbeat is 2 minutes old.
    expect((await modelsRow())?.agents).toBe(2);
    expect(view(a)?.stale).toBe(true);
    // The pull-only agent never had a socket: unaffected.
    expect(view(pullOnly)?.stale).toBe(false);
    // A new call goes to a live agent.
    const c = await submit();
    expect(await pull(b)).toBe(c.subtaskId);
    expect((await finish(b, c)).statusCode).toBe(200);
    // Its socket dropped but it is alive (an HTTP pull): routable again.
    expect(await pull(a)).toBeNull();
    expect(agentSocketLost(a.peerId)).toBe(false);
    expect((await modelsRow())?.agents).toBe(3);
    expect(view(a)?.stale).toBe(false);
    await openSocket(a);
  });

  test("a call it held that streamed nothing is run by another agent once: one reserve, the lost run unpaid", async () => {
    const before = creditEngine.balance(requester.peerId);
    const earnedA = await earnedMsat(a.peerId);
    const earnedB = await earnedMsat(b.peerId);
    const c = await submit();
    expect(await pull(a)).toBe(c.subtaskId);
    await kill(a);
    // Within the grace period nothing moves (a live agent heartbeats every 15 s while it holds a claim).
    expect(await requeueLostAgentClaims(Date.now(), 60_000)).toEqual([]);
    const moved = await requeueLostAgentClaims(Date.now(), 0);
    expect(moved).toEqual([c.subtaskId]);
    expect(circuitState(a.peerId).recentFailures).toBeGreaterThanOrEqual(1);
    // Moved once only.
    expect(await requeueLostAgentClaims(Date.now(), 0)).toEqual([]);
    expect(await pull(b)).toBe(c.subtaskId);
    // The lost holder's late pieces and result are refused.
    expect((await post("/inference/chunks", { subtaskId: c.subtaskId, seq: 0, delta: "late", done: false }, a)).statusCode).toBe(403);
    expect((await post("/result", { subtaskId: c.subtaskId, taskId: c.taskId, agentId: a.peerId, ok: true, output: "late", durationMs: 100, model: MODEL }, a)).statusCode).toBeGreaterThanOrEqual(400);
    const read = post("/inference/stream", { taskId: c.taskId, subtaskId: c.subtaskId, waitMs: 3_000 }, requester);
    await sleep(30);
    expect((await finish(b, c)).statusCode).toBe(200);
    expect((await read).json()).toMatchObject({ chunks: ["ok"], done: true });
    // Charged once, within the one reserve; paid to the agent that ran it, nothing to the lost one.
    const after = creditEngine.balance(requester.peerId);
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThanOrEqual(before - c.reservedCSats);
    expect(await earnedMsat(a.peerId)).toBe(earnedA);
    expect(await earnedMsat(b.peerId)).toBeGreaterThanOrEqual(earnedB);
    expect(await pull(a)).toBeNull();
    await openSocket(a);
  });

  test("a call that already streamed part of its reply is left to the lease (no spliced replies)", async () => {
    const c = await submit();
    expect(await pull(a)).toBe(c.subtaskId);
    expect((await post("/inference/chunks", { subtaskId: c.subtaskId, seq: 0, delta: "par", done: false }, a)).statusCode).toBe(200);
    await kill(a);
    expect(await requeueLostAgentClaims(Date.now(), 0)).toEqual([]);
    // It was alive after all: it finishes (and is routable again).
    expect((await post("/inference/chunks", { subtaskId: c.subtaskId, seq: 1, delta: "t", done: true, promptTokens: 5, outputTokens: 2 }, a)).statusCode).toBe(200);
    expect((await post("/result", { subtaskId: c.subtaskId, taskId: c.taskId, agentId: a.peerId, ok: true, output: "part", durationMs: 100, model: MODEL }, a)).statusCode).toBe(200);
    await openSocket(a);
  });

  test("with no other agent holding the model, the call is left to its lease and bound (refunded as today)", async () => {
    const c = await submit(SOLO);
    expect(await pull(a)).toBe(c.subtaskId);
    await kill(a);
    expect(await requeueLostAgentClaims(Date.now(), 0)).toEqual([]);
    // Clean up: it comes back and finishes the call.
    expect((await finish(a, c, SOLO)).statusCode).toBe(200);
    await openSocket(a);
  });
});

describe("an HTTP pull-only agent (never had a socket)", () => {
  test("keeps its slots and its work", async () => {
    expect(agentSocketLost(pullOnly.peerId)).toBe(false);
    expect(view(pullOnly)).toMatchObject({ stale: false, pullAgeMs: expect.any(Number) });
    const c = await submit();
    // The socket agents are told first; it still gets the call when it pulls.
    let got: string | null = null;
    for (let i = 0; i < 40 && got === null; i++) {
      got = await pull(pullOnly);
      if (got === null) await sleep(50);
    }
    expect(got).toBe(c.subtaskId);
    expect((await finish(pullOnly, c)).statusCode).toBe(200);
  });
});
