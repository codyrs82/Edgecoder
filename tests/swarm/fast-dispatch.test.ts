import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { signMeshWsBind } from "../../src/mesh/ws-auth.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";
import { DEFER_MS, pickupStats } from "../../src/swarm/coordinator/dispatch.js";

// A call here waits past DEFER_MS (1.5 s) on purpose; the claim decision (1.6 s at the default since
// run 16) is not what these test (tests/swarm/run14-decide.test.ts). Set before the static imports load the config.
vi.hoisted(() => {
  process.env.INFERENCE_CLAIM_DECISION_MS = "4000";
});

/*
 * Fast dispatch (real coordinator app, Fastify inject + injectWS): a new call is announced at once
 * to idle eligible agents over their authenticated mesh WebSocket, with a frame that carries no
 * task; the agent's signed /pull still decides. A model call goes only to an agent with a free
 * slot, and an agent already running something leaves a fresh call to an idle one for DEFER_MS.
 */

const MESH = "mesh-secret-dispatch";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.46";
const MODEL = "qwen-dispatch:1.5b";
let portal: Server;
let app: any;
const requester = createPeerKeys("agent-dispatch-requester");
const busy = createPeerKeys("agent-dispatch-busy");
const idle = createPeerKeys("agent-dispatch-idle");
const unsigned = createPeerKeys("agent-dispatch-unsigned");
const frames = new Map<string, Array<{ atMs: number; data: string }>>();
const sockets: any[] = [];

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
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  await register(requester, []);
  for (const k of [busy, idle, unsigned]) await register(k, [MODEL]);
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
  for (const k of [busy, idle, unsigned]) {
    const headers = { "x-mesh-token": MESH, ...(k === unsigned ? {} : signMeshWsBind(k.peerId, k.privateKeyPem)) };
    const ws = await app.injectWS(`/mesh/ws?peerId=${k.peerId}`, { headers });
    frames.set(k.peerId, []);
    ws.on("message", (d: Buffer) => frames.get(k.peerId)!.push({ atMs: Date.now(), data: d.toString() }));
    sockets.push(ws);
  }
}, 60_000);

afterAll(async () => {
  delete process.env.INFERENCE_CLAIM_DECISION_MS;
  for (const ws of sockets) ws.terminate();
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
const pull = async (k: PeerKeys, slots = 2, free = 2) => {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: slots, freeInferenceSlots: free, wake: true }, k)).json();
  return (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null;
};
const submit = async () => {
  const taskId = `inf-${randomUUID()}`;
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester);
  expect(r.statusCode, r.body).toBe(200);
  return { taskId, subtaskId: r.json().subtaskId as string, atMs: Date.now() };
};
const finish = async (k: PeerKeys, c: { taskId: string; subtaskId: string }) => {
  await post("/inference/chunks", { subtaskId: c.subtaskId, seq: 0, delta: "ok", done: true }, k);
  await post("/result", { subtaskId: c.subtaskId, taskId: c.taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model: MODEL }, k);
};
const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(5);
  return cond();
};

describe("fast dispatch", () => {
  test("a new call is announced at once to idle agents, with a frame that carries no task", async () => {
    // Agents say they take nudges (and their slots) when they pull; nothing is queued yet.
    for (const k of [busy, idle, unsigned]) expect(await pull(k)).toBeNull();
    for (const f of frames.values()) f.length = 0;
    const c = await submit();
    expect(await until(() => frames.get(busy.peerId)!.length > 0 && frames.get(idle.peerId)!.length > 0, 1_000)).toBe(true);
    const latency = Math.max(frames.get(busy.peerId)![0].atMs, frames.get(idle.peerId)![0].atMs) - c.atMs;
    console.log(`[fast-dispatch] submit -> nudge: ${latency} ms`);
    expect(latency).toBeLessThan(250);
    for (const k of [busy, idle]) expect(frames.get(k.peerId)!.map((f) => JSON.parse(f.data))).toEqual([{ type: "work_available" }]);
    expect(frames.get(busy.peerId)![0].data).not.toContain(c.subtaskId);
    // An unauthenticated (unsigned) bind is never nudged.
    expect(frames.get(unsigned.peerId)).toEqual([]);
    // The nudged agent pulls and gets it through the normal claim.
    expect(await pull(idle)).toBe(c.subtaskId);
    await finish(idle, c);
  });

  test("a busy agent's pull leaves a fresh call to an idle agent; after DEFER_MS anyone may take it", async () => {
    const first = await submit();
    expect(await pull(busy)).toBe(first.subtaskId); // busy now runs one call (one slot left)
    for (const f of frames.values()) f.length = 0;
    const second = await submit();
    // The idle agent is nudged first; the busy one is not taken while the idle one can come.
    expect(await until(() => frames.get(idle.peerId)!.length > 0, 1_000)).toBe(true);
    expect(await pull(busy, 2, 1)).toBeNull();
    expect(await pull(idle)).toBe(second.subtaskId);
    await finish(idle, second);

    // The idle agent does not come: the busy one (with a free slot) gets it after DEFER_MS, and is nudged.
    const third = await submit();
    expect(await pull(busy, 2, 1)).toBeNull();
    for (const f of frames.values()) f.length = 0;
    await sleep(DEFER_MS + 150);
    expect(frames.get(busy.peerId)!.length).toBeGreaterThan(0);
    expect(await pull(busy, 2, 1)).toBe(third.subtaskId);
    await finish(busy, first);
    await finish(busy, third);
  });

  test("a model call goes only to an agent with a free slot", async () => {
    const c = await submit();
    expect(await pull(busy, 2, 0)).toBeNull(); // the agent says both slots are busy
    expect(await pull(idle, 1, 1)).toBe(c.subtaskId);
    await finish(idle, c);
    // One slot, holding one call: nothing more, whatever it reports.
    const a = await submit();
    expect(await pull(idle, 1, 1)).toBe(a.subtaskId);
    const b = await submit();
    await sleep(DEFER_MS + 50);
    expect(await pull(idle, 1, 1)).toBeNull();
    expect(await pull(busy)).toBe(b.subtaskId);
    await finish(idle, a);
    await finish(busy, b);
    expect(pickupStats().count).toBeGreaterThan(0);
  });

  test("a call longer than an agent's context window goes to an agent with a bigger one; none big enough: 413", async () => {
    const long = "x".repeat(40_000); // ~13k tokens with the reply
    const taskId = `inf-${randomUUID()}`;
    const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: long }], maxTokens: 512, timeoutMs: 60_000 }, requester);
    expect(r.statusCode, r.body).toBe(200);
    const subtaskId = r.json().subtaskId;
    const pullWin = async (k: PeerKeys, contextWindow: number) => {
      const j = (await post("/pull", { agentId: k.peerId, inferenceSlots: 2, freeInferenceSlots: 2, contextWindow, wake: true }, k)).json();
      return (j.subtask?.id ?? j.envelope?.subtaskId ?? null) as string | null;
    };
    await sleep(DEFER_MS + 50);
    expect(await pullWin(idle, 8192)).toBeNull();
    expect(await pullWin(busy, 16_384)).toBe(subtaskId);
    await finish(busy, { taskId, subtaskId });
    // The unsigned agent has the model too: make it report a small window, like the others.
    expect(await pullWin(unsigned, 8192)).toBeNull();
    await pullWin(busy, 8192);
    const huge = await post("/inference/submit", { taskId: `inf-${randomUUID()}`, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: long }], maxTokens: 512, timeoutMs: 60_000 }, requester);
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toMatchObject({ error: "context_too_long", largestContextWindow: 8192 });
  });
  test("model affinity: a known-cold agent leaves a fresh call to a warm one, but not when it is the preferred agent (locality, best fit)", async () => {
    const mem = await import("../../src/swarm/coordinator/memory-admission.js");
    const dispatch = await import("../../src/swarm/coordinator/dispatch.js");
    const GB = 1024 ** 3;
    const tele = (loaded: string[]) => ({ totalBytes: 64 * GB, pressure: "normal" as const, budgetBytes: 32 * GB, usedBytes: 0, loadedModels: loaded.map((name) => ({ name, bytes: GB })), models: [{ name: MODEL, bytes: GB, contextWindow: 32_768, slots: 2 }], atMs: Date.now() });
    dispatch.forgetAgentLoad(busy.peerId); // it has not served MODEL lately
    for (const k of [busy, idle]) expect(await pull(k)).toBeNull();
    mem.noteAgentMemory(busy.peerId, tele([]));
    mem.noteAgentMemory(idle.peerId, tele([MODEL]));
    try {
      expect(dispatch.modelKnownCold(busy.peerId, MODEL)).toBe(true);
      const a = await submit();
      expect(await pull(busy)).toBeNull(); // cold, and idle has it loaded with room
      expect(await pull(idle)).toBe(a.subtaskId);
      await finish(idle, a);
      // Run 2's B1: the nearest host was preferred for 1 s but deferred 1.5 s to the warm Mac.
      const b = await submit();
      dispatch.preferAgent(b.subtaskId, busy.peerId, 2_000);
      expect(await pull(idle)).toBeNull(); // left to the preferred agent
      expect(await pull(busy)).toBe(b.subtaskId); // not held back by affinity
      await finish(busy, b);
      // It ran MODEL just now: warm, whatever its telemetry said.
      expect(dispatch.modelWarmOn(busy.peerId, MODEL)).toBe(true);
      expect(dispatch.modelKnownCold(busy.peerId, MODEL)).toBe(false);
    } finally {
      mem.resetMemoryAdmission();
    }
  });

  test("C3: the locality choice is still nudged first when its hold ends", async () => {
    const dispatch = await import("../../src/swarm/coordinator/dispatch.js");
    const { queue } = await import("../../src/swarm/coordinator/context.js");
    for (const k of [busy, idle]) expect(await pull(k)).toBeNull();
    // The other agent ran MODEL just now (warm); the preferred one reports nothing (not known cold).
    dispatch.noteModelServed(idle.peerId, MODEL);
    const c = await submit();
    dispatch.preferAgent(c.subtaskId, busy.peerId, 1);
    await sleep(10);
    expect(dispatch.preferredAgentFor(c.subtaskId)).toBeUndefined();
    expect(dispatch.nudgeTargets(queue.getSubtask(c.subtaskId)!)[0]).toBe(busy.peerId);
    expect(await pull(busy)).toBe(c.subtaskId);
    await finish(busy, c);
  });

  test("/inference/models reports free model slots, so the portal can compare coordinators by room left", async () => {
    const models = async () => ((await app.inject({ method: "GET", url: "/inference/models", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } })).json().models as Array<{ model: string; freeSlots?: number; idleAgents: number }>).find((m) => m.model === MODEL)!;
    // Each of busy and idle reports 2 slots, both free.
    await pull(busy, 2, 2);
    await pull(idle, 2, 2);
    const before = await models();
    const c = await submit();
    expect(await pull(idle, 2, 2)).toBe(c.subtaskId);
    const after = await models();
    // idle now holds one of its two slots: one fewer free slot, and the other still counts.
    expect(before.freeSlots).toBeGreaterThanOrEqual(4);
    expect(after.freeSlots).toBe((before.freeSlots ?? 0) - 1);
    await finish(idle, c);
  });
});
