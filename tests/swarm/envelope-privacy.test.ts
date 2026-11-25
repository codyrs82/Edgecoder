import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";
import { decryptTaskEnvelope, encryptResult, generateX25519KeyPair, type TaskEnvelope, type X25519KeyPair } from "../../src/security/envelope.js";

/*
 * Task privacy on the real coordinator app, with ENVELOPE_REQUIRED on:
 *  - an agent without an envelope key gets no user data;
 *  - an agent whose envelope cannot be built gets an error, never plaintext, and the subtask stays claimable;
 *  - a coordinator restart between claim and result does not lose the envelope key.
 */

const MESH = "mesh-secret-envelope-privacy";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.48";
const MODEL = "qwen-envelope:7b";
let portal: Server;
let app: any;
let agentState: typeof import("../../src/swarm/coordinator/agent-state.js");
let envelopePolicy: typeof import("../../src/swarm/envelope-policy.js");
const requester = createPeerKeys("agent-env-requester");
const keyless = createPeerKeys("agent-env-keyless");
const broken = createPeerKeys("agent-env-broken");
const sealed = createPeerKeys("agent-env-sealed");
const sealedX25519: X25519KeyPair = generateX25519KeyPair();

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

describe("envelope privacy (ENVELOPE_REQUIRED=1)", () => {
  test("an agent without an envelope key is not given the task", async () => {
    await register(keyless, [MODEL]);
    const { subtaskId } = await submit();
    const pulled = await post("/pull", { agentId: keyless.peerId }, keyless);
    expect(pulled.statusCode).toBe(200);
    expect(pulled.json().subtask).toBeNull();
    expect(pulled.body).not.toContain(PROMPT);
    // Still claimable by an agent with a key.
    await register(sealed, [MODEL], sealedX25519.publicKey.toString("base64"));
    const ok = await post("/pull", { agentId: sealed.peerId }, sealed);
    expect(ok.json().envelope?.subtaskId).toBe(subtaskId);
    expect(ok.body).not.toContain(PROMPT);
    agentState.agentCapabilities.delete(keyless.peerId);
  });

  test("a failed envelope is an error, never plaintext, and the subtask is handed back", async () => {
    // 16 bytes: not an X25519 key, so the envelope cannot be built.
    await register(broken, [MODEL], Buffer.alloc(16, 7).toString("base64"));
    const failsBefore = envelopePolicy.envelopeStats.encryptFailed;
    const plainBefore = envelopePolicy.envelopeStats.plaintext;
    const { subtaskId } = await submit();
    const pulled = await post("/pull", { agentId: broken.peerId }, broken);
    expect(pulled.statusCode).toBe(503);
    expect(pulled.json()).toEqual({ error: "envelope_encryption_failed" });
    expect(pulled.body).not.toContain(PROMPT);
    expect(envelopePolicy.envelopeStats.encryptFailed).toBe(failsBefore + 1);
    expect(envelopePolicy.envelopeStats.plaintext).toBe(plainBefore);
    agentState.agentCapabilities.delete(broken.peerId);
    // Another agent claims it.
    await register(sealed, [MODEL], sealedX25519.publicKey.toString("base64"));
    const again = await post("/pull", { agentId: sealed.peerId }, sealed);
    expect(again.json().envelope?.subtaskId).toBe(subtaskId);
  });

  test("a coordinator restart between claim and result: the result still decrypts", async () => {
    await register(sealed, [MODEL], sealedX25519.publicKey.toString("base64"));
    // Drain anything the earlier tests left claimable for this agent.
    const { taskId, subtaskId } = await submit();
    let envelope: TaskEnvelope | undefined;
    for (let i = 0; i < 5 && envelope?.subtaskId !== subtaskId; i++) envelope = (await post("/pull", { agentId: sealed.peerId }, sealed)).json().envelope;
    expect(envelope?.subtaskId).toBe(subtaskId);
    const task = decryptTaskEnvelope(envelope!, sealedX25519.privateKey);
    expect(task.input).toContain(PROMPT);

    // Restart: the in-memory key cache and agent registry are gone; the agent registers again
    // (same keys, as a running agent does) before reporting.
    agentState.envelopeSharedKeys.clear();
    agentState.agentCapabilities.delete(sealed.peerId);
    await register(sealed, [MODEL], sealedX25519.publicKey.toString("base64"));
    const rederivedBefore = envelopePolicy.envelopeStats.rederived;

    const enc = encryptResult({ ok: true, output: "the private answer", durationMs: 900 }, envelope!, sealedX25519.privateKey);
    const res = await post("/result", { ...enc, taskId, agentId: sealed.peerId, model: MODEL }, sealed);
    expect(res.statusCode, res.body).toBe(200);
    expect(envelopePolicy.envelopeStats.rederived).toBe(rederivedBefore + 1);
  });

  test("an encrypted result under the wrong key is refused", async () => {
    await register(sealed, [MODEL], sealedX25519.publicKey.toString("base64"));
    const { taskId, subtaskId } = await submit();
    let envelope: TaskEnvelope | undefined;
    for (let i = 0; i < 5 && envelope?.subtaskId !== subtaskId; i++) envelope = (await post("/pull", { agentId: sealed.peerId }, sealed)).json().envelope;
    expect(envelope?.subtaskId).toBe(subtaskId);
    const other = generateX25519KeyPair();
    const enc = encryptResult({ ok: true, output: "forged", durationMs: 900 }, envelope!, other.privateKey);
    const res = await post("/result", { ...enc, taskId, agentId: sealed.peerId, model: MODEL }, sealed);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "envelope_decrypt_failed" });
  });
});
