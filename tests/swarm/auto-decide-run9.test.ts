import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, earnedMsat, grantCredits } from "../../src/credits/store.js";

/*
 * Run 9 follow-up: the three standard Auto calls in run 9 were refused 25-48 s after submit (placed
 * on a host that did not take them, re-placed after BEST_FIT_REPLACE_MS onto busy hosts, ended by the
 * 45 s claim bound). An Auto call is now decided within INFERENCE_CLAIM_DECISION_MS (here 800 ms):
 * it waits a quarter window more only while its host could claim it, is re-placed only onto a host
 * that could claim it now, and is otherwise refused at once with nothing charged.
 *
 * Setup from auto-replace.test.ts (#523 (real coordinator app, Fastify inject): Auto does not count on an agent that has never pulled
 * work, and a call placed on an agent that does not come is re-placed on the next candidate after
 * INFERENCE_CLAIM_DECISION_MS (run 9: 2 s, plus a quarter window while it reports a free slot) instead of failing after 45 s. One reserve, settled once by the
 * agent that ran it; nothing paid to the one that did not come, which counts a failure on its circuit.
 */

const MESH = "mesh-secret-auto-decide";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.49";
const BIG = "qwen2.5-coder:7b";
const SMALL = "qwen2.5:3b";
const DECISION_MS = 800;
let portal: Server;
let app: any;
let mods: any;
const requester = createPeerKeys("agent-decide-requester");
const big = createPeerKeys("agent-decide-7b");
const small = createPeerKeys("agent-decide-3b");

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
  process.env.BEST_FIT_REPLACE_MS = "30000"; // the old fixed wait: not what decides now
  process.env.INFERENCE_CLAIM_DECISION_MS = String(DECISION_MS);
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
  delete process.env.INFERENCE_CLAIM_DECISION_MS;
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
const pull = async (k: PeerKeys, free = 1) => {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: 1, freeInferenceSlots: free }, k)).json();
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

const read = (taskId: string, subtaskId: string) => post("/inference/stream", { taskId, subtaskId, after: 0, waitMs: 0 }, requester);
const prompt = () => "Explain recursion in one paragraph " + randomUUID();

describe("run 9: Auto calls are decided within INFERENCE_CLAIM_DECISION_MS", () => {
  test("the chosen host waits a quarter window more while it could claim the call, and takes it", async () => {
    expect(await pull(big)).toBeNull();
    expect(await pull(small)).toBeNull();
    const c = await submitAuto(prompt());
    expect(c.model).toBe(BIG);
    // Run 12: first decided at three quarters of the window; the grace runs to the window's end.
    await sleep(DECISION_MS * 0.75 + 60);
    // Still placed on the 7b (it reports a free slot): not moved, not refused.
    expect(mods.context.queue.isUnclaimed(c.subtaskId)).toBe(true);
    expect(mods.context.usagePending.get(c.taskId)?.model).toBe(BIG);
    expect(await pull(big)).toBe(c.subtaskId);
    await finish(big, c.taskId, c.subtaskId, BIG);
  });

  test("its host cannot start it: moved at the decision time onto a host with a free slot", async () => {
    expect(await pull(small)).toBeNull();
    const c = await submitAuto(prompt());
    expect(c.model).toBe(BIG);
    // The 7b reports no free slot (busy elsewhere, throttled): it cannot claim the call.
    expect(await pull(big, 0)).toBeNull();
    const t0 = Date.now();
    let got: string | null = null;
    for (let i = 0; i < 60 && got === null; i++) {
      await sleep(50);
      got = await pull(small);
    }
    expect(got).toBe(c.subtaskId);
    expect(Date.now() - t0).toBeLessThan(DECISION_MS * 2.5);
    expect(mods.context.usagePending.get(c.taskId)?.model).toBe(SMALL);
    await finish(small, c.taskId, c.subtaskId, SMALL);
    expect(await pull(big)).toBeNull();
  });

  test("no host can start it: refused at the decision time (503 busy, nothing charged), never moved onto a busy host", async () => {
    expect(await pull(small)).toBeNull();
    expect(await pull(big)).toBeNull();
    const before = creditEngine.balance(requester.peerId);
    const t0 = Date.now();
    const c = await submitAuto(prompt());
    expect(c.model).toBe(BIG);
    // Both now report no free slot.
    expect(await pull(big, 0)).toBeNull();
    expect(await pull(small, 0)).toBeNull();
    let r = await read(c.taskId, c.subtaskId);
    for (let i = 0; i < 60 && r.statusCode === 200 && !r.json().done; i++) {
      await sleep(50);
      r = await read(c.taskId, c.subtaskId);
    }
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    // Within the decision window (2 s by default; 800 ms here), not BEST_FIT_REPLACE_MS or the 45 s bound.
    expect(Date.now() - t0).toBeLessThan(DECISION_MS * 2);
    // Not moved onto the busy 3b host on the way.
    expect(mods.context.usagePending.get(c.taskId)?.model ?? BIG).toBe(BIG);
    await sleep(50);
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
    expect(await pull(small)).toBeNull();
  });

  test("run 10: an Auto call taken back from its host is decided again (re-placed within the window, not left to the 45 s bound)", async () => {
    const inference = await import("../../src/swarm/coordinator/routes/inference.js");
    expect(await pull(big)).toBeNull();
    expect(await pull(small)).toBeNull();
    const c = await submitAuto(prompt());
    expect(c.model).toBe(BIG);
    expect(await pull(big)).toBe(c.subtaskId);
    // Its decision passed while it was claimed (as in run 10: claimed at once, taken back seconds later).
    await sleep(DECISION_MS * 1.6);
    // The 7b host runs out of CPU credit before its first piece: taken back (it may not get the call again).
    await post("/pull", { agentId: big.peerId, inferenceSlots: 1, freeInferenceSlots: 0, cpuThrottled: true, cpuStealShare: 0.8 }, big);
    await inference.takeBackStalledClaims(Date.now() + 2_500);
    expect(mods.context.queue.isUnclaimed(c.subtaskId)).toBe(true);
    const t0 = Date.now();
    let got: string | null = null;
    for (let i = 0; i < 60 && got === null; i++) {
      await sleep(50);
      got = await pull(small);
    }
    expect(got).toBe(c.subtaskId);
    expect(Date.now() - t0).toBeLessThan(DECISION_MS * 2.5);
    expect(mods.context.usagePending.get(c.taskId)?.model).toBe(SMALL);
    await finish(small, c.taskId, c.subtaskId, SMALL);
    (await import("../../src/swarm/coordinator/host-steal.js")).clearAgentSteal();
  });

  test("decideAuto: claimed calls are left alone", async () => {
    const autoReplace = await import("../../src/swarm/coordinator/auto-replace.js");
    expect(await pull(big)).toBeNull();
    const c = await submitAuto(prompt());
    expect(await pull(big)).toBe(c.subtaskId);
    const p = autoReplace.autoPlacementOf(c.subtaskId);
    expect(p).toBeDefined();
    expect(await autoReplace.decideAuto(p!)).toBe("claimed");
    await finish(big, c.taskId, c.subtaskId, BIG);
  });
});
