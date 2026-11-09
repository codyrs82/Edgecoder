import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { earnedMsat, grantCredits } from "../../src/credits/store.js";

/*
 * What an agent earns is what the requester was charged (real coordinator app, Fastify inject):
 * - model-call token counts are taken once, from the accepted final piece, and bounded by the stream;
 * - pay never exceeds what the requester set aside; anonymous work (nothing set aside) earns nothing;
 * - a task id in use by one requester cannot be reused by another, and a stream is read only
 *   through its own task.
 */

const MESH = "mesh-secret-billing";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.40";
const MODEL = "qwen-test:7b";
let portal: Server;
let inference: Server;
let app: any;
const requester = createPeerKeys("agent-billing-requester");
const worker = createPeerKeys("agent-billing-worker");
const other = createPeerKeys("agent-billing-other");

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
  // Stand-in for the inference service's /decompose: one code subtask per task.
  inference = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ subtasks: [{ taskId: body.taskId, kind: "single_step", input: "print(1)", language: "python", timeoutMs: 30_000, snapshotRef: "commit:test" }] }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => inference.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.INFERENCE_URL = `http://127.0.0.1:${(inference.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = MESH;
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  for (const keys of [requester, worker, other]) {
    const payload = JSON.stringify({
      os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
      sandboxMode: "docker", installedModels: keys === worker ? [MODEL] : [],
    });
    const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
    const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
    expect(res.statusCode).toBe(200);
  }
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
  await grantCredits(other.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  await new Promise<void>((resolve) => inference.close(() => resolve()));
});

function post(url: string, body: unknown, signer?: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signer
    ? (signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>)
    : {};
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

/** The worker claims the next subtask (claims of code tasks wait out the gossip delay when there are peers; there are none). */
async function pull(): Promise<{ id: string; taskId: string } | null> {
  const res = await post("/pull", { agentId: worker.peerId }, worker);
  expect(res.statusCode).toBe(200);
  return res.json().subtask ?? null;
}

async function submitInference(taskId: string, by: PeerKeys = requester) {
  return post("/inference/submit", { taskId, submitterAccountId: by.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, by);
}

describe("/inference/chunks token counts", () => {
  test("pay is bounded by the reserve and counts are taken once, bounded by the stream", async () => {
    const taskId = `inf-${randomUUID()}`;
    const sub = await submitInference(taskId);
    expect(sub.statusCode).toBe(200);
    const reservedMsat = sub.json().reservedCSats * 10; // 1 cSat = 10 msat
    const st = await pull();
    expect(st?.taskId).toBe(taskId);
    const before = await earnedMsat(worker.peerId);

    const text = await post("/inference/chunks", { subtaskId: st!.id, seq: 0, delta: "hello there" }, worker);
    expect(text.statusCode).toBe(200);
    const final = await post("/inference/chunks", { subtaskId: st!.id, seq: 1, delta: "", done: true, promptTokens: 10_000_000, outputTokens: 10_000_000 }, worker);
    expect(final.statusCode).toBe(200);
    // Repeats of the final piece, or pieces after it, change nothing.
    expect((await post("/inference/chunks", { subtaskId: st!.id, seq: 1, delta: "", done: true, promptTokens: 10_000_000, outputTokens: 10_000_000 }, worker)).json().status).toBe("duplicate");
    expect((await post("/inference/chunks", { subtaskId: st!.id, seq: 2, delta: "", done: true, promptTokens: 10_000_000, outputTokens: 10_000_000 }, worker)).statusCode).toBe(409);

    const result = await post("/result", { subtaskId: st!.id, taskId, agentId: worker.peerId, ok: true, output: "hello there", durationMs: 1000 }, worker);
    expect(result.statusCode).toBe(200);
    const earned = (await earnedMsat(worker.peerId)) - before;
    expect(earned).toBeGreaterThan(0);
    expect(earned).toBeLessThanOrEqual(reservedMsat);
    // Counts bounded by the stream: 11 bytes of reply and a ~100-byte request price at well under the reserve.
    expect(earned).toBeLessThan(reservedMsat / 2);
  });
});

describe("anonymous /submit", () => {
  test("work nobody paid for earns nothing", async () => {
    const taskId = randomUUID();
    const sub = await post("/submit", { taskId, prompt: "print 1", language: "python", submitterAccountId: "anonymous", snapshotRef: "a".repeat(40), projectId: "p", resourceClass: "cpu", priority: 10 });
    expect(sub.statusCode).toBe(200);
    const st = await pull();
    expect(st?.taskId).toBe(taskId);
    const before = await earnedMsat(worker.peerId);
    // The job ran for 30 s (server clock): paid work if anyone had paid for it.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 29_000);
      const result = await post("/result", { subtaskId: st!.id, taskId, agentId: worker.peerId, ok: true, output: "1", durationMs: 29_000 }, worker);
      expect(result.statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    expect(await earnedMsat(worker.peerId)).toBe(before);
  });
});

describe("task ids", () => {
  test("an id in use by another requester is refused, by either route", async () => {
    const taskId = `inf-${randomUUID()}`;
    expect((await submitInference(taskId)).statusCode).toBe(200);
    const again = await submitInference(taskId, other);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("duplicate_task");
    const anon = await post("/submit", { taskId, prompt: "print 1", language: "python", submitterAccountId: "anonymous", snapshotRef: "a".repeat(40), projectId: "p", resourceClass: "cpu", priority: 10 });
    expect(anon.statusCode).toBe(409);
    // Clean up: run it so later tests see an empty queue.
    const st = await pull();
    expect(st?.taskId).toBe(taskId);
    await post("/inference/chunks", { subtaskId: st!.id, seq: 0, delta: "x", done: true }, worker);
    await post("/result", { subtaskId: st!.id, taskId, agentId: worker.peerId, ok: true, output: "x", durationMs: 100 }, worker);
  });

  test("a stream is read only through the task it belongs to", async () => {
    const victimTask = `inf-${randomUUID()}`;
    const victim = await submitInference(victimTask);
    expect(victim.statusCode).toBe(200);
    const ownTask = `inf-${randomUUID()}`;
    expect((await submitInference(ownTask, other)).statusCode).toBe(200);
    const read = await post("/inference/stream", { taskId: ownTask, subtaskId: victim.json().subtaskId, waitMs: 0 }, other);
    expect(read.statusCode).toBe(404);
    const own = await post("/inference/stream", { taskId: victimTask, subtaskId: victim.json().subtaskId, waitMs: 0 }, requester);
    expect(own.statusCode).toBe(200);
  });
});
