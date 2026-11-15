import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, earnedMsat, grantCredits } from "../../src/credits/store.js";

/*
 * Overload (real coordinator app, Fastify inject): an inference call no agent claims within
 * INFERENCE_CLAIM_TIMEOUT_MS is cancelled, refunded in full and answered 503 no_capacity with
 * Retry-After, so it fails before a proxy's 100 s limit. An agent that comes for it later finds
 * nothing to claim, cannot report it and earns nothing; the refund is never repeated.
 */

const MESH = "mesh-secret-nocap";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.44";
const MODEL = "qwen-nocap:7b";
const CLAIM_TIMEOUT_MS = 1_000;
let portal: Server;
let app: any;
const requester = createPeerKeys("agent-nocap-requester");
const worker = createPeerKeys("agent-nocap-worker");

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
  process.env.INFERENCE_CLAIM_TIMEOUT_MS = String(CLAIM_TIMEOUT_MS);
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  for (const keys of [requester, worker]) {
    const payload = JSON.stringify({
      os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
      sandboxMode: "docker", installedModels: keys === worker ? [MODEL] : [],
    });
    const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
    const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
    expect(res.statusCode).toBe(200);
  }
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  delete process.env.INFERENCE_CLAIM_TIMEOUT_MS;
});

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const submit = (taskId: string) =>
  post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester);

describe("inference claim timeout (no capacity)", () => {
  test("an unclaimed call is cancelled at the bound: 503 no_capacity, full refund, and a later claim gets nothing", async () => {
    const before = creditEngine.balance(requester.peerId);
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId);
    expect(sub.statusCode, sub.body).toBe(200);
    expect(sub.json().reservedCSats).toBeGreaterThan(0);
    expect(creditEngine.balance(requester.peerId)).toBeLessThan(before);
    const subtaskId = sub.json().subtaskId;

    // The requester is waiting on the stream when the bound passes: the wait ends with 503.
    const reading = post("/inference/stream", { taskId, subtaskId, waitMs: 25_000 }, requester).then((r: unknown) => r);
    const t0 = Date.now();
    const read: any = await reading;
    expect(Date.now() - t0).toBeLessThan(CLAIM_TIMEOUT_MS + 3_000);
    expect(read.statusCode, read.body).toBe(503);
    expect(read.headers["retry-after"]).toBe("15");
    expect(read.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);

    // A read after the fact gets the same answer.
    expect((await post("/inference/stream", { taskId, subtaskId, waitMs: 0 }, requester)).statusCode).toBe(503);

    // An agent arriving now finds nothing, cannot stream or report the cancelled call, and earns nothing.
    const earnedBefore = await earnedMsat(worker.peerId);
    const pulled = await post("/pull", { agentId: worker.peerId }, worker);
    expect(pulled.json().subtask ?? null).toBeNull();
    expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "late", done: true }, worker)).statusCode).toBe(403);
    const late = await post("/result", { subtaskId, taskId, agentId: worker.peerId, ok: true, output: "late", durationMs: 100 }, worker);
    expect(late.statusCode).toBeGreaterThanOrEqual(400);
    expect(await earnedMsat(worker.peerId)).toBe(earnedBefore);
    // The refund happened once.
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
  });

  test("a class no agent with the model is paid at is refused at submit, not called busy later", async () => {
    // The worker registered without a hardware profile: it is matched at cpu. An @gpu.dc call for its model:
    const before = creditEngine.balance(requester.peerId);
    const taskId = `inf-${randomUUID()}`;
    const res = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, computeClass: "gpu.dc", messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: "no_agent_in_class", model: MODEL, computeClass: "gpu.dc", availableClasses: ["cpu"] });
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6); // nothing set aside
    // A class that has the model is accepted as before.
    const ok = await post("/inference/submit", { taskId: `inf-${randomUUID()}`, submitterAccountId: requester.peerId, model: MODEL, computeClass: "cpu", messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester);
    expect(ok.statusCode, ok.body).toBe(200);
    // Leave nothing queued for the next test's pull.
    await sleep(CLAIM_TIMEOUT_MS + 300);
  });

  test("a call an agent claimed before the bound runs and is settled as usual", async () => {
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId);
    expect(sub.statusCode).toBe(200);
    const subtaskId = sub.json().subtaskId;
    const pulled = await post("/pull", { agentId: worker.peerId }, worker);
    expect(pulled.json().subtask?.id).toBe(subtaskId);
    await sleep(CLAIM_TIMEOUT_MS + 300);
    expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "hello", done: true }, worker)).statusCode).toBe(200);
    const reading = post("/inference/stream", { taskId, subtaskId, waitMs: 0 }, requester).then((r: unknown) => r);
    await sleep(50);
    expect((await post("/result", { subtaskId, taskId, agentId: worker.peerId, ok: true, output: "hello", durationMs: 1000 }, worker)).statusCode).toBe(200);
    const read: any = await reading;
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ done: true, chunks: ["hello"] });
  });
});
