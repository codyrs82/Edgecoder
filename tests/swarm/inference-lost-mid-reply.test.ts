import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, earnedMsat, grantCredits } from "../../src/credits/store.js";

/*
 * Streams cut mid-reply (load test lg-202611161428): a call's lease is kept alive by the pieces its
 * holder posts (not only by heartbeats), and a call whose holder is lost after part of the reply
 * reached the requester ends with a clear error and a full refund, instead of being handed to
 * another agent whose reply would be spliced onto the text already sent (real coordinator app).
 */

const MESH = "mesh-secret-lost-mid-reply";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.48";
const MODEL = "qwen-midreply:7b";
const CLAIM_TIMEOUT_MS = 1_500;
const LIVENESS_MS = 1_000;
let portal: Server;
let app: any;
const requester = createPeerKeys("agent-midreply-requester");
const worker = createPeerKeys("agent-midreply-worker");

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
  process.env.CLAIM_LEASE_LIVENESS_MS = String(LIVENESS_MS);
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
  delete process.env.CLAIM_LEASE_LIVENESS_MS;
});

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const submit = (taskId: string) =>
  post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester);

const stream = (taskId: string, subtaskId: string, after = 0, waitMs = 0) => post("/inference/stream", { taskId, subtaskId, after, waitMs }, requester);

async function claimed(): Promise<{ taskId: string; subtaskId: string }> {
  const taskId = `inf-${randomUUID()}`;
  const sub = await submit(taskId);
  expect(sub.statusCode, sub.body).toBe(200);
  const subtaskId = sub.json().subtaskId;
  const pulled = await post("/pull", { agentId: worker.peerId }, worker);
  expect(pulled.json().subtask?.id ?? pulled.json().envelope?.subtaskId).toBe(subtaskId);
  return { taskId, subtaskId };
}

describe("a model call cut mid-reply", () => {
  test("a holder posting pieces keeps its lease without a heartbeat, and the reply ends whole", async () => {
    const { taskId, subtaskId } = await claimed();
    const words = ["Hel", "lo ", "wor", "ld, ", "a ", "slow ", "reply"];
    // Pieces every 300 ms for ~2.1 s: past the 1 s liveness, with no heartbeat from the worker.
    for (let i = 0; i < words.length; i++) {
      // Other agent traffic runs the expiry check.
      await post("/heartbeat", { agentId: requester.peerId }, requester);
      const r = await post("/inference/chunks", { subtaskId, seq: i, delta: words[i] }, worker);
      expect(r.statusCode, `piece ${i}: ${r.body}`).toBe(200);
      await sleep(300);
    }
    expect((await post("/inference/chunks", { subtaskId, seq: words.length, delta: "", done: true, promptTokens: 5, outputTokens: 7 }, worker)).statusCode).toBe(200);
    const res = await post("/result", { subtaskId, taskId, agentId: worker.peerId, ok: true, output: words.join(""), durationMs: 2100, model: MODEL }, worker);
    expect(res.statusCode, res.body).toBe(200);
    const read = await stream(taskId, subtaskId);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ done: true });
    expect(read.json().error).toBeUndefined();
    expect(read.json().chunks.join("")).toBe(words.join(""));
  }, 20_000);

  test("its holder vanishes after part of the reply: the stream ends with agent_lost_mid_reply, refunded in full, never re-run", async () => {
    const before = creditEngine.balance(requester.peerId);
    const { taskId, subtaskId } = await claimed();
    expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "partial " }, worker)).statusCode).toBe(200);
    expect((await stream(taskId, subtaskId)).json().chunks).toEqual(["partial "]);
    // The worker goes silent past the lease's liveness; other agent traffic expires the lease.
    await sleep(LIVENESS_MS + 300);
    await post("/heartbeat", { agentId: requester.peerId }, requester);
    const read = await stream(taskId, subtaskId, 1, 5_000);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ done: true });
    expect(read.json().error).toContain("agent_lost_mid_reply");
    expect(read.json().chunks).toEqual([]);
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
    // Not handed out again (no second reply spliced on), and the lost holder's late pieces and result are refused.
    const again = await post("/pull", { agentId: worker.peerId }, worker);
    expect(again.json().subtask?.id ?? again.json().envelope?.subtaskId).not.toBe(subtaskId);
    expect((await post("/inference/chunks", { subtaskId, seq: 1, delta: "more" }, worker)).statusCode).toBe(403);
    const earned = await earnedMsat(worker.peerId);
    const late = await post("/result", { subtaskId, taskId, agentId: worker.peerId, ok: true, output: "partial more", durationMs: 100 }, worker);
    expect(late.statusCode).toBeGreaterThanOrEqual(400);
    expect(await earnedMsat(worker.peerId)).toBe(earned);
  }, 20_000);
});
