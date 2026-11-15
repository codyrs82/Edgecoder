import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { publicKeyFingerprint, signForwardedResult, signRegistration } from "../../src/mesh/peer-trust.js";
import { MeshProtocol } from "../../src/mesh/protocol.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, earnedMsat, grantCredits } from "../../src/credits/store.js";
const creditBalance = async (id: string) => creditEngine.balance(id);

/*
 * Stress finding 1: a subtask offered to peer coordinators ran on both coordinators, and the peer
 * paid its agent out of nothing (the origin refunded its requester in full). Now (real coordinator
 * app, Fastify inject, a stand-in peer coordinator on a local HTTP server):
 * - origin: a peer's task_claim takes the subtask off the origin's queue (granted once), no local
 *   agent can claim it any more, and only the granted peer's forwarded result is accepted, charged once;
 * - peer: an offered subtask is queued only after the origin grants it, and its agent is paid at most
 *   what the origin answers it charged (nothing when the origin refuses the result).
 */

const MESH = "mesh-secret-grants";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.50";
const PEER_ID = "coord-peer-x";
const peerKeys = createPeerKeys(PEER_ID);
const proto = new MeshProtocol();
let portal: Server;
let inference: Server;
let fakePeer: Server;
let fakePeerUrl = "";
let app: any;
const requester = createPeerKeys("agent-grants-requester");
const worker = createPeerKeys("agent-grants-worker");

/** What the stand-in peer coordinator saw, and how it answers. */
const peerState = {
  ingested: [] as Array<Record<string, any>>,
  forwarded: [] as Array<Record<string, any>>,
  grant: true,
  chargedMsat: 0
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}

beforeAll(async () => {
  portal = createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || "{}");
    const allowed = req.url === "/internal/nodes/validate" && body.registrationToken === VALID_TOKEN;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(allowed ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }));
  });
  inference = createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || "{}");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ subtasks: [{ taskId: body.taskId, kind: "single_step", input: "print(1)", language: "python", timeoutMs: 30_000, snapshotRef: "commit:test" }] }));
  });
  fakePeer = createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || "{}");
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/mesh/ingest") {
      peerState.ingested.push(body);
      if (body.type === "task_claim") return res.end(JSON.stringify(peerState.grant ? { ok: true, granted: true, grantTtlMs: 600_000 } : { ok: true, granted: false, reason: "granted_elsewhere" }));
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === "/result") {
      peerState.forwarded.push(body);
      return res.end(JSON.stringify({ ok: true, chargedMsat: peerState.chargedMsat }));
    }
    res.end("{}");
  });
  for (const s of [portal, inference, fakePeer]) await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  fakePeerUrl = `http://127.0.0.1:${(fakePeer.address() as AddressInfo).port}`;
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.INFERENCE_URL = `http://127.0.0.1:${(inference.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = MESH;
  process.env.MESH_PEER_ALLOWLIST = `${PEER_ID}:${publicKeyFingerprint(peerKeys.publicKeyPem)}@${fakePeerUrl}`;
  process.env.RESULT_VERIFICATION_RATE = "0";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  for (const keys of [requester, worker]) {
    const payload = JSON.stringify({ os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem, sandboxMode: "docker" });
    const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
    const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
    expect(res.statusCode).toBe(200);
  }
  // The stand-in peer registers with its allowlisted, signed key.
  const fields = { peerId: PEER_ID, publicKeyPem: peerKeys.publicKeyPem, coordinatorUrl: fakePeerUrl, networkMode: "public_mesh" as const, role: "coordinator" as const };
  const reg = await post("/mesh/register-peer", { ...fields, ...signRegistration(fields, peerKeys.privateKeyPem) });
  expect(reg.statusCode, reg.body).toBe(200);
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  for (const s of [portal, inference, fakePeer]) await new Promise<void>((resolve) => s.close(() => resolve()));
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.RESULT_VERIFICATION_RATE;
});

beforeEach(() => {
  peerState.ingested.length = 0;
  peerState.forwarded.length = 0;
  peerState.grant = true;
  peerState.chargedMsat = 0;
});

function post(url: string, body: unknown, signer?: PeerKeys, headers: Record<string, string> = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const signed = signer
    ? (signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>)
    : {};
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...headers, ...signed }, payload });
}

/** A gossip message from the stand-in peer, signed with its key. */
function fromPeer(type: string, payload: Record<string, unknown>) {
  return post("/mesh/ingest", proto.createMessage(type as any, PEER_ID, payload, peerKeys.privateKeyPem, 60_000));
}

/** The stand-in peer forwards a result its agent produced (signed as the peer coordinator). */
function forward(result: Record<string, unknown>) {
  const json = JSON.stringify(result);
  return post("/result", json, undefined, signForwardedResult(PEER_ID, peerKeys.privateKeyPem, json));
}

async function pull(): Promise<{ id: string; taskId: string } | null> {
  const res = await post("/pull", { agentId: worker.peerId }, worker);
  expect(res.statusCode).toBe(200);
  return res.json().subtask ?? null;
}

async function submit(taskId: string) {
  const res = await post("/submit", { taskId, prompt: "print 1", language: "python", submitterAccountId: requester.peerId, snapshotRef: "a".repeat(40), projectId: "p", resourceClass: "cpu", priority: 10 }, requester);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { taskId: string; subtasks: string[] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("origin: a subtask offered to peers runs on one coordinator only", () => {
  test("a peer's claim takes the subtask off the origin's queue; only that peer's result is accepted, charged once", async () => {
    const taskId = randomUUID();
    const balance0 = await creditBalance(requester.peerId);
    const { subtasks } = await submit(taskId);
    const subtaskId = subtasks[0];
    await sleep(100);
    expect(peerState.ingested.some((m) => m.type === "task_offer" && m.payload.subtaskId === subtaskId)).toBe(true);

    const claim = await fromPeer("task_claim", { subtaskId, taskId, claimedByCoordinator: PEER_ID });
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ granted: true });
    // Asking again (a re-sent claim) gets the same grant.
    expect((await fromPeer("task_claim", { subtaskId, taskId, claimedByCoordinator: PEER_ID })).json()).toMatchObject({ granted: true });

    // Past the gossip claim delay, a local agent finds nothing: the copy left the queue with the grant.
    await sleep(3_200);
    expect(await pull()).toBeNull();

    const result = { subtaskId, taskId, agentId: "agent-on-peer", ok: true, output: "1\n", durationMs: 1200 };
    const first = await forward(result);
    expect(first.statusCode, first.body).toBe(200);
    const charged = first.json().chargedMsat;
    expect(charged).toBeGreaterThan(0);
    // A re-sent forward is answered the same way and charged nothing more.
    const again = await forward(result);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ duplicate: true, chargedMsat: charged });
    await sleep(50);
    // The requester paid exactly what was charged for the peer's work (the rest was refunded).
    const spent = Math.round((balance0 - (await creditBalance(requester.peerId))) * 1000);
    expect(spent).toBe(Math.round(charged));
  }, 20_000);

  test("a forwarded result for a subtask that was never granted to the peer is refused", async () => {
    const taskId = randomUUID();
    const { subtasks } = await submit(taskId);
    await sleep(3_200);
    // The local agent took it: a peer's late claim is refused, and so is its result.
    const st = await pull();
    expect(st?.id).toBe(subtasks[0]);
    expect((await fromPeer("task_claim", { subtaskId: subtasks[0], taskId, claimedByCoordinator: PEER_ID })).json()).toMatchObject({ granted: false });
    const res = await forward({ subtaskId: subtasks[0], taskId, agentId: "agent-on-peer", ok: true, output: "1\n", durationMs: 1200 });
    expect(res.statusCode).not.toBe(200);
    // The local agent finishes it normally.
    expect((await post("/result", { subtaskId: st!.id, taskId, agentId: worker.peerId, ok: true, output: "1\n", durationMs: 1000 }, worker)).statusCode).toBe(200);
  }, 20_000);

  test("a claim for another coordinator, or naming someone else, is refused", async () => {
    const res = await fromPeer("task_claim", { subtaskId: randomUUID(), claimedByCoordinator: "coord-other" });
    expect(res.statusCode).toBe(403);
    expect((await fromPeer("task_claim", { subtaskId: randomUUID(), claimedByCoordinator: PEER_ID })).json()).toMatchObject({ granted: false, reason: "not_offered" });
  });
});

describe("peer: an offered subtask is run only once granted, and paid only what the origin charged", () => {
  function offer(subtaskId: string, taskId: string) {
    return fromPeer("task_offer", {
      subtaskId, taskId, kind: "single_step", language: "python", input: "print(2)", timeoutMs: 30_000, snapshotRef: "commit:test",
      projectMeta: { projectId: "p-remote", resourceClass: "cpu", priority: 10 },
      originCoordinatorId: PEER_ID, originCoordinatorUrl: "https://ignored.invalid"
    });
  }

  test("not granted: nothing is queued here", async () => {
    peerState.grant = false;
    const subtaskId = randomUUID();
    expect((await offer(subtaskId, randomUUID())).statusCode).toBe(200);
    await sleep(200);
    expect(peerState.ingested.some((m) => m.type === "task_claim" && m.payload.subtaskId === subtaskId)).toBe(true);
    expect(await pull()).toBeNull();
  });

  test("granted, then the origin refuses the result: the agent here is paid nothing", async () => {
    peerState.chargedMsat = 0;
    const subtaskId = randomUUID();
    const taskId = randomUUID();
    await offer(subtaskId, taskId);
    await sleep(200);
    const st = await pull();
    expect(st?.id).toBe(subtaskId);
    const before = await earnedMsat(worker.peerId);
    expect((await post("/result", { subtaskId, taskId, agentId: worker.peerId, ok: true, output: "2\n", durationMs: 1000 }, worker)).statusCode).toBe(200);
    expect(peerState.forwarded.some((f) => f.subtaskId === subtaskId)).toBe(true);
    expect((await earnedMsat(worker.peerId)) - before).toBe(0);
  });

  test("granted and charged: the agent earns at most the charge (minus the network fee)", async () => {
    peerState.chargedMsat = 3;
    const subtaskId = randomUUID();
    const taskId = randomUUID();
    await offer(subtaskId, taskId);
    await sleep(200);
    const st = await pull();
    expect(st?.id).toBe(subtaskId);
    const before = await earnedMsat(worker.peerId);
    expect((await post("/result", { subtaskId, taskId, agentId: worker.peerId, ok: true, output: "2\n", durationMs: 30_000 }, worker)).statusCode).toBe(200);
    const earned = (await earnedMsat(worker.peerId)) - before;
    expect(earned).toBeLessThanOrEqual(3);
  });
});
