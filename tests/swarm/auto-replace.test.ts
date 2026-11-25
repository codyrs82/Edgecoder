import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, earnedMsat, grantCredits } from "../../src/credits/store.js";

/*
 * #523 (real coordinator app, Fastify inject): Auto does not count on an agent that has never pulled
 * work, and a call placed on an agent that does not come is re-placed on the next candidate after
 * BEST_FIT_REPLACE_MS (here 600 ms) instead of failing after 45 s. One reserve, settled once by the
 * agent that ran it; nothing paid to the one that did not come, which counts a failure on its circuit.
 */

const MESH = "mesh-secret-auto-replace";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.49";
const BIG = "qwen2.5-coder:7b";
const SMALL = "qwen2.5:3b";
let portal: Server;
let app: any;
let mods: any;
const requester = createPeerKeys("agent-replace-requester");
const big = createPeerKeys("agent-replace-7b");
const small = createPeerKeys("agent-replace-3b");

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
  process.env.BEST_FIT_REPLACE_MS = "600";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  mods = {
    routing: await import("../../src/swarm/coordinator/routing.js"),
    memory: await import("../../src/swarm/coordinator/memory-admission.js"),
    context: await import("../../src/swarm/coordinator/context.js"),
  };
  await app.ready();
  await register(requester, []);
  await register(big, [BIG]);
  await register(small, [SMALL]);
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  delete process.env.BEST_FIT_REPLACE_MS;
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
const pull = async (k: PeerKeys) => {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: 1, freeInferenceSlots: 1 }, k)).json();
  return (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null;
};
const submitAuto = async (content: string) => {
  const taskId = `inf-${randomUUID()}`;
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: "auto", timeoutMs: 60_000, messages: [{ role: "user", content }] }, requester);
  expect(r.statusCode, r.body).toBe(200);
  return { taskId, ...r.json() } as { taskId: string; subtaskId: string; model: string; reservedCSats: number };
};
const finish = async (k: PeerKeys, taskId: string, subtaskId: string, model: string) => {
  expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 8, outputTokens: 1 }, k)).statusCode).toBe(200);
  expect((await post("/result", { subtaskId, taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model }, k)).statusCode).toBe(200);
};

describe("Auto and agents that do not pull", () => {
  test("an agent that has never pulled is not counted on: a proven one is chosen", async () => {
    expect(await pull(small)).toBeNull();
    const c = await submitAuto("What is a closure in JavaScript?");
    expect(c.model).toBe(SMALL);
    expect(await pull(small)).toBe(c.subtaskId);
    await finish(small, c.taskId, c.subtaskId, SMALL);
  });

  test("a call placed on an agent that stops pulling is re-placed on the next candidate", async () => {
    // Both pull (proven); the 7b is the best fit for a question.
    expect(await pull(big)).toBeNull();
    expect(await pull(small)).toBeNull();
    const before = creditEngine.balance(requester.peerId);
    const earnedBig = await earnedMsat(big.peerId);
    const c = await submitAuto("Explain recursion in one paragraph " + randomUUID());
    expect(c.model).toBe(BIG);
    // The 7b agent never comes. The 3b agent cannot take a 7b call ...
    expect(await pull(small)).toBeNull();
    // ... until the call is re-placed on it.
    let got: string | null = null;
    for (let i = 0; i < 60 && got === null; i++) {
      await sleep(50);
      got = await pull(small);
    }
    expect(got).toBe(c.subtaskId);
    expect(mods.context.usagePending.get(c.taskId)?.model).toBe(SMALL);
    const d = mods.routing.recentDecisions(5).find((x: { taskId: string }) => x.taskId === c.taskId);
    expect(d).toMatchObject({ model: SMALL });
    expect(d.reason).toMatch(/^re-placed: nobody picked it up within 1 s; was qwen2\.5-coder:7b/);
    // A pickup timeout on an idle agent counts on its circuit breaker.
    expect(mods.memory.circuitState(big.peerId).recentFailures).toBeGreaterThanOrEqual(1);
    await finish(small, c.taskId, c.subtaskId, SMALL);
    // One reserve, settled once; nothing to the agent that did not come.
    const after = creditEngine.balance(requester.peerId);
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThanOrEqual(before - c.reservedCSats);
    expect(await earnedMsat(big.peerId)).toBe(earnedBig);
    // The 7b agent coming late finds nothing.
    expect(await pull(big)).toBeNull();
  });
});
