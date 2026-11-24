import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  askEveryCoordinator,
  drainingAnswer,
  everyCoordinator,
  firstCoordinatorAnswer,
  mergeInferenceModels,
  mergeLocalModels,
  networkModelsFromEvery
} from "../../src/portal/coordinator-fanout.js";
import { registerChatApiRoutes } from "../../src/portal/routes/chat.js";
import { registerMachineRoutes } from "../../src/portal/routes/machines.js";
import { registerCodeRoutes } from "../../src/portal/routes/code.js";

/*
 * Website lookups of live machines ask every coordinator (each knows only the machines linked to
 * it) and merge; a coordinator that is down or restarting is left out rather than failing the page.
 */
const SERVICE = "s".repeat(40);
/** Nothing listens here: connection refused, like a coordinator that is restarting. */
const DOWN = "http://127.0.0.1:1";

type Route = (body: any) => { status: number; json: unknown };
function fakeCoordinator(routes: Record<string, Route>): Server {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const route = routes[`${req.method} ${req.url?.split("?")[0]}`];
      const out = route ? route(raw ? JSON.parse(raw) : {}) : { status: 404, json: {} };
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
}
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

const NOW = Date.now();
let coordA: Server;
let coordB: Server;
beforeAll(async () => {
  coordA = fakeCoordinator({
    "GET /portal/models": () => ({ status: 200, json: { local: [{ name: "qwen3.5:4b", parameterSize: "4B", quantization: "Q4", running: false }] } }),
    "GET /inference/models": () => ({
      status: 200,
      json: { models: [{ model: "qwen3-coder:30b", agents: 1, idleAgents: 1, freeSlots: 2, classes: ["gpu"], agentsByClass: { gpu: 1 }, contextWindow: 32_768 }], classes: { gpu: { label: "GPU", cSatsPerSecondBaseTier: 3, agents: 1 } } }
    }),
    "POST /agent-control/machines": () => ({ status: 200, json: { machines: [] } }),
    "POST /agent-control/code": () => ({ status: 200, json: { machines: [] } })
  });
  coordB = fakeCoordinator({
    "GET /portal/models": () => ({ status: 200, json: { local: [{ name: "qwen3.5:4b", parameterSize: "4B", quantization: "Q4", running: true }] } }),
    "GET /inference/models": () => ({
      status: 200,
      json: {
        models: [
          { model: "qwen3-coder:30b", agents: 2, idleAgents: 0, freeSlots: 1, classes: ["gpu.dc"], agentsByClass: { "gpu.dc": 2 }, contextWindow: 16_384 },
          { model: "qwen2.5-coder:7b", agents: 3, classes: ["cpu"] }
        ],
        classes: { gpu: { label: "GPU", cSatsPerSecondBaseTier: 3, agents: 0 }, cpu: { label: "CPU", agents: 3 } }
      }
    }),
    "POST /agent-control/machines": (body) => ({
      status: 200,
      json: { machines: (body.agentIds as string[]).filter((id) => id === "mac-1").map((agentId) => ({ agentId, connected: true, state: { activeModel: "qwen3.5:9b" }, stateAtMs: NOW, lastSeenMs: NOW, coordinatorId: "B", audit: [] })) }
    }),
    "POST /agent-control/code": (body) => ({
      status: 200,
      json: {
        coordinatorId: "B",
        machines: (body.agentIds as string[])
          .filter((id) => id === "mac-1")
          .map((agentId) => ({ agentId, connected: true, reportedAtMs: NOW, snapshot: { v: 1, machineName: "Studio", controls: "on", account: "acct-u1", generatedAtMs: NOW, projects: [], sessions: [] }, audit: [] }))
      }
    })
  });
  await Promise.all([coordA, coordB].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
});
const apps: FastifyInstance[] = [];
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await Promise.all([coordA, coordB].map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe("coordinator fan-out helpers", () => {
  it("everyCoordinator puts the preferred one first, adds the rest, dedupes and skips a failing source", async () => {
    const every = everyCoordinator(async () => ["https://b.example/"], async () => ["https://a.example", "https://b.example"]);
    expect(await every()).toEqual(["https://b.example", "https://a.example"]);
    const broken = everyCoordinator(async () => {
      throw new Error("picker down");
    }, async () => ["https://a.example"]);
    expect(await broken()).toEqual(["https://a.example"]);
  });

  it("askEveryCoordinator tolerates a coordinator that fails or hangs, and bounds concurrency", async () => {
    let running = 0;
    let peak = 0;
    const answers = await askEveryCoordinator(
      ["https://a", "https://down", "https://hang", "https://d", "https://e"],
      async (base) => {
        running++;
        peak = Math.max(peak, running);
        try {
          if (base === "https://down") throw new Error("ECONNREFUSED");
          if (base === "https://hang") await new Promise(() => undefined);
          await new Promise((r) => setTimeout(r, 5));
          return base;
        } finally {
          running--;
        }
      },
      { concurrency: 2, timeoutMs: 100 }
    );
    expect(answers.map((a) => a.ok)).toEqual([true, false, false, true, true]);
    expect(answers[2]).toMatchObject({ ok: false, error: "timeout" });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("firstCoordinatorAnswer falls over to the next coordinator (shared state)", async () => {
    const asked: string[] = [];
    const found = await firstCoordinatorAnswer(["https://a", "https://b", "https://c"], async (base) => {
      asked.push(base);
      if (base === "https://a") throw new Error("down");
      return base === "https://b" ? { rate: 1 } : null;
    });
    expect(found).toEqual({ url: "https://b", value: { rate: 1 } });
    expect(asked).toEqual(["https://a", "https://b"]);
  });

  it("merges /inference/models: counts add up, classes union, smallest context window, class counts add", () => {
    const merged = mergeInferenceModels([
      { models: [{ model: "m", agents: 1, idleAgents: 1, freeSlots: 2, classes: ["gpu"], agentsByClass: { gpu: 1 }, contextWindow: 32_768 }], classes: { gpu: { agents: 1, cSatsPerSecondBaseTier: 3 } } },
      { models: [{ model: "m", agents: 2, freeSlots: 1, classes: ["gpu.dc", "gpu"], agentsByClass: { "gpu.dc": 2 }, contextWindow: 16_384 }, { model: "n", agents: 1, classes: ["cpu"] }], classes: { gpu: { agents: 2, cSatsPerSecondBaseTier: 9 } } }
    ]);
    expect(merged.models).toEqual([
      { model: "m", agents: 3, idleAgents: 1, freeSlots: 3, classes: ["gpu", "gpu.dc"], agentsByClass: { gpu: 1, "gpu.dc": 2 }, contextWindow: 16_384 },
      { model: "n", agents: 1, classes: ["cpu"] }
    ]);
    // The first coordinator's price; machine counts add up.
    expect(merged.classes.gpu).toEqual({ agents: 3, cSatsPerSecondBaseTier: 3 });
  });

  it("merges coordinators' own models by name (running anywhere counts)", () => {
    expect(mergeLocalModels([[{ name: "a", running: false }], [{ name: "a", running: true }, { name: "b", running: false }]])).toEqual([
      { name: "a", running: true },
      { name: "b", running: false }
    ]);
  });

  it("reads a draining answer's wait (bounded) and nothing else", () => {
    expect(drainingAnswer(JSON.stringify({ error: "coordinator_draining", retryAfterMs: 3000 }))).toBe(3000);
    expect(drainingAnswer(JSON.stringify({ error: "coordinator_draining", retryAfterMs: 600_000 }))).toBe(5000);
    expect(drainingAnswer(JSON.stringify({ error: "no_capacity" }))).toBeNull();
    expect(drainingAnswer("<html>")).toBeNull();
  });

  it("networkModelsFromEvery: 200 with one coordinator down, 0 with all down", async () => {
    const r = await networkModelsFromEvery([DOWN, urlOf(coordA), urlOf(coordB)], { serviceToken: SERVICE, account: "acct-u1", timeoutMs: 2_000 });
    expect(r.status).toBe(200);
    expect(r.json.coordinators).toBe(2);
    expect((r.json.models as Array<{ model: string; agents: number }>).map((m) => [m.model, m.agents])).toEqual([
      ["qwen3-coder:30b", 3],
      ["qwen2.5-coder:7b", 3]
    ]);
    expect((await networkModelsFromEvery([DOWN], { account: "acct-u1", timeoutMs: 1_000 })).status).toBe(0);
  });
});

describe("portal lookups ask every coordinator, with one down", () => {
  it("GET /portal/api/models merges the network's models and the coordinators' own", async () => {
    const app = Fastify();
    apps.push(app);
    registerChatApiRoutes(app, {
      store: null,
      getCurrentUser: async () => ({ userId: "u1" }),
      PORTAL_SERVICE_TOKEN: SERVICE,
      // The healthy pick: only one coordinator.
      discoverCoordinatorUrlsForPortal: async () => [urlOf(coordA)],
      everyCoordinatorUrl: async () => [DOWN, urlOf(coordA), urlOf(coordB)]
    } as never);
    const res = await app.inject({ method: "GET", url: "/portal/api/models" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { local: Array<{ name: string; running: boolean }>; swarm: Array<{ model: string; agentCount: number }> };
    expect(body.local).toEqual([{ name: "qwen3.5:4b", parameterSize: "4B", quantization: "Q4", running: true }]);
    expect(body.swarm.map((r) => [r.model, r.agentCount])).toEqual([
      ["qwen3-coder:30b", 3],
      ["qwen2.5-coder:7b", 3]
    ]);
  });

  it("GET /portal/api/machines lists the machine linked to the coordinator that is up", async () => {
    const app = Fastify();
    apps.push(app);
    registerMachineRoutes(app, {
      PORTAL_SERVICE_TOKEN: SERVICE,
      EXTERNAL_HTTP_TIMEOUT_MS: 2_000,
      discoverCoordinatorUrlsForPortal: async () => [DOWN, urlOf(coordA), urlOf(coordB)],
      getCurrentUser: async () => ({ userId: "u1" }),
      store: { listNodesByOwner: async () => [{ nodeId: "mac-1", nodeKind: "agent" }, { nodeId: "gpu-1", nodeKind: "agent" }] }
    });
    const res = await app.inject({ method: "GET", url: "/portal/api/machines" });
    expect(res.statusCode).toBe(200);
    const machines = (res.json() as { machines: Array<{ agentId: string; connected: boolean }> }).machines;
    expect(machines.find((m) => m.agentId === "mac-1")?.connected).toBe(true);
    expect(machines.find((m) => m.agentId === "gpu-1")?.connected).toBe(false);
  });

  it("GET /portal/api/code/machines shows the Mac whose relay is on the coordinator that is up", async () => {
    const app = Fastify();
    apps.push(app);
    registerCodeRoutes(app, {
      PORTAL_SERVICE_TOKEN: SERVICE,
      EXTERNAL_HTTP_TIMEOUT_MS: 2_000,
      discoverCoordinatorUrlsForPortal: async () => [DOWN, urlOf(coordA), urlOf(coordB)],
      getCurrentUser: async () => ({ userId: "u1" }),
      store: { listNodesByOwner: async () => [{ nodeId: "mac-1", nodeKind: "agent" }] }
    });
    const res = await app.inject({ method: "GET", url: "/portal/api/code/machines" });
    expect(res.statusCode).toBe(200);
    const [mac] = (res.json() as { machines: Array<Record<string, unknown>> }).machines;
    expect(mac).toMatchObject({ agentId: "mac-1" });
    expect(JSON.stringify(mac)).toContain("Studio");
  });
});
