import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, earnedMsat, grantCredits } from "../../src/credits/store.js";

/*
 * A model call whose agent vanished (its lease expired) goes back on the queue with the
 * no-capacity bound armed again: if nobody takes it, it is cancelled and refunded in full instead
 * of keeping the requester's reserve until some agent shows up (real coordinator app).
 */

const MESH = "mesh-secret-lease-requeue";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.47";
const MODEL = "qwen-lease:7b";
const CLAIM_TIMEOUT_MS = 1_500;
const LIVENESS_MS = 1_000;
let portal: Server;
let app: any;
const requester = createPeerKeys("agent-lease-requester");
const worker = createPeerKeys("agent-lease-worker");

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

describe("inference requeued after a lease expiry", () => {
  test("nobody takes it again: cancelled within the claim bound, refunded in full, and the late holder earns nothing", async () => {
    const before = creditEngine.balance(requester.peerId);
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId);
    expect(sub.statusCode, sub.body).toBe(200);
    const subtaskId = sub.json().subtaskId;
    const pulled = await post("/pull", { agentId: worker.peerId }, worker);
    expect(pulled.json().subtask?.id ?? pulled.json().envelope?.subtaskId).toBe(subtaskId);
    // The worker vanishes: no heartbeat, no result. Past the original claim bound and the lease's liveness.
    await sleep(CLAIM_TIMEOUT_MS + LIVENESS_MS);
    // Any agent traffic (here the requester's heartbeat) expires the lease; the call is requeued.
    await post("/heartbeat", { agentId: requester.peerId }, requester);
    const reading = post("/inference/stream", { taskId, subtaskId, waitMs: 10_000 }, requester).then((r: unknown) => r);
    const read: any = await reading;
    expect(read.statusCode, read.body).toBe(503);
    expect(read.json()).toMatchObject({ error: "no_capacity" });
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
    const earned = await earnedMsat(worker.peerId);
    const late = await post("/result", { subtaskId, taskId, agentId: worker.peerId, ok: true, output: "late", durationMs: 100 }, worker);
    expect(late.statusCode).toBeGreaterThanOrEqual(400);
    expect(await earnedMsat(worker.peerId)).toBe(earned);
  }, 20_000);
});
