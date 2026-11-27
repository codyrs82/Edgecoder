import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";

/*
 * Network validation run 24 (services ff738583): this coordinator plays the EU one (CPU hosts and a
 * Mac, no cloud host). Its peers: the US platform coordinator (a cloud host and an iad CPU host, free)
 * and two outside coordinators that cannot bill a call (edgecoder-coord-sin.fly.dev,
 * edgecoder-coord3-jnb on Azure), each with a free CPU host.
 * (Harness as in run11/run12-overflow.test.ts; the run-11 notes below are kept for its setup.)
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

const MESH = "mesh-secret-run24";
const REMOTE = "203.0.113.124";
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
let inference: any;
const requester = createPeerKeys("agent-run24-requester");
const lhr = createPeerKeys("agent-run24-lhr");
const fra = createPeerKeys("agent-run24-fra");
const cloud = createPeerKeys("agent-run24-cloud");
const mac = createPeerKeys("agent-run24-mac");
const MAC_MODEL = "qwen3.5:9b";
const MAC_PROFILE = { cpuCores: 12, cpuModel: "Apple M3 Max", ramGb: 64, arch: "arm64", platform: "darwin", gpu: { vendor: "apple", model: "Apple M3 Max", vramGb: 64, datacenter: false } };

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
  inference = await import("../../src/swarm/coordinator/routes/inference.js");
  await app.ready();
  dispatch.setNudgeTransport({ connected: () => true, send: () => true });
  await register(requester, "token-host", { installedModels: [] });
  await register(lhr, "token-host", { installedModels: [MODEL], region: "lhr" });
  await register(fra, "token-host", { installedModels: [MODEL], region: "fra" });
  await register(mac, "token-host", { installedModels: [MAC_MODEL], region: "iad", hardwareProfile: MAC_PROFILE });
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
    for (const [k, model, slots] of [[lhr, MODEL, 1], [fra, MODEL, 1], [mac, MAC_MODEL, 2]] as const) {
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





const US_URL = "https://us.coord.example";
const SIN_URL = "https://edgecoder-coord-sin.fly.dev";
const JNB_URL = "https://edgecoder-coord3-jnb.southafricanorth.cloudapp.azure.com";
const agentRow = (agentId: string, coordinatorId: string, region: string, computeClass: string, models: string[], free: number, slots = 1) => ({
  agentId, ownerTag: null, lastSeenMs: Date.now(), id: `${agentId}-mask`, label: agentId, os: "linux", region, country: null, continent: null, computeClass, tier: null, vramGb: null,
  models, modelsTotal: models.length, activeModel: models[0], status: "idle", slots, slotsUsed: slots - free, coordinatorId, rttMs: 12,
  perf: { contextWindow: null, tokensPerSec: null, reliability: null, verified: true, freeSlots: free, failRate: null, tierWeight: 1 }, activity: { callsNow: 0, streaming: 0, callsPerMin: 0 },
});
const world = (id: string, url: string, region: string, agents: unknown[]) => ({ linkRttMs: 90, world: { coordinator: { id, url, region, country: null, continent: null, agents: agents.length, agentsOnline: agents.length }, links: [], generatedAtMs: Date.now(), agents } });
/** As in the run: the US CPU hosts busy, its cloud host 16/16 free; the outside coordinators' CPU hosts free. */
const peers = (usFree = true, usCpu = false) => [
  world("coord-peer-us", US_URL, "ord", usFree ? [agentRow("us-cloud", "coord-peer-us", "ord", "cloud", [CLOUD_MODEL], 16, 16), ...(usCpu ? [agentRow("us-iad", "coord-peer-us", "iad", "cpu", [MODEL], 1)] : [])] : []),
  world("coord-outside-sin", SIN_URL, "sin", [agentRow("sin-host", "coord-outside-sin", "sin", "cpu", [MODEL], 1)]),
  world("coord-outside-jnb", JNB_URL, "jnb", [agentRow("jnb-host", "coord-outside-jnb", "jnb", "cpu", [MODEL], 1)]),
];

/** Read until the call ends. */
async function ended(taskId: string, subtaskId: string) {
  let r = await read(taskId, subtaskId);
  for (let i = 0; i < 150 && r.statusCode === 200 && !r.json().done; i++) {
    await sleep(10);
    r = await read(taskId, subtaskId);
  }
  return r;
}
const longPrompt = () => {
  const doc = Array.from({ length: 120 }, (_, i) => `Paragraph ${i}: the quarterly report notes revenue moved ${i % 7} percent while costs held steady (${randomUUID()}).`).join("\n");
  return [{ role: "user", content: `Summarize this document in a few paragraphs:\n${doc}` }];
};
const outside = [SIN_URL, JNB_URL];

describe("run 24: billed calls go only to peers that can bill them", () => {
  beforeEach(() => {
    // The platform's own coordinators are in the allowlist; the outside ones are not (and the registry lists none here).
    ctx.MESH_PEER_ALLOWLIST.set("coord-peer-us", []);
  });
  afterEach(() => {
    ctx.MESH_PEER_ALLOWLIST.delete("coord-peer-us");
    routing.setPeerWorldSource(undefined);
  });

  test("the notion: the platform peer bills, the outside ones do not", () => {
    expect(ctx.peerMayBillCalls("coord-peer-us")).toBe(true);
    expect(ctx.peerMayBillCalls("coord-outside-sin")).toBe(false);
    expect(ctx.peerMayBillCalls("coord-outside-jnb")).toBe(false);
  });

  test("inf-1795797527305-86c452c3: long-prompt Auto from an lhr buyer goes to the US, never to jnb-azure (was: 503 at 0.99 s, redirect to jnb not followed)", async () => {
    delete process.env.INFERENCE_COMPLETION_PRIOR_SPEED;
    routing.setPeerWorldSource(async () => peers());
    try {
      await post("/pull", { agentId: mac.peerId, inferenceSlots: 2, freeInferenceSlots: 0, cpuThrottled: true, cpuStealShare: 0.8, wake: true }, mac);
      const c = await submit({ model: "auto", maxTokens: 300, timeoutMs: 180_000, routeRedirect: true, clientRegion: "lhr", messages: longPrompt() });
      expect(c.r.statusCode, c.r.body).toBe(409);
      expect(c.r.json()).toMatchObject({ error: "route_elsewhere", coordinatorUrl: US_URL });
    } finally {
      process.env.INFERENCE_COMPLETION_PRIOR_SPEED = "off";
      (await import("../../src/swarm/coordinator/host-steal.js")).clearAgentSteal();
      await pull(mac, 2);
    }
  });

  for (const [id, region] of [["inf-1795797575311-5691e32b", "fra"], ["inf-1795797643137-9d8edb59", "lhr"]] as const) {
    test(`${id}: a burst ${region} buyer's Auto call not claimed here is handed to the US, never to sin-fly`, async () => {
      routing.setPeerWorldSource(async () => peers());
      const c = await submitAuto({ routeRedirect: true, clientRegion: region });
      expect(c.r.statusCode, c.r.body).toBe(200);
      for (const [k, slots] of [[lhr, 1], [fra, 1], [mac, 2]] as const) expect((await pull(k, slots, 0)).id).toBeNull();
      const r = await ended(c.taskId, c.subtaskId);
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ reason: "elsewhere", coordinatorUrl: US_URL });
      for (const [k, slots] of [[lhr, 1], [fra, 1], [mac, 2]] as const) await pull(k, slots);
    });
  }

  test("only outside coordinators have room: named and Auto calls are never pointed at them (refused here)", async () => {
    routing.setPeerWorldSource(async () => peers(false));
    for (const [k, slots] of [[lhr, 1], [fra, 1], [mac, 2]] as const) expect((await pull(k, slots, 0)).id).toBeNull();
    const named = await submit({ model: MODEL, routeRedirect: true, clientRegion: "sin" });
    expect(outside).not.toContain(named.r.json().coordinatorUrl);
    const auto = await submitAuto({ routeRedirect: true, clientRegion: "sin" });
    expect(outside).not.toContain(auto.r.json().coordinatorUrl);
    if (auto.r.statusCode === 200) {
      const r = await ended(auto.taskId, auto.subtaskId);
      expect(outside).not.toContain(r.json().coordinatorUrl);
    }
    for (const [k, slots] of [[lhr, 1], [fra, 1], [mac, 2]] as const) await pull(k, slots);
  });

  test("a named call with no slot here goes to the US platform host, not the nearer outside one (sin buyer)", async () => {
    routing.setPeerWorldSource(async () => peers(true, true));
    for (const [k, slots] of [[lhr, 1], [fra, 1], [mac, 2]] as const) expect((await pull(k, slots, 0)).id).toBeNull();
    const named = await submit({ model: MODEL, routeRedirect: true, clientRegion: "sin" });
    expect(named.r.statusCode, named.r.body).toBe(409);
    expect(named.r.json()).toMatchObject({ error: "route_elsewhere", coordinatorUrl: US_URL });
    for (const [k, slots] of [[lhr, 1], [fra, 1], [mac, 2]] as const) await pull(k, slots);
  });
});
