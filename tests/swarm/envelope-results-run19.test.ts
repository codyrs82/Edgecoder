import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";
import { decryptTaskEnvelope, encryptResult, generateX25519KeyPair, type TaskEnvelope, type X25519KeyPair } from "../../src/security/envelope.js";

/*
 * Network run 19 (subtask e62bda47, desktop-maw-mb-02), replayed on the real coordinator app: the
 * agent restarted (a new envelope key pair, registered again) and its first flush sent a result it
 * had buffered before, sealed for its old key, for a call it no longer held. Three AES-GCM failures
 * (claimant null), each answered 400, which the agent kept retrying at the head of its buffer.
 */

const MESH = "mesh-secret-envelope-r19";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.50";
const MODEL = "qwen-r19:1.5b";
let portal: Server;
let app: any;
let agentState: typeof import("../../src/swarm/coordinator/agent-state.js");
let envelopePolicy: typeof import("../../src/swarm/envelope-policy.js");
const requester = createPeerKeys("agent-r19-requester");
const hostA = createPeerKeys("agent-r19-lax");
const hostB = createPeerKeys("agent-r19-syd");
const xA: X25519KeyPair = generateX25519KeyPair();
const xB: X25519KeyPair = generateX25519KeyPair();

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
  process.env.ENVELOPE_REQUIRED = "1";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  agentState = await import("../../src/swarm/coordinator/agent-state.js");
  envelopePolicy = await import("../../src/swarm/envelope-policy.js");
  await app.ready();
  await register(requester, []);
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  delete process.env.ENVELOPE_REQUIRED;
});

async function register(keys: PeerKeys, installedModels: string[], x25519PublicKey?: string) {
  const payload = JSON.stringify({
    os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
    sandboxMode: "docker", installedModels, ...(x25519PublicKey ? { x25519PublicKey } : {}),
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

const PROMPT = "my private prompt 7f3a";
async function submit(): Promise<{ taskId: string; subtaskId: string }> {
  const taskId = `inf-${randomUUID()}`;
  const res = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: PROMPT }], timeoutMs: 60_000 }, requester);
  expect(res.statusCode, res.body).toBe(200);
  return { taskId, subtaskId: res.json().subtaskId };
}


async function claimAs(keys: PeerKeys, subtaskId: string): Promise<TaskEnvelope> {
  let envelope: TaskEnvelope | undefined;
  for (let i = 0; i < 5 && envelope?.subtaskId !== subtaskId; i++) envelope = (await post("/pull", { agentId: keys.peerId }, keys)).json().envelope;
  expect(envelope?.subtaskId).toBe(subtaskId);
  return envelope!;
}

async function handBack(keys: PeerKeys) {
  const res = await post("/heartbeat", { agentId: keys.peerId, goingOffline: "drain" }, keys);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json()).toMatchObject({ offline: true, released: 1 });
}

describe("network run 19: a result sealed for an agent's envelope key from before its restart", () => {
  test("with no claim for that agent it is refused for good (409 envelope_result_unusable), never opened", async () => {
    const before = generateX25519KeyPair();
    await register(hostA, [MODEL], before.publicKey.toString("base64"));
    const { taskId, subtaskId } = await submit();
    const envOld = await claimAs(hostA, subtaskId);
    const sealedOld = encryptResult({ ok: true, output: "answer from the old run", durationMs: 900 }, envOld, before.privateKey);
    // The agent stops without a goodbye; the call goes to another host, which finishes it.
    await handBack(hostA);
    agentState.agentCapabilities.delete(hostA.peerId);
    await register(hostB, [MODEL], xB.publicKey.toString("base64"));
    const envB = await claimAs(hostB, subtaskId);
    const encB = encryptResult({ ok: true, output: "answer from B", durationMs: 900 }, envB, xB.privateKey);
    expect((await post("/result", { ...encB, taskId, agentId: hostB.peerId, model: MODEL }, hostB)).statusCode).toBe(200);
    agentState.agentCapabilities.delete(hostB.peerId);

    // A restarts: a new envelope key pair, registered again, then flushes its buffer.
    await register(hostA, [MODEL], xA.publicKey.toString("base64"));
    const failsBefore = envelopePolicy.envelopeStats.decryptFailed;
    const res = await post("/result", { ...sealedOld, taskId, agentId: hostA.peerId, model: MODEL }, hostA);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: "envelope_result_unusable" });
    expect(envelopePolicy.envelopeStats.decryptFailed).toBe(failsBefore + 1);
  });

  test("the claimant's own result that does not authenticate stays a retryable 400 and keeps its claim", async () => {
    await register(hostA, [MODEL], xA.publicKey.toString("base64"));
    const { taskId, subtaskId } = await submit();
    const envA = await claimAs(hostA, subtaskId);
    const forged = encryptResult({ ok: true, output: "forged", durationMs: 900 }, envA, generateX25519KeyPair().privateKey);
    const res = await post("/result", { ...forged, taskId, agentId: hostA.peerId, model: MODEL }, hostA);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "envelope_decrypt_failed" });
    const real = encryptResult({ ok: true, output: "answer from A", durationMs: 900 }, envA, xA.privateKey);
    expect((await post("/result", { ...real, taskId, agentId: hostA.peerId, model: MODEL }, hostA)).statusCode).toBe(200);
  });

  test("run 19 duplicate (inf-1795720679465-e55bb2b1): a memory-cancelled result crossing the hand-back is refused, so another host runs the call", async () => {
    // iad was 8 s into a ~71 s call (estimated prefill alone 21 s) when its guard cancelled it: the
    // result it posted was the cancellation, not an answer.
    await register(hostA, [MODEL], xA.publicKey.toString("base64"));
    const { taskId, subtaskId } = await submit();
    const envA = await claimAs(hostA, subtaskId);
    const cancelled = encryptResult({ ok: false, output: "", error: "memory_pressure: cancelled, this host ran critically low on memory", durationMs: 7600 }, envA, xA.privateKey);
    await handBack(hostA);
    const res = await post("/result", { ...cancelled, taskId, agentId: hostA.peerId, model: MODEL }, hostA);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: "lease_expired" });
    agentState.agentCapabilities.delete(hostA.peerId);
    await register(hostB, [MODEL], xB.publicKey.toString("base64"));
    expect((await claimAs(hostB, subtaskId)).subtaskId).toBe(subtaskId);
    agentState.agentCapabilities.delete(hostB.peerId);
  });
});
