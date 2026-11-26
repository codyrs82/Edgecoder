import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, earnedMsat, grantCredits } from "../../src/credits/store.js";

/*
 * Size-aware model-call reserve (real coordinator app, Fastify inject). Every call used to set aside
 * ~750 cSats (180 s at the top of the dearest class band) whatever the model, for calls that settle
 * at well under 1 cSat (small models) to ~6 cSats (30B): a 1,000-cSat account ran one call at a time.
 * The reserve is now an upper bound on the call's own cost (job-pricing.ts inferenceReserveMsat), and
 * every way a call ends gives back what it did not use.
 */

const MESH = "mesh-secret-size-reserve";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.47";
const SMALL = "qwen2.5-coder:1.5b";
const BIG = "qwen3-coder:30b";
const CLAIM_TIMEOUT_MS = 1_500;
const OLD_RESERVE_CSATS = 750;
let portal: Server;
let app: any;
let queue: typeof import("../../src/swarm/coordinator/context.js")["queue"];
let taskBilling: typeof import("../../src/swarm/coordinator/context.js")["taskBilling"];
let cancelUnclaimedInference: typeof import("../../src/swarm/coordinator/routes/inference.js")["cancelUnclaimedInference"];
let sweepIdleTaskBilling: typeof import("../../src/swarm/coordinator/billing-restore.js")["sweepIdleTaskBilling"];
const requester = createPeerKeys("agent-size-reserve-requester");
const small = createPeerKeys("agent-size-reserve-small-buyer");
const worker = createPeerKeys("agent-size-reserve-worker");

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
  process.env.INFERENCE_CLAIM_TIMEOUT_MS = String(CLAIM_TIMEOUT_MS);
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  ({ queue, taskBilling } = await import("../../src/swarm/coordinator/context.js"));
  ({ cancelUnclaimedInference } = await import("../../src/swarm/coordinator/routes/inference.js"));
  ({ sweepIdleTaskBilling } = await import("../../src/swarm/coordinator/billing-restore.js"));
  await app.ready();
  for (const keys of [requester, small, worker]) {
    const payload = JSON.stringify({
      os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
      sandboxMode: "docker", installedModels: keys === worker ? [SMALL, BIG] : [],
    });
    const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
    const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
    expect(res.statusCode).toBe(200);
  }
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  delete process.env.INFERENCE_CLAIM_TIMEOUT_MS;
});

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const submit = (taskId: string, o: { model?: string; content?: string; by?: PeerKeys; maxTokens?: number; routing?: Record<string, unknown> } = {}) =>
  post("/inference/submit", {
    taskId, submitterAccountId: (o.by ?? requester).peerId, model: o.model ?? SMALL, computeClass: "cpu", timeoutMs: 60_000,
    messages: [{ role: "user", content: o.content ?? "hi" }],
    ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}), ...(o.routing ? { routing: o.routing } : {}),
  }, o.by ?? requester);

/** Cancel whatever a test left queued, so the next test's pull finds only its own call. */
async function drain(...calls: Array<{ taskId: string; subtaskId: string }>) {
  for (const c of calls) await cancelUnclaimedInference(c.taskId, c.subtaskId);
}

describe("size-aware model-call reserve", () => {
  test("sized by model and prompt: 1.5B < 30B, long prompt > short, all far under the old 750 cSats", async () => {
    const calls: Array<{ taskId: string; subtaskId: string; reserved: number }> = [];
    for (const [model, content] of [[SMALL, "hi"], [BIG, "hi"], [BIG, "x".repeat(200_000)]] as const) {
      const taskId = `inf-${randomUUID()}`;
      const sub = await submit(taskId, { model, content });
      expect(sub.statusCode, sub.body).toBe(200);
      calls.push({ taskId, subtaskId: sub.json().subtaskId, reserved: sub.json().reservedCSats });
    }
    const [s, bShort, bLong] = calls.map((c) => c.reserved);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(5);
    expect(bShort).toBeGreaterThan(s);
    expect(bShort).toBeLessThan(30);
    expect(bLong).toBeGreaterThan(bShort * 5);
    for (const r of calls.map((c) => c.reserved)) expect(r).toBeLessThan(OLD_RESERVE_CSATS / 4);
    await drain(...calls);
  });

  test("maxCSats caps the reserve (and with it the settled cost)", async () => {
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId, { model: BIG, routing: { maxCSats: 1.25 } });
    expect(sub.statusCode, sub.body).toBe(200);
    expect(sub.json().reservedCSats).toBe(1.25);
    await drain({ taskId, subtaskId: sub.json().subtaskId });
  });

  test("a small balance runs calls side by side instead of one at a time", async () => {
    await grantCredits(small.peerId, 20, "test_funding");
    const ids = Array.from({ length: 5 }, () => `inf-${randomUUID()}`);
    const subs = await Promise.all(ids.map((taskId) => submit(taskId, { by: small })));
    for (const s of subs) expect(s.statusCode, s.body).toBe(200);
    const held = subs.reduce((n, s) => n + s.json().reservedCSats, 0);
    expect(creditEngine.balance(small.peerId)).toBeCloseTo(20 - held, 6);
    await drain(...subs.map((s, i) => ({ taskId: ids[i], subtaskId: s.json().subtaskId })));
    expect(creditEngine.balance(small.peerId)).toBeCloseTo(20, 6);
  });

  test("the worst token counts an agent can report are bounded at /inference/chunks and settled at their priced cost", async () => {
    const before = creditEngine.balance(requester.peerId);
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId, { model: BIG, content: "y".repeat(4_000), maxTokens: 256 });
    expect(sub.statusCode, sub.body).toBe(200);
    const reservedCSats = sub.json().reservedCSats;
    const subtaskId = sub.json().subtaskId;
    expect((await post("/pull", { agentId: worker.peerId }, worker)).json().subtask?.id).toBe(subtaskId);
    const earnedBefore = await earnedMsat(worker.peerId);
    // The longest reply the cap allows, and token counts far past anything real: bounded at /inference/chunks.
    expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "z".repeat(5_000) }, worker)).statusCode).toBe(200);
    expect((await post("/inference/chunks", { subtaskId, seq: 1, delta: "", done: true, promptTokens: 10_000_000, outputTokens: 10_000_000 }, worker)).statusCode).toBe(200);
    expect((await post("/result", { subtaskId, taskId, agentId: worker.peerId, ok: true, output: "z".repeat(5_000), durationMs: 60_000 }, worker)).statusCode).toBe(200);
    const earned = (await earnedMsat(worker.peerId)) - earnedBefore;
    const spent = before - creditEngine.balance(requester.peerId);
    expect(earned).toBeGreaterThan(0);
    expect(spent).toBeGreaterThan(0);
    // Settled at its priced cost. The prompt is held at bytes / 2 (+ allowance) now, not one token per
    // byte: these bounded counts still fit this call's hold, and a cost past a hold is taken from the
    // balance at settle (tests/swarm/reserve-overflow-settle.test.ts).
    expect(spent).toBeLessThanOrEqual(reservedCSats + 1e-9);
    expect(spent * 1000).toBeGreaterThanOrEqual(earned);
    expect(taskBilling.has(taskId)).toBe(false);
  });

  test("released in full on a failed run", async () => {
    const before = creditEngine.balance(requester.peerId);
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId);
    const subtaskId = sub.json().subtaskId;
    expect(creditEngine.balance(requester.peerId)).toBeLessThan(before);
    expect((await post("/pull", { agentId: worker.peerId }, worker)).json().subtask?.id).toBe(subtaskId);
    expect((await post("/result", { subtaskId, taskId, agentId: worker.peerId, ok: false, output: "", error: "model crashed", durationMs: 500 }, worker)).statusCode).toBe(200);
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
    expect(taskBilling.has(taskId)).toBe(false);
  });

  test("released in full on a timeout: nobody claims it, or its holder vanishes", async () => {
    const before = creditEngine.balance(requester.peerId);
    const unclaimed = `inf-${randomUUID()}`;
    expect((await submit(unclaimed)).statusCode).toBe(200);
    const vanished = `inf-${randomUUID()}`;
    const sub = await submit(vanished);
    const subtaskId = sub.json().subtaskId;
    // The worker takes the second call only (the first is left for the claim bound) and goes silent.
    const taken: string[] = [];
    for (let i = 0; i < 2; i++) {
      const st = (await post("/pull", { agentId: worker.peerId }, worker)).json().subtask;
      if (st) taken.push(st.id);
    }
    expect(taken).toContain(subtaskId);
    for (const id of taken.filter((id) => id !== subtaskId)) queue.requeue(id);
    expect(creditEngine.balance(requester.peerId)).toBeLessThan(before);
    // Its lease lapses: the call goes back on the queue under the claim bound, and nobody takes it.
    expect(queue.expireLeases(Date.now() + 10 * 60_000).requeued).toContain(subtaskId);
    await sleep(CLAIM_TIMEOUT_MS + 700);
    expect(taskBilling.has(unclaimed)).toBe(false);
    expect(taskBilling.has(vanished)).toBe(false);
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
  });

  test("released in full on a cancel", async () => {
    const before = creditEngine.balance(requester.peerId);
    const taskId = `inf-${randomUUID()}`;
    const sub = await submit(taskId, { model: BIG });
    expect(creditEngine.balance(requester.peerId)).toBeLessThan(before);
    expect(await cancelUnclaimedInference(taskId, sub.json().subtaskId)).toBe(true);
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
  });

  test("the idle sweep settles a reserve nothing will settle, and leaves live calls alone", async () => {
    const before = creditEngine.balance(requester.peerId);
    const orphan = `inf-${randomUUID()}`;
    const orphanSub = await submit(orphan);
    const live = `inf-${randomUUID()}`;
    const liveSub = await submit(live);
    // The orphan's work disappears without its billing being settled (a forgotten settle).
    expect(queue.markRemoteClaimed(orphanSub.json().subtaskId)).toBe(true);
    const now = Date.now();
    expect(await sweepIdleTaskBilling(now, 60_000)).toEqual({ swept: 0, refunded: 0 }); // first sighting
    expect(await sweepIdleTaskBilling(now + 30_000, 60_000)).toEqual({ swept: 0, refunded: 0 }); // not idle long enough
    expect(await sweepIdleTaskBilling(now + 60_000, 60_000)).toEqual({ swept: 1, refunded: 1 });
    expect(taskBilling.has(orphan)).toBe(false);
    expect(taskBilling.has(live)).toBe(true);
    await drain({ taskId: live, subtaskId: liveSub.json().subtaskId });
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
  });
});
