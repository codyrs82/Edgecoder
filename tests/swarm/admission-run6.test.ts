import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";
import { agentFlapping, FLAP_STEADY_MS, noteAgentHttpAlive, resetAgentLiveness } from "../../src/swarm/coordinator/agent-liveness.js";
import { ModelPickups } from "../../src/swarm/coordinator/start-eta.js";
import { edgecoderUsage, openAiResponse } from "../../src/inference-api/openai.js";
import { untilDeadline } from "../../src/inference-api/routes.js";
import { ChatBackendError, DEADLINE_ERROR_CODE, type ChatPiece } from "../../src/inference-api/types.js";
import { describeJob } from "../../src/inference-api/job-descriptor.js";

/*
 * Network validation run 6 (2026-11-25, scratchpad netval/run6/report.md):
 *
 * 1. US→EU redirects skipped the completion check: the US coordinator had no host that could finish a
 *    ~4.5k-token prompt with max_tokens 300 and sent it to EU for a free slot (peerWithFreeCapacity
 *    looked only at free slots). EU accepted (its 1.5b CPU class judged on its prior) and nothing came
 *    out before the 180 s deadline: US 12a98450 → EU inf-1795606903912-52ddd004, US 2d30f9ec → EU
 *    inf-1795606909897-ce81590e, and EU inf-1795606915785-c31fb636.
 * 2. Auto re-placement skipped admission: inf-1795607918429-b8995549 was not picked up on qwen3.5:9b
 *    within 12 s and was moved to a 1.5b CPU host, where it ran 193 s.
 * 3. 16 "none could start this request in time" refusals came 40-50 s after submit (the 45 s claim
 *    bound) in the CPU ramp: the slots were held by calls running far past the median service time.
 * 4. Auto placed inf-1795607920748-eb25b92f on qwen2.5-coder:7b on the maw Mac, which kept dropping
 *    out (heard for a minute, silent for one or two) and was refused after 22.9 s.
 * 5. A deadline cut and a max_tokens cut both read finish_reason "length".
 */

const MESH = "mesh-secret-run6";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.66";
const MODEL = "qwen2.5-coder:1.5b";
let portal: Server;
let app: any;
let eta: any;
let routing: any;
let inference: any;
let autoReplace: any;
const requester = createPeerKeys("agent-run6-requester");
const lhr = createPeerKeys("agent-run6-lhr");
const fra = createPeerKeys("agent-run6-fra");

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
  routing = await import("../../src/swarm/coordinator/routing.js");
  inference = await import("../../src/swarm/coordinator/routes/inference.js");
  autoReplace = await import("../../src/swarm/coordinator/auto-replace.js");
  await app.ready();
  await register(requester, []);
  await register(lhr, [MODEL], "lhr");
  await register(fra, [MODEL], "fra");
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  delete process.env.COORDINATOR_STARTUP_GRACE_MS;
  delete process.env.INFERENCE_COMPLETION_PRIOR_SPEED;
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
  expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 3, outputTokens: 1 }, k)).statusCode).toBe(200);
  expect((await post("/result", { subtaskId, taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model: MODEL }, k)).statusCode).toBe(200);
};
async function drain() {
  for (let i = 0; i < 64; i++) {
    let any = false;
    for (const k of [lhr, fra]) {
      const r = await pullAs(k);
      if (!r.id || !r.taskId) continue;
      any = true;
      await finish(k, r.taskId, r.id);
    }
    if (!any) break;
  }
}

/** The probe of run 6: a ~4.5k-token prompt (18 KB) and max_tokens 300. */
const MODULE = Array.from({ length: 230 }, (_, i) => `function probe_${i}(a, b) { return a * ${1000 + i} + b - ${i % 7}; }`).join("\n");
const probe = () => ({ model: MODEL, maxTokens: 300, messages: [{ role: "user", content: `Explain this module briefly:\n${MODULE}` }] });
const lookup = () => ({ model: MODEL, maxTokens: 48, messages: [{ role: "user", content: `Write a JS function named f${Math.floor(Math.random() * 100)} that returns its square. Code only.` }] });
/** Tokens completion admission judges a body on (as routes/inference.ts completionWork). */
const promptTokensOf = (b: { messages: unknown[] }) => Math.ceil(Buffer.byteLength(JSON.stringify({ messages: b.messages, tools: [] }), "utf8") / 4);

const submit = async (body: Record<string, unknown>) => {
  const taskId = `inf-${randomUUID()}`;
  const t0 = Date.now();
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, timeoutMs: 180_000, ...body }, requester);
  return { taskId, r, ms: Date.now() - t0 };
};
const read = (taskId: string, subtaskId: string) => post("/inference/stream", { taskId, subtaskId, after: 0, waitMs: 0 }, requester);

/** This coordinator's measured speed for calls the probe's size on 1.5b CPU hosts (run 6: they ran past the deadline). */
function slowSamples(promptTokens: number, outputTokens: number, speed = 2) {
  const work = eta.callWorkMs(MODEL, "cpu", promptTokens, outputTokens);
  for (let i = 0; i < 3; i++) eta.serviceTimes.record(MODEL, "cpu", work * speed, Date.now(), work);
}

const peerWorld = (computeClass: string, tokensPerSec: number | null) => [{
  linkRttMs: 90,
  world: {
    coordinator: { id: "coord-peer-eu", url: "https://eu.coord.example", region: "fra", country: "DE", continent: "EU", agents: 1, agentsOnline: 1 },
    links: [],
    generatedAtMs: Date.now(),
    agents: [{ agentId: "eu-host", ownerTag: null, lastSeenMs: Date.now(), id: "abcdef0123", label: "lin-•••0123", os: "linux", region: "fra", country: "DE", continent: "EU", computeClass, tier: null, vramGb: null, models: [MODEL], modelsTotal: 1, activeModel: MODEL, status: "idle", slots: 2, slotsUsed: 0, coordinatorId: "coord-peer-eu", rttMs: 12, perf: { contextWindow: null, tokensPerSec, reliability: null, verified: true, freeSlots: 2, failRate: null, tierWeight: 1 }, activity: { callsNow: 0, streaming: 0, callsPerMin: 0 } }],
  },
}];

beforeEach(async () => {
  routing.setPeerWorldSource(undefined);
  delete process.env.INFERENCE_COMPLETION_PRIOR_SPEED;
  await drain();
  eta.serviceTimes.clear();
  eta.decodeRates.clear();
  eta.prefillRates.clear();
  eta.modelPickups.clear();
});

describe("1. redirects check completion at both ends", () => {
  test("sender: no host here can finish the probe and the peer's free host would not either: 503 at once, not route_elsewhere (12a98450, 2d30f9ec)", async () => {
    slowSamples(promptTokensOf(probe()), 300);
    routing.setPeerWorldSource(async () => peerWorld("cpu", null));
    const before = creditEngine.balance(requester.peerId);
    for (let i = 0; i < 3; i++) {
      const { r, ms } = await submit({ ...probe(), routeRedirect: true, clientRegion: "iad" });
      expect(r.statusCode, r.body).toBe(503);
      expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
      expect(ms).toBeLessThan(2_000);
    }
    expect(creditEngine.balance(requester.peerId)).toBe(before);
  });

  test("sender: a peer whose free host would finish it in time still gets it", async () => {
    slowSamples(promptTokensOf(probe()), 300);
    routing.setPeerWorldSource(async () => peerWorld("gpu", 400));
    const { r } = await submit({ ...probe(), routeRedirect: true, clientRegion: "iad" });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "route_elsewhere", coordinatorUrl: "https://eu.coord.example", reason: "completion_eta" });
  });

  test("peerCompletionMs: the slower of the peer's advertised speed and this coordinator's measured one", async () => {
    const locality = await import("../../src/swarm/coordinator/locality.js");
    const a = routing.peerAgentViews(peerWorld("cpu", null), Date.now())[0];
    const fit = { promptTokens: promptTokensOf(probe()), outputTokens: 300, limitMs: 162_000 };
    const advertised = locality.peerCompletionMs(a, MODEL, fit);
    expect(advertised).toBeLessThan(162_000); // the class default says it would finish...
    slowSamples(fit.promptTokens, 300);
    expect(locality.peerCompletionMs(a, MODEL, fit)).toBeGreaterThan(162_000); // ...what was measured here says not
  });

  test("receiver: a redirected call gets no exploration (EU 52ddd004, ce81590e, c31fb636)", async () => {
    // EU judged the 1.5b CPU class on its prior alone, nothing in flight: an estimate between the
    // completion limit (162 s) and the timeout (180 s) is let in once to learn the class's speed.
    const work = eta.callWorkMs(MODEL, "cpu", promptTokensOf(probe()), 300);
    process.env.INFERENCE_COMPLETION_PRIOR_SPEED = `cpu=${(170_000 / work).toFixed(6)}`;
    const before = creditEngine.balance(requester.peerId);
    const sent = await submit({ ...probe(), redirected: true });
    expect(sent.r.statusCode, sent.r.body).toBe(503);
    expect(sent.r.json()).toMatchObject({ error: "no_capacity", reason: "busy", limitMs: 162_000 });
    expect(sent.ms).toBeLessThan(2_000);
    expect(creditEngine.balance(requester.peerId)).toBe(before);
    // The same call submitted here first is still let in (exploration), as before.
    const own = await submit(probe());
    expect(own.r.statusCode, own.r.body).toBe(200);
  });
});

describe("2. Auto re-placement applies the completion gate on the time left (b8995549)", () => {
  const LONG = Array.from({ length: 120 }, (_, i) => `test("case ${i}", () => expect(add(${i}, 1)).toBe(${i + 1}));`).join("\n");
  const tests = () => ({ model: MODEL, maxTokens: 1_024, computeClass: "cpu", messages: [{ role: "user", content: `Write more unit tests like these:\n${LONG}` }] });
  const placement = (taskId: string, subtaskId: string, body: ReturnType<typeof tests>) => ({
    taskId, subtaskId, accountId: requester.peerId, tried: [lhr.peerId], clientRegion: null,
    job: describeJob({ messages: body.messages as any, maxTokens: body.maxTokens }, {}, routing.complexityWeights),
  });

  // Run 7: these hosts decode fast enough for the reply (the 1.5b CPU decode prior alone would refuse it at submit).
  const fastDecode = () => {
    for (let i = 0; i < 3; i++) eta.decodeRates.record(MODEL, "cpu", 40);
    for (let i = 0; i < 3; i++) eta.prefillRates.record(MODEL, "cpu", 400);
  };

  test("nothing would finish it and its placement would not either: refused now, refunded", async () => {
    fastDecode();
    const body = tests();
    const before = creditEngine.balance(requester.peerId);
    const call = await submit(body);
    expect(call.r.statusCode, call.r.body).toBe(200);
    // Not picked up; meanwhile calls this size were measured on the 1.5b CPU hosts far past the limit.
    slowSamples(promptTokensOf(body), 1_024, 3);
    const out = await autoReplace.replaceUnclaimedAuto(placement(call.taskId, call.r.json().subtaskId, body));
    expect(out).toBe("refused");
    const r = await read(call.taskId, call.r.json().subtaskId);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(creditEngine.balance(requester.peerId)).toBe(before);
  });

  test("a candidate that would finish in the time left is still taken", async () => {
    fastDecode();
    const body = tests();
    const call = await submit(body);
    expect(call.r.statusCode, call.r.body).toBe(200);
    slowSamples(promptTokensOf(body), 1_024, 0.1);
    const out = await autoReplace.replaceUnclaimedAuto(placement(call.taskId, call.r.json().subtaskId, body));
    expect(["same", "replaced"]).toContain(out);
  });
});

describe("3. a waiting call that cannot start in time is answered in ≤ 2 s, not at the 45 s bound", () => {
  async function fillBothHosts() {
    const fillers: Array<{ k: PeerKeys; taskId: string; id: string }> = [];
    for (const k of [lhr, fra]) {
      const f = await submit({ ...lookup(), clientRegion: k === lhr ? "lhr" : "fra" });
      expect(f.r.statusCode, f.r.body).toBe(200);
    }
    for (let i = 0; i < 4 && fillers.length < 2; i++) {
      for (const k of [lhr, fra]) {
        if (fillers.some((f) => f.k === k)) continue;
        const r = await pullAs(k, 1, 1);
        if (r.id && r.taskId) fillers.push({ k, taskId: r.taskId, id: r.id });
      }
      if (fillers.length < 2) await new Promise((r) => setTimeout(r, 1_100));
    }
    expect(fillers).toHaveLength(2);
    return fillers;
  }

  test("submit: the model has been saturated with slots held long (pickups slower than the claim bound): 503 at once", async () => {
    const fillers = await fillBothHosts();
    eta.modelPickups.clear();
    eta.modelPickups.noteSaturated(MODEL, true, Date.now() - 30_000);
    const before = creditEngine.balance(requester.peerId);
    const { r, ms } = await submit(lookup());
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(r.json().startEtaMs).toBeGreaterThan(45_000);
    expect(ms).toBeLessThan(2_000);
    expect(creditEngine.balance(requester.peerId)).toBe(before);
    for (const f of fillers) await finish(f.k, f.taskId, f.id);
  });

  test("sweep: a call accepted before the stall was known is ended as soon as it is (refunded)", async () => {
    const fillers = await fillBothHosts();
    eta.modelPickups.clear();
    const before = creditEngine.balance(requester.peerId);
    const waiting = await submit(lookup());
    expect(waiting.r.statusCode, waiting.r.body).toBe(200);
    // Nothing is picked up for 30 s with every slot held.
    eta.modelPickups.clear();
    eta.modelPickups.noteSaturated(MODEL, true, Date.now() - 30_000);
    await inference.sweepWaitingInference(Date.now());
    const r = await read(waiting.taskId, waiting.r.json().subtaskId);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(r.json().startEtaMs).toBeGreaterThan(40_000);
    expect(creditEngine.balance(requester.peerId)).toBe(before);
    expect(inference.WAITING_SWEEP_MS).toBeLessThanOrEqual(2_000);
    for (const f of fillers) await finish(f.k, f.taskId, f.id);
  });

  test("sweep: a call with a free slot for it, or a start in time, is left alone", async () => {
    const call = await submit(lookup());
    expect(call.r.statusCode).toBe(200);
    expect(await inference.sweepWaitingInference(Date.now())).toBe(0);
    const r = await read(call.taskId, call.r.json().subtaskId);
    expect(r.statusCode).toBe(200);
  });

  test("ModelPickups: the pickup rate over the saturated span", () => {
    const p = new ModelPickups();
    expect(p.etaMs("m", 1, 100_000)).toBeNull();
    p.noteSaturated("m", true, 100_000);
    expect(p.etaMs("m", 1, 102_000)).toBeNull(); // too short a span to tell (RATE_MIN_SPAN_MS)
    for (const t of [101_000, 106_000, 111_000]) p.record("m", t);
    // 3 pickups in 20 s: one every ~6.7 s.
    expect(p.etaMs("m", 3, 120_000)).toBe(20_000);
    p.noteSaturated("m", false, 121_000);
    expect(p.etaMs("m", 3, 140_000)).toBeNull();
  });
});

describe("4. an agent that keeps dropping out is not a best-fit candidate (eb25b92f)", () => {
  test("flapping: two or more silences within 10 min, until steady for 2 min", () => {
    resetAgentLiveness();
    noteAgentHttpAlive("m", 0);
    noteAgentHttpAlive("m", 5_000);
    noteAgentHttpAlive("m", 121_000); // one gap: a restart, still routable
    expect(agentFlapping("m", 121_000)).toBe(false);
    noteAgentHttpAlive("m", 160_000); // a second gap
    expect(agentFlapping("m", 160_000)).toBe(true);
    for (let t = 165_000; t <= 160_000 + FLAP_STEADY_MS; t += 5_000) noteAgentHttpAlive("m", t);
    expect(agentFlapping("m", 160_000 + FLAP_STEADY_MS)).toBe(false);
  });

  test("the maw Mac pattern: just back after repeated silences, it is stale for best fit and not capacity", async () => {
    const maw = createPeerKeys("agent-run6-maw");
    await register(maw, ["qwen2.5-coder:7b"]);
    const now = Date.now();
    for (const t of [now - 300_000, now - 250_000, now - 200_000]) noteAgentHttpAlive(maw.peerId, t);
    await pullAs(maw); // heard again now, 200 s after the last
    const views = routing.localAgentViews(Date.now());
    expect(views.find((v: { agentId: string }) => v.agentId === maw.peerId)?.stale).toBe(true);
    expect(views.find((v: { agentId: string }) => v.agentId === lhr.peerId)?.stale).toBe(false);
    expect(eta.modelHolders("qwen2.5-coder:7b", "any", 0).map((h: { agentId: string }) => h.agentId)).not.toContain(maw.peerId);
    const job = describeJob({ messages: [{ role: "user", content: "Write unit tests for add(a, b)." }], maxTokens: 1_024 }, { job: "tests" }, routing.complexityWeights);
    const { result } = await routing.resolveAuto(job, { requesterAccountId: requester.peerId });
    expect(result.chosen?.agentId).not.toBe(maw.peerId);
  });
});

describe("5. edgecoder.cut tells a deadline cut from a max_tokens cut (finish_reason stays length)", () => {
  async function* pieces(list: ChatPiece[], err?: Error): AsyncGenerator<ChatPiece> {
    for (const p of list) yield p;
    if (err) throw err;
  }

  test("max_tokens", async () => {
    const res = await openAiResponse(pieces([{ delta: "abc" }, { done: true, stopReason: "length" }]), "m");
    expect(res.choices[0].finish_reason).toBe("length");
    expect(res.edgecoder).toMatchObject({ cut: "max_tokens" });
  });

  test("deadline (the 3 × 181.6 s partial replies)", async () => {
    const deadline = new ChatBackendError("The machine running m reported: timed out after 180 s", 502, undefined, { code: DEADLINE_ERROR_CODE });
    const res = await openAiResponse(untilDeadline(pieces([{ delta: "partial" }], deadline)), "m");
    expect(res.choices[0].finish_reason).toBe("length");
    expect(res.edgecoder).toMatchObject({ cut: "deadline" });
  });

  test("a reply that stopped on its own says nothing", () => {
    expect(edgecoderUsage({ stopReason: "stop" })).toEqual({});
    expect(edgecoderUsage({ cSatsSpent: 1, stopReason: "stop" }).edgecoder?.cut).toBeUndefined();
  });
});
