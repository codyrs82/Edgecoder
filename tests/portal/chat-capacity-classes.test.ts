import { describe, expect, it } from "vitest";
import { createChatCapacityDirectory, httpCapacityProbe, type CapacityReport } from "../../src/portal/chat-capacity.js";

// Live regtest finding (2026-11-15): /v1/models advertised qwen3-coder:30b@gpu, but the only GPU
// machine holding it is a datacenter GPU (class gpu.dc), so every @gpu call answered 404. The
// portal listed models from one coordinator, and picked the coordinator for a call by model only,
// never by class. Now the list is the union of what every coordinator reports, @class variants
// only for classes an online agent holds, and a classed call goes to a coordinator that has that class.

const US = "https://us.example";
const EU = "https://eu.example";
const MODEL = "qwen3-coder:30b";
const rep = (classes: string[], free: number): CapacityReport => ({
  reachable: true,
  agentModels: [MODEL],
  modelLoad: { [MODEL]: { agents: 1, idle: free, free, waiting: 0 } },
  modelClasses: { [MODEL]: classes }
});

describe("network calls by compute class", () => {
  it("sends a classed call to a coordinator that has that class, even when another has more room", async () => {
    const reports: Record<string, CapacityReport> = { [US]: rep(["apple"], 5), [EU]: rep(["gpu.dc"], 1) };
    const d = createChatCapacityDirectory({ candidates: async () => [US, EU], allowed: () => true, probe: async (u) => reports[u], ttlMs: 60_000 });
    expect((await d.pick({ kind: "network", model: MODEL, computeClass: "gpu.dc" })).url).toBe(EU);
    expect((await d.pick({ kind: "network", model: MODEL, computeClass: "apple" })).url).toBe(US);
    expect((await d.pick({ kind: "network", model: MODEL })).url).toBe(US); // any class: the most room
  });

  it("lists every coordinator's models with only the classes some agent actually holds", async () => {
    const reports: Record<string, CapacityReport> = { [US]: rep(["apple"], 5), [EU]: rep(["gpu.dc"], 1) };
    const d = createChatCapacityDirectory({ candidates: async () => [US, EU], allowed: () => true, probe: async (u) => reports[u], ttlMs: 60_000 });
    expect(await d.networkModels()).toEqual([{ model: MODEL, agents: 2, classes: ["apple", "gpu.dc"] }]);
  });

  it("the HTTP probe reads each model's classes from /inference/models", async () => {
    const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = await import("undici");
    const prev = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    try {
      agent.get(US).intercept({ path: "/inference/models", method: "GET" }).reply(200, { models: [{ model: MODEL, agents: 1, idleAgents: 1, freeSlots: 1, waiting: 0, classes: ["gpu.dc"] }] });
      const r = await httpCapacityProbe({ timeoutMs: 1000 })(US, "network");
      expect(r.modelClasses).toEqual({ [MODEL]: ["gpu.dc"] });
    } finally {
      setGlobalDispatcher(prev);
      await agent.close();
    }
  });
});

describe("/v1/models", () => {
  it("advertises @class variants only for classes an online agent holds, from every coordinator", async () => {
    const Fastify = (await import("fastify")).default;
    const { hashApiKey, registerHostedRoutes } = await import("../../src/portal/routes/hosted.js");
    const key = "eck_test_models_key";
    const app = Fastify();
    registerHostedRoutes(app, {
      store: { userForApiKeyHash: async (h: string) => (h === hashApiKey(key) ? "u1" : null) } as never,
      getCurrentUser: async () => null,
      PORTAL_SERVICE_TOKEN: "svc",
      EXTERNAL_HTTP_TIMEOUT_MS: 1000,
      discoverCoordinatorUrlsForPortal: async () => [],
      chatCapacity: {
        pick: async () => ({ url: null, known: 0 }),
        markFailed: () => undefined,
        networkModels: async () => [{ model: MODEL, agents: 1, classes: ["gpu.dc"] }, { model: "qwen2.5-coder:1.5b", agents: 9, classes: ["apple", "cpu"] }]
      }
    } as never);
    const r = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${key}` } });
    const ids = (r.json().data as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toContain(`network/${MODEL}@gpu.dc`);
    expect(ids).not.toContain(`network/${MODEL}@gpu`);
    expect(ids).toEqual(expect.arrayContaining(["auto", `network/${MODEL}`, "network/qwen2.5-coder:1.5b@cpu", "network/qwen2.5-coder:1.5b@apple"]));
  });
});
