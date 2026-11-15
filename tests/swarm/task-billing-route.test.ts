import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, earnedMsat, grantCredits } from "../../src/credits/store.js";
import { jobCostMsat } from "../../src/economy/job-pricing.js";

/*
 * What an agent earns is what the requester was charged (real coordinator app, Fastify inject):
 * - model-call token counts are taken once, from the accepted final piece, and bounded by the stream;
 * - pay never exceeds what the requester set aside; anonymous work (nothing set aside) earns nothing;
 * - a task id in use by one requester cannot be reused by another, and a stream is read only
 *   through its own task.
 */

const MESH = "mesh-secret-billing";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.40";
const MODEL = "qwen-test:7b";
let portal: Server;
let inference: Server;
let app: any;
const requester = createPeerKeys("agent-billing-requester");
const worker = createPeerKeys("agent-billing-worker");
const other = createPeerKeys("agent-billing-other");

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
  // Stand-in for the inference service's /decompose: one code subtask per task.
  inference = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ subtasks: [{ taskId: body.taskId, kind: "single_step", input: "print(1)", language: "python", timeoutMs: 30_000, snapshotRef: "commit:test" }] }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => inference.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.INFERENCE_URL = `http://127.0.0.1:${(inference.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = MESH;
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  for (const keys of [requester, worker, other]) {
    const payload = JSON.stringify({
      os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
      sandboxMode: "docker", installedModels: keys === worker ? [MODEL] : [],
    });
    const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
    const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
    expect(res.statusCode).toBe(200);
  }
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
  await grantCredits(other.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  await new Promise<void>((resolve) => inference.close(() => resolve()));
});

function post(url: string, body: unknown, signer?: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signer
    ? (signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>)
    : {};
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

/** The worker claims the next subtask (claims of code tasks wait out the gossip delay when there are peers; there are none). */
async function pull(): Promise<{ id: string; taskId: string } | null> {
  const res = await post("/pull", { agentId: worker.peerId }, worker);
  expect(res.statusCode).toBe(200);
  return res.json().subtask ?? null;
}

async function submitInference(taskId: string, by: PeerKeys = requester) {
  return post("/inference/submit", { taskId, submitterAccountId: by.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, by);
}

describe("/inference/chunks token counts", () => {
  test("pay is bounded by the reserve and counts are taken once, bounded by the stream", async () => {
    const taskId = `inf-${randomUUID()}`;
    const sub = await submitInference(taskId);
    expect(sub.statusCode).toBe(200);
    const reservedMsat = sub.json().reservedCSats * 10; // 1 cSat = 10 msat
    const st = await pull();
    expect(st?.taskId).toBe(taskId);
    const before = await earnedMsat(worker.peerId);

    const text = await post("/inference/chunks", { subtaskId: st!.id, seq: 0, delta: "hello there" }, worker);
    expect(text.statusCode).toBe(200);
    const final = await post("/inference/chunks", { subtaskId: st!.id, seq: 1, delta: "", done: true, promptTokens: 10_000_000, outputTokens: 10_000_000 }, worker);
    expect(final.statusCode).toBe(200);
    // Repeats of the final piece, or pieces after it, change nothing.
    expect((await post("/inference/chunks", { subtaskId: st!.id, seq: 1, delta: "", done: true, promptTokens: 10_000_000, outputTokens: 10_000_000 }, worker)).json().status).toBe("duplicate");
    expect((await post("/inference/chunks", { subtaskId: st!.id, seq: 2, delta: "", done: true, promptTokens: 10_000_000, outputTokens: 10_000_000 }, worker)).statusCode).toBe(409);

    const result = await post("/result", { subtaskId: st!.id, taskId, agentId: worker.peerId, ok: true, output: "hello there", durationMs: 1000 }, worker);
    expect(result.statusCode).toBe(200);
    const earned = (await earnedMsat(worker.peerId)) - before;
    expect(earned).toBeGreaterThan(0);
    expect(earned).toBeLessThanOrEqual(reservedMsat);
    // Counts bounded by the stream: 11 bytes of reply and a ~100-byte request price at well under the reserve.
    expect(earned).toBeLessThan(reservedMsat / 2);
  });

  test("the requester's final stream read carries the token counts it was billed on", async () => {
    const taskId = `inf-${randomUUID()}`;
    expect((await submitInference(taskId)).statusCode).toBe(200);
    const st = await pull();
    expect(st?.taskId).toBe(taskId);
    await post("/inference/chunks", { subtaskId: st!.id, seq: 0, delta: "hello there" }, worker);
    await post("/inference/chunks", { subtaskId: st!.id, seq: 1, delta: "", done: true, promptTokens: 7, outputTokens: 3 }, worker);
    // As in use: the requester is reading when the agent's result lands (the read waits for it).
    // (inject() starts on .then, so start it now.)
    const reading = post("/inference/stream", { taskId, subtaskId: st!.id, waitMs: 0 }, requester).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await post("/result", { subtaskId: st!.id, taskId, agentId: worker.peerId, ok: true, output: "hello there", durationMs: 500 }, worker)).statusCode).toBe(200);
    const read = await reading;
    expect(read.statusCode, JSON.stringify(read.json())).toBe(200);
    expect(read.json(), JSON.stringify(read.json())).toMatchObject({ done: true, promptTokens: 7, outputTokens: 3 });
    expect(typeof read.json().creditsSpent).toBe("number");
  });
});

describe("anonymous /submit", () => {
  test("work nobody paid for earns nothing", async () => {
    const taskId = randomUUID();
    const sub = await post("/submit", { taskId, prompt: "print 1", language: "python", submitterAccountId: "anonymous", snapshotRef: "a".repeat(40), projectId: "p", resourceClass: "cpu", priority: 10 });
    expect(sub.statusCode).toBe(200);
    const st = await pull();
    expect(st?.taskId).toBe(taskId);
    const before = await earnedMsat(worker.peerId);
    // The job ran for 30 s (server clock): paid work if anyone had paid for it.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 29_000);
      const result = await post("/result", { subtaskId: st!.id, taskId, agentId: worker.peerId, ok: true, output: "1", durationMs: 29_000 }, worker);
      expect(result.statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    expect(await earnedMsat(worker.peerId)).toBe(before);
    expect(await accrualsFor(st!.id)).toEqual([]);
  });
});

/** The earnings_accrual payloads the coordinator's ledger holds for a subtask. */
async function accrualsFor(subtaskId: string): Promise<any[]> {
  const snap = (await app.inject({ method: "GET", url: "/ledger/snapshot", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } })).json();
  return snap.records.filter((r: any) => r.eventType === "earnings_accrual" && r.subtaskId === subtaskId).map((r: any) => JSON.parse(r.payloadJson));
}

/** Submit a paid code job as the requester and claim it; returns the reserve it took from the balance. */
async function submitJob(extra: Record<string, unknown> = {}) {
  const taskId = `job-${randomUUID()}`;
  const balanceBefore = creditEngine.balance(requester.peerId);
  const sub = await post("/submit", { taskId, prompt: "print 1", language: "python", submitterAccountId: requester.peerId, snapshotRef: "a".repeat(40), projectId: "p", resourceClass: "cpu", priority: 10, ...extra }, requester);
  expect(sub.statusCode).toBe(200);
  const reservedMsat = Math.round((balanceBefore - creditEngine.balance(requester.peerId)) * 1000);
  expect(reservedMsat).toBeGreaterThan(0);
  const st = await pull();
  expect(st?.taskId).toBe(taskId);
  return { taskId, st: st!, balanceBefore, reservedMsat };
}

/** Report a result after `ms` of server-clock time has passed since the claim. */
async function resultAfter(ms: number, body: Record<string, unknown>) {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + ms);
    return await post("/result", body, worker);
  } finally {
    vi.useRealTimers();
  }
}

describe("/result pricing (#38)", () => {
  test("a successful code job is priced per measured second, not a flat amount, and the ledger matches the balance", async () => {
    const { taskId, st, balanceBefore, reservedMsat } = await submitJob();
    const before = await earnedMsat(worker.peerId);
    // Reports far more time than the server saw: only the server-measured ~10 s is priced.
    const res = await resultAfter(10_000, { subtaskId: st.id, taskId, agentId: worker.peerId, ok: true, output: randomUUID(), durationMs: 25_000 });
    expect(res.statusCode).toBe(200);
    const earned = (await earnedMsat(worker.peerId)) - before;

    const [acc, ...rest] = await accrualsFor(st.id);
    expect(rest).toEqual([]);
    expect(acc.pricingBasis).toBe("per_second");
    expect(acc.ok).toBe(true);
    expect(acc.reportedDurationMs).toBe(25_000);
    expect(acc.durationMs).toBeGreaterThanOrEqual(10_000);
    expect(acc.durationMs).toBeLessThan(15_000);
    expect(acc.costMsat).toBe(jobCostMsat(acc.durationMs, acc.ratePerSecondMsat));
    expect(acc.costMsat).toBeGreaterThan(0);
    expect(acc.costMsat).toBeLessThanOrEqual(reservedMsat);
    // The agent gets the cost minus the network fee; the ledger records exactly what was credited.
    expect(acc.msat + acc.feeMsat).toBe(acc.costMsat);
    expect(earned).toBe(acc.msat);
    expect(acc.credits).toBeCloseTo(acc.msat / 1000, 6);
    expect(acc.credits).not.toBe(5);
    // The requester pays the cost (the unused reserve is refunded once the task settles).
    expect(balanceBefore - creditEngine.balance(requester.peerId)).toBeCloseTo(acc.costMsat / 1000, 2);
  });

  test("a failed result earns nothing and the requester is refunded in full", async () => {
    const { taskId, st, balanceBefore } = await submitJob();
    const before = await earnedMsat(worker.peerId);
    const res = await resultAfter(10_000, { subtaskId: st.id, taskId, agentId: worker.peerId, ok: false, output: "", error: "boom", durationMs: 10_000 });
    expect(res.statusCode).toBe(200);
    expect(await earnedMsat(worker.peerId)).toBe(before);
    expect(await accrualsFor(st.id)).toEqual([]);
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(balanceBefore, 6);
  });

  test("pay is capped at what the requester set aside", async () => {
    // A 1 msat/credit ceiling makes the reserve tiny (10 s at 1 msat x tier weight), while a long
    // reply priced per token is worth far more: the agent gets the reserve and no more.
    const taskId = `inf-${randomUUID()}`;
    const balanceBefore = creditEngine.balance(requester.peerId);
    const sub = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs: 10_000, maxBidMsatPerCredit: 1, maxTokens: 32_768 }, requester);
    expect(sub.statusCode).toBe(200);
    const reservedMsat = Math.round((balanceBefore - creditEngine.balance(requester.peerId)) * 1000);
    expect(reservedMsat).toBeGreaterThan(0);
    const st = await pull();
    expect(st?.taskId).toBe(taskId);
    const before = await earnedMsat(worker.peerId);
    // Varied text (a repeated character would be billed as padding, inference-degeneracy.ts).
    let reply = "";
    while (reply.length < 200_000) reply += `${randomUUID()} `;
    expect((await post("/inference/chunks", { subtaskId: st!.id, seq: 0, delta: reply, done: true, promptTokens: 10, outputTokens: 200_000 }, worker)).statusCode).toBe(200);
    const res = await resultAfter(1_000, { subtaskId: st!.id, taskId, agentId: worker.peerId, ok: true, output: reply, durationMs: 1_000 });
    expect(res.statusCode).toBe(200);
    const earned = (await earnedMsat(worker.peerId)) - before;
    const [acc] = await accrualsFor(st!.id);
    expect(acc.pricingBasis).toBe("tokens");
    // Billed at most the call's 32768-token cap (+64): on a 7B model about 0.0033 USD (3,300 msat at
    // 100k USD/BTC), still far above the reserve.
    expect(reservedMsat).toBeLessThan(3_000);
    expect(acc.costMsat).toBe(reservedMsat);
    expect(acc.msat + acc.feeMsat).toBe(reservedMsat);
    expect(earned).toBe(acc.msat);
    // The requester is charged the reserve, never more.
    expect(balanceBefore - creditEngine.balance(requester.peerId)).toBeCloseTo(reservedMsat / 1000, 6);
  });

  test("a replayed result earns nothing more", async () => {
    const { taskId, st, balanceBefore } = await submitJob();
    const body = { subtaskId: st.id, taskId, agentId: worker.peerId, ok: true, output: randomUUID(), durationMs: 5_000 };
    expect((await resultAfter(5_000, body)).statusCode).toBe(200);
    const afterFirst = await earnedMsat(worker.peerId);
    const charged = balanceBefore - creditEngine.balance(requester.peerId);
    const replay = await resultAfter(5_000, body);
    expect(replay.statusCode).not.toBe(200);
    expect(await earnedMsat(worker.peerId)).toBe(afterFirst);
    expect(await accrualsFor(st.id)).toHaveLength(1);
    expect(balanceBefore - creditEngine.balance(requester.peerId)).toBeCloseTo(charged, 6);
  });
});

describe("task ids", () => {
  test("an id in use by another requester is refused, by either route", async () => {
    const taskId = `inf-${randomUUID()}`;
    expect((await submitInference(taskId)).statusCode).toBe(200);
    const again = await submitInference(taskId, other);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("duplicate_task");
    const anon = await post("/submit", { taskId, prompt: "print 1", language: "python", submitterAccountId: "anonymous", snapshotRef: "a".repeat(40), projectId: "p", resourceClass: "cpu", priority: 10 });
    expect(anon.statusCode).toBe(409);
    // Clean up: run it so later tests see an empty queue.
    const st = await pull();
    expect(st?.taskId).toBe(taskId);
    await post("/inference/chunks", { subtaskId: st!.id, seq: 0, delta: "x", done: true }, worker);
    await post("/result", { subtaskId: st!.id, taskId, agentId: worker.peerId, ok: true, output: "x", durationMs: 100 }, worker);
  });

  test("a stream is read only through the task it belongs to", async () => {
    const victimTask = `inf-${randomUUID()}`;
    const victim = await submitInference(victimTask);
    expect(victim.statusCode).toBe(200);
    const ownTask = `inf-${randomUUID()}`;
    expect((await submitInference(ownTask, other)).statusCode).toBe(200);
    const read = await post("/inference/stream", { taskId: ownTask, subtaskId: victim.json().subtaskId, waitMs: 0 }, other);
    expect(read.statusCode).toBe(404);
    const own = await post("/inference/stream", { taskId: victimTask, subtaskId: victim.json().subtaskId, waitMs: 0 }, requester);
    expect(own.statusCode).toBe(200);
  });
});

describe("reserved-capacity leases", () => {
  test("two leases made at once cannot both hold the one agent", async () => {
    const [a, b] = await Promise.all([
      post("/account/reservations", { computeClass: "cpu", minutes: 5, model: MODEL }, requester),
      post("/account/reservations", { computeClass: "cpu", minutes: 5, model: MODEL }, other),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });
});
