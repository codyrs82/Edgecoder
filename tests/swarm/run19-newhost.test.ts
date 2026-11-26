import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";

/*
 * Network validation run 19: a new Mac (desktop-maw-mb-02, apple, qwen2.5-coder 1.5b and 7b, 2 slots,
 * no region) joined mid-run; each test replays a sequence from the run-19 logs.
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

const MESH = "mesh-secret-run19";
const REMOTE = "203.0.113.119";
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
const requester = createPeerKeys("agent-run19-requester");
const lhr = createPeerKeys("agent-run19-lhr");
const fra = createPeerKeys("agent-run19-fra");
const cloud = createPeerKeys("agent-run19-cloud");
const mac = createPeerKeys("agent-run19-mac");
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
    for (const [k, model, slots] of [[lhr, MODEL, 1], [fra, MODEL, 1], [mac, MAC_MODEL, 2], [cloud, CLOUD_MODEL, 16]] as const) {
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





const maw = createPeerKeys("agent-run19-maw");
const MAW_MODEL = "qwen2.5-coder:7b";
/** A tentacle helper call (tools, at least 7B, a sizeable prompt), as inf-1795719570184-e99775d0. */
const helperCall = (maxCSats?: number) => {
  const doc = Array.from({ length: 110 }, (_, i) => `// line ${i}: function f${i}(a, b) { return a * ${i} + b; } ${randomUUID()}`).join("\n");
  const tools = ["read_file", "write_file", "edit_file", "run_tests"].map((name) => ({ type: "function", function: { name, description: `${name} tool`, parameters: { type: "object", properties: { path: { type: "string" } } } } }));
  return submit({ model: "auto", maxTokens: 3905, timeoutMs: 180_000, tools, routing: { job: "tests", complexity: 0.1, quality: "fast", latency: "batch", needsTools: true, minContext: 8192, minParamsB: 7, ...(maxCSats !== undefined ? { maxCSats } : {}), sessionId: `tentacle:${randomUUID()}` }, messages: [{ role: "user", content: `Write tests for this:\n${doc}` }] });
};
/** The two Macs poll without a socket (the run: socketConnected false); the Fly hosts and the cloud have one. */
const macsWithoutSocket = () => dispatch.setNudgeTransport({ connected: (id: string) => id !== mac.peerId && id !== maw.peerId, send: () => true });
const allSockets = () => dispatch.setNudgeTransport({ connected: () => true, send: () => true });

describe("run 19, 1: Auto calls and a new host that does not claim", () => {
  test("register the new Mac (apple, 7b and 1.5b, 2 slots, no region)", async () => {
    await register(maw, "token-host", { installedModels: [MAW_MODEL, MODEL], hardwareProfile: MAC_PROFILE });
    expect((await pull(maw, 2)).id).toBeNull();
  });

  test("inf-1795719570184-e99775d0: late in the window a move goes only to a host with a socket; the cloud takes it (was: moved to the new Mac, refused at 1.79 s)", async () => {
    macsWithoutSocket();
    try {
      for (const [k, slots] of [[mac, 2], [maw, 2]] as const) expect((await pull(k, slots)).id).toBeNull();
      const c = await helperCall(25);
      expect(c.r.statusCode, c.r.body).toBe(200);
      // The Macs last pulled a second ago ("ready": within 6 s), polling every few seconds.
      for (const k of [mac, maw]) dispatch.noteAgentPull(k.peerId, { inferenceSlots: 2, freeInferenceSlots: 2, wake: false }, Date.now() - 1_000);
      const p = autoReplace.autoPlacementOf(c.subtaskId);
      // As at 1.5 s in the run: the first host has not come, 0.3 s of the bound left (less than a quarter window).
      const now = Date.now();
      p.boundAt = now + Math.round(DECISION_MS * 0.2);
      p.decideBy = p.boundAt;
      p.graced = true;
      expect(await autoReplace.decideAuto(p, now)).toBe("replaced");
      // Not onto the other Mac (it polls without a socket and would not pull in time): the cloud.
      expect(p.tried.at(-1)).toBe(cloud.peerId);
      expect((await pullCloud()).id).toBe(c.subtaskId);
      await finish(cloud, c.taskId, c.subtaskId, CLOUD_MODEL);
    } finally {
      allSockets();
    }
  });

  test("a price ceiling under the cloud's cost: the refusal says so, with what the cloud needs (a helper then waits for room and sends it again)", async () => {
    // The Macs fit the ceiling but do not come; the cloud has room but costs more than the ceiling.
    const c = await submit({ model: "auto", maxTokens: 1024, routing: { minParamsB: 7, maxCSats: 0.2 } });
    expect(c.r.statusCode, c.r.body).toBe(200);
    expect(c.r.json().model).not.toBe(CLOUD_MODEL);
    for (const [k, slots] of [[mac, 2], [maw, 2]] as const) expect((await pull(k, slots, 0)).id).toBeNull();
    let r = await read(c.taskId, c.subtaskId);
    for (let i = 0; i < 120 && r.statusCode === 200 && !r.json().done; i++) {
      await sleep(10);
      r = await read(c.taskId, c.subtaskId);
    }
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "price" });
    expect(r.json().neededCSats).toBeGreaterThan(0.2);
    // The IDE turns it into a price refusal the tentacle helper retries on (tentacle-reserve.ts priceRefusalNeed).
    const { noCapacityError } = await import("../../src/apps/ide/network-inference.js");
    const { priceRefusalNeed } = await import("../../src/apps/ide/tentacle-reserve.js");
    expect(priceRefusalNeed(noCapacityError(r.json(), "auto"))).toBe(r.json().neededCSats);
  });
});

describe("run 19, 2: a host with no region", () => {
  test("its location is unknown (no km advantage), not this coordinator's region; the Fly edge region of its registration is used when there is one", async () => {
    expect(routing.agentRegionCode({})).toBeNull();
    expect(routing.agentRegionCode({ countryCode: "GB" })).toBe("GB");
    expect(routing.agentRegionCode({ inferredRegion: "lhr", countryCode: "GB" })).toBe("lhr");
    expect(routing.agentRegionCode({ region: "fra", inferredRegion: "lhr" })).toBe("fra");
    const agentState = await import("../../src/swarm/coordinator/agent-state.js");
    // The new Mac registered without a region and without a Fly edge header: unknown, so no locality preference.
    expect(agentState.agentCapabilities.get(maw.peerId)?.inferredRegion).toBeUndefined();
    const locality = await import("../../src/swarm/coordinator/locality.js");
    expect(locality.nearestFreeHolder([{ agentId: maw.peerId, free: 2, slots: 2, region: null }, { agentId: "lax", free: 1, slots: 1, region: "lax" }], "ord", MODEL)?.agentId).toBe("lax");
    // Registered through the gru edge: placed at gru.
    const viaLhr = createPeerKeys("agent-run19-maw-gru");
    const payload = JSON.stringify({ os: "macos", version: "1", mode: "swarm-only", agentId: viaLhr.peerId, registrationToken: "token-host", publicKeyPem: viaLhr.publicKeyPem, sandboxMode: "docker", installedModels: [MODEL], hardwareProfile: MAC_PROFILE });
    const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: viaLhr.privateKeyPem, agentId: viaLhr.peerId }) as unknown as Record<string, string>;
    const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", "fly-region": "gru", ...signed }, payload });
    expect(res.statusCode, res.body).toBe(200);
    expect(agentState.agentCapabilities.get(viaLhr.peerId)?.inferredRegion).toBe("gru");
    expect(routing.agentRegionCode(agentState.agentCapabilities.get(viaLhr.peerId))).toBe("gru");
  });

  test("a host that keeps failing is not offered to the portal as a free host (its speed estimate stops winning)", async () => {
    const viaLhr = createPeerKeys("agent-run19-maw-gru");
    expect((await pull(viaLhr, 2)).id).toBeNull();
    const freeHosts = async () => {
      const res = await app.inject({ method: "GET", url: "/inference/models", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
      const row = res.json().models.find((m: { model: string }) => m.model === MODEL);
      return ((row?.freeHosts ?? []) as Array<{ region: string }>).map((h) => h.region);
    };
    expect(await freeHosts()).toContain("gru");
    for (let i = 0; i < 4; i++) routing.noteAgentOutcome(viaLhr.peerId, false);
    expect(await freeHosts()).not.toContain("gru");
  });
});
