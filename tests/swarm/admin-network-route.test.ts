import { afterAll, beforeAll, describe, expect, test } from "vitest";

/*
 * GET /admin/network (real coordinator app): the admin token gates it like /admin/revenue, and the
 * snapshot carries agents, queue, dispatch, latency, models, gaps and a time series.
 */

const ADMIN = "admin-secret-network";
const MESH = "mesh-secret-network";
const PORTAL = "portal-secret-network";
let app: any;
let state: typeof import("../../src/swarm/coordinator/agent-state.js");
let ctx: typeof import("../../src/swarm/coordinator/context.js");
let dispatch: typeof import("../../src/swarm/coordinator/dispatch.js");
let net: typeof import("../../src/swarm/coordinator/routes/admin-network.js");

beforeAll(async () => {
  Object.assign(process.env, { ADMIN_API_TOKEN: ADMIN, MESH_AUTH_TOKEN: MESH, PORTAL_SERVICE_TOKEN: PORTAL, BITCOIN_NETWORK: "signet", LIGHTNING_PROVIDER: "mock" });
  delete process.env.DATABASE_URL;
  app = (await import("../../src/swarm/coordinator.js")).coordinatorServer;
  state = await import("../../src/swarm/coordinator/agent-state.js");
  ctx = await import("../../src/swarm/coordinator/context.js");
  dispatch = await import("../../src/swarm/coordinator/dispatch.js");
  net = await import("../../src/swarm/coordinator/routes/admin-network.js");
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  delete process.env.ADMIN_API_TOKEN;
});

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });

function addAgent(agentId: string, models: string[], lastSeenMs: number) {
  state.agentCapabilities.set(agentId, {
    os: "macos", version: "1.2.3", mode: "swarm-only", localModelEnabled: true, localModelProvider: "ollama-local",
    localModelCatalog: models, modelsReported: true, clientType: "desktop", swarmEnabled: true, ideEnabled: false,
    maxConcurrentTasks: 2, connectedPeers: new Set(), ownerEmail: "owner@example.com", countryCode: "US",
    sandboxMode: "none", lastSeenMs, computeClass: "apple"
  });
}

describe("GET /admin/network", () => {
  test("needs the admin token: none, a wrong one, the mesh token or the portal token are refused", async () => {
    expect((await get("/admin/network", {})).statusCode).toBe(401);
    expect((await get("/admin/network", { "x-admin-token": "wrong" })).statusCode).toBe(401);
    expect((await get("/admin/network", { "x-mesh-token": MESH })).statusCode).toBe(401);
    expect((await get("/admin/network", { "x-portal-service-token": PORTAL })).statusCode).toBe(401);
    expect((await get("/admin/network?range=30d", { "x-admin-token": ADMIN })).statusCode).toBe(400);
  });

  test("reports agents, queue, models, gaps, latency and the series", async () => {
    const now = Date.now();
    addAgent("agent-live", ["llama3:8b", "qwen2.5:7b"], now);
    addAgent("agent-stale", ["llama3:8b"], now - 10 * 60_000);
    dispatch.noteAgentPull("agent-live", { inferenceSlots: 2, freeInferenceSlots: 2, contextWindow: 8192, wake: true });
    ctx.queue.enqueueSubtask({
      taskId: "task-wait", kind: "inference", language: "python", input: "{}", timeoutMs: 60_000, snapshotRef: "inference",
      requestedModel: "qwen2.5:7b", projectMeta: { projectId: "p", resourceClass: "gpu", priority: 60 }
    } as never);

    // Calls the onSend hook would see: a refusal for a missing model, and a timed call.
    net.observeInference("/inference/submit", 409, { model: "mistral:7b" }, JSON.stringify({ error: "no_agent_has_model", model: "mistral:7b" }), now - 5_000);
    net.observeInference("/inference/submit", 200, { model: "llama3:8b" }, JSON.stringify({ taskId: "t-1", subtaskId: "s-1" }), now - 4_000);
    net.observeInference("/inference/chunks", 200, { subtaskId: "s-1", seq: 0, delta: "hi" }, JSON.stringify({ status: "ok" }), now - 3_500);
    net.observeInference("/inference/chunks", 200, { subtaskId: "s-1", seq: 1, delta: "", done: true }, JSON.stringify({ status: "ok" }), now - 2_000);
    // A refused piece (409) is not counted.
    net.observeInference("/inference/chunks", 409, { subtaskId: "s-1", seq: 2, done: true }, JSON.stringify({ status: "closed" }), now);
    net.takeNetworkSample(now - 1_000);

    const res = await get("/admin/network?range=1h", { "x-admin-token": ADMIN });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const r = res.json();
    expect(Object.keys(r).sort()).toEqual(["agents", "coordinator", "dispatch", "gaps", "latency", "models", "queue", "routing", "series", "totals"]);
    expect(r.routing).toMatchObject({ decisions: expect.any(Array), config: { weights: expect.any(Object), preferMs: expect.any(Number) }, complexityWeights: expect.any(Object) });

    const live = r.agents.find((a: { agentId: string }) => a.agentId === "agent-live");
    expect(live).toMatchObject({
      accountId: null, ownerEmail: "owner@example.com", os: "macos", clientType: "desktop", version: "1.2.3", countryCode: "US",
      computeClass: "apple", modelsInstalled: ["llama3:8b", "qwen2.5:7b"], slots: 2, freeSlots: 2, contextWindow: 8192,
      claims: 0, connected: true, socketConnected: false, blacklisted: false, status: "idle"
    });
    expect(r.agents.find((a: { agentId: string }) => a.agentId === "agent-stale")).toMatchObject({ status: "stale", freeSlots: 0 });

    expect(r.totals).toMatchObject({ agentsKnown: 2, agentsConnected: 1, agentsBusy: 0, agentsStale: 1, totalSlots: 2, freeSlots: 2 });
    expect(r.queue).toMatchObject({ queued: 1, claimed: 0, unclaimed: 1, waitingInference: 1, waitingByModel: [{ model: "qwen2.5:7b", waiting: 1 }] });
    expect(r.dispatch).toMatchObject({ pickup: { count: expect.any(Number) }, nudges: expect.any(Number) });
    expect(r.latency.ttft).toEqual({ count: 1, p50: 500, p90: 500 });
    expect(r.latency.duration).toEqual({ count: 1, p50: 2000, p90: 2000 });

    const llama = r.models.find((m: { model: string }) => m.model === "llama3:8b");
    expect(llama).toMatchObject({ agents: 1, idleAgents: 1, slots: 2, freeSlots: 2, callsWindow: 1, completedWindow: 1, calls24h: 1 });
    expect(r.models.find((m: { model: string }) => m.model === "mistral:7b")).toMatchObject({ agents: 0, noAgentHasModel24h: 1 });
    expect(r.gaps.missingModels).toEqual([{ model: "mistral:7b", noAgentHasModel: 1, noCapacity: 0, holders: 0 }]);
    expect(r.gaps.staleAgents.map((a: { agentId: string }) => a.agentId)).toEqual(["agent-stale"]);
    expect(r.gaps.saturatedModels).toEqual([]);

    expect(r.series).toMatchObject({ range: "1h", bucketMs: 15_000 });
    const last = r.series.points.at(-1);
    expect(last).toMatchObject({ connectedAgents: 1, totalSlots: 2, freeSlots: 2, waitingInference: 1, started: 1, completed: 1, noAgentHasModel: 1, ttftP50: 500 });
    expect(r.coordinator).toMatchObject({ sampleIntervalMs: 15_000, generatedAtMs: expect.any(Number) });
  });

  test("serves a 7 d range in 30 min buckets", async () => {
    net.takeNetworkSample(Date.now());
    const res = await get("/admin/network?range=7d", { "x-admin-token": ADMIN });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().series).toMatchObject({ range: "7d", bucketMs: 30 * 60_000 });
    expect(res.json().series.points.length).toBeGreaterThan(0);
  });

  test("without a database the series stays in memory and nothing is queued for writing", () => {
    expect(net.networkHistory.enabled).toBe(false);
    net.takeNetworkSample(Date.now());
    expect(net.networkHistory.pendingCount).toBe(0);
    expect(net.networkSamples.size).toBeGreaterThan(0);
  });
});
