import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";
import { ModelPickups, ServiceTimes, TokenRates } from "../../src/swarm/coordinator/start-eta.js";

/*
 * Network validation run 8 (2026-11-25, CPU ramp after the hosts ran out of CPU credit):
 *
 * 1. inf-1795626005562-e8d4e4d0, -42b56eeb, -b008d3ec and -12a17597 waited in the shared backlog
 *    ("every coordinator busy: backlog shared by agents") and were claimed at /pull by hosts out of CPU
 *    credit (first piece 17-43 s after submit), then ran to the 180 s timeout. A claim was judged only
 *    on the puller's free slot; the stalled-claim take-back ran once per call.
 * 2. 21 calls were refused "none could start this request in time" 34-92 s after submit: the waiting
 *    sweep counted idle slots of hosts that had stopped pulling, and the slots of hosts a re-queued
 *    call may not go to, as free, and skipped the call until its 45 s claim bound (re-armed after a
 *    take-back: 70-92 s).
 *
 * Run 7 (for the setup below, shared with admission-run7.test.ts):
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

const MESH = "mesh-secret-run8";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.77";
const MODEL = "qwen2.5-coder:1.5b";
let portal: Server;
let app: any;
let eta: any;
let inference: any;
let hostSteal: any;
let ctx: any;
const requester = createPeerKeys("agent-run8-requester");
const gru = createPeerKeys("agent-run8-gru");
const syd = createPeerKeys("agent-run8-syd");

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
  ctx = await import("../../src/swarm/coordinator/context.js");
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

const lookup = () => ({ model: MODEL, maxTokens: 48, messages: [{ role: "user", content: `Write a JS function named f${Math.floor(Math.random() * 100)} that returns its square. Code only.` }] });

const submit = async (body: Record<string, unknown>) => {
  const taskId = `inf-${randomUUID()}`;
  const t0 = Date.now();
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, timeoutMs: 180_000, ...body }, requester);
  return { taskId, r, ms: Date.now() - t0 };
};
const read = (taskId: string, subtaskId: string) => post("/inference/stream", { taskId, subtaskId, after: 0, waitMs: 0 }, requester);
const stolenPull = (k: PeerKeys, share: number, slots = 2, free = 2) =>
  post("/pull", { agentId: k.peerId, inferenceSlots: slots, freeInferenceSlots: free, cpuStealShare: share, cpuThrottled: false }, k);
const pulledId = (res: any) => (res.json().subtask?.id ?? res.json().envelope?.subtaskId ?? null) as string | null;

beforeEach(async () => {
  hostSteal.clearAgentSteal();
  eta.clearHeldCounts();
  await drain();
  await pullAs(gru);
  await pullAs(syd);
  eta.serviceTimes.clear();
  eta.decodeRates.clear();
  eta.prefillRates.clear();
  eta.modelPickups.clear();
});

describe("1. a call taken from the backlog gets the same admission as placement (e8d4e4d0, 42b56eeb, b008d3ec, 12a17597)", () => {
  test("a host reporting CPU steal below its own guard (free slots still reported) does not claim it; a healthy host does", async () => {
    const call = await submit(lookup());
    expect(call.r.statusCode, call.r.body).toBe(200);
    const subtaskId = call.r.json().subtaskId;
    // syd's guard has not engaged (share < 0.5, free slots reported), but the coordinator's threshold is met.
    expect(pulledId(await stolenPull(syd, 0.35))).toBeNull();
    expect(eta.agentStolenRecently(syd.peerId)).toBe(true);
    // A steal report from a reply piece a few seconds ago counts too: a plain pull now still takes nothing.
    expect((await pullAs(syd)).id).toBeNull();
    expect((await pullAs(gru)).id).toBe(subtaskId);
    await finish(gru, call.taskId, subtaskId);
  });

  test("a held-back host is not counted as a free holder or a slot a waiting call could get", async () => {
    await stolenPull(syd, 0.4);
    expect(eta.agentHeldBack(syd.peerId, 0)).toBe(true);
    expect(eta.modelSlots(MODEL, "any", 0)).toEqual({ slots: 2, free: 2 });
    expect(eta.withholdingHolders(MODEL)).toEqual([syd.peerId]);
    const models = (await app.inject({ method: "GET", url: "/inference/models" })).json();
    const row = (models.models ?? models.data ?? []).find((m: any) => (m.model ?? m.id) === MODEL);
    if (row && typeof row.freeSlots === "number") expect(row.freeSlots).toBe(2);
  });

  test("every host held back: a waiting call is ended by the first sweep, refunded (not left for a stolen host)", async () => {
    const before = creditEngine.balance(requester.peerId);
    const call = await submit(lookup());
    expect(call.r.statusCode, call.r.body).toBe(200);
    const subtaskId = call.r.json().subtaskId;
    expect(pulledId(await stolenPull(gru, 0.3))).toBeNull();
    expect(pulledId(await stolenPull(syd, 0.3))).toBeNull();
    const t0 = Date.now();
    await inference.sweepWaitingInference();
    const r = await read(call.taskId, subtaskId);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(creditEngine.balance(requester.peerId)).toBe(before);
  });

  test("completion gate at claim: a call that would no longer finish in the time it has left is not claimed", async () => {
    // 900 tokens at a measured 6.5 tok/s: ~141 s, inside the 162 s completion limit at submit.
    for (let i = 0; i < 3; i++) eta.decodeRates.record(MODEL, "cpu", 6.5);
    const call = await submit({ ...lookup(), maxTokens: 900 });
    expect(call.r.statusCode, call.r.body).toBe(200);
    const st = ctx.queue.getSubtask(call.r.json().subtaskId);
    expect(inference.claimAdmits(gru.peerId, st)).toBe(true);
    // The same call pulled by gru 30 s after submit (it waited in the backlog): no longer fits the time left.
    const later = Date.now() + 30_000;
    const dispatch = await import("../../src/swarm/coordinator/dispatch.js");
    dispatch.noteAgentPull(gru.peerId, { inferenceSlots: 2, freeInferenceSlots: 2, wake: false }, later);
    expect(inference.claimAdmits(gru.peerId, st, later)).toBe(false);
    dispatch.noteAgentPull(gru.peerId, { inferenceSlots: 2, freeInferenceSlots: 2, wake: false });
    // The hosts slowed down while it waited (measured decode ~1 tok/s): the sweep ends it now (no class
    // here would finish it, a free slot or not), refunded.
    eta.decodeRates.clear();
    for (let i = 0; i < 3; i++) eta.decodeRates.record(MODEL, "cpu", 1);
    await inference.sweepWaitingInference();
    expect((await read(call.taskId, st.id)).statusCode).toBe(503);
  });

  test("the stalled-claim take-back covers a call taken from the backlog after an earlier take-back", async () => {
    const before = creditEngine.balance(requester.peerId);
    const call = await submit(lookup());
    const subtaskId = call.r.json().subtaskId;
    expect((await pullAs(gru)).id).toBe(subtaskId);
    // gru runs out of CPU credit before its first piece: taken back.
    await post("/pull", { agentId: gru.peerId, inferenceSlots: 2, freeInferenceSlots: 0, cpuThrottled: true, cpuStealShare: 0.8 }, gru);
    await inference.takeBackStalledClaims(Date.now() + 3_000);
    // syd takes it from the backlog (healthy at its pull), then runs out of credit too: taken back again.
    expect((await pullAs(syd)).id).toBe(subtaskId);
    await post("/pull", { agentId: syd.peerId, inferenceSlots: 2, freeInferenceSlots: 0, cpuThrottled: true, cpuStealShare: 0.8 }, syd);
    await inference.takeBackStalledClaims(Date.now() + 3_000);
    expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "late" }, syd)).statusCode).toBe(403);
    // No host left for it: ended by the next sweep, refunded in full.
    await inference.sweepWaitingInference();
    const r = await read(call.taskId, subtaskId);
    expect(r.statusCode).toBe(503);
    expect(creditEngine.balance(requester.peerId)).toBe(before);
  });
});

describe("2. waiting calls the sweep skipped are decided at once (21 refusals at 34-92 s)", () => {
  test("hosts with idle slots that stopped pulling are not free slots: the waiting call is ended, not left to its 45 s bound", async () => {
    const call = await submit(lookup());
    expect(call.r.statusCode, call.r.body).toBe(200);
    const subtaskId = call.r.json().subtaskId;
    const now = Date.now();
    await inference.sweepWaitingInference(now);
    expect((await read(call.taskId, subtaskId)).statusCode).toBe(200); // both just pulled: kept
    // Neither host pulls again (throttled VMs whose agent loop starves): idle slots, no pull for > PULL_STALE_MS.
    const later = now + eta.PULL_STALE_MS + 1_000;
    expect(eta.agentHeldBack(gru.peerId, 0, later)).toBe(true);
    expect(eta.modelSlots(MODEL, "any", 0, later)).toEqual({ slots: 0, free: 0 });
    await inference.sweepWaitingInference(later);
    const r = await read(call.taskId, subtaskId);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
  });

  test("a slot that just freed is not held back before its agent's next pull", async () => {
    // syd holds a call for a long time with no pull (all slots busy: it does not pull), then finishes it.
    const call = await submit(lookup());
    const subtaskId = call.r.json().subtaskId;
    let holder: PeerKeys | undefined;
    for (const k of [gru, syd]) if ((await pullAs(k, 1, 1)).id === subtaskId) holder = k;
    expect(holder).toBeDefined();
    const t = Date.now();
    eta.noteHeldCounts(t);
    expect(eta.agentHeldBack(holder!.peerId, 1, t + 60_000)).toBe(false); // every slot busy
    await finish(holder!, call.taskId, subtaskId);
    eta.noteHeldCounts(t + 60_000);
    expect(eta.agentHeldBack(holder!.peerId, 0, t + 60_500)).toBe(false);
    expect(eta.agentHeldBack(holder!.peerId, 0, t + 60_000 + eta.PULL_STALE_MS + 1)).toBe(true);
  });

  test("both hosts stopped pulling before the call came: refused at submit, within 2 s", async () => {
    const before = creditEngine.balance(requester.peerId);
    // Their last pulls, and the last change in what they hold, were more than PULL_STALE_MS ago.
    const dispatch = await import("../../src/swarm/coordinator/dispatch.js");
    const old = Date.now() - eta.PULL_STALE_MS - 5_000;
    dispatch.noteAgentPull(gru.peerId, { inferenceSlots: 2, freeInferenceSlots: 2, wake: false }, old);
    dispatch.noteAgentPull(syd.peerId, { inferenceSlots: 2, freeInferenceSlots: 2, wake: false }, old);
    eta.clearHeldCounts();
    eta.noteHeldCounts(old);
    const { r, ms } = await submit(lookup());
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(ms).toBeLessThan(2_000);
    expect(creditEngine.balance(requester.peerId)).toBe(before);
  });

  test("a re-queued call is judged without the host it was taken from (its free slot is not one it could get)", async () => {
    // syd busy (one slot) with a call that holds its slot long; the next call goes to gru and stalls there.
    const filler = await submit(lookup());
    expect((await pullAs(syd, 1, 1)).id).toBe(filler.r.json().subtaskId);
    expect((await post("/inference/chunks", { subtaskId: filler.r.json().subtaskId, seq: 0, delta: "working" }, syd)).statusCode).toBe(200);
    const call = await submit(lookup());
    const subtaskId = call.r.json().subtaskId;
    expect((await pullAs(gru, 1, 1)).id).toBe(subtaskId);
    // No first piece long past the expected first token: taken back from gru (no throttle report).
    const bound = eta.stalledClaimMs(MODEL, "cpu", 40);
    await inference.takeBackStalledClaims(Date.now() + bound + 1_000);
    expect(ctx.queue.excludedAgents(subtaskId)).toContain(gru.peerId);
    // gru is idle and pulling (a free slot by every count), but the call may not go there.
    expect((await pullAs(gru, 1, 1)).id).toBeNull();
    expect(eta.modelSlots(MODEL, "any", 0)).toEqual({ slots: 2, free: 1 });
    expect(eta.modelSlots(MODEL, "any", 0, Date.now(), [gru.peerId])).toEqual({ slots: 1, free: 0 });
    // syd's calls hold their slot ~150 s: the call cannot start within its bound; ended on the next tick.
    for (const ms of [150_000, 150_000, 150_000]) eta.serviceTimes.record(MODEL, "cpu", ms);
    await inference.sweepWaitingInference();
    const r = await read(call.taskId, subtaskId);
    expect(r.statusCode).toBe(503);
    await finish(syd, filler.taskId, filler.r.json().subtaskId);
  });
});
