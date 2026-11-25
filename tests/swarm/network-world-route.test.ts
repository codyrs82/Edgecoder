import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { signMeshWsBind } from "../../src/mesh/ws-auth.js";

/*
 * GET /network/world and /network/world/local on the real coordinator app: who may ask, what is
 * masked (asserted on the serialized JSON), the caller's own machines, peers merged, and bounds.
 */

const MESH = "mesh-secret-world";
const PORTAL = "portal-secret-world";
const REMOTE = "203.0.113.44";
let app: any;
let state: typeof import("../../src/swarm/coordinator/agent-state.js");
let ctx: typeof import("../../src/swarm/coordinator/context.js");
let route: typeof import("../../src/swarm/coordinator/routes/network-world.js");
let meshRoutes: typeof import("../../src/swarm/coordinator/routes/mesh.js");

const caller = createPeerKeys("world-caller-macbook");
const stranger = createPeerKeys("world-stranger-gpu-box");
const unregistered = createPeerKeys("world-unregistered");

function signedHeaders(keys: PeerKeys, path: string): Record<string, string> {
  return signRequest({ method: "GET", path, bodyHash: hashRequestBody(""), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
}
const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, remoteAddress: REMOTE, headers });

function addAgent(keys: PeerKeys, over: Record<string, unknown> = {}) {
  state.agentCapabilities.set(keys.peerId, {
    os: "macos", version: "1", mode: "swarm-only", localModelEnabled: true, localModelProvider: "ollama-local",
    localModelCatalog: ["qwen3.5:9b", "llama3.2:3b"], modelsReported: true, clientType: "desktop", swarmEnabled: true, ideEnabled: false,
    maxConcurrentTasks: 2, connectedPeers: new Set(), ownerEmail: "owner@private.example", sourceIp: "198.51.100.77", countryCode: "US",
    sandboxMode: "none", lastSeenMs: Date.now(), computeClass: "apple", publicKeyPem: keys.publicKeyPem, ...over
  } as never);
}

beforeAll(async () => {
  // Pings every 100 ms here (20 s by default), so the socket test sees a pong quickly.
  Object.assign(process.env, { MESH_AUTH_TOKEN: MESH, PORTAL_SERVICE_TOKEN: PORTAL, BITCOIN_NETWORK: "signet", LIGHTNING_PROVIDER: "mock", MESH_WS_PING_INTERVAL_MS: "100" });
  delete process.env.DATABASE_URL;
  delete process.env.COORDINATOR_TRUST_PROXY;
  app = (await import("../../src/swarm/coordinator.js")).coordinatorServer;
  state = await import("../../src/swarm/coordinator/agent-state.js");
  ctx = await import("../../src/swarm/coordinator/context.js");
  route = await import("../../src/swarm/coordinator/routes/network-world.js");
  meshRoutes = await import("../../src/swarm/coordinator/routes/mesh.js");
  await app.ready();
  addAgent(caller, { lanAddresses: ["192.168.1.40/24"] });
  addAgent(stranger, { os: "linux", computeClass: "gpu", region: "sin", countryCode: "SG", ownerEmail: "stranger@private.example", lanAddresses: ["192.168.1.77/24"] });
  meshRoutes.meshRtt.record(stranger.peerId, 180, Date.now());
}, 60_000);

afterAll(async () => {
  route.setWorldPeerFetch(null);
  await app?.close();
  delete process.env.MESH_WS_PING_INTERVAL_MS;
});

describe("GET /network/world: who may ask", () => {
  test("no credentials, an unregistered agent's signature or a forged one are refused", async () => {
    expect((await get("/network/world")).statusCode).toBe(401);
    expect((await get("/network/world", signedHeaders(unregistered, "/network/world"))).statusCode).toBe(401);
    const forged = { ...signedHeaders(stranger, "/network/world"), "x-agent-id": caller.peerId };
    expect((await get("/network/world", forged)).statusCode).toBe(401);
    // A signature over another path does not open this one.
    expect((await get("/network/world", signedHeaders(caller, "/inference/models"))).statusCode).toBe(401);
  });

  test("a registered agent's signed GET and the portal token are accepted", async () => {
    expect((await get("/network/world", signedHeaders(caller, "/network/world"))).statusCode).toBe(200);
    expect((await get(`/network/world?accountId=${caller.peerId}`, { "x-portal-service-token": PORTAL })).statusCode).toBe(200);
    expect((await get("/network/world", { "x-portal-service-token": "wrong" })).statusCode).toBe(401);
  });

  test("/network/world/local is for coordinators only (mesh token)", async () => {
    expect((await get("/network/world/local", signedHeaders(caller, "/network/world/local"))).statusCode).toBe(401);
    expect((await get("/network/world/local", { "x-portal-service-token": PORTAL })).statusCode).toBe(401);
    const res = await get("/network/world/local", { "x-mesh-token": MESH });
    expect(res.statusCode).toBe(200);
    expect(res.json().coordinator.id).toBe(ctx.identity.peerId);
  });
});

describe("GET /network/world: what it shows", () => {
  test("other people's machines are masked: no ids, e-mails or IPs in the serialized answer", async () => {
    const res = await get("/network/world", signedHeaders(caller, "/network/world"));
    const text = res.body as string;
    for (const secret of [stranger.peerId, "stranger", "gpu-box", "private.example", "198.51.100.77", "ownerTag", "lastSeenMs", "agentId", "publicKeyPem", "sourceIp", "192.168.1.77", "netTag"]) {
      expect(text).not.toContain(secret);
    }
    const body = res.json();
    const other = body.agents.find((a: any) => !a.mine);
    expect(other.label).toMatch(/^lin-•••[0-9a-f]{4}$/);
    expect(other).toMatchObject({ region: "sin", country: "SG", continent: "AS", computeClass: "gpu", status: "idle", rttMs: 180, coordinatorId: ctx.identity.peerId });
    expect(other.models).toEqual(expect.arrayContaining(["qwen3.5:9b", "llama3.2:3b"]));
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("the caller's own machine is marked and named", async () => {
    const body = (await get("/network/world", signedHeaders(caller, "/network/world"))).json();
    const mine = body.agents.filter((a: any) => a.mine);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe(caller.peerId);
    expect(body.totals.mine).toBe(1);
    // LAN facts about your own machine, for your desktop app only (it connects from another address here).
    expect(mine[0].lan).toEqual({ samePublicNetwork: false, addresses: ["192.168.1.40/24"] });
    expect(body.agents.find((a: any) => !a.mine).lan).toBeUndefined();
    const portalMine = (await get(`/network/world?accountId=${caller.peerId}`, { "x-portal-service-token": PORTAL })).body as string;
    expect(portalMine).not.toMatch(/192\.168|"lan"/);
    // The portal names the account; without one nothing is anyone's.
    const portal = (await get("/network/world", { "x-portal-service-token": PORTAL })).json();
    expect(portal.agents.every((a: any) => !a.mine && a.name === undefined)).toBe(true);
  });

  test("lists this coordinator and merges a peer coordinator's agents", async () => {
    const peerKeys = createPeerKeys("coord-eu-test");
    const added = ctx.mesh.addPeer({ peerId: peerKeys.peerId, publicKeyPem: peerKeys.publicKeyPem, coordinatorUrl: "https://eu.coord.example", networkMode: "public_mesh" }, { authoritative: true, source: "register" });
    if (!added) (ctx.mesh as any).peers.set(peerKeys.peerId, { peerId: peerKeys.peerId, publicKeyPem: peerKeys.publicKeyPem, coordinatorUrl: "https://eu.coord.example", networkMode: "public_mesh" });
    const asked: Array<{ url: string; headers: Record<string, string> }> = [];
    route.setWorldPeerFetch(async (url, headers) => {
      asked.push({ url, headers });
      return {
        status: 200,
        json: {
          coordinator: { id: peerKeys.peerId, url: "https://eu.coord.example", region: "fra", country: "DE", continent: "EU", agents: 1, agentsOnline: 1 },
          links: [],
          generatedAtMs: Date.now(),
          agents: [{ agentId: "eu-private-name", ownerTag: null, lastSeenMs: Date.now(), id: "abcdef0123", label: "eu-private-name", os: "linux", region: "fra", country: "DE", continent: "EU", computeClass: "gpu", tier: null, vramGb: 24, models: ["qwen2.5-coder:32b"], modelsTotal: 1, activeModel: "qwen2.5-coder:32b", status: "busy", slots: 4, slotsUsed: 2, coordinatorId: "ignored", rttMs: 12 }]
        }
      };
    });
    try {
      const res = await get("/network/world", signedHeaders(stranger, "/network/world"));
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(asked[0].url).toBe("https://eu.coord.example/network/world/local");
      expect(asked[0].headers["x-mesh-token"]).toBe(MESH);
      expect(body.coordinators.map((c: any) => [c.id, c.self, c.reachable])).toEqual([
        [ctx.identity.peerId, true, true],
        [peerKeys.peerId, false, true]
      ]);
      expect(body.links).toContainEqual(expect.objectContaining({ from: ctx.identity.peerId, to: peerKeys.peerId }));
      const eu = body.agents.find((a: any) => a.coordinatorId === peerKeys.peerId);
      expect(eu).toMatchObject({ label: "lin-•••0123", status: "busy", slots: 4, slotsUsed: 2, models: ["qwen2.5-coder:32b"] });
      expect(res.body).not.toContain("eu-private-name");
      expect(body.totals.coordinators).toBe(2);
    } finally {
      route.setWorldPeerFetch(null);
      ctx.mesh.removePeer(peerKeys.peerId);
    }
  });

  test("an unreachable peer is listed as unreachable, without agents", async () => {
    const peerKeys = createPeerKeys("coord-down-test");
    (ctx.mesh as any).peers.set(peerKeys.peerId, { peerId: peerKeys.peerId, publicKeyPem: peerKeys.publicKeyPem, coordinatorUrl: "https://down.coord.example", networkMode: "public_mesh" });
    route.setWorldPeerFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      const body = (await get("/network/world", { "x-portal-service-token": PORTAL })).json();
      expect(body.coordinators.find((c: any) => c.id === peerKeys.peerId)).toMatchObject({ reachable: false, agents: 0, url: "https://down.coord.example" });
    } finally {
      route.setWorldPeerFetch(null);
      ctx.mesh.removePeer(peerKeys.peerId);
    }
  });
});

describe("peer views for routing (run 4)", () => {
  test("a failed or slow refresh keeps routing on the peer's last good view, up to WORLD_PEER_ROUTING_STALE_MS", async () => {
    const routing = await import("../../src/swarm/coordinator/routing.js");
    const peerKeys = createPeerKeys("coord-eu-routing");
    (ctx.mesh as any).peers.set(peerKeys.peerId, { peerId: peerKeys.peerId, publicKeyPem: peerKeys.publicKeyPem, coordinatorUrl: "https://eu2.coord.example", networkMode: "public_mesh" });
    const world = {
      coordinator: { id: peerKeys.peerId, url: "https://eu2.coord.example", region: "fra", country: "DE", continent: "EU", agents: 1, agentsOnline: 1 },
      links: [],
      generatedAtMs: Date.now(),
      agents: [{ agentId: "ec-fra", ownerTag: null, lastSeenMs: Date.now(), id: "fra0123456", label: "ec-fra", os: "linux", region: "fra", country: "DE", continent: "EU", computeClass: "cpu", tier: null, vramGb: null, models: ["qwen2.5-coder:1.5b"], modelsTotal: 1, activeModel: "qwen2.5-coder:1.5b", status: "idle", slots: 2, slotsUsed: 0, coordinatorId: "x", rttMs: 10 }]
    };
    let up = true;
    route.setWorldPeerFetch(async () => {
      if (!up) throw new Error("ETIMEDOUT");
      return { status: 200, json: world };
    });
    try {
      const t0 = Date.now();
      const ids = (views: Array<{ world: { coordinator: { id: string } } }>) => views.map((v) => v.world.coordinator.id);
      expect(ids(await routing.peerWorldViews(t0))).toContain(peerKeys.peerId);
      up = false;
      // Past the 15 s cache the refresh fails: the last good view is still used.
      expect(ids(await routing.peerWorldViews(t0 + route.WORLD_PEER_CACHE_MS + 1_000))).toContain(peerKeys.peerId);
      // Too old: dropped.
      expect(ids(await routing.peerWorldViews(t0 + route.WORLD_PEER_ROUTING_STALE_MS + route.WORLD_PEER_CACHE_MS + 2_000))).not.toContain(peerKeys.peerId);
    } finally {
      route.setWorldPeerFetch(null);
      ctx.mesh.removePeer(peerKeys.peerId);
    }
  });
});

describe("round trip on the mesh WebSocket", () => {
  test("an agent's signed socket is pinged and its pong's round trip is recorded", async () => {
    expect(meshRoutes.meshRtt.get(caller.peerId, Date.now())).toBeNull();
    const ws = await app.injectWS(`/mesh/ws?peerId=${caller.peerId}`, { headers: signMeshWsBind(caller.peerId, caller.privateKeyPem) });
    // injectWS builds its client socket without ws's autoPong; a real agent's `new WebSocket(url)` has it on (the default).
    ws.on("ping", () => ws.pong());
    try {
      for (let i = 0; i < 50 && !meshRoutes.meshRtt.get(caller.peerId, Date.now()); i++) await new Promise((r) => setTimeout(r, 20));
      const sample = meshRoutes.meshRtt.get(caller.peerId, Date.now());
      expect(sample).not.toBeNull();
      expect(sample!.rttMs).toBeGreaterThanOrEqual(0);
      const body = (await get("/network/world", signedHeaders(caller, "/network/world"))).json();
      expect(body.agents.find((a: any) => a.mine)).toBeDefined();
    } finally {
      ws.terminate();
    }
  });
});

describe("GET /network/world: activity and your own requests", () => {
  const someoneElse = "acct-someone-else-private";
  let mineId = "";
  let theirsId = "";

  beforeAll(async () => {
    // The caller's call and another account's, both running on the stranger's machine.
    const base = { kind: "inference" as const, language: "python" as const, input: "{}", timeoutMs: 60_000, snapshotRef: "inference", requestedModel: "qwen3.5:9b" };
    mineId = ctx.queue.enqueueSubtask({ ...base, taskId: "world-mine-task", projectMeta: { projectId: `inference:${caller.peerId}`, resourceClass: "gpu", priority: 60 } }).id;
    theirsId = ctx.queue.enqueueSubtask({ ...base, taskId: "world-theirs-task", projectMeta: { projectId: `inference:${someoneElse}`, resourceClass: "gpu", priority: 60 } }).id;
    for (let i = 0; i < 2; i++) ctx.queue.claim(stranger.peerId);
    // The caller's reply is streaming.
    const { inferenceStreams } = await import("../../src/swarm/coordinator/routes/inference.js");
    inferenceStreams.open(mineId, "world-mine-task");
    inferenceStreams.append(mineId, 0, "Hello");
    route.clearWorldLocalCache();
  });

  afterAll(() => {
    ctx.queue.removeHeld(mineId);
    ctx.queue.removeHeld(theirsId);
    route.clearWorldLocalCache();
  });

  test("a busy machine shows how much it is doing, never for whom", async () => {
    const res = await get(`/network/world?accountId=${caller.peerId}`, { "x-portal-service-token": PORTAL });
    const body = res.json();
    const busy = body.agents.find((a: any) => !a.mine);
    expect(busy.activity).toEqual({ callsNow: 2, streaming: 1, callsPerMin: expect.any(Number) });
    expect(busy.activity.callsPerMin).toBeGreaterThanOrEqual(2);
    expect(res.body).not.toContain(someoneElse);
    expect(res.body).not.toContain(theirsId);
    expect(res.body).not.toContain(mineId);
    expect(res.body).not.toMatch(/"tag"|ownerTag|"requests"/);
  });

  test("the caller sees only their own request, and which machine is serving it", async () => {
    const body = (await get(`/network/world?accountId=${caller.peerId}`, { "x-portal-service-token": PORTAL })).json();
    const busy = body.agents.find((a: any) => !a.mine);
    expect(body.yourRequests).toEqual([{ coordinator: ctx.identity.peerId, machineKey: busy.id, state: "streaming" }]);
    // The same through the desktop app (signed agent of the same account).
    const signed = (await get("/network/world", signedHeaders(caller, "/network/world"))).json();
    expect(signed.yourRequests).toEqual(body.yourRequests);
  });

  test("another account sees its own request only; nobody's without an account", async () => {
    const theirs = (await get(`/network/world?accountId=${someoneElse}`, { "x-portal-service-token": PORTAL })).json();
    expect(theirs.yourRequests).toEqual([{ coordinator: ctx.identity.peerId, machineKey: expect.stringMatching(/^[0-9a-f]{10}$/), state: "starting" }]);
    const nobody = (await get("/network/world", { "x-portal-service-token": PORTAL })).json();
    expect(nobody.yourRequests).toEqual([]);
    const stranger3 = (await get("/network/world", signedHeaders(stranger, "/network/world"))).json();
    expect(stranger3.yourRequests).toEqual([]);
  });

  test("peers get the tagged requests (mesh token only); the tags are hashes, not accounts", async () => {
    const local = (await get("/network/world/local", { "x-mesh-token": MESH })).json();
    expect(local.requests).toHaveLength(2);
    for (const r of local.requests) expect(r.tag).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(local.requests)).not.toContain(someoneElse);
  });
});

describe("bounds", () => {
  test("rate-limited per caller", () => {
    const limiter = new route.WorldRateLimiter(3, 10);
    expect([0, 1, 2].map(() => limiter.take("a", 1_000))).toEqual([0, 0, 0]);
    expect(limiter.take("a", 2_000)).toBe(59);
    expect(limiter.take("b", 2_000)).toBe(0);
    expect(limiter.take("a", 61_000)).toBe(0);
  });

  test("the route answers 429 with Retry-After past the limit", async () => {
    let last: any;
    for (let i = 0; i <= route.WORLD_RATE_PER_MIN + 1; i++) last = await get("/network/world", signedHeaders(stranger, "/network/world"));
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers["retry-after"])).toBeGreaterThan(0);
  });

  test("the answer states its limits", async () => {
    const body = (await get("/network/world", { "x-portal-service-token": PORTAL })).json();
    expect(body.limits).toEqual({ maxAgents: 500, maxModelsPerAgent: 12, maxCoordinators: 16 });
    expect(body.agents.length).toBeLessThanOrEqual(500);
  });
});
