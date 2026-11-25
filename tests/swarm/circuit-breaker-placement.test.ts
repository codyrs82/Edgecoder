import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";

/*
 * B4 (network test 2026-11-24, real coordinator app via Fastify inject): calls waited 45 s behind
 * cloud-fireworks-1's open circuit, and each of those waits counted as a new trip. Now an agent whose
 * circuit is open gets no placement; a named call whose only holders are cooling down is refused at
 * once (503 no_capacity, reason cooling_down, Retry-After); and when a circuit trips, the calls
 * waiting for that agent are re-placed (Auto) or ended and refunded (named, no other holder) at once,
 * without the breaker's own wait counting as another failure.
 */

const MESH = "mesh-secret-circuit-placement";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.57";
const BIG = "qwen2.5-coder:7b";
const SMALL = "qwen2.5:3b";
let portal: Server;
let app: any;
let mods: any;
const requester = createPeerKeys("agent-circuit-requester");
const big = createPeerKeys("agent-circuit-7b");
const small = createPeerKeys("agent-circuit-3b");

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
  // Long, so only a trip can move a call within the test.
  process.env.BEST_FIT_REPLACE_MS = "30000";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  mods = {
    memory: await import("../../src/swarm/coordinator/memory-admission.js"),
    context: await import("../../src/swarm/coordinator/context.js"),
    inference: await import("../../src/swarm/coordinator/routes/inference.js"),
    autoReplace: await import("../../src/swarm/coordinator/auto-replace.js"),
  };
  await app.ready();
  await register(requester, []);
  await register(big, [BIG]);
  await register(small, [SMALL]);
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  delete process.env.BEST_FIT_REPLACE_MS;
  mods?.autoReplace.clearAutoReplaceTimers();
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

beforeEach(async () => {
  mods.memory.resetMemoryAdmission();
  // Both proven pullers (an agent that never pulled is not counted on).
  expect(await pull(big)).toBeNull();
  expect(await pull(small)).toBeNull();
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
const submit = (model: string, content: string) => post("/inference/submit", { taskId: `inf-${randomUUID()}`, submitterAccountId: requester.peerId, model, timeoutMs: 60_000, messages: [{ role: "user", content }] }, requester);
const tripBig = () => {
  for (let i = 0; i < mods.memory.circuitThreshold(big.peerId); i++) mods.memory.noteAgentOutcome(big.peerId, false);
  expect(mods.memory.circuitOpen(big.peerId)).toBe(true);
};
const finish = async (k: PeerKeys, taskId: string, subtaskId: string, model: string) => {
  expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 8, outputTokens: 1 }, k)).statusCode).toBe(200);
  expect((await post("/result", { subtaskId, taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model }, k)).statusCode).toBe(200);
};

describe("B4: an open circuit gets no placement", () => {
  test("a named call whose only holder is cooling down is refused at once, retryable, nothing reserved", async () => {
    tripBig();
    const before = creditEngine.balance(requester.peerId);
    const started = Date.now();
    const r = await submit(BIG, "hello");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "cooling_down" });
    const retryAfter = Number(r.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(creditEngine.balance(requester.peerId)).toBe(before);
  });

  test("Auto does not place on an agent whose circuit is open", async () => {
    tripBig();
    const r = await submit("auto", "Explain recursion in one paragraph " + randomUUID());
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json();
    expect(c.model).toBe(SMALL);
    expect(await pull(small)).toBe(c.subtaskId);
    await finish(small, mods.context.queue.getSubtask(c.subtaskId).taskId, c.subtaskId, SMALL);
  });
});

describe("B4: a trip moves the calls waiting for that agent", () => {
  test("a waiting Auto call is re-placed at once, and the breaker's wait is not another failure", async () => {
    const r = await submit("auto", "Explain recursion in one paragraph " + randomUUID());
    expect(r.statusCode, r.body).toBe(200);
    const { subtaskId, model } = r.json();
    expect(model).toBe(BIG);
    const taskId = mods.context.queue.getSubtask(subtaskId).taskId;
    // The 7b agent never comes; its circuit trips (other calls failed on it).
    tripBig();
    let got: string | null = null;
    for (let i = 0; i < 20 && got === null; i++) {
      await sleep(25);
      got = await pull(small);
    }
    expect(got).toBe(subtaskId);
    expect(mods.context.usagePending.get(taskId)?.model).toBe(SMALL);
    expect(mods.memory.circuitState(big.peerId)).toMatchObject({ trips: 1, recentFailures: 0 });
    await finish(small, taskId, subtaskId, SMALL);
  });

  test("a waiting named call no other agent can take is ended and refunded at once (cooling_down)", async () => {
    const before = creditEngine.balance(requester.peerId);
    const r = await submit(BIG, "hello " + randomUUID());
    expect(r.statusCode, r.body).toBe(200);
    const { subtaskId } = r.json();
    const taskId = mods.context.queue.getSubtask(subtaskId).taskId;
    expect(creditEngine.balance(requester.peerId)).toBeLessThan(before);
    tripBig();
    for (let i = 0; i < 20 && !mods.inference.inferenceCancelledForCapacity(taskId); i++) await sleep(25);
    expect(mods.inference.inferenceCancelledForCapacity(taskId)).toBe(true);
    expect(mods.context.queue.isUnclaimed(subtaskId)).toBe(false);
    expect(creditEngine.balance(requester.peerId)).toBe(before);
    // The 7b agent coming back later finds nothing.
    expect(await pull(big)).toBeNull();
  });
});
