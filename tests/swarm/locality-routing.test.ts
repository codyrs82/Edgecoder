import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";

/*
 * #526 (real coordinator app, Fastify inject): a named-model call is first offered to the free host
 * nearest the buyer (the region the portal passes, or the request's edge headers); a busy near host
 * does not hold it. /inference/models says where the free slots are, for the portal's coordinator
 * choice. A named model with no free slot here that a peer coordinator has free is answered with
 * route_elsewhere when the caller allows it, before anything is reserved.
 */

const MESH = "mesh-secret-locality";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.50";
const MODEL = "qwen-near:1.5b";
const PEER_ONLY = "qwen-peer-only:7b";
let portal: Server;
let app: any;
let routing: any;
let dispatch: any;
let locality: any;
const requester = createPeerKeys("agent-locality-requester");
const syd = createPeerKeys("agent-locality-syd");
const iad = createPeerKeys("agent-locality-iad");

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
  process.env.COORDINATOR_STARTUP_GRACE_MS = "0"; // a model nobody holds is refused at once (no restart grace here)
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  routing = await import("../../src/swarm/coordinator/routing.js");
  dispatch = await import("../../src/swarm/coordinator/dispatch.js");
  locality = await import("../../src/swarm/coordinator/locality.js");
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
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, timeoutMs: 60_000, messages: [{ role: "user", content: "hi" }], ...body }, requester);
  return { taskId, r };
};
const finish = async (k: PeerKeys, taskId: string, subtaskId: string) => {
  expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 3, outputTokens: 1 }, k)).statusCode).toBe(200);
  expect((await post("/result", { subtaskId, taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model: MODEL }, k)).statusCode).toBe(200);
};

describe("named-model locality", () => {
  test("the free host nearest the buyer gets the call first", async () => {
    for (const k of [syd, iad]) expect(await pull(k)).toBeNull();
    for (const [region, near, far] of [["syd", syd, iad], ["iad", iad, syd], ["cc-au", syd, iad]] as const) {
      const { taskId, r } = await submit({ clientRegion: region });
      expect(r.statusCode, r.body).toBe(200);
      const sub = r.json().subtaskId;
      expect(dispatch.preferredAgentFor(sub)).toBe(near.peerId);
      expect(await pull(far)).toBeNull();
      expect(await pull(near)).toBe(sub);
      await finish(near, taskId, sub);
    }
  });

  test("the buyer's region also comes from the edge headers", async () => {
    const taskId = `inf-${randomUUID()}`;
    const payload = JSON.stringify({ taskId, submitterAccountId: requester.peerId, model: MODEL, timeoutMs: 60_000, messages: [{ role: "user", content: "hi" }] });
    const signed = signRequest({ method: "POST", path: "/inference/submit", bodyHash: hashRequestBody(payload), privateKeyPem: requester.privateKeyPem, agentId: requester.peerId }) as unknown as Record<string, string>;
    const r = await app.inject({ method: "POST", url: "/inference/submit", remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, "fly-region": "syd", ...signed }, payload });
    expect(r.statusCode, r.body).toBe(200);
    expect(dispatch.preferredAgentFor(r.json().subtaskId)).toBe(syd.peerId);
    expect(await pull(syd)).toBe(r.json().subtaskId);
    await finish(syd, taskId, r.json().subtaskId);
  });

  test("a busy near host does not hold the call: the next nearest free one takes it", async () => {
    expect(await pull(syd, 0)).toBeNull(); // syd reports no free slot
    const { taskId, r } = await submit({ clientRegion: "syd" });
    const sub = r.json().subtaskId;
    expect(dispatch.preferredAgentFor(sub)).toBe(iad.peerId);
    expect(await pull(iad)).toBe(sub);
    await finish(iad, taskId, sub);
    expect(await pull(syd)).toBeNull();
  });

  test("/inference/models says where the free slots are", async () => {
    const res = await app.inject({ method: "GET", url: "/inference/models", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
    const row = res.json().models.find((m: { model: string }) => m.model === MODEL);
    expect([...row.freeRegions].sort()).toEqual(["iad", "syd"]);
    // Each free host with its own numbers, for the portal's end to end score (coordinator-latency.ts).
    const hosts = [...row.freeHosts].sort((a: { region: string }, b: { region: string }) => a.region.localeCompare(b.region));
    expect(hosts.map((h: { region: string; free: number }) => [h.region, h.free])).toEqual([["iad", 2], ["syd", 2]]);
    for (const h of hosts) if (h.serviceMs !== undefined) expect(h.serviceMs).toBeGreaterThan(0);
  });

  test("a free host's reference-call time is its own speed, not how large its recent calls were", async () => {
    const eta = await import("../../src/swarm/coordinator/start-eta.js");
    const now = Date.now();
    const work = eta.callWorkMs(MODEL, "cpu", 1_000, 200);
    eta.agentServiceTimes.clear(); // the calls above left samples of their own
    // iad ran small calls at the estimate's speed; syd ran huge calls twice as slow per token.
    for (let i = 0; i < 3; i++) {
      eta.agentServiceTimes.record(MODEL, iad.peerId, 1_000, now, 1_000);
      eta.agentServiceTimes.record(MODEL, syd.peerId, 60_000, now, 30_000);
    }
    expect(eta.hostServiceMs(MODEL, iad.peerId, "cpu", now)).toBe(work);
    expect(eta.hostServiceMs(MODEL, syd.peerId, "cpu", now)).toBe(2 * work);
    const res = await app.inject({ method: "GET", url: "/inference/models", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
    const row = res.json().models.find((m: { model: string }) => m.model === MODEL);
    const byRegion = Object.fromEntries(row.freeHosts.map((h: { region: string; serviceMs?: number }) => [h.region, h.serviceMs]));
    expect(byRegion).toEqual({ iad: work, syd: 2 * work });
    // Run 6: also each host's class and speed, measured on its own calls, for the portal to scale to its call.
    const speeds = Object.fromEntries(row.freeHosts.map((h: { region: string; computeClass: string; speed: number; speedFrom: string }) => [h.region, [h.computeClass, h.speed, h.speedFrom]]));
    expect(speeds).toEqual({ iad: ["cpu", 1, "host"], syd: ["cpu", 2, "host"] });
    eta.agentServiceTimes.clear();
  });

  test("run 6: a host's speed says whether it is its own, its class's or the prior", async () => {
    const eta = await import("../../src/swarm/coordinator/start-eta.js");
    const now = Date.now();
    eta.agentServiceTimes.clear();
    eta.serviceTimes.clear();
    expect(eta.hostSpeed(MODEL, iad.peerId, "cpu", now)).toBeNull();
    expect(eta.hostSpeed(MODEL, iad.peerId, "cpu", now, 0.5)).toEqual({ speed: 0.5, from: "prior" });
    for (let i = 0; i < 3; i++) eta.serviceTimes.record(MODEL, "cpu", 300, now, 1_000);
    expect(eta.hostSpeed(MODEL, iad.peerId, "cpu", now, 0.5)).toEqual({ speed: 0.3, from: "class" });
    for (let i = 0; i < 3; i++) eta.agentServiceTimes.record(MODEL, iad.peerId, 200, now, 1_000);
    expect(eta.hostSpeed(MODEL, iad.peerId, "cpu", now, 0.5)).toEqual({ speed: 0.2, from: "host", ageMs: 0 });
    eta.agentServiceTimes.clear();
    eta.serviceTimes.clear();
  });
});

describe("a named model a peer coordinator has free", () => {
  const peerWorld = (freeSlots: number) => [{
    linkRttMs: 90,
    world: {
      coordinator: { id: "coord-peer-eu", url: "https://eu.coord.example", region: "fra", country: "DE", continent: "EU", agents: 1, agentsOnline: 1 },
      links: [],
      generatedAtMs: Date.now(),
      agents: [{ agentId: "eu-host", ownerTag: null, lastSeenMs: Date.now(), id: "abcdef0123", label: "lin-•••0123", os: "linux", region: "fra", country: "DE", continent: "EU", computeClass: "cpu", tier: null, vramGb: null, models: [PEER_ONLY, MODEL], modelsTotal: 2, activeModel: PEER_ONLY, status: "idle", slots: 2, slotsUsed: 0, coordinatorId: "coord-peer-eu", rttMs: 12, perf: { contextWindow: null, tokensPerSec: null, reliability: null, verified: true, freeSlots, failRate: null, tierWeight: 1 }, activity: { callsNow: 0, streaming: 0, callsPerMin: 0 } }],
    },
  }];

  test("is sent there before anything is reserved, only when the caller allows it", async () => {
    routing.setPeerWorldSource(async () => peerWorld(1));
    try {
      const before = creditEngine.balance(requester.peerId);
      // Run 6: only a call the peer's free host would finish in time (a 7b CPU host writes 64 tokens well within 54 s)...
      const redirected = await submit({ model: PEER_ONLY, routeRedirect: true, clientRegion: "lhr", maxTokens: 64 });
      expect(redirected.r.statusCode).toBe(409);
      expect(redirected.r.json()).toMatchObject({ error: "route_elsewhere", coordinatorId: "coord-peer-eu", coordinatorUrl: "https://eu.coord.example", model: PEER_ONLY });
      expect(creditEngine.balance(requester.peerId)).toBe(before);
      // ...not one it would not (1,024 tokens at a CPU host's ~6 tok/s is past the limit).
      expect((await submit({ model: PEER_ONLY, routeRedirect: true, clientRegion: "lhr" })).r.json().error).not.toBe("route_elsewhere");
      // Without routeRedirect: as before (no agent here has it).
      expect((await submit({ model: PEER_ONLY })).r.json().error).toBe("no_agent_has_model");
      // A model with a free slot here is not sent away.
      for (const k of [syd, iad]) expect(await pull(k)).toBeNull();
      const local = await submit({ routeRedirect: true });
      expect(local.r.statusCode, local.r.body).toBe(200);
      const sub = local.r.json().subtaskId;
      let holder: PeerKeys | null = null;
      for (const k of [syd, iad]) if (!holder && (await pull(k)) === sub) holder = k;
      if (!holder) {
        await new Promise((r) => setTimeout(r, 1_100));
        for (const k of [syd, iad]) if (!holder && (await pull(k)) === sub) holder = k;
      }
      expect(holder).not.toBeNull();
      await finish(holder!, local.taskId, sub);
    } finally {
      routing.setPeerWorldSource(undefined);
    }
  });

  test("a peer with no free slot either is not a reason to send the call away", async () => {
    routing.setPeerWorldSource(async () => peerWorld(0));
    try {
      expect((await submit({ model: PEER_ONLY, routeRedirect: true })).r.json().error).toBe("no_agent_has_model");
    } finally {
      routing.setPeerWorldSource(undefined);
    }
  });
});

describe("locality and warm models (network test run 2, B1)", () => {
  test("the preference outlasts dispatch's model-affinity deferral", () => {
    expect(locality.LOCALITY_PREFER_MS).toBeGreaterThan(dispatch.DEFER_MS);
  });

  test("a near host with the model installed wins over a far warm host unless it is known to be cold", () => {
    const near = { agentId: "iad", free: 2, slots: 2, region: "iad" };
    const farWarm = { agentId: "mac-ord", free: 2, slots: 2, region: "ord", warm: true };
    // Not reporting its loaded models (the Fly CPU hosts): never assumed cold.
    expect(locality.nearestFreeHolder([farWarm, near], "iad", MODEL)?.agentId).toBe("iad");
    expect(locality.nearestFreeHolder([farWarm, { ...near, warm: true }], "iad", MODEL)?.agentId).toBe("iad");
    // Known cold (reports loaded models, not this one, not served lately): the load outweighs ~1,000 km.
    expect(locality.nearestFreeHolder([farWarm, { ...near, cold: true }], "iad", MODEL)?.agentId).toBe("mac-ord");
    // Known cold but nobody has it warm: distance decides.
    expect(locality.nearestFreeHolder([{ ...farWarm, warm: false }, { ...near, cold: true }], "iad", MODEL)?.agentId).toBe("iad");
  });
});

