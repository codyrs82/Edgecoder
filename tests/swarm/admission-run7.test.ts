import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";
import { ModelPickups, ServiceTimes, TokenRates } from "../../src/swarm/coordinator/start-eta.js";

/*
 * Network validation run 7 (2026-11-25, scratchpad netval/run7/report.md):
 *
 * 1. Long replies were admitted and cut at the deadline: inf-1795616749810-31c83bfe (gru) and
 *    inf-1795616757465-36c23c3c (syd), max_tokens 1400 on 1.5b CPU hosts that decode at 7-8 tok/s.
 *    The class prior (0.5 × expectedWorkMs) judged them at ~28 tok/s (~103 s).
 * 2. inf-1795617240059-949e8a28 and inf-1795617241236-f9c28e38 were claimed by a host whose CPU credit
 *    ran out; nothing came in 180 s, and the waiting sweep only looked at unclaimed calls.
 * 3. Claim-time "none could start in time" refusals came 8.5-42 s after submit: the start estimate
 *    used the median service time (mostly short calls) and the pickup rate needed 10 s of saturation.
 * 4. Hosts reporting no free slot while idle (#563 throttled) still counted as slots that would free
 *    up, so calls were accepted and held; calls already claimed there waited for a first piece.
 */

const MESH = "mesh-secret-run7";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.77";
const MODEL = "qwen2.5-coder:1.5b";
let portal: Server;
let app: any;
let eta: any;
let inference: any;
let hostSteal: any;
const requester = createPeerKeys("agent-run7-requester");
const gru = createPeerKeys("agent-run7-gru");
const syd = createPeerKeys("agent-run7-syd");

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
  process.env.COORDINATOR_STARTUP_GRACE_MS = "0";
  delete process.env.INFERENCE_COMPLETION_PRIOR_SPEED;
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  eta = await import("../../src/swarm/coordinator/start-eta.js");
  inference = await import("../../src/swarm/coordinator/routes/inference.js");
  hostSteal = await import("../../src/swarm/coordinator/host-steal.js");
  await app.ready();
  await register(requester, []);
  await register(gru, [MODEL], "gru");
  await register(syd, [MODEL], "syd");
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  delete process.env.COORDINATOR_STARTUP_GRACE_MS;
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

async function register(keys: PeerKeys, installedModels: string[], region?: string) {
  const payload = JSON.stringify({
    os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
    sandboxMode: "docker", installedModels, ...(region ? { region } : {}),
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

const pullAs = async (k: PeerKeys, slots = 2, free = 2) => {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: slots, freeInferenceSlots: free }, k)).json();
  return { id: (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null, taskId: (r.subtask?.taskId ?? r.envelope?.taskId ?? null) as string | null };
};
const finish = async (k: PeerKeys, taskId: string, subtaskId: string) => {
  await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 3, outputTokens: 1 }, k);
  await post("/result", { subtaskId, taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model: MODEL }, k);
};
async function drain() {
  for (let i = 0; i < 64; i++) {
    let any = false;
    for (const k of [gru, syd]) {
      const r = await pullAs(k);
      if (!r.id || !r.taskId) continue;
      any = true;
      await finish(k, r.taskId, r.id);
    }
    if (!any) break;
  }
}

/** A run-7 long call: a short prompt and max_tokens 1400. */
const longReply = () => ({ model: MODEL, maxTokens: 1_400, messages: [{ role: "user", content: "Write a long, detailed tutorial on writing a tiny HTTP server in Node.js, with full code for every step and explanations." }] });
const lookup = () => ({ model: MODEL, maxTokens: 48, messages: [{ role: "user", content: `Write a JS function named f${Math.floor(Math.random() * 100)} that returns its square. Code only.` }] });

const submit = async (body: Record<string, unknown>) => {
  const taskId = `inf-${randomUUID()}`;
  const t0 = Date.now();
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, timeoutMs: 180_000, ...body }, requester);
  return { taskId, r, ms: Date.now() - t0 };
};
const read = (taskId: string, subtaskId: string) => post("/inference/stream", { taskId, subtaskId, after: 0, waitMs: 0 }, requester);

beforeEach(async () => {
  hostSteal.clearAgentSteal();
  await drain();
  // Both hosts idle and taking calls (a fresh report each).
  await pullAs(gru);
  await pullAs(syd);
  eta.serviceTimes.clear();
  eta.decodeRates.clear();
  eta.prefillRates.clear();
  eta.modelPickups.clear();
});

describe("1. a long reply is judged on max_tokens ÷ the decode rate (31c83bfe, 36c23c3c)", () => {
  test("the 1.5b CPU prior decodes far below the old ~28 tok/s: 1400 tokens need more than the 180 s timeout", () => {
    const tps = eta.priorDecodeTps(MODEL, "cpu");
    expect(tps).toBeGreaterThan(5);
    expect(tps).toBeLessThan(9); // run 7: 7-8 tok/s measured
    const est = eta.decodeEstimateMs(MODEL, "cpu", 40, 1_400);
    expect(est.prior).toBe(true);
    expect(est.ms).toBeGreaterThan(180_000);
    // The old judgement: the speed prior × expectedWorkMs.
    expect(eta.COMPLETION_PRIOR_SPEED.cpu * eta.callWorkMs(MODEL, "cpu", 40, 1_400)).toBeLessThan(110_000);
  });

  test("submit: max_tokens 1400 on the 1.5b CPU hosts is refused at once (no exploration past the timeout), nothing reserved", async () => {
    const before = creditEngine.balance(requester.peerId);
    const { r, ms } = await submit(longReply());
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(r.json().completionEtaMs).toBeGreaterThan(180_000);
    expect(ms).toBeLessThan(2_000);
    expect(creditEngine.balance(requester.peerId)).toBe(before);
  });

  test("a call that sets no max_tokens is judged as before (a typical reply at the speed estimate), not on the decode rate", async () => {
    const { r } = await submit({ model: MODEL, messages: longReply().messages });
    expect(r.statusCode, r.body).toBe(200);
  });

  test("submit: a short reply on the same hosts is still accepted", async () => {
    const { r } = await submit({ ...lookup(), maxTokens: 256 });
    expect(r.statusCode, r.body).toBe(200);
  });

  test("measured decode rate takes over from the prior: hosts measured at 30 tok/s get the 1400-token call", async () => {
    for (let i = 0; i < 3; i++) eta.decodeRates.record(MODEL, "cpu", 30);
    const est = eta.decodeEstimateMs(MODEL, "cpu", 40, 1_400);
    expect(est.prior).toBe(false);
    expect(est.ms).toBeLessThan(60_000);
    const { r } = await submit(longReply());
    expect(r.statusCode, r.body).toBe(200);
  });

  test("measured at 7.5 tok/s (run 7): refused even though short calls measured fast speeds", async () => {
    for (let i = 0; i < 3; i++) eta.decodeRates.record(MODEL, "cpu", 7.5);
    // Short calls ran far under their expectedWorkMs (speed 0.1): the speed estimate alone would admit it.
    const work = eta.callWorkMs(MODEL, "cpu", 40, 1_400);
    for (let i = 0; i < 3; i++) eta.serviceTimes.record(MODEL, "cpu", work * 0.1, Date.now(), work);
    const { r } = await submit(longReply());
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json().completionEtaMs).toBeGreaterThan(180_000);
  });

  test("a finished streamed call records the class's decode rate (first piece to last, normalised for contention)", async () => {
    const before = Date.now();
    eta.noteDecodeRate(MODEL, gru.peerId, before - 30_000, before - 20_000, before, { promptTokens: 50, outputTokens: 150 }, 1);
    eta.noteDecodeRate(MODEL, gru.peerId, before - 30_000, before - 20_000, before, { promptTokens: 50, outputTokens: 150 }, 2);
    eta.noteDecodeRate(MODEL, gru.peerId, before - 30_000, before - 20_000, before, { promptTokens: 50, outputTokens: 20 }, 1); // too short: no sample
    const r = new TokenRates();
    expect(r.rate(MODEL, "cpu", undefined)).toBeNull();
    const rate = eta.decodeRates.rate(MODEL, "cpu", undefined);
    expect(rate).toBeNull(); // two samples, no prior: not enough
    const withPrior = eta.decodeRates.rate(MODEL, "cpu", 6);
    // 150 tokens in 20 s alone (7.5 tok/s) and beside another call (15 tok/s for one call), prior 6: median 7.5.
    expect(withPrior).toMatchObject({ tps: 7.5, samples: 2, prior: true });
  });

  test("route: pieces streamed over time give a decode sample", async () => {
    const call = await submit(lookup());
    expect(call.r.statusCode, call.r.body).toBe(200);
    const pulled = await pullAs(gru);
    expect(pulled.id).toBe(call.r.json().subtaskId);
    expect((await post("/inference/chunks", { subtaskId: pulled.id, seq: 0, delta: "x".repeat(40) }, gru)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 1_100));
    expect((await post("/inference/chunks", { subtaskId: pulled.id, seq: 1, delta: "y".repeat(400), done: true, promptTokens: 30, outputTokens: 100 }, gru)).statusCode).toBe(200);
    const rate = eta.decodeRates.rate(MODEL, "cpu", 1);
    expect(rate.samples).toBe(1);
    await post("/result", { subtaskId: pulled.id, taskId: call.taskId, agentId: gru.peerId, ok: true, output: "x", durationMs: 100, model: MODEL }, gru);
  });
});

describe("2/4. a claimed call with nothing sent is taken back from a throttled or silent host (949e8a28, f9c28e38)", () => {
  test("its host withholds its slots (throttled): the call goes back on the queue without it and another host takes it", async () => {
    const call = await submit(lookup());
    expect(call.r.statusCode, call.r.body).toBe(200);
    const subtaskId = call.r.json().subtaskId;
    let holder: PeerKeys | undefined;
    for (const k of [gru, syd]) if ((await pullAs(k)).id === subtaskId) holder = k;
    expect(holder).toBeDefined();
    const other = holder === gru ? syd : gru;
    // The holder's CPU is throttled: it reports no free slot with one of two idle (#563).
    await pullAs(holder!, 2, 0);
    expect(eta.agentWithholding(holder!.peerId)).toBe(true);
    expect(await inference.takeBackStalledClaims(Date.now() + 3_000)).toBe(0);
    const again = await pullAs(other);
    expect(again.id).toBe(subtaskId);
    // The first holder's late pieces are refused.
    expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "late" }, holder!)).statusCode).toBe(403);
    await finish(other, call.taskId, subtaskId);
  });

  test("its host's every slot is busy but it reports its throttle guard (#572 host-steal): taken back too", async () => {
    const call = await submit(lookup());
    const subtaskId = call.r.json().subtaskId;
    let holder: PeerKeys | undefined;
    for (const k of [gru, syd]) if ((await pullAs(k, 1, 1)).id === subtaskId) holder = k;
    expect(holder).toBeDefined();
    // One slot, held: no withheld slot by count; the steal report alone says it is held back.
    await post("/pull", { agentId: holder!.peerId, inferenceSlots: 1, freeInferenceSlots: 0, cpuThrottled: true, cpuStealShare: 0.7 }, holder!);
    expect(eta.withheldSlots(holder!.peerId, 1)).toBe(0);
    expect(eta.agentWithholding(holder!.peerId)).toBe(true);
    await inference.takeBackStalledClaims(Date.now() + 3_000);
    const other = holder === gru ? syd : gru;
    expect((await pullAs(other)).id).toBe(subtaskId);
    await finish(other, call.taskId, subtaskId);
  });

  test("no first piece long past the expected first token: taken back even with no throttle report", async () => {
    const call = await submit(lookup());
    const subtaskId = call.r.json().subtaskId;
    let holder: PeerKeys | undefined;
    for (const k of [gru, syd]) if ((await pullAs(k)).id === subtaskId) holder = k;
    expect(holder).toBeDefined();
    const bound = eta.stalledClaimMs(MODEL, "cpu", 40);
    expect(bound).toBeGreaterThanOrEqual(eta.STALL_MIN_MS);
    expect(bound).toBeLessThan(60_000);
    await inference.takeBackStalledClaims(Date.now() + 5_000);
    expect((await read(call.taskId, subtaskId)).statusCode).toBe(200); // too early: still its host's
    expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "" }, holder!)).statusCode).toBe(200);
    await inference.takeBackStalledClaims(Date.now() + bound + 1_000);
    const other = holder === gru ? syd : gru;
    expect((await pullAs(other)).id).toBe(subtaskId);
    await finish(other, call.taskId, subtaskId);
  });

  test("a call that already sent a piece is never taken back", async () => {
    const call = await submit(lookup());
    const subtaskId = call.r.json().subtaskId;
    let holder: PeerKeys | undefined;
    for (const k of [gru, syd]) if ((await pullAs(k)).id === subtaskId) holder = k;
    expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "hello" }, holder!)).statusCode).toBe(200);
    await pullAs(holder!, 2, 0);
    await inference.takeBackStalledClaims(Date.now() + 600_000);
    expect((await post("/inference/chunks", { subtaskId, seq: 1, delta: " world", done: true, promptTokens: 3, outputTokens: 2 }, holder!)).statusCode).toBe(200);
    await post("/result", { subtaskId, taskId: call.taskId, agentId: holder!.peerId, ok: true, output: "hello world", durationMs: 100, model: MODEL }, holder!);
  });

  test("every host throttled: the taken-back call is ended by the next sweep, refunded", async () => {
    const before = creditEngine.balance(requester.peerId);
    const call = await submit(lookup());
    const subtaskId = call.r.json().subtaskId;
    let holder: PeerKeys | undefined;
    for (const k of [gru, syd]) if ((await pullAs(k)).id === subtaskId) holder = k;
    await pullAs(gru, 2, 0);
    await pullAs(syd, 2, 0);
    await inference.sweepWaitingInference(Date.now() + 3_000);
    await inference.sweepWaitingInference(Date.now() + 3_000);
    const r = await read(call.taskId, subtaskId);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(creditEngine.balance(requester.peerId)).toBe(before);
    expect(holder).toBeDefined();
  });
});

describe("3/4. calls that cannot start are refused at submit or on the first sweep, not 8-42 s later", () => {
  test("every holder reports no free slot while idle (throttled): a named call is refused at submit", async () => {
    await pullAs(gru, 2, 0);
    await pullAs(syd, 2, 0);
    const before = creditEngine.balance(requester.peerId);
    const { r, ms } = await submit(lookup());
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(ms).toBeLessThan(2_000);
    expect(creditEngine.balance(requester.peerId)).toBe(before);
  });

  test("one host throttled: only the other's slots count for the start estimate", async () => {
    await pullAs(gru, 2, 0);
    const slots = eta.modelSlots(MODEL, "any", 0);
    expect(slots).toEqual({ slots: 2, free: 2 });
  });

  test("sweep: slots held by long calls (mean hold, not the median of short ones) end calls far back in the queue on the first tick", async () => {
    // Fill both hosts (one slot each).
    const fillers: Array<{ k: PeerKeys; taskId: string; id: string }> = [];
    for (let i = 0; i < 2; i++) expect((await submit(lookup())).r.statusCode).toBe(200);
    for (const k of [gru, syd]) {
      const r = await pullAs(k, 1, 1);
      if (r.id && r.taskId) fillers.push({ k, taskId: r.taskId, id: r.id });
    }
    expect(fillers).toHaveLength(2);
    // Three calls wait (nothing known yet: accepted).
    const waiting = [];
    for (let i = 0; i < 3; i++) {
      const w = await submit(lookup());
      expect(w.r.statusCode, w.r.body).toBe(200);
      waiting.push(w);
    }
    // Five quick lookups and three calls that held their slot ~150 s: median 1 s, mean ~57 s.
    for (const ms of [1_000, 1_000, 1_000, 1_000, 1_000, 150_000, 150_000, 150_000]) eta.serviceTimes.record(MODEL, "cpu", ms);
    expect(eta.serviceTimes.typicalMs(MODEL, "cpu")).toBe(1_000);
    expect(eta.serviceTimes.meanMs(MODEL, "cpu")).toBeGreaterThan(50_000);
    // First tick: the first in line starts in ~28 s (kept); the two behind it not within the claim bound.
    await inference.sweepWaitingInference(Date.now());
    const codes = [];
    for (const w of waiting) codes.push((await read(w.taskId, w.r.json().subtaskId)).statusCode);
    expect(codes).toEqual([200, 503, 503]);
    // A new call behind them is refused at submit, at once.
    const late = await submit(lookup());
    expect(late.r.statusCode, late.r.body).toBe(503);
    expect(late.ms).toBeLessThan(2_000);
    for (const f of fillers) await finish(f.k, f.taskId, f.id);
  });

  test("ServiceTimes.meanMs and the pickup rate known after 3 s of saturation", () => {
    const s = new ServiceTimes();
    expect(s.meanMs("m", "cpu", 0)).toBeNull();
    for (const ms of [1_000, 2_000, 9_000]) s.record("m", "cpu", ms, 0);
    expect(s.meanMs("m", "cpu", 0)).toBe(4_000);
    const p = new ModelPickups();
    p.noteSaturated("m", true, 100_000);
    expect(p.etaMs("m", 1, 102_000)).toBeNull();
    // No pickup in 3 s: at most one per 6 s.
    expect(p.etaMs("m", 1, 103_000)).toBe(6_000);
  });
});
