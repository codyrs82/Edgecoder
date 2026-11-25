import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";

/*
 * A vLLM agent at the coordinator (real app, Fastify inject): it registers its engine, and one
 * agent with N model slots gets N calls at once (the free-slot accounting of #285/#287/#290), then
 * none while it reports no free slot (an engine that is down reports 0).
 */

const MESH = "mesh-secret-engine-agent";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.58";
const MODEL = "qwen3-coder:30b";
let portal: Server;
let app: any;
const requester = createPeerKeys("agent-engine-requester");
const gpu = createPeerKeys("agent-engine-vllm");
const odd = createPeerKeys("agent-engine-odd");

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
  await register(requester, { installedModels: [] });
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

function signedHeaders(url: string, payload: string, keys: PeerKeys) {
  return signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
}

async function register(keys: PeerKeys, extra: Record<string, unknown>) {
  const payload = JSON.stringify({ os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem, sandboxMode: "docker", localModelProvider: "ollama-local", ...extra });
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signedHeaders("/register", payload, keys) }, payload });
  expect(res.statusCode, res.body).toBe(200);
}

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signedHeaders(url, payload, signer) }, payload });
}

const pull = async (k: PeerKeys, slots: number, free: number) => {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: slots, freeInferenceSlots: free, contextWindow: 65_536 }, k)).json();
  return (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null;
};
const taskOf = new Map<string, string>();
const submit = async () => {
  const taskId = `inf-${randomUUID()}`;
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester);
  expect(r.statusCode, r.body).toBe(200);
  const subtaskId = r.json().subtaskId as string;
  taskOf.set(subtaskId, taskId);
  return subtaskId;
};

describe("vLLM agent at the coordinator", () => {
  test("registers its engine; an unknown engine value is dropped, not refused", async () => {
    const { agentCapabilities } = await import("../../src/swarm/coordinator/agent-state.js");
    await register(gpu, { installedModels: [MODEL], activeModel: MODEL, inferenceEngine: "vllm", engineModel: "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ" });
    expect(agentCapabilities.get(gpu.peerId)).toMatchObject({ inferenceEngine: "vllm", engineModel: "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ", activeModel: MODEL, localModelCatalog: [MODEL] });
    await register(odd, { installedModels: [MODEL], inferenceEngine: "tgi" });
    expect(agentCapabilities.get(odd.peerId)?.inferenceEngine).toBeUndefined();
    // Out of the way of the slot test below.
    agentCapabilities.delete(odd.peerId);
  });

  test("one agent with 6 slots takes 6 calls at once, and none while it reports no free slot", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await submit());
    const got: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await pull(gpu, 6, 6 - i);
      expect(id, `pull ${i + 1}`).not.toBeNull();
      got.push(id!);
    }
    expect(new Set(got).size).toBe(6);
    // All 6 slots held: the 7th call waits, whatever the agent reports.
    expect(await pull(gpu, 6, 1)).toBeNull();
    // One call finishes: a slot is free again by the coordinator's count.
    const done = got[0];
    await post("/inference/chunks", { subtaskId: done, seq: 0, delta: "ok", done: true }, gpu);
    const res = await post("/result", { subtaskId: done, taskId: taskOf.get(done), agentId: gpu.peerId, ok: true, output: "ok", durationMs: 100, model: MODEL }, gpu);
    expect(res.statusCode, res.body).toBe(200);
    // An engine that is down reports no free slot: nothing is handed over.
    expect(await pull(gpu, 6, 0)).toBeNull();
    // Back up: the 7th call goes out.
    expect(await pull(gpu, 6, 1)).toBe(ids.find((id) => !got.includes(id)));
  });
});
