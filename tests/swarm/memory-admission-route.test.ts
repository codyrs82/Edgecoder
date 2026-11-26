import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { signMeshWsBind } from "../../src/mesh/ws-auth.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";
import { DEFER_MS } from "../../src/swarm/coordinator/dispatch.js";
import { agentMemory } from "../../src/swarm/coordinator/memory-admission.js";
import type { MemoryTelemetry } from "../../src/swarm/memory-budget.js";

// The calls here wait past DEFER_MS (1.5 s) on purpose; the claim decision (1.5 s by default since
// run 11) is not what these test (tests/swarm/run11-overflow.test.ts). Set before the static imports
// above load the coordinator config.
vi.hoisted(() => {
  process.env.INFERENCE_CLAIM_DECISION_MS = "4000";
});

/*
 * Coordinator admission control on the real app (heartbeat telemetry -> /pull): a call goes to an
 * agent only if its model is loaded there or fits the agent's budget headroom; an agent with the
 * model loaded is preferred (affinity); memory pressure means no dispatch; /inference/models is honest.
 */

const MESH = "mesh-secret-memadmit";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.47";
const MODEL = "qwen-memadmit:9b";
const GB = 1024 ** 3;
let portal: Server;
let app: any;
const requester = createPeerKeys("agent-memadmit-requester");
const warm = createPeerKeys("agent-memadmit-warm");
const cold = createPeerKeys("agent-memadmit-cold");
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
  for (const k of [warm, cold]) await register(k, [MODEL]);
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
  for (const k of [warm, cold]) {
    const ws = await app.injectWS(`/mesh/ws?peerId=${k.peerId}`, { headers: { "x-mesh-token": MESH, ...signMeshWsBind(k.peerId, k.privateKeyPem) } });
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
  const payload = JSON.stringify({ os: "macos", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem, sandboxMode: "docker", installedModels });
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
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: 2, freeInferenceSlots: 2, wake: true }, k)).json();
  return (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null;
};
const submit = async () => {
  const taskId = `inf-${randomUUID()}`;
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester);
  expect(r.statusCode, r.body).toBe(200);
  return { taskId, subtaskId: r.json().subtaskId as string };
};
const finish = async (k: PeerKeys, c: { taskId: string; subtaskId: string }) => {
  await post("/inference/chunks", { subtaskId: c.subtaskId, seq: 0, delta: "ok", done: true }, k);
  await post("/result", { subtaskId: c.subtaskId, taskId: c.taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model: MODEL }, k);
};
const memory = (over: Partial<MemoryTelemetry> = {}): MemoryTelemetry => ({
  totalBytes: 48 * GB, availableBytes: 20 * GB, pressure: "normal", budgetBytes: 28.8 * GB, usedBytes: 0, loadedModels: [],
  models: [{ name: MODEL, bytes: 16 * GB, contextWindow: 32768, slots: 2 }], atMs: Date.now(), ...over,
});
const heartbeat = async (k: PeerKeys, m: unknown) => {
  const r = await post("/heartbeat", { agentId: k.peerId, memory: m }, k);
  expect(r.statusCode, r.body).toBe(200);
};
const models = async () => ((await app.inject({ method: "GET", url: "/inference/models", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } })).json().models as Array<{ model: string; freeSlots: number; agents: number }>).find((m) => m.model === MODEL);

describe("coordinator memory admission", () => {
  test("heartbeat telemetry is stored; a malformed one is dropped, not rejected", async () => {
    await heartbeat(warm, memory({ usedBytes: 16 * GB, loadedModels: [{ name: MODEL, bytes: 16 * GB }] }));
    expect(agentMemory(warm.peerId)?.loadedModels.map((m) => m.name)).toEqual([MODEL]);
    await heartbeat(cold, { pressure: "on fire" });
    expect(agentMemory(cold.peerId)).toBeUndefined();
  });

  test("affinity: an agent that would have to load the model leaves a fresh call to the one that has it loaded", async () => {
    await heartbeat(warm, memory({ usedBytes: 16 * GB, loadedModels: [{ name: MODEL, bytes: 16 * GB }] }));
    await heartbeat(cold, memory());
    for (const k of [warm, cold]) expect(await pull(k)).toBeNull();
    const c = await submit();
    expect(await pull(cold)).toBeNull();
    expect(await pull(warm)).toBe(c.subtaskId);
    await finish(warm, c);
  });

  test("a model that does not fit the agent's headroom, or an agent under memory pressure, gets nothing", async () => {
    // cold: something else fills its budget; warm: critical pressure.
    await heartbeat(cold, memory({ usedBytes: 20 * GB, loadedModels: [{ name: "other:14b", bytes: 20 * GB }] }));
    await heartbeat(warm, memory({ pressure: "critical", usedBytes: 16 * GB, loadedModels: [{ name: MODEL, bytes: 16 * GB }] }));
    const c = await submit();
    await sleep(DEFER_MS + 100);
    expect(await pull(cold)).toBeNull();
    expect(await pull(warm)).toBeNull();
    // /inference/models is honest: nobody has a free slot for it.
    expect((await models())?.freeSlots).toBe(0);
    // The pressure passes: the warm agent takes it.
    await heartbeat(warm, memory({ usedBytes: 16 * GB, loadedModels: [{ name: MODEL, bytes: 16 * GB }] }));
    expect(await pull(warm)).toBe(c.subtaskId);
    await finish(warm, c);
  });

  test("an agent that hands a call back for memory is not handed that model again for a while", async () => {
    await heartbeat(cold, memory());
    await heartbeat(warm, memory({ pressure: "warning" }));
    const c = await submit();
    await sleep(DEFER_MS + 100);
    expect(await pull(cold)).toBe(c.subtaskId);
    await post("/result", { subtaskId: c.subtaskId, taskId: c.taskId, agentId: cold.peerId, ok: false, output: "", error: "memory_budget: needs 16 GB", durationMs: 0, executed: false, model: MODEL }, cold);
    const d = await submit();
    await sleep(DEFER_MS + 100);
    expect(await pull(cold)).toBeNull();
    await heartbeat(warm, memory({ usedBytes: 16 * GB, loadedModels: [{ name: MODEL, bytes: 16 * GB }] }));
    const got = await pull(warm);
    expect([c.subtaskId, d.subtaskId]).toContain(got);
  });
});
