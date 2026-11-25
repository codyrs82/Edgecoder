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
  // Run 5 prior speed off: these calls are judged on measured samples only (start-eta.ts; the prior has its own tests).
  process.env.INFERENCE_COMPLETION_PRIOR_SPEED = "off";
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
    expect(capped.r.statusCode, capped.r.body).toBe(409);
    expect(capped.r.json()).toMatchObject({ error: "no_route_fits", detail: expect.stringMatching(/cSats ceiling/), routing: { model: null } });
    // reason "price": a money problem (the apps say "Not enough cSats"), with what the step needs.
    expect(capped.r.json()).toMatchObject({ reason: "price", neededCSats: expect.any(Number) });
    const mine = await submitAuto({ messages: [{ role: "user", content: "hello" }], target: "mine" });
    expect(mine.r.statusCode).toBe(400);
    expect(mine.r.json().error).toBe("auto_network_only");
  });

  test("a named class limits the choice to it", async () => {
    const r = await submitAuto({ messages: [{ role: "user", content: "hello" }], computeClass: "gpu" });
    expect(r.r.statusCode).toBe(409);
    expect(r.r.json().error).toBe("no_route_fits");
    // No GPU of either kind here (every agent is CPU): no machine, not money, and which class.
    expect(r.r.json()).toMatchObject({ reason: "none", computeClass: "gpu" });
  });
});

describe("the portal's coordinator choice is kept on the routing decision", () => {
  const choice = {
    chosen: "coordinator-eu.edgecoder.io",
    rule: "overflow",
    reason: "overflow: coordinator.edgecoder.io has no free slot (queue ~15500 ms); expected 640 ms vs 15600 ms",
    clientRegion: "lhr",
    portalRegion: "ord",
    candidates: [
      { coordinator: "coordinator.edgecoder.io", rttMs: 2, queueMs: 15500, agentRttMs: 40, expectedMs: 15600, free: -3, waiting: 5, agents: 9 },
      { coordinator: "coordinator-eu.edgecoder.io", rttMs: 99, queueMs: 500, agentRttMs: 41, expectedMs: 640, free: 1, waiting: 0, agents: 2 },
    ],
    injected: "<script>",
  };

  test("/inference/models reports queueing signals for the portal", async () => {
    const res = await app.inject({ method: "GET", url: "/inference/models", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().load).toEqual({ pickupP90Ms: expect.anything(), callP50Ms: expect.anything() });
    // Machines online per class (the apps' "2 online" and "Available now: …"), and per model.
    const body = res.json();
    expect(body.classes.cpu.agents).toBeGreaterThanOrEqual(3);
    expect(body.classes["gpu.dc"].agents).toBe(0);
    expect(body.models.find((m: { model: string }) => m.model === "qwen2.5-coder:7b").agentsByClass).toEqual({ cpu: 2 });
  });

  test("a named-model call the portal placed is logged with which coordinator and why", async () => {
    const taskId = `inf-${randomUUID()}`;
    const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: "qwen2.5-coder:7b", timeoutMs: 60_000, messages: [{ role: "user", content: "hi" }], coordinatorChoice: choice }, requester);
    expect(r.statusCode, r.body).toBe(200);
    const d = recentDecisions(1)[0];
    expect(d).toMatchObject({ taskId, pinned: true, model: "qwen2.5-coder:7b", reason: expect.stringMatching(/^coordinator: overflow: /) });
    expect(d.coordinatorChoice).toMatchObject({ chosen: "coordinator-eu.edgecoder.io", rule: "overflow", clientRegion: "lhr", portalRegion: "ord" });
    expect(d.coordinatorChoice!.candidates[1]).toEqual(choice.candidates[1]);
    expect(d.coordinatorChoice).not.toHaveProperty("injected");
    const subtaskId = r.json().subtaskId as string;
    for (const k of [a7, b7]) {
      if ((await pull(k)) === subtaskId) {
        await finish(k, taskId, subtaskId, "qwen2.5-coder:7b");
        break;
      }
    }
  });

  test("a model auto call carries the choice on its best-fit decision", async () => {
    const { r, taskId } = await submitAuto({ messages: [{ role: "user", content: "What is a closure?" }], coordinatorChoice: { ...choice, rule: "latency", reason: "faster with a free slot" } });
    expect(r.statusCode, r.body).toBe(200);
    const d = recentDecisions(1)[0];
    expect(d).toMatchObject({ taskId, job: "chat", coordinatorChoice: { rule: "latency", reason: "faster with a free slot" } });
    expect(d.pinned).toBeUndefined();
    const j = r.json();
    const preferred = byId(preferredAgentFor(j.subtaskId));
    expect(await pull(preferred)).toBe(j.subtaskId);
    await finish(preferred, taskId, j.subtaskId, j.model);
  });

  test("a named call without a choice still logs a placement, without a coordinator choice", async () => {
    const before = recentDecisions(1)[0]?.taskId;
    const taskId = `inf-${randomUUID()}`;
    const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: "qwen2.5-coder:7b", timeoutMs: 60_000, messages: [{ role: "user", content: "hi" }] }, requester);
    expect(r.statusCode, r.body).toBe(200);
    const d = recentDecisions(1)[0];
    expect(d?.taskId).not.toBe(before);
    expect(d).toMatchObject({ taskId, pinned: true, model: "qwen2.5-coder:7b" });
    expect(d?.coordinatorChoice).toBeUndefined();
    const subtaskId = r.json().subtaskId as string;
    for (const k of [a7, b7]) {
      if ((await pull(k)) === subtaskId) {
        await finish(k, taskId, subtaskId, "qwen2.5-coder:7b");
        break;
      }
    }
  });
});

describe("model auto and a call that would not finish in time (run 4)", () => {
  test("best fit's pick that would not finish is dropped for one that would; with nothing in time: 503 before anything is reserved", async () => {
    const { serviceTimes } = await import("../../src/swarm/coordinator/start-eta.js");
    const { creditEngine } = await import("../../src/credits/store.js");
    // The 7b CPU hosts here run at 0.05 × the slow-host estimate: a 4,096-token reply takes ~140 s.
    // (Samples of calls that size: run 5, a much smaller call says little about a long one.)
    serviceTimes.clear();
    for (let i = 0; i < 3; i++) serviceTimes.record("qwen2.5-coder:7b", "cpu", 140_000, Date.now(), 2_800_000);
    // Run 9: an Auto call is judged on the reply calls of its job type are seen to write (not its
    // max_tokens): here recent chats wrote their whole 4,096 tokens.
    const { outputLengths, clearExpectedOutput } = await import("../../src/swarm/coordinator/expected-output.js");
    clearExpectedOutput();
    for (let i = 0; i < 3; i++) outputLengths.record("chat", 4_096);
    try {
      const question = () => [{ role: "user", content: "What is a closure in JavaScript? " + randomUUID() }];
      // Picked again without the 7b hosts: the 1.5b host (no speed known for it), and the 7b hosts may not take it.
      const moved = await submitAuto({ messages: question(), maxTokens: 4_096 });
      expect(moved.r.statusCode, moved.r.body).toBe(200);
      expect(moved.r.json().model).toBe("qwen2.5-coder:1.5b");
      await sleep(bestFitConfig.preferMs + 50);
      expect(await pull(a7)).toBeNull();
      expect(await pull(b7)).toBeNull();
      expect(await pull(small)).toBe(moved.r.json().subtaskId);
      await finish(small, moved.taskId, moved.r.json().subtaskId, "qwen2.5-coder:1.5b");
      // The 1.5b host is as slow: nothing here would finish it in time.
      serviceTimes.clear();
      for (let i = 0; i < 3; i++) {
        serviceTimes.record("qwen2.5-coder:7b", "cpu", 140_000, Date.now(), 2_800_000);
        serviceTimes.record("qwen2.5-coder:1.5b", "cpu", 300_000, Date.now(), 600_000);
      }
      const before = creditEngine.balance(requester.peerId);
      const { r } = await submitAuto({ messages: question(), maxTokens: 4_096 });
      expect(r.statusCode, r.body).toBe(503);
      expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy", limitMs: 54_000 });
      expect(r.json().completionEtaMs).toBeGreaterThan(54_000);
      expect(creditEngine.balance(requester.peerId)).toBe(before);
      // A short reply on the same hosts fits.
      const short = await submitAuto({ messages: question(), maxTokens: 256 });
      expect(short.r.statusCode, short.r.body).toBe(200);
      expect(short.r.json().model).toBe("qwen2.5-coder:7b");
    } finally {
      serviceTimes.clear();
      clearExpectedOutput();
    }
  });
});
