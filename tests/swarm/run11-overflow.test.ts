import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";

/*
 * Network validation run 11 (main 1cbfb1c1), each test replays a sequence from the run-11 logs:
 *
 * 1. Two bursts of 20 simple Auto calls (max_tokens 1024): 14 refused "every machine that runs
 *    qwen2.5-coder:1.5b is busy" while the cloud host had 16/16 free. All 14 had been sent by the US
 *    coordinator to the EU one (route_elsewhere: its own 1.5b hosts were full, the EU view still showed
 *    lhr/fra free for every call of the burst), and the EU coordinator has no cloud host. Also: a
 *    re-placement asked best fit with hosts free by count that could not start the call, which kept
 *    the cloud out (cloudConsidered), and the cloud was never tried past the decision bound.
 * 2. Refusals took 2.0-3.5 s at the coordinator (3.44 s at the portal): the decision window is 1.5 s now.
 * 3. inf-1795652230416-401ddacd: "preferredHolding=true reason=preference_lapsed waited=116ms": fra
 *    (preferred) had just taken another call; lhr pulled and took fra's buyer's call, not the lhr
 *    buyer's call held for it, which waited and was refused.
 */

const MESH = "mesh-secret-run11";
const REMOTE = "203.0.113.111";
const MODEL = "qwen2.5-coder:1.5b";
const CLOUD_MODEL = "deepseek-v4.1-flash";
const OWNER = "ops@edgecoder.io";
const TOKENS: Record<string, { ownerEmail: string; hostApproved: boolean }> = {
  "token-host": { ownerEmail: "host@example.com", hostApproved: true },
  "token-cloud": { ownerEmail: OWNER, hostApproved: true },
};
const DECISION_MS = 800;
let portal: Server;
let app: any;
let dispatch: any;
let ctx: any;
let routing: any;
let autoReplace: any;
let economy: any;
const requester = createPeerKeys("agent-run11-requester");
const lhr = createPeerKeys("agent-run11-lhr");
const fra = createPeerKeys("agent-run11-fra");
const cloud = createPeerKeys("agent-run11-cloud");

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const t = TOKENS[body.registrationToken as string];
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/internal/nodes/validate" && t) res.end(JSON.stringify({ allowed: true, reason: "ok", node: { nodeId: body.nodeId, ...t } }));
      else res.end(JSON.stringify({ allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = MESH;
  process.env.CLOUD_HOST_OWNER_EMAILS = OWNER;
  process.env.INFERENCE_COMPLETION_PRIOR_SPEED = "off";
  process.env.COORDINATOR_STARTUP_GRACE_MS = "0";
  process.env.INFERENCE_CLAIM_DECISION_MS = String(DECISION_MS);
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  dispatch = await import("../../src/swarm/coordinator/dispatch.js");
  ctx = await import("../../src/swarm/coordinator/context.js");
  routing = await import("../../src/swarm/coordinator/routing.js");
  autoReplace = await import("../../src/swarm/coordinator/auto-replace.js");
  economy = await import("../../src/swarm/coordinator/economy.js");
  await app.ready();
  dispatch.setNudgeTransport({ connected: () => true, send: () => true });
  await register(requester, "token-host", { installedModels: [] });
  await register(lhr, "token-host", { installedModels: [MODEL], region: "lhr" });
  await register(fra, "token-host", { installedModels: [MODEL], region: "fra" });
  await register(cloud, "token-cloud", { installedModels: [CLOUD_MODEL], hardwareProfile: { platform: "linux", arch: "x64", cpuCores: 2, ramGb: 2, cloud: { provider: "fireworks" } } });
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  dispatch?.setNudgeTransport(undefined);
  routing?.setPeerWorldSource(undefined);
  for (const k of ["COORDINATOR_STARTUP_GRACE_MS", "INFERENCE_CLAIM_DECISION_MS", "CLOUD_HOST_OWNER_EMAILS", "INFERENCE_COMPLETION_PRIOR_SPEED"]) delete process.env[k];
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

async function register(keys: PeerKeys, token: string, extra: Record<string, unknown>) {
  const payload = JSON.stringify({ os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: token, publicKeyPem: keys.publicKeyPem, sandboxMode: "docker", ...extra });
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
const pull = async (k: PeerKeys, slots = 1, free = slots) => {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: slots, freeInferenceSlots: free, wake: true }, k)).json();
  return { id: (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null, taskId: (r.subtask?.taskId ?? r.envelope?.taskId ?? null) as string | null };
};
const pullCloud = (free = 16) => pull(cloud, 16, free);
const submit = async (body: Record<string, unknown>) => {
  const taskId = `inf-${randomUUID()}`;
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, timeoutMs: 120_000, messages: [{ role: "user", content: `hi ${randomUUID()}` }], ...body }, requester);
  return { taskId, r, subtaskId: r.json().subtaskId as string };
};
const submitAuto = (body: Record<string, unknown> = {}) => submit({ model: "auto", maxTokens: 1024, ...body });
const finish = async (k: PeerKeys, taskId: string, subtaskId: string, model = MODEL) => {
  await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 3, outputTokens: 1 }, k);
  await post("/result", { subtaskId, taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model }, k);
};
const read = (taskId: string, subtaskId: string) => post("/inference/stream", { taskId, subtaskId, after: 0, waitMs: 0 }, requester);
/** The host stopped pulling 8 s ago with its slot free by its last report (busy hosts do not pull): free by count, cannot claim now. */
const stalePull = (k: PeerKeys) => dispatch.noteAgentPull(k.peerId, { inferenceSlots: 1, freeInferenceSlots: 1, wake: true }, Date.now() - 8_000);

async function drain() {
  for (let i = 0; i < 32; i++) {
    let any = false;
    for (const [k, model, slots] of [[lhr, MODEL, 1], [fra, MODEL, 1], [cloud, CLOUD_MODEL, 16]] as const) {
      const r = await pull(k, slots);
      if (!r.id || !r.taskId) continue;
      any = true;
      await finish(k, r.taskId, r.id, model);
    }
    if (!any) break;
  }
}

/** Pull as `k` every 50 ms until it gets a call (or `ms` passes). */
async function pullUntil(k: PeerKeys, slots: number, ms: number): Promise<{ id: string | null; taskId: string | null; afterMs: number }> {
  const t0 = Date.now();
  for (;;) {
    const r = await pull(k, slots);
    if (r.id || Date.now() - t0 > ms) return { ...r, afterMs: Date.now() - t0 };
    await sleep(50);
  }
}

beforeEach(async () => {
  routing.setPeerWorldSource(undefined);
  routing.clearPeerRedirects();
  await drain();
});

describe("run 11, 1: simple Auto calls overflow to the cloud when no CPU host can start them", () => {
  test("at idle a simple call stays off the cloud, and its reserve covers the cloud's worst case", async () => {
    const c = await submitAuto();
    expect(c.r.statusCode, c.r.body).toBe(200);
    expect(c.r.json().model).toBe(MODEL);
    const st = ctx.queue.getSubtask(c.subtaskId);
    const worst = economy.inferenceCallReserve({ model: CLOUD_MODEL, taskClass: "cloud", timeoutMs: 120_000, inputBytes: Buffer.byteLength(st.input, "utf8"), maxTokens: 1024 });
    const own = economy.inferenceCallReserve({ model: MODEL, taskClass: "cpu", timeoutMs: 120_000, inputBytes: Buffer.byteLength(st.input, "utf8"), maxTokens: 1024 });
    // As in the run: the 1.5b reserve alone does not cover the cloud call.
    expect(worst.reserveMsat).toBeGreaterThan(own.reserveMsat);
    expect(ctx.taskBilling.get(c.taskId).reservedMsat).toBe(worst.reserveMsat);
    // A CPU host takes it; the cloud is not offered it.
    expect((await pullCloud()).id).toBeNull();
  });

  test("its CPU host stops pulling (free by count, cannot claim): moved to the cloud at the first decision, not refused", async () => {
    const t0 = Date.now();
    const c = await submitAuto();
    expect(c.r.json().model).toBe(MODEL);
    // Every 1.5b host is busy and not pulling, though its last report showed a free slot (the burst).
    stalePull(lhr);
    stalePull(fra);
    const got = await pullUntil(cloud, 16, DECISION_MS * 3);
    expect(got.id).toBe(c.subtaskId);
    expect(Date.now() - t0).toBeLessThan(DECISION_MS * 1.5);
    expect(ctx.usagePending.get(c.taskId)?.model).toBe(CLOUD_MODEL);
    await finish(cloud, c.taskId, c.subtaskId, CLOUD_MODEL);
  });

  test("a free CPU host that may not take this call does not keep the cloud out of its re-placement", async () => {
    // Two slots each: room for this call even with it counted as waiting (best fit's queued share).
    expect((await pull(lhr, 2)).id).toBeNull();
    expect((await pull(fra, 2)).id).toBeNull();
    const t0 = Date.now();
    const c = await submitAuto({ maxTokens: 64 });
    expect(c.r.json().model).toBe(MODEL);
    // Both 1.5b hosts are free and pulling, but neither may take this call (taken back from them:
    // excluded). Before, best fit counted the one not yet tried as room, left the cloud out, and the
    // call was refused because that host could not claim it.
    ctx.queue.tasks.find((t: any) => t.subtask.id === c.subtaskId).excludeAgents = [lhr.peerId, fra.peerId];
    const got = await pullUntil(cloud, 16, DECISION_MS * 3);
    expect(got.id).toBe(c.subtaskId);
    expect(Date.now() - t0).toBeLessThan(DECISION_MS * 1.5);
    await finish(cloud, c.taskId, c.subtaskId, CLOUD_MODEL);
    for (const k of [lhr, fra]) await pull(k, 1);
  });

  test("past its move limit it still overflows to the cloud once before a refusal", async () => {
    const c = await submitAuto();
    expect(c.r.json().model).toBe(MODEL);
    autoReplace.autoPlacementOf(c.subtaskId).replaced = autoReplace.AUTO_REPLACE_MAX;
    expect((await pull(lhr, 1, 0)).id).toBeNull();
    expect((await pull(fra, 1, 0)).id).toBeNull();
    const got = await pullUntil(cloud, 16, DECISION_MS * 3);
    expect(got.id).toBe(c.subtaskId);
    await finish(cloud, c.taskId, c.subtaskId, CLOUD_MODEL);
  });

  test("the cloud full too: refused at the first decision (503 busy, nothing charged), no extension", async () => {
    const before = creditEngine.balance(requester.peerId);
    const t0 = Date.now();
    const c = await submitAuto();
    expect(c.r.json().model).toBe(MODEL);
    expect((await pull(lhr, 1, 0)).id).toBeNull();
    expect((await pull(fra, 1, 0)).id).toBeNull();
    expect((await pullCloud(0)).id).toBeNull();
    let r = await read(c.taskId, c.subtaskId);
    for (let i = 0; i < 60 && r.statusCode === 200 && !r.json().done; i++) {
      await sleep(50);
      r = await read(c.taskId, c.subtaskId);
    }
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(Date.now() - t0).toBeLessThan(DECISION_MS + 500);
    await sleep(50);
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
  });
});

describe("run 11, 1: a peer's free hosts are not counted twice for a burst", () => {
  const peerWorld = (freeSlots: number, generatedAtMs = Date.now()) => [{
    linkRttMs: 90,
    world: {
      coordinator: { id: "coord-peer-eu", url: "https://eu.coord.example", region: "fra", country: "DE", continent: "EU", agents: 1, agentsOnline: 1 },
      links: [],
      generatedAtMs,
      agents: [{ agentId: "eu-lhr", ownerTag: null, lastSeenMs: Date.now(), id: "abcdef0123", label: "lin-•••0123", os: "linux", region: "lhr", country: "GB", continent: "EU", computeClass: "cpu", tier: null, vramGb: null, models: [MODEL], modelsTotal: 1, activeModel: MODEL, status: "idle", slots: 1, slotsUsed: 0, coordinatorId: "coord-peer-eu", rttMs: 12, perf: { contextWindow: null, tokensPerSec: null, reliability: null, verified: true, freeSlots, failRate: null, tierWeight: 1 }, activity: { callsNow: 0, streaming: 0, callsPerMin: 0 } }],
    },
  }];

  test("a peer agent's free slot is spoken for by the Auto call sent to it until its view shows the call", () => {
    const now = Date.now();
    const free = () => routing.peerAgentViews(peerWorld(1, now - 5_000), now).find((a: any) => a.agentId === "eu-lhr").freeSlots;
    expect(free()).toBe(1);
    // Sent before the view was built (and its round trip): already in the view.
    routing.notePeerRedirect("eu-lhr", now - 7_000);
    expect(free()).toBe(1);
    routing.notePeerRedirect("eu-lhr", now - 100);
    expect(free()).toBe(0);
    // Never past PEER_REDIRECT_DEBIT_MS, however old the view.
    expect(routing.peerAgentViews(peerWorld(1, now - 60_000), now + routing.PEER_REDIRECT_DEBIT_MS).find((a: any) => a.agentId === "eu-lhr").freeSlots).toBe(1);
  });

  test("the burst: the first call goes to the peer's free host, the next to the cloud here (was: every call sent to the peer, refused there)", async () => {
    routing.setPeerWorldSource(async () => peerWorld(1));
    // This coordinator's 1.5b hosts are full; the cloud host is free.
    expect((await pull(lhr, 1, 0)).id).toBeNull();
    expect((await pull(fra, 1, 0)).id).toBeNull();
    expect((await pullCloud()).id).toBeNull();
    const first = await submitAuto({ routeRedirect: true, clientRegion: "lhr" });
    expect(first.r.statusCode, first.r.body).toBe(409);
    expect(first.r.json()).toMatchObject({ error: "route_elsewhere", coordinatorId: "coord-peer-eu" });
    const second = await submitAuto({ routeRedirect: true, clientRegion: "lhr" });
    expect(second.r.statusCode, second.r.body).toBe(200);
    expect(second.r.json().model).toBe(CLOUD_MODEL);
    expect((await pullCloud()).id).toBe(second.subtaskId);
    await finish(cloud, second.taskId, second.subtaskId, CLOUD_MODEL);
  });
});

describe("run 11, 1: a long prompt no CPU host would finish in time", () => {
  test("Auto sends it to the cloud host (not a 503); a named call keeps its clean 503", async () => {
    delete process.env.INFERENCE_COMPLETION_PRIOR_SPEED; // the default priors judge the CPU class
    try {
      const module = Array.from({ length: 150 }, (_, i) => `function z${i}(a, b) { const r = a * ${2499 + i} + b - ${(i * 5) % 13}; return r > ${i} ? r : b; }`).join("\n");
      const messages = [{ role: "user", content: `Here is a module:\n${module}\nWrite a long, detailed explanation of every function in this module, one paragraph each, in order.` }];
      const named = await submit({ model: MODEL, maxTokens: 2_000, timeoutMs: 180_000, messages });
      expect(named.r.statusCode, named.r.body).toBe(503);
      const auto = await submit({ model: "auto", maxTokens: 2_000, timeoutMs: 180_000, messages });
      expect(auto.r.statusCode, auto.r.body).toBe(200);
      expect(auto.r.json().model).toBe(CLOUD_MODEL);
      expect((await pullCloud()).id).toBe(auto.subtaskId);
      await finish(cloud, auto.taskId, auto.subtaskId, CLOUD_MODEL);
    } finally {
      process.env.INFERENCE_COMPLETION_PRIOR_SPEED = "off";
    }
  });
});

describe("run 11, 3: a host takes the call held for it before another host's", () => {
  test("inf-1795652230416-401ddacd: lhr pulls while fra (preferred, now full) holds the older call; lhr takes its own buyer's call", async () => {
    // Both EU hosts free, 1 slot each.
    const c0 = await submit({ model: MODEL, clientRegion: "fra" });
    const a = await submit({ model: MODEL, clientRegion: "fra" });
    const c2 = await submit({ model: MODEL, clientRegion: "lhr" });
    for (const c of [c0, a, c2]) expect(c.r.statusCode, c.r.body).toBe(200);
    expect(dispatch.preferredAgentFor(c0.subtaskId)).toBe(fra.peerId);
    expect(dispatch.preferredAgentFor(a.subtaskId)).toBe(fra.peerId);
    expect(dispatch.preferredAgentFor(c2.subtaskId)).toBe(lhr.peerId);
    // fra pulls first and takes its first call: it is full now.
    expect((await pull(fra)).id).toBe(c0.subtaskId);
    // lhr pulls: before, it took `a` (oldest; fra cannot take it now) and its own lhr buyer waited.
    expect((await pull(lhr)).id).toBe(c2.subtaskId);
    await finish(fra, c0.taskId, c0.subtaskId);
    expect((await pull(fra)).id).toBe(a.subtaskId);
    await finish(fra, a.taskId, a.subtaskId);
    await finish(lhr, c2.taskId, c2.subtaskId);
  });
});
