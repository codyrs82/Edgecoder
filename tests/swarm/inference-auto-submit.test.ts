import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";
import { preferredAgentFor } from "../../src/swarm/coordinator/dispatch.js";
import { bestFitConfig, recentDecisions } from "../../src/swarm/coordinator/routing.js";
import { usagePending } from "../../src/swarm/coordinator/context.js";

/*
 * model "auto" on the coordinator (real app, Fastify inject): /inference/submit describes the job,
 * best-fit routing picks model, class and a preferred agent, the answer says what and why, other
 * agents leave the call to the preferred one for BEST_FIT_PREFER_MS, and the decision log records
 * what happened.
 */

const MESH = "mesh-secret-auto";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.47";
let portal: Server;
let app: any;
const requester = createPeerKeys("agent-auto-requester");
const a7 = createPeerKeys("agent-auto-7b-a");
const b7 = createPeerKeys("agent-auto-7b-b");
const small = createPeerKeys("agent-auto-1-5b");

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
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  await register(requester, []);
  await register(a7, ["qwen2.5-coder:7b"]);
  await register(b7, ["qwen2.5-coder:7b"]);
  await register(small, ["qwen2.5-coder:1.5b"]);
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
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
const submitAuto = async (body: Record<string, unknown>) => {
  const taskId = `inf-${randomUUID()}`;
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: "auto", timeoutMs: 60_000, ...body }, requester);
  return { r, taskId };
};
const finish = async (k: PeerKeys, taskId: string, subtaskId: string, model: string) => {
  await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true }, k);
  await post("/result", { subtaskId, taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model }, k);
};
const byId = (id: string | undefined) => [a7, b7, small].find((k) => k.peerId === id)!;

describe("/inference/submit with model auto", () => {
  test("resolves the model, says what and why, and prefers one agent for a moment", async () => {
    const question = [{ role: "user", content: "What is a closure in JavaScript?" }];
    const { r, taskId } = await submitAuto({ messages: question });
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    // A question wants at least 3B: the 1.5b agent is not considered.
    expect(j.model).toBe("qwen2.5-coder:7b");
    expect(j.routing).toMatchObject({ model: "qwen2.5-coder:7b", computeClass: "cpu", job: "chat", jobInferred: true, complexity: { level: "low" } });
    expect(j.routing.line).toMatch(/^routed to qwen2\.5-coder:7b on cpu because chat · complexity low/);
    expect(j.routing.estimate).toEqual({ waitMs: expect.any(Number), ttftMs: expect.any(Number), totalMs: expect.any(Number), cSats: expect.any(Number) });
    expect(usagePending.get(taskId)?.routing).toBe(j.routing.line);

    const preferred = byId(preferredAgentFor(j.subtaskId));
    expect(preferred).toBeDefined();
    const other = preferred === a7 ? b7 : a7;
    // The other 7b agent is idle too, but the call is kept for the preferred one.
    expect(await pull(other)).toBeNull();
    expect(await pull(small)).toBeNull();
    expect(await pull(preferred)).toBe(j.subtaskId);
    await finish(preferred, taskId, j.subtaskId, "qwen2.5-coder:7b");

    const d = recentDecisions(1)[0];
    expect(d).toMatchObject({ taskId, model: "qwen2.5-coder:7b", job: "chat", actual: { ranOnPreferred: true, ok: true } });
    expect(d.actual.ttftMs).toEqual(expect.any(Number));
    expect(d.complexity.signals).toEqual(expect.any(Array));

    // The next turn of the same conversation keeps that machine (its prompt is cached there).
    const next = await submitAuto({ messages: [...question, { role: "assistant", content: "A function with its scope." }, { role: "user", content: "Show an example." }] });
    expect(next.r.statusCode, next.r.body).toBe(200);
    expect(next.r.json().routing.affinity.status).toBe("kept");
    expect(preferredAgentFor(next.r.json().subtaskId)).toBe(preferred.peerId);
    expect(await pull(preferred)).toBe(next.r.json().subtaskId);
    await finish(preferred, next.taskId, next.r.json().subtaskId, "qwen2.5-coder:7b");
  });

  test("after the preference window anyone eligible may take the call", async () => {
    const { r, taskId } = await submitAuto({ messages: [{ role: "user", content: "Explain recursion in one paragraph, different wording " + randomUUID() }] });
    expect(r.statusCode, r.body).toBe(200);
    const sub = r.json().subtaskId;
    const preferred = byId(preferredAgentFor(sub));
    const other = preferred === a7 ? b7 : a7;
    expect(await pull(other)).toBeNull();
    await sleep(bestFitConfig.preferMs + 50);
    expect(await pull(other)).toBe(sub);
    await finish(other, taskId, sub, "qwen2.5-coder:7b");
    expect(recentDecisions(1)[0].actual.ranOnPreferred).toBe(false);
  });

  test("hints: job, quality and a client complexity; a job bigger than any model takes the biggest, marked", async () => {
    const { r, taskId } = await submitAuto({
      messages: [{ role: "user", content: "Refactor the session module across src/a.ts, src/b.ts, src/c.ts and src/d.ts." }],
      routing: { job: "refactor", quality: "best", complexity: "very_high", sessionId: "s-1" },
    });
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    expect(j.routing).toMatchObject({ model: "qwen2.5-coder:7b", job: "refactor", jobInferred: false, quality: "best", complexity: { level: "very_high", hinted: 0.9 } });
    expect(j.routing.reason).toMatch(/nothing ≥ 30B is available/);
    const preferred = byId(preferredAgentFor(j.subtaskId));
    expect(await pull(preferred)).toBe(j.subtaskId);
    await finish(preferred, taskId, j.subtaskId, "qwen2.5-coder:7b");
  });

  test("a price ceiling nothing meets, and auto for your own machines, are refused", async () => {
    const capped = await submitAuto({ messages: [{ role: "user", content: "hello there" }], routing: { maxCSats: 0.0000001 } });
    expect(capped.r.statusCode).toBe(409);
    expect(capped.r.json()).toMatchObject({ error: "no_route_fits", detail: expect.stringMatching(/cSats ceiling/), routing: { model: null } });
    const mine = await submitAuto({ messages: [{ role: "user", content: "hello" }], target: "mine" });
    expect(mine.r.statusCode).toBe(400);
    expect(mine.r.json().error).toBe("auto_network_only");
  });

  test("a named class limits the choice to it", async () => {
    const r = await submitAuto({ messages: [{ role: "user", content: "hello" }], computeClass: "gpu" });
    expect(r.r.statusCode).toBe(409);
    expect(r.r.json().error).toBe("no_route_fits");
  });
});
