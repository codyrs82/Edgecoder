import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, earnedMsat, grantCredits } from "../../src/credits/store.js";

/*
 * An empty model reply (no text, no tool call) is a failed call (real coordinator app, Fastify
 * inject): the agent that produced it is not paid, the requester is not charged for it, and the
 * call goes to another agent once while the request has time left. Without time left it fails and the reserve comes back in full.
 */

const MESH = "mesh-secret-empty";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.45";
const MODEL = "qwen-empty:1.5b";
let portal: Server;
let app: any;
const requester = createPeerKeys("agent-empty-requester");
const first = createPeerKeys("agent-empty-first");
const second = createPeerKeys("agent-empty-second");

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
  for (const keys of [requester, first, second]) await register(keys, keys === requester ? [] : [MODEL]);
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

const submit = (taskId: string, timeoutMs = 60_000) =>
  post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs }, requester);

describe("empty model reply", () => {
  test("is not charged or paid, and the call is answered by another agent", async () => {
    const before = creditEngine.balance(requester.peerId);
    const earnedFirst = await earnedMsat(first.peerId);
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId);
    expect(sub.statusCode, sub.body).toBe(200);
    const subtaskId = sub.json().subtaskId;

    const pulled = await post("/pull", { agentId: first.peerId }, first);
    expect(pulled.json().subtask?.id ?? pulled.json().envelope?.subtaskId).toBe(subtaskId);
    // An older agent: an empty final piece, then "ok" with no output.
    expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "", done: true, promptTokens: 5, outputTokens: 0 }, first)).statusCode).toBe(200);
    const empty = await post("/result", { subtaskId, taskId, agentId: first.peerId, ok: true, output: "", durationMs: 800, model: MODEL }, first);
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toMatchObject({ retried: true });

    // The requester's stream is still open and empty.
    const mid = await post("/inference/stream", { taskId, subtaskId, waitMs: 0 }, requester);
    expect(mid.json()).toMatchObject({ chunks: [], done: false });

    // The first agent cannot take it again (nor report it again); the second one can.
    expect((await post("/pull", { agentId: first.peerId }, first)).json().subtask ?? null).toBeNull();
    const again = await post("/pull", { agentId: second.peerId }, second);
    expect(again.json().subtask?.id ?? again.json().envelope?.subtaskId).toBe(subtaskId);
    const dup = await post("/result", { subtaskId, taskId, agentId: first.peerId, ok: true, output: "late", durationMs: 800, model: MODEL }, first);
    expect(dup.statusCode).toBeGreaterThanOrEqual(400);

    expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "hello", done: true, promptTokens: 5, outputTokens: 2 }, second)).statusCode).toBe(200);
    const reading = post("/inference/stream", { taskId, subtaskId, waitMs: 0 }, requester).then((r: unknown) => r);
    await new Promise((r) => setTimeout(r, 50));
    expect((await post("/result", { subtaskId, taskId, agentId: second.peerId, ok: true, output: "hello", durationMs: 900, model: MODEL }, second)).statusCode).toBe(200);
    const read: any = await reading;
    expect(read.json()).toMatchObject({ chunks: ["hello"], done: true });
    expect(read.json().error).toBeUndefined();

    // The empty run earned nothing; the requester paid at most the one reserve (the answer's tokens).
    expect(await earnedMsat(first.peerId)).toBe(earnedFirst);
    expect(creditEngine.balance(requester.peerId)).toBeLessThanOrEqual(before);
    expect(creditEngine.balance(requester.peerId)).toBeGreaterThanOrEqual(before - sub.json().reservedCSats);
  });

  test("with too little time left to retry, it fails and the reserve comes back in full", async () => {
    const before = creditEngine.balance(requester.peerId);
    const earnedFirst = await earnedMsat(first.peerId);
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId, 12_000); // less than the retry window
    const subtaskId = sub.json().subtaskId;
    const pulled = await post("/pull", { agentId: first.peerId }, first);
    expect(pulled.json().subtask?.id ?? pulled.json().envelope?.subtaskId).toBe(subtaskId);
    // The requester is waiting on the stream when the result arrives.
    const reading = post("/inference/stream", { taskId, subtaskId, waitMs: 5_000 }, requester).then((r: unknown) => r);
    await new Promise((r) => setTimeout(r, 50));
    const res = await post("/result", { subtaskId, taskId, agentId: first.peerId, ok: true, output: "  ", durationMs: 500, model: MODEL }, first);
    expect(res.json().retried).toBeUndefined();
    const read: any = await reading;
    expect(read.json()).toMatchObject({ done: true, error: "empty_reply" });
    expect(await earnedMsat(first.peerId)).toBe(earnedFirst);
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
  });
});
