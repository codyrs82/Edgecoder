import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";
import {
  classContention, COMPLETION_PRIOR_SPEED, judgeCompletion, parseCompletionPrior, RELEVANT_WORK_SHARE, ServiceTimes,
} from "../../src/swarm/coordinator/start-eta.js";

/*
 * Network validation run 5 (2026-11-25): calls that completion-aware admission (#555) let through
 * ran to the 180 s deadline, and "busy" refusals came after the 45 s claim bound.
 *
 * - Heavy calls on the EU coordinator (12 KB prompt, max_tokens 2000, on 2-slot 1.5b CPU hosts):
 *   inf-1795598815058-e13b5460, inf-1795599047742-2e35fe93. The coordinator had ~20 speed samples
 *   for the model, all from short calls (~1.3 s, max_tokens 48): their median made a heavy call look
 *   like 35 s. A short call says little about a long one: only samples at least RELEVANT_WORK_SHARE of
 *   the judged call's work count, and the class's prior fills in for the missing ones.
 * - Right after a deploy (samples live in memory) nothing was judged: the prior judges from the start.
 * - A burst of 6 onto 4 slots: the hosts share their cores; the third call on a 2-host class would run
 *   beside another one.
 * - A call whose placement died (the 3a probe right after a host stop) waited 45 s to hear "busy".
 */

const MESH = "mesh-secret-run5";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.55";
const MODEL = "qwen2.5-coder:1.5b";
let portal: Server;
let app: any;
let eta: any;
let routing: any;
let liveness: any;
let lostSweep: any;
const requester = createPeerKeys("agent-run5-requester");
const lhr = createPeerKeys("agent-run5-lhr");
const fra = createPeerKeys("agent-run5-fra");

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
  delete process.env.INFERENCE_COMPLETION_PRIOR_SPEED; // the defaults
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  eta = await import("../../src/swarm/coordinator/start-eta.js");
  routing = await import("../../src/swarm/coordinator/routing.js");
  liveness = await import("../../src/swarm/coordinator/agent-liveness.js");
  lostSweep = await import("../../src/swarm/coordinator/lost-agent-claims.js");
  await app.ready();
  await register(requester, []);
  await register(lhr, [MODEL], "lhr");
  await register(fra, [MODEL], "fra");
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
  return (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null;
};
const finish = async (k: PeerKeys, taskId: string, subtaskId: string) => {
  expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 3, outputTokens: 1 }, k)).statusCode).toBe(200);
  expect((await post("/result", { subtaskId, taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model: MODEL }, k)).statusCode).toBe(200);
};
/** Run every call still waiting, so each test starts with free hosts. */
async function drain() {
  for (let i = 0; i < 64; i++) {
    let any = false;
    for (const k of [lhr, fra]) {
      const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: 2, freeInferenceSlots: 2 }, k)).json();
      const id = r.subtask?.id ?? r.envelope?.subtaskId;
      if (!id) continue;
      any = true;
      await finish(k, r.subtask?.taskId ?? r.envelope?.taskId, id);
    }
    if (!any) break;
  }
}

/** The long-call shapes of run 5 (long.json): a 12 KB module to explain (max 2000), and a long tutorial (max 1400). */
const MODULE = Array.from({ length: 150 }, (_, i) => `function z2499_${i}(a, b) { const r = a * ${2499 + i} + b - ${(i * 5) % 13}; return r > ${i} ? r : b; }`).join("\n");
const heavy = () => ({ model: MODEL, maxTokens: 2_000, messages: [{ role: "user", content: `Here is a module:\n${MODULE}\nWrite a long, detailed explanation of every function in this module, one paragraph each, in order.` }] });
const tutorial = () => ({ model: MODEL, maxTokens: 1_400, messages: [{ role: "user", content: "Write a long, detailed tutorial on writing a JSON parser in JavaScript, with full code for every step and explanations." }] });
const lookup = () => ({ model: MODEL, maxTokens: 48, messages: [{ role: "user", content: `Write a JS function named f${Math.floor(Math.random() * 100)} that returns its square. Code only.` }] });

const submit = async (body: Record<string, unknown>) => {
  const taskId = `inf-${randomUUID()}`;
  const t0 = Date.now();
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, timeoutMs: 180_000, ...body }, requester);
  return { taskId, r, ms: Date.now() - t0 };
};

/** What the EU coordinator had learnt before the heavy burst: ~20 short calls (~1.3 s for max_tokens 48). */
function shortSamples(n = 20) {
  for (let i = 0; i < n; i++) eta.serviceTimes.record(MODEL, "cpu", 1_300, Date.now(), eta.callWorkMs(MODEL, "cpu", 30, 48));
}

describe("completion prior and relevance (unit)", () => {
  test("INFERENCE_COMPLETION_PRIOR_SPEED: defaults, off, one number, per class", () => {
    expect(parseCompletionPrior(undefined)).toEqual(COMPLETION_PRIOR_SPEED);
    expect(parseCompletionPrior("off")).toEqual({});
    expect(parseCompletionPrior("0")).toEqual({});
    expect(parseCompletionPrior("0.4")).toEqual({ cpu: 0.4, apple: 0.4, gpu: 0.4, "gpu.dc": 0.4 });
    expect(parseCompletionPrior("cpu=0.8,gpu=0")).toEqual({ cpu: 0.8, apple: 0.15, "gpu.dc": 0.1 });
    expect(parseCompletionPrior("bogus")).toEqual(COMPLETION_PRIOR_SPEED);
  });

  test("a short call's sample does not judge a long call; the prior fills in, real samples take over", () => {
    const s = new ServiceTimes();
    const big = 360_000;
    for (let i = 0; i < 20; i++) s.record("m", "cpu", 1_300, 0, 12_600);
    // Short samples only: the prior judges the long call.
    expect(s.speedFor("m", "cpu", big, 0.5, 0)).toEqual({ speed: 0.5, samples: 0, prior: true });
    // ...and they still judge a short call.
    expect(s.speedFor("m", "cpu", 12_600, 0.5, 0)).toMatchObject({ samples: 20, prior: false });
    expect(s.speedFor("m", "cpu", 12_600, 0.5, 0).speed).toBeCloseTo(1_300 / 12_600, 5);
    // Without a prior: not judged until enough relevant samples (as before run 5).
    expect(s.speedFor("m", "cpu", big, undefined, 0).speed).toBeNull();
    // Relevant samples arrive: blended, then theirs alone.
    s.record("m", "cpu", 360_000, 0, big * RELEVANT_WORK_SHARE);
    expect(s.speedFor("m", "cpu", big, 0.5, 0)).toMatchObject({ speed: 0.5, samples: 1, prior: true });
    s.record("m", "cpu", 270_000, 0, big);
    s.record("m", "cpu", 252_000, 0, big);
    expect(s.speedFor("m", "cpu", big, 0.5, 0)).toEqual({ speed: 0.75, samples: 3, prior: false });
  });

  test("contention: the call shares the least loaded host with the calls already there", () => {
    // EU: 2 hosts of 2 slots. Two calls go one per host; a third shares one.
    expect(classContention("cpu", 2, 2, 0)).toBe(1);
    expect(classContention("cpu", 2, 2, 1)).toBe(1);
    expect(classContention("cpu", 2, 2, 2)).toBe(2);
    expect(classContention("cpu", 2, 2, 9)).toBe(2);
    expect(classContention("apple", 1, 2, 1)).toBe(1.5);
    expect(classContention("cloud", 1, 16, 10)).toBe(1);
  });

  test("exploration: a class judged on its prior alone gets one call at a time, within the whole timeout", () => {
    const c = (completionEtaMs: number, inFlight: number, priorOnly = true) => ({ computeClass: "cpu", agents: ["a"], startEtaMs: 0, completionEtaMs, priorOnly, inFlight });
    expect(judgeCompletion([c(170_000, 0)], 162_000, 180_000)).toMatchObject({ none: false, exclude: [] });
    expect(judgeCompletion([c(170_000, 1)], 162_000, 180_000)).toMatchObject({ none: true });
    expect(judgeCompletion([c(181_000, 0)], 162_000, 180_000)).toMatchObject({ none: true });
    expect(judgeCompletion([c(170_000, 0, false)], 162_000, 180_000)).toMatchObject({ none: true });
  });
});

describe("run 5 shapes on a real coordinator", () => {
  beforeEach(async () => {
    routing.setPeerWorldSource(undefined);
    await drain();
    eta.serviceTimes.clear();
  });

  test("heavy calls (e13b5460, 2e35fe93): refused at once although short calls had made the class look fast", async () => {
    shortSamples();
    const before = creditEngine.balance(requester.peerId);
    for (let i = 0; i < 3; i++) {
      const { r, ms } = await submit(heavy());
      expect(r.statusCode, r.body).toBe(503);
      expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy", limitMs: 162_000 });
      expect(r.json().completionEtaMs).toBeGreaterThan(162_000);
      expect(ms).toBeLessThan(2_000);
    }
    expect(creditEngine.balance(requester.peerId)).toBe(before);
    // The short calls are still judged by their own samples: accepted.
    expect((await submit(lookup())).r.statusCode).toBe(200);
  });

  test("right after a deploy (no samples at all) a heavy call is judged too", async () => {
    const { r } = await submit(heavy());
    expect(r.statusCode, r.body).toBe(503);
  });

  test("a burst of long tutorials onto 2 hosts × 2 slots: one per host, the rest refused at once (no 45 s wait)", async () => {
    shortSamples();
    const answers: number[] = [];
    for (let i = 0; i < 6; i++) answers.push((await submit(tutorial())).r.statusCode);
    expect(answers.slice(0, 2)).toEqual([200, 200]);
    expect(answers.slice(2).every((s) => s === 503)).toBe(true);
  });

  test("a call that ran out its deadline with nothing sent teaches the class (timeouts are samples too)", async () => {
    // Real samples for calls this size say the class is fast enough...
    const work = eta.callWorkMs(MODEL, "cpu", 2_400, 1_400);
    for (let i = 0; i < 3; i++) eta.serviceTimes.record(MODEL, "cpu", work * 0.3, Date.now(), work);
    expect((await submit(tutorial())).r.statusCode).toBe(200);
    await drain();
    // ...then four such calls time out with nothing sent: the median moves past the limit.
    for (let i = 0; i < 4; i++) eta.noteTimedOutCall(MODEL, fra.peerId, Date.now() - 180_000, JSON.stringify(tutorial()));
    const { r } = await submit(tutorial());
    expect(r.statusCode, r.body).toBe(503);
  });
});

describe("a call whose placement died is answered at once (3a probe)", () => {
  test("placed on a host that is lost while the other is full: no_capacity within the sweep, refunded", async () => {
    routing.setPeerWorldSource(undefined);
    await drain();
    eta.serviceTimes.clear();
    // fra is full (one slot, running a call); lhr has a free slot and is nearest the lhr buyer.
    const filler = await submit({ ...lookup(), clientRegion: "fra" });
    expect(filler.r.statusCode).toBe(200);
    expect(await pullAs(fra, 1, 1)).toBe(filler.r.json().subtaskId);
    await pullAs(lhr, 2, 2);
    liveness.noteAgentSocketOpen(lhr.peerId);
    const before = creditEngine.balance(requester.peerId);
    const probe = await submit({ ...lookup(), clientRegion: "lhr" });
    expect(probe.r.statusCode, probe.r.body).toBe(200);
    // lhr is stopped: its socket closes, nothing more comes from it.
    const stoppedAt = Date.now();
    liveness.noteAgentSocketClosed(lhr.peerId, stoppedAt);
    expect((await lostSweep.moveWaitingCallsOffLostAgents(stoppedAt + 1_000)).cancelled).toBe(0); // within the grace
    const moved = await lostSweep.moveWaitingCallsOffLostAgents(stoppedAt + lostSweep.LOST_PLACEMENT_GRACE_MS);
    expect(moved.cancelled).toBe(1);
    const read = await post("/inference/stream", { taskId: probe.taskId, subtaskId: probe.r.json().subtaskId, after: 0, waitMs: 0 }, requester);
    expect(read.statusCode).toBe(503);
    expect(read.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(creditEngine.balance(requester.peerId)).toBe(before);
    // Within the 2 s sweep after the 3 s grace, not the 45 s claim bound.
    expect(lostSweep.LOST_AGENT_SWEEP_MS + lostSweep.LOST_PLACEMENT_GRACE_MS).toBeLessThanOrEqual(5_000);
    liveness.noteAgentSocketOpen(lhr.peerId);
    await finish(fra, filler.taskId, filler.r.json().subtaskId);
  });

  test("another live host with a free slot: the call stays and is run there", async () => {
    await drain();
    await pullAs(lhr, 2, 2);
    await pullAs(fra, 2, 2);
    liveness.noteAgentSocketOpen(lhr.peerId);
    const probe = await submit({ ...lookup(), clientRegion: "lhr" });
    expect(probe.r.statusCode).toBe(200);
    const stoppedAt = Date.now();
    liveness.noteAgentSocketClosed(lhr.peerId, stoppedAt);
    expect((await lostSweep.moveWaitingCallsOffLostAgents(stoppedAt + lostSweep.LOST_PLACEMENT_GRACE_MS)).cancelled).toBe(0);
    await new Promise((r) => setTimeout(r, 2_100)); // the locality preference lapses
    expect(await pullAs(fra, 2, 2)).toBe(probe.r.json().subtaskId);
    await finish(fra, probe.taskId, probe.r.json().subtaskId);
    liveness.noteAgentSocketOpen(lhr.peerId);
  });
});

describe("the reply's finish reason reaches the requester's stream read", () => {
  test("a reply cut at max_tokens reads finishReason length; an agent without the field is judged by its output count", async () => {
    await drain();
    for (const [chunk, want] of [[{ finishReason: "length", outputTokens: 40 }, "length"], [{ outputTokens: 48 }, "length"], [{ outputTokens: 5 }, "stop"]] as const) {
      const call = await submit({ ...lookup(), clientRegion: "fra" });
      expect(call.r.statusCode).toBe(200);
      const id = call.r.json().subtaskId;
      let by: PeerKeys | null = null;
      for (const k of [fra, lhr]) if (!by && (await pullAs(k)) === id) by = k;
      expect(by).not.toBeNull();
      expect((await post("/inference/chunks", { subtaskId: id, seq: 0, delta: "x", done: true, promptTokens: 3, ...chunk }, by!)).statusCode).toBe(200);
      expect((await post("/result", { subtaskId: id, taskId: call.taskId, agentId: by!.peerId, ok: true, output: "x", durationMs: 100, model: MODEL }, by!)).statusCode).toBe(200);
      const read = await post("/inference/stream", { taskId: call.taskId, subtaskId: id, after: 0, waitMs: 0 }, requester);
      expect(read.json()).toMatchObject({ done: true, finishReason: want });
    }
  });
});

describe("#557: a cloud host's reasoning overrun", () => {
  test("does not count against the host's circuit breaker (as reasoning_only does not)", async () => {
    const mem = await import("../../src/swarm/coordinator/memory-admission.js");
    for (let i = 0; i < 12; i++) mem.noteAgentResult("cloud-overrun-1", "deepseek-v4.1-flash", false, "cloud_reasoning_overrun: deepseek-v4.1-flash was still thinking after up to 8192 tokens");
    expect(mem.circuitOpen("cloud-overrun-1")).toBe(false);
    for (let i = 0; i < 12; i++) mem.noteAgentResult("cloud-overrun-2", "deepseek-v4.1-flash", false, "provider 500");
    expect(mem.circuitOpen("cloud-overrun-2")).toBe(true);
  });

  test("an Auto call is placed again without that host; nothing is charged for the overrun", async () => {
    await drain();
    eta.serviceTimes.clear();
    const taskId = `inf-${randomUUID()}`;
    const sub = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: "auto", timeoutMs: 180_000, maxTokens: 64, messages: [{ role: "user", content: "What is a closure in JavaScript?" }] }, requester);
    expect(sub.statusCode, sub.body).toBe(200);
    const id = sub.json().subtaskId;
    await new Promise((r) => setTimeout(r, 450));
    let first: PeerKeys | null = null;
    for (const k of [lhr, fra]) if (!first && (await pullAs(k)) === id) first = k;
    expect(first).not.toBeNull();
    const other = first === lhr ? fra : lhr;
    const before = creditEngine.balance(requester.peerId);
    const res = await post("/result", { subtaskId: id, taskId, agentId: first!.peerId, ok: false, output: "", error: "cloud_reasoning_overrun: still thinking after 8192 tokens; nothing was sent", durationMs: 100, model: MODEL }, first!);
    expect(res.json()).toMatchObject({ retried: true });
    // The host that overran may not take it again; the other one runs it.
    expect(await pullAs(first!)).toBeNull();
    await new Promise((r) => setTimeout(r, 1_100));
    expect(await pullAs(other)).toBe(id);
    await finish(other, taskId, id);
    expect(creditEngine.balance(requester.peerId)).toBeGreaterThanOrEqual(before - 1);
  });
});

describe("#557: an overrun on the only host of its model", () => {
  test("the Auto call goes to another model (best fit without that host), not back to the same one", async () => {
    await drain();
    const big = createPeerKeys("agent-run5-big");
    await register(big, ["qwen2.5-coder:7b"], "fra");
    await pullAs(big, 1, 1);
    const taskId = `inf-${randomUUID()}`;
    const sub = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: "auto", timeoutMs: 180_000, maxTokens: 64, routing: { job: "tests" }, messages: [{ role: "user", content: "Write unit tests for add(a, b)." }] }, requester);
    expect(sub.statusCode, sub.body).toBe(200);
    expect(sub.json().model).toBe("qwen2.5-coder:7b");
    const id = sub.json().subtaskId;
    expect(await pullAs(big, 1, 1)).toBe(id);
    const res = await post("/result", { subtaskId: id, taskId, agentId: big.peerId, ok: false, output: "", error: "cloud_reasoning_overrun: still thinking; nothing was sent", durationMs: 100, model: "qwen2.5-coder:7b" }, big);
    expect(res.json()).toMatchObject({ retried: true });
    await new Promise((r) => setTimeout(r, 1_100));
    let ranOn: string | null = null;
    for (const k of [lhr, fra]) if (!ranOn && (await pullAs(k)) === id) ranOn = k.peerId;
    expect(ranOn).not.toBeNull();
    const { queue } = await import("../../src/swarm/coordinator/context.js");
    expect(queue.getSubtask(id)?.requestedModel).toBe(MODEL);
  });

  test("nothing else could take it: not re-run, the call ends now (failed, uncharged)", async () => {
    await drain();
    const only = createPeerKeys("agent-run5-only");
    await register(only, ["qwen-only:3b"], "fra");
    await pullAs(only, 1, 1);
    const taskId = `inf-${randomUUID()}`;
    const sub = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: "qwen-only:3b", timeoutMs: 180_000, maxTokens: 64, messages: [{ role: "user", content: "hi" }] }, requester);
    expect(sub.statusCode, sub.body).toBe(200);
    const id = sub.json().subtaskId;
    expect(await pullAs(only, 1, 1)).toBe(id);
    const res = await post("/result", { subtaskId: id, taskId, agentId: only.peerId, ok: false, output: "", error: "cloud_reasoning_overrun: still thinking; nothing was sent", durationMs: 100, model: "qwen-only:3b" }, only);
    expect(res.statusCode).toBe(200);
    expect(res.json().retried).toBeUndefined();
  });
});

describe("the prior and #558's per-host speeds", () => {
  test("a host's reference time: its own samples, else its class's, else the class prior when given", () => {
    eta.serviceTimes.clear();
    eta.agentServiceTimes.clear();
    expect(eta.hostServiceMs(MODEL, "host-x", "cpu", Date.now())).toBeNull();
    const work = eta.callWorkMs(MODEL, "cpu", eta.REFERENCE_CALL_TOKENS.promptTokens, eta.REFERENCE_CALL_TOKENS.outputTokens);
    expect(eta.hostServiceMs(MODEL, "host-x", "cpu", Date.now(), 0.5)).toBe(Math.round(0.5 * work));
    for (let i = 0; i < 3; i++) eta.agentServiceTimes.record(MODEL, "host-x", 1_000, Date.now(), 10_000);
    expect(eta.hostServiceMs(MODEL, "host-x", "cpu", Date.now(), 0.5)).toBe(Math.round(0.1 * work));
  });

  test("a timed-out call is a sample for its host as well as its class", () => {
    eta.serviceTimes.clear();
    eta.agentServiceTimes.clear();
    for (let i = 0; i < 3; i++) eta.noteTimedOutCall(MODEL, fra.peerId, Date.now() - 180_000, JSON.stringify(tutorial()));
    expect(eta.agentServiceTimes.speed(MODEL, fra.peerId)).toBeGreaterThan(0.5);
    eta.agentServiceTimes.clear();
  });
});
