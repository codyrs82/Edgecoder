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
  Object.assign(process.env, { ADMIN_API_TOKEN: ADMIN, MESH_AUTH_TOKEN: MESH, PORTAL_SERVICE_TOKEN: PORTAL, BITCOIN_NETWORK: "signet", LIGHTNING_PROVIDER: "mock", FLY_REGION: "ord" });
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
  delete process.env.FLY_REGION;
});

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });

function addAgent(agentId: string, models: string[], lastSeenMs: number, region?: string) {
  state.agentCapabilities.set(agentId, {
    os: "macos", version: "1.2.3", mode: "swarm-only", localModelEnabled: true, localModelProvider: "ollama-local",
    localModelCatalog: models, modelsReported: true, clientType: "desktop", swarmEnabled: true, ideEnabled: false,
    maxConcurrentTasks: 2, connectedPeers: new Set(), ownerEmail: "owner@example.com", countryCode: "US",
    sandboxMode: "none", lastSeenMs, computeClass: "apple", ...(region ? { region } : {})
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
    // Gaps over time (#340): unmet by model, slots per model, saturated and stale counts, agents by region.
    expect(last).toMatchObject({
      unmetByModel: { "mistral:7b": 1 },
      modelSlots: { "llama3:8b": { free: 2, total: 2 }, "qwen2.5:7b": { free: 2, total: 2 } },
      saturatedModels: 0,
      staleAgents: 1,
      // agent-live reports no region of its own: it counts under this coordinator's (FLY_REGION).
      agentsByRegion: { ord: 1 }
    });
  });

  test("the coordinator's region comes from FLY_REGION, and an agent's own region is used where it reported one", async () => {
    const now = Date.now();
    addAgent("agent-sin", ["llama3:8b"], now, "sin");
    // agent-sin's two slots are full: llama3:8b now has free slots only on agent-live; qwen is fine.
    dispatch.noteAgentPull("agent-sin", { inferenceSlots: 2, freeInferenceSlots: 0 });
    const sample = net.takeNetworkSample(now);
    expect(sample.agentsByRegion).toEqual({ ord: 1, sin: 1 });
    expect(sample.modelSlots!["llama3:8b"]).toEqual({ free: 2, total: 4 });
    const r = (await get("/admin/network?range=1h", { "x-admin-token": ADMIN })).json();
    expect(r.coordinator.region).toBe("ord");
    expect(r.agents.find((a: { agentId: string }) => a.agentId === "agent-sin")).toMatchObject({ region: "sin" });
    expect(r.agents.find((a: { agentId: string }) => a.agentId === "agent-live")).toMatchObject({ region: null });
    // The served point averages the samples in its 15 s bucket.
    expect(Object.keys(r.series.points.at(-1).agentsByRegion).sort()).toEqual(["ord", "sin"]);
    state.agentCapabilities.delete("agent-sin");
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

describe("run 8: only calls that completed normally and ran alone feed a host's own speed", () => {
  /*
   * Network run 8 (2026-11-25): idle lhr buyers went to iad on "iad 987 ms vs lhr 2273 ms"
   * (inf-1795623629295-bac0c382, inf-1795623637550-c2e2e888); lhr serves its own buyers in ~1.0 s.
   * lhr's samples came from the cancel test and from two calls that ran side by side on it.
   */
  const MODEL = "qwen2.5-coder:1.5b";
  let eta: typeof import("../../src/swarm/coordinator/start-eta.js");
  let cancel: typeof import("../../src/swarm/coordinator/inference-cancel.js");
  let n = 0;

  beforeAll(async () => {
    eta = await import("../../src/swarm/coordinator/start-eta.js");
    cancel = await import("../../src/swarm/coordinator/inference-cancel.js");
  });

  function claimCall(agentId: string, claimedAtMs: number): { taskId: string; subtaskId: string } {
    n++;
    const taskId = `task-r8-${n}`;
    const subtaskId = `sub-r8-${n}`;
    const input = JSON.stringify({ messages: [{ role: "user", content: "write a python function that adds two numbers" }] });
    ctx.queue.restoreSubtask({
      id: subtaskId, taskId, kind: "inference", language: "python", input, timeoutMs: 600_000, snapshotRef: "inference",
      requestedModel: MODEL, projectMeta: { projectId: "p-r8", resourceClass: "cpu", priority: 60 }
    } as never, { claim: { agentId, claimedAtMs } });
    return { taskId, subtaskId };
  }

  function finish(call: { subtaskId: string }, atMs: number, extra: Record<string, unknown> = {}): void {
    net.observeInference("/inference/chunks", 200, { subtaskId: call.subtaskId, seq: 0, delta: "def add(a, b):\n    return a + b\n", done: true, promptTokens: 40, outputTokens: 20, ...extra }, JSON.stringify({ status: "ok" }), atMs);
    ctx.queue.removeHeld(call.subtaskId);
  }

  test("an errored (deadline-cut) or requester-cancelled reply is no sample; three normal ones alone are", async () => {
    const agent = "agent-r8-lhr";
    addAgent(agent, [MODEL], Date.now(), "lhr");
    eta.agentServiceTimes.clear();
    eta.clearCallEnds();
    const t0 = Date.now() - 120_000;
    // Two calls that completed normally, one at a time.
    for (let i = 0; i < 2; i++) finish(claimCall(agent, t0 + i * 5_000), t0 + i * 5_000 + 1_000);
    // Cut at its 8 s deadline, part of the reply sent.
    const cut = claimCall(agent, t0 + 10_000);
    finish(cut, t0 + 18_000, { error: "timed out after 8 s" });
    // Cancelled by its requester (run 8's cancel test): the agent reports what it produced, no error.
    const cancelled = claimCall(agent, t0 + 20_000);
    expect(await cancel.cancelInferenceCall(cancelled.taskId, cancelled.subtaskId, t0 + 21_000, 3_600_000)).toBe("stopping");
    finish(cancelled, t0 + 22_000);
    // Two normal samples: not enough for a speed of its own.
    expect(eta.agentServiceTimes.speed(MODEL, agent, t0 + 23_000)).toBeNull();
    expect(eta.hostSpeed(MODEL, agent, "apple", t0 + 23_000)?.from).not.toBe("host");
    // A third normal one: measured, at the normal calls' speed.
    finish(claimCall(agent, t0 + 30_000), t0 + 31_000);
    const now = t0 + 40_000;
    expect(eta.hostSpeed(MODEL, agent, "apple", now)).toMatchObject({ from: "host" });
    const normal = eta.agentServiceTimes.speed(MODEL, agent, now)!;
    expect(normal).toBeCloseTo(1_000 / eta.callWorkMs(MODEL, "apple", 40, 20), 6);
    state.agentCapabilities.delete(agent);
  });

  test("two calls side by side on one host are no sample of its own speed (the class keeps them)", () => {
    const agent = "agent-r8-pair";
    addAgent(agent, [MODEL], Date.now(), "lhr");
    eta.agentServiceTimes.clear();
    eta.serviceTimes.clear();
    eta.clearCallEnds();
    const t0 = Date.now() - 120_000;
    for (let i = 0; i < 3; i++) {
      // Run 8's idle probe: an lhr and a fra buyer's calls on lhr at once, each ~2.5 s.
      const a = claimCall(agent, t0 + i * 10_000);
      const b = claimCall(agent, t0 + i * 10_000 + 100);
      finish(a, t0 + i * 10_000 + 2_450);
      finish(b, t0 + i * 10_000 + 2_500);
    }
    const now = t0 + 40_000;
    expect(eta.agentServiceTimes.speed(MODEL, agent, now)).toBeNull();
    expect(eta.serviceTimes.speed(MODEL, "apple", now)).not.toBeNull();
    expect(eta.hostSpeed(MODEL, agent, "apple", now)?.from).toBe("class");
    state.agentCapabilities.delete(agent);
  });
});
