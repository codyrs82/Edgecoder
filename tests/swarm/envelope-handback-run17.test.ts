import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";
import { decryptTaskEnvelope, encryptResult, generateX25519KeyPair, type TaskEnvelope, type X25519KeyPair } from "../../src/security/envelope.js";

/*
 * Network run 17 (inf-1795701785966-351be87d), replayed on the real coordinator app: host A posted
 * its finished, envelope-encrypted result and, 3 ms later, handed its claims back (critical memory
 * pressure). The result was refused, host B claimed the call (its envelope key replaced A's in the
 * cache), and A's retries failed AES-GCM authentication against B's key. B ran the call again.
 */

const MESH = "mesh-secret-envelope-r17";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.49";
const MODEL = "qwen-r17:1.5b";
let portal: Server;
let app: any;
let agentState: typeof import("../../src/swarm/coordinator/agent-state.js");
let envelopePolicy: typeof import("../../src/swarm/envelope-policy.js");
const requester = createPeerKeys("agent-r17-requester");
const hostA = createPeerKeys("agent-r17-lax");
const hostB = createPeerKeys("agent-r17-syd");
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

describe("network run 17: a finished result and a claim hand-back cross", () => {
  test("A's result arriving just after its hand-back is taken while nobody else has claimed the call", async () => {
    await register(hostA, [MODEL], xA.publicKey.toString("base64"));
    const { taskId, subtaskId } = await submit();
    const envelope = await claimAs(hostA, subtaskId);
    expect(decryptTaskEnvelope(envelope, xA.privateKey).input).toContain(PROMPT);
    const enc = encryptResult({ ok: true, output: "answer from A", durationMs: 900 }, envelope, xA.privateKey);
    await handBack(hostA);
    const res = await post("/result", { ...enc, taskId, agentId: hostA.peerId, model: MODEL }, hostA);
    expect(res.statusCode, res.body).toBe(200);
    // Settled once: nobody else can claim it now.
    await register(hostB, [MODEL], xB.publicKey.toString("base64"));
    const pulled = await post("/pull", { agentId: hostB.peerId }, hostB);
    expect(pulled.json().envelope?.subtaskId).not.toBe(subtaskId);
    agentState.agentCapabilities.delete(hostB.peerId);
  });

  test("after B claims the call, A's retry still decrypts (no auth failure) and is refused as late; B's result is taken", async () => {
    await register(hostA, [MODEL], xA.publicKey.toString("base64"));
    const { taskId, subtaskId } = await submit();
    const envA = await claimAs(hostA, subtaskId);
    const encA = encryptResult({ ok: true, output: "answer from A", durationMs: 900 }, envA, xA.privateKey);
    await handBack(hostA);
    agentState.agentCapabilities.delete(hostA.peerId);
    await register(hostB, [MODEL], xB.publicKey.toString("base64"));
    const envB = await claimAs(hostB, subtaskId);
    // The cache now holds B's key for this subtask (as on the coordinator in run 17).
    expect(agentState.envelopeSharedKeys.get(subtaskId)?.agentId).toBe(hostB.peerId);
    await register(hostA, [MODEL], xA.publicKey.toString("base64"));

    const failsBefore = envelopePolicy.envelopeStats.decryptFailed;
    const retry = await post("/result", { ...encA, taskId, agentId: hostA.peerId, model: MODEL }, hostA);
    expect(envelopePolicy.envelopeStats.decryptFailed).toBe(failsBefore);
    // A permanent refusal the agent stops retrying on (pending-results.ts isPermanentResultRefusal).
    expect(retry.statusCode, retry.body).toBe(409);
    expect(retry.json()).toEqual({ error: "lease_expired" });
    // B's own key was not spent by A's attempt.
    expect(agentState.envelopeSharedKeys.get(subtaskId)?.agentId).toBe(hostB.peerId);

    const encB = encryptResult({ ok: true, output: "answer from B", durationMs: 900 }, envB, xB.privateKey);
    const resB = await post("/result", { ...encB, taskId, agentId: hostB.peerId, model: MODEL }, hostB);
    expect(resB.statusCode, resB.body).toBe(200);
    agentState.agentCapabilities.delete(hostB.peerId);
  });

  test("a result under a key A does not share for the subtask is still refused", async () => {
    await register(hostA, [MODEL], xA.publicKey.toString("base64"));
    const { taskId, subtaskId } = await submit();
    const envA = await claimAs(hostA, subtaskId);
    const forged = encryptResult({ ok: true, output: "forged", durationMs: 900 }, envA, generateX25519KeyPair().privateKey);
    const res = await post("/result", { ...forged, taskId, agentId: hostA.peerId, model: MODEL }, hostA);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "envelope_decrypt_failed" });
    // The claim is left with A (nothing re-queued on a decrypt failure): its real result is taken.
    const real = encryptResult({ ok: true, output: "answer from A", durationMs: 900 }, envA, xA.privateKey);
    const ok = await post("/result", { ...real, taskId, agentId: hostA.peerId, model: MODEL }, hostA);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  test("a failure result after the hand-back does not take the call back", async () => {
    await register(hostA, [MODEL], xA.publicKey.toString("base64"));
    const { taskId, subtaskId } = await submit();
    const envA = await claimAs(hostA, subtaskId);
    const enc = encryptResult({ ok: false, output: "", error: "memory_critical: cancelled", durationMs: 100 }, envA, xA.privateKey);
    await handBack(hostA);
    const res = await post("/result", { ...enc, taskId, agentId: hostA.peerId, model: MODEL }, hostA);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: "lease_expired" });
  });
});
