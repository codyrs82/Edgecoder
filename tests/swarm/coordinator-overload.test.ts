import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";

/*
 * C9 (network test run 3, real coordinator app, Fastify inject): a call that would not start here
 * within a share of its timeout (calls ahead / slots × typical service time) is answered
 * route_elsewhere to a peer with a free slot, or 503 no_capacity with Retry-After, before anything
 * is reserved. Calls with a slot left for them are accepted as before.
 */

const MESH = "mesh-secret-overload";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.50";
const MODEL = "qwen-overload:1.5b";
let portal: Server;
let app: any;
let routing: any;
let eta: any;
const requester = createPeerKeys("agent-overload-requester");
const syd = createPeerKeys("agent-overload-syd");
const iad = createPeerKeys("agent-overload-iad");

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
  process.env.COORDINATOR_STARTUP_GRACE_MS = "0"; // a model nobody holds is refused at once (no restart grace here)
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  routing = await import("../../src/swarm/coordinator/routing.js");
  eta = await import("../../src/swarm/coordinator/start-eta.js");
  await app.ready();
  await register(requester, []);
  await register(syd, [MODEL], "syd");
  await register(iad, [MODEL], "iad");
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pull = async (k: PeerKeys, free = 2) => {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: 2, freeInferenceSlots: free }, k)).json();
  return (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null;
};
const submit = async (body: Record<string, unknown>) => {
  const taskId = `inf-${randomUUID()}`;
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, timeoutMs: 120_000, messages: [{ role: "user", content: "hi" }], ...body }, requester);
  return { taskId, r };
};
const finish = async (k: PeerKeys, taskId: string, subtaskId: string) => {
  expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 3, outputTokens: 1 }, k)).statusCode).toBe(200);
  expect((await post("/result", { subtaskId, taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model: MODEL }, k)).statusCode).toBe(200);
};

const peerWorld = (freeSlots: number) => [{
  linkRttMs: 90,
  world: {
    coordinator: { id: "coord-peer-us", url: "https://us.coord.example", region: "iad", country: "US", continent: "NA", agents: 1, agentsOnline: 1 },
    links: [],
    generatedAtMs: Date.now(),
    agents: [{ agentId: "us-host", ownerTag: null, lastSeenMs: Date.now(), id: "abcdef0456", label: "lin-•••0456", os: "linux", region: "iad", country: "US", continent: "NA", computeClass: "cpu", tier: null, vramGb: null, models: [MODEL], modelsTotal: 1, activeModel: MODEL, status: "idle", slots: 2, slotsUsed: 0, coordinatorId: "coord-peer-us", rttMs: 12, perf: { contextWindow: null, tokensPerSec: null, reliability: null, verified: true, freeSlots, failRate: null, tierWeight: 1 }, activity: { callsNow: 0, streaming: 0, callsPerMin: 0 } }],
  },
}];

describe("start estimate (unit)", () => {
  test("zero while a slot is left, then rounds of the typical service time per slot", () => {
    expect(eta.startEtaMs({ waiting: 1, slots: 4, free: 4, typicalMs: 60_000 })).toBe(0);
    expect(eta.startEtaMs({ waiting: 4, slots: 4, free: 4, typicalMs: 60_000 })).toBe(15_000);
    expect(eta.startEtaMs({ waiting: 6, slots: 2, free: 0, typicalMs: 30_000 })).toBe(105_000);
    expect(eta.startEtaMs({ waiting: 6, slots: 2, free: 0, typicalMs: null })).toBeNull();
    expect(eta.startEtaMs({ waiting: 6, slots: 0, free: 0, typicalMs: 30_000 })).toBeNull();
  });

  test("the limit is a share of the timeout, never past the claim bound; 0 turns it off", () => {
    expect(eta.startEtaLimitMs(180_000, 0.5, 45_000)).toBe(45_000);
    expect(eta.startEtaLimitMs(60_000, 0.5, 45_000)).toBe(30_000);
    expect(eta.startEtaLimitMs(60_000, 0, 45_000)).toBe(Infinity);
  });

  test("service times: median of recent samples per model and class, none with too few", () => {
    const s = new eta.ServiceTimes();
    s.record("m", "cpu", 10_000, 0);
    s.record("m", "cpu", 30_000, 0);
    expect(s.typicalMs("m", "cpu", 0)).toBeNull();
    s.record("m", "cpu", 20_000, 0);
    s.record("m", "apple", 1_000, 0);
    expect(s.typicalMs("m", "cpu", 0)).toBe(20_000);
    expect(s.typicalMs("m", "any", 0)).toBe(15_000);
    expect(s.typicalMs("m", "cpu", eta.SERVICE_WINDOW_MS + 1)).toBeNull();
  });
});

describe("a burst larger than this coordinator can start in time", () => {
  test("normal load is accepted; the excess of a burst is sent to a free peer at once", async () => {
    for (const k of [syd, iad]) expect(await pull(k, 2)).toBeNull();
    eta.serviceTimes.clear();
    // Calls of this model hold a slot about a minute here (2 hosts × 2 slots).
    for (let i = 0; i < 3; i++) eta.serviceTimes.record(MODEL, "cpu", 60_000);
    routing.setPeerWorldSource(async () => peerWorld(2));
    try {
      const t0 = Date.now();
      const answers: Array<{ status: number; json: any }> = [];
      for (let i = 0; i < 12; i++) {
        const { r } = await submit({ routeRedirect: true });
        answers.push({ status: r.statusCode, json: r.json() });
      }
      expect(Date.now() - t0).toBeLessThan(10_000);
      // Normal load (a free slot each): accepted. The excess: route_elsewhere at once, nothing reserved.
      expect(answers.slice(0, 4).every((a) => a.status === 200)).toBe(true);
      for (const a of answers.slice(4)) {
        expect(a.status).toBe(409);
        expect(a.json).toMatchObject({ error: "route_elsewhere", coordinatorId: "coord-peer-us", coordinatorUrl: "https://us.coord.example", model: MODEL });
      }
    } finally {
      routing.setPeerWorldSource(undefined);
    }
  }, 30_000);

  test("past the start limit: route_elsewhere to a free peer, else 503 with Retry-After; nothing reserved", async () => {
    eta.serviceTimes.clear();
    for (let i = 0; i < 3; i++) eta.serviceTimes.record(MODEL, "cpu", 60_000);
    // 4 calls wait for 4 busy-soon slots. Without redirects (or a free peer) a call is kept while it
    // would start within the limit (min(0.5 × 120 s, the 45 s claim bound)): 15 s, 30 s, 45 s ahead.
    const kept: number[] = [];
    let refused: any;
    for (let i = 0; i < 6 && !refused; i++) {
      const { r } = await submit({});
      if (r.statusCode === 200) kept.push(i);
      else refused = r;
    }
    expect(kept).toEqual([0, 1, 2]);
    expect(refused.statusCode).toBe(503);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(refused.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(refused.json().startEtaMs).toBeGreaterThan(45_000);
    const before = creditEngine.balance(requester.peerId);
    // A peer with no free slot is no reason to send it there: still 503, at once.
    routing.setPeerWorldSource(async () => peerWorld(0));
    try {
      expect((await submit({ routeRedirect: true })).r.statusCode).toBe(503);
    } finally {
      routing.setPeerWorldSource(undefined);
    }
    // A free peer: route_elsewhere, saying why.
    routing.setPeerWorldSource(async () => peerWorld(2));
    try {
      const sent = (await submit({ routeRedirect: true })).r;
      expect(sent.statusCode).toBe(409);
      expect(sent.json()).toMatchObject({ error: "route_elsewhere", coordinatorId: "coord-peer-us" });
    } finally {
      routing.setPeerWorldSource(undefined);
    }
    expect(creditEngine.balance(requester.peerId)).toBe(before);
    // With no service times known there is no estimate: accepted as before.
    eta.serviceTimes.clear();
    expect((await submit({})).r.statusCode).toBe(200);
  }, 30_000);
});

/*
 * Run 4: calls that started in time but could not finish in time (a heavy prompt and a long reply on
 * 2-slot CPU hosts) ran to the 180 s deadline. Each service sample also gives the class's speed
 * (measured ÷ expectedWorkMs for its tokens); a call expected to finish past 0.9 × its timeout is not
 * given to a class that slow, and with no class here in time it goes to a peer or is refused (503),
 * before anything is reserved.
 */
describe("completion estimate (unit)", () => {
  test("speed: median of measured ÷ expected per model and class, none with too few", () => {
    const s = new eta.ServiceTimes();
    s.record("m", "cpu", 10_000, 0, 20_000);
    s.record("m", "cpu", 30_000, 0, 30_000);
    s.record("m", "cpu", 5_000, 0); // no tokens known: a service time, no speed
    expect(s.speed("m", "cpu", 0)).toBeNull();
    s.record("m", "cpu", 40_000, 0, 20_000);
    expect(s.speed("m", "cpu", 0)).toBe(1);
    expect(s.typicalMs("m", "cpu", 0)).toBe(20_000);
  });

  test("completion = start + speed × the call's work; the work grows with max_tokens and the prompt", () => {
    expect(eta.completionEtaMs({ startEtaMs: 10_000, speed: 0.5, workMs: 100_000 })).toBe(60_000);
    expect(eta.completionEtaMs({ startEtaMs: null, speed: 0.5, workMs: 100_000 })).toBe(50_000);
    expect(eta.completionEtaMs({ startEtaMs: 0, speed: null, workMs: 100_000 })).toBeNull();
    const short = eta.callWorkMs("q:1.5b", "cpu", 100, 256);
    expect(eta.callWorkMs("q:1.5b", "cpu", 100, 2_048)).toBeGreaterThan(short);
    expect(eta.callWorkMs("q:1.5b", "cpu", 20_000, 256)).toBeGreaterThan(short);
    expect(eta.completionLimitMs(180_000, 0.9)).toBe(162_000);
    expect(eta.completionLimitMs(180_000, 0)).toBe(Infinity);
  });

  test("a class over the limit is excluded; none in time when every class is over; unknown classes are not judged", () => {
    const cpu = { computeClass: "cpu", agents: ["c1", "c2"], startEtaMs: 0, completionEtaMs: 200_000 };
    const gpu = { computeClass: "gpu", agents: ["g1"], startEtaMs: 0, completionEtaMs: 20_000 };
    const apple = { computeClass: "apple", agents: ["a1"], startEtaMs: 0, completionEtaMs: null };
    expect(eta.judgeCompletion([cpu, gpu], 162_000)).toEqual({ exclude: ["c1", "c2"], none: false, etaMs: 20_000 });
    expect(eta.judgeCompletion([cpu], 162_000)).toEqual({ exclude: ["c1", "c2"], none: true, etaMs: 200_000 });
    expect(eta.judgeCompletion([cpu, apple], 162_000)).toMatchObject({ exclude: ["c1", "c2"], none: false });
    expect(eta.judgeCompletion([cpu], Infinity)).toEqual({ exclude: [], none: false, etaMs: null });
  });
});

describe("a call that would not finish here in time", () => {
  /** Calls of MODEL on this coordinator's CPU hosts run at `speed` × the slow-host estimate. */
  const measured = (speed: number) => {
    eta.serviceTimes.clear();
    for (let i = 0; i < 3; i++) eta.serviceTimes.record(MODEL, "cpu", 10_000, Date.now(), 10_000 / speed);
  };

  test("refused (503, completionEtaMs) or sent to a free peer, before anything is reserved; a short one is accepted", async () => {
    // The calls earlier tests left waiting are run, so this coordinator has free slots again.
    for (let i = 0; i < 64; i++) {
      const k = i % 2 ? syd : iad;
      const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: 2, freeInferenceSlots: 2 }, k)).json();
      const id = r.subtask?.id ?? r.envelope?.subtaskId;
      if (!id) {
        if (i > 2) break;
        continue;
      }
      await finish(k, r.subtask?.taskId ?? r.envelope?.taskId, id);
    }
    measured(0.2);
    const before = creditEngine.balance(requester.peerId);
    // 2,048 output tokens of a 1.5B model on these hosts: about 0.2 × 590 s, past 0.9 × 120 s.
    const refused = (await submit({ maxTokens: 4_096 })).r;
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.json()).toMatchObject({ error: "no_capacity", reason: "busy", limitMs: 108_000 });
    expect(refused.json().completionEtaMs).toBeGreaterThan(108_000);
    expect(refused.json().message).toContain("would finish");
    routing.setPeerWorldSource(async () => peerWorld(2));
    try {
      const sent = (await submit({ maxTokens: 4_096, routeRedirect: true })).r;
      expect(sent.statusCode, sent.body).toBe(409);
      expect(sent.json()).toMatchObject({ error: "route_elsewhere", coordinatorId: "coord-peer-us", reason: "completion_eta" });
    } finally {
      routing.setPeerWorldSource(undefined);
    }
    expect(creditEngine.balance(requester.peerId)).toBe(before);
    // A short reply fits: accepted.
    expect((await submit({ maxTokens: 256 })).r.statusCode).toBe(200);
    // Fast hosts: the long one fits too.
    measured(0.05);
    expect((await submit({ maxTokens: 4_096 })).r.statusCode).toBe(200);
    eta.serviceTimes.clear();
  }, 30_000);
});
