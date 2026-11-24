import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerChatApiRoutes } from "../../src/portal/routes/chat.js";
import { computeOptions } from "../../src/portal/routes/compute.js";
import { swarmModelsFromInference } from "../../src/portal/network-models.js";
import { BUILTIN_CLOUD_MODELS, orderCloudModels, parseCloudCatalog, parseCloudModelSpec } from "../../src/cloud-host/catalog.js";

// GET /portal/api/models (the iPhone app's model picker): `swarm` comes from the coordinator's
// /inference/models, cloud models included, in the shape the app's PortalSwarmModel decodes.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** What a coordinator answers today: /inference/models with a GPU model, both cloud models (GLM listed first), a restricted one. */
const INFERENCE_MODELS = {
  models: [
    { model: "glm-5.3", agents: 1, classes: ["cloud"], paramsB: 744, contextWindow: 1_000_000, cSatsPerMTokens: { input: 2, output: 6 }, origin: { vendor: "Z.ai (Zhipu AI)", country: "CN" }, hostedBy: "fireworks", cloudRank: 2, cloudHint: "premium" },
    { model: "qwen3-coder:30b", agents: 2, classes: ["gpu"], paramsB: 30, contextWindow: 32_768, cSatsPerMTokens: { input: 1, output: 3 } },
    { model: "deepseek-v4.1-flash", agents: 1, classes: ["cloud"], paramsB: 552, contextWindow: 1_000_000, origin: { vendor: "DeepSeek", country: "CN" }, hostedBy: "fireworks", cloudRank: 1, cloudHint: "recommended" },
    // An older coordinator: no paramsB.
    { model: "qwen2.5-coder:7b", agents: 3, classes: ["apple", "cpu"] },
    { model: "sec-model:70b", agents: 1, classes: ["gpu.dc"], restricted: "security" },
  ],
  classes: {},
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function stubCoordinator(opts: { inferenceStatus?: number } = {}) {
  const seen: Array<{ path: string; headers: Record<string, unknown> }> = [];
  const co = Fastify();
  co.get("/portal/models", async (req, reply) => {
    seen.push({ path: "/portal/models", headers: req.headers });
    // What production answers: the portal token is not enough for this path.
    return reply.code(401).send({ error: "mesh_unauthorized" });
  });
  co.get("/inference/models", async (req, reply) => {
    seen.push({ path: "/inference/models", headers: req.headers });
    if (opts.inferenceStatus && opts.inferenceStatus !== 200) return reply.code(opts.inferenceStatus).send({ error: "nope" });
    return INFERENCE_MODELS;
  });
  await co.listen({ port: 0, host: "127.0.0.1" });
  apps.push(co);
  const addr = co.server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, seen };
}

async function portalWith(coordinatorUrl: string | null, user: { userId: string } | null = { userId: "u1" }) {
  const app = Fastify();
  registerChatApiRoutes(app, {
    store: null,
    getCurrentUser: async () => user,
    PORTAL_SERVICE_TOKEN: "svc-token",
    discoverCoordinatorUrlsForPortal: async () => (coordinatorUrl ? [coordinatorUrl] : []),
  } as never);
  apps.push(app);
  return app;
}

/** The stored properties of a Swift struct: `let name: Type` (optional when `Type?`). */
function swiftFields(source: string, struct: string): Array<{ name: string; type: string; optional: boolean }> {
  const start = source.indexOf(`struct ${struct}`);
  expect(start, `struct ${struct} in the Swift source`).toBeGreaterThan(-1);
  const body = source.slice(source.indexOf("{", start) + 1, source.indexOf("\n}", start));
  return [...body.matchAll(/^\s*let\s+(\w+)\s*:\s*([\w[\]]+)(\?)?/gm)].map((m) => ({ name: m[1], type: m[2], optional: !!m[3] }));
}

describe("GET /portal/api/models", () => {
  it("builds swarm from the coordinator's /inference/models: numeric sizes, cloud rows, Flash before GLM, no restricted model", async () => {
    const co = await stubCoordinator();
    const app = await portalWith(co.url);
    // The shipped iPhone app (no ?cloud=1) gets no cloud rows: it would show paramSize as cSats.
    const plain = (await app.inject({ method: "GET", url: "/portal/api/models" })).json() as { swarm: Array<Record<string, any>> };
    expect(plain.swarm.map((r) => r.model)).toEqual(["qwen3-coder:30b", "qwen2.5-coder:7b"]);
    const res = await app.inject({ method: "GET", url: "/portal/api/models?cloud=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { local: unknown[]; swarm: Array<Record<string, any>> };
    // local: unchanged (the coordinator's own Ollama list; empty when it refuses).
    expect(body.local).toEqual([]);
    expect(body.swarm.map((r) => r.model)).toEqual(["deepseek-v4.1-flash", "qwen3-coder:30b", "glm-5.3", "qwen2.5-coder:7b"]);
    for (const r of body.swarm) {
      expect(typeof r.paramSize, r.model).toBe("number");
      expect(Number.isFinite(r.paramSize) && r.paramSize > 0, r.model).toBe(true);
      expect(Number.isInteger(r.agentCount), r.model).toBe(true);
    }
    expect(body.swarm.find((r) => r.model === "qwen2.5-coder:7b")!.paramSize).toBe(7); // from the tag
    expect(body.swarm.find((r) => r.model === "deepseek-v4.1-flash")).toMatchObject({ paramSize: 552, agentCount: 1, cloud: true, label: "Cloud · recommended", classes: ["cloud"] });
    expect(body.swarm.find((r) => r.model === "glm-5.3")).toMatchObject({ paramSize: 744, agentCount: 1, cloud: true, label: "Cloud · premium" });
    expect(body.swarm.find((r) => r.model === "qwen3-coder:30b")!.cloud).toBeUndefined();
    // Asked as the portal, for the signed-in user's account.
    const call = co.seen.find((s) => s.path === "/inference/models")!;
    expect(call.headers["x-portal-service-token"]).toBe("svc-token");
    expect(call.headers["x-edgecoder-account"]).toBe("acct-u1");
  });

  it("every swarm row carries the fields the iPhone app's PortalSwarmModel requires, with matching JSON types", async () => {
    const swift = readFileSync(join(ROOT, "ios", "EdgeCoderIOS", "EdgeCoderIOS", "Chat", "ModelPickerModels.swift"), "utf8");
    const fields = swiftFields(swift, "PortalSwarmModel");
    expect(fields.map((f) => f.name).sort()).toEqual(["agentCount", "model", "paramSize"]);
    const response = swiftFields(swift, "PortalModelsResponse");
    expect(response).toEqual([
      { name: "local", type: "[PortalLocalModel]", optional: true },
      { name: "swarm", type: "[PortalSwarmModel]", optional: true },
    ]);
    const check: Record<string, (v: unknown) => boolean> = {
      String: (v) => typeof v === "string",
      Double: (v) => typeof v === "number" && Number.isFinite(v),
      Int: (v) => typeof v === "number" && Number.isInteger(v),
      Bool: (v) => typeof v === "boolean",
    };
    const co = await stubCoordinator();
    const body = (await (await portalWith(co.url)).inject({ method: "GET", url: "/portal/api/models" })).json() as { swarm: Array<Record<string, unknown>> };
    expect(body.swarm.length).toBeGreaterThan(0);
    for (const row of body.swarm) {
      for (const f of fields) {
        if (f.optional && (row[f.name] === undefined || row[f.name] === null)) continue;
        expect(check[f.type], `Swift type ${f.type}`).toBeDefined();
        expect(check[f.type](row[f.name]), `${row.model}.${f.name} as ${f.type}: ${JSON.stringify(row[f.name])}`).toBe(true);
      }
    }
  });

  it("answers an empty swarm (not an error) when the coordinator's list fails, and 401 when signed out", async () => {
    const co = await stubCoordinator({ inferenceStatus: 503 });
    const res = await (await portalWith(co.url)).inject({ method: "GET", url: "/portal/api/models" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ local: [], swarm: [] });
    expect((await (await portalWith(null)).inject({ method: "GET", url: "/portal/api/models" })).json()).toEqual({ local: [], swarm: [] });
    expect((await (await portalWith(co.url, null)).inject({ method: "GET", url: "/portal/api/models" })).statusCode).toBe(401);
  });

  it("swarmModelsFromInference tolerates junk and counts a listed cloud model as online", () => {
    expect(swarmModelsFromInference(undefined)).toEqual([]);
    expect(swarmModelsFromInference([null, 3, { model: "" }, { model: "glm-5.3", agents: 0, classes: ["cloud"], cloudRank: 2 }])).toEqual([
      { model: "glm-5.3", paramSize: 744, agentCount: 1, classes: ["cloud"], cloud: true, label: "Cloud" },
    ]);
  });
});

describe("the web chat's compute picker with cloud models", () => {
  it("lists Flash before GLM, labelled Cloud · recommended / premium, and never as your own machines", () => {
    const opts = computeOptions(INFERENCE_MODELS.models, { gpu: { cSatsPerSecondBaseTier: 0.5 }, cloud: { cSatsPerSecondBaseTier: 0.7 } }, [], Date.now());
    const network = opts.filter((o) => o.group === "network");
    const cloud = network.filter((o) => o.detail.startsWith("Cloud"));
    expect(cloud.map((o) => [o.compute.model, o.detail])).toEqual([
      ["deepseek-v4.1-flash", "Cloud · recommended · hosted model API"],
      ["glm-5.3", "Cloud · premium · hosted model API"],
    ]);
    expect(cloud.every((o) => o.compute.target === "network" && "computeClass" in o.compute && o.compute.computeClass === "any")).toBe(true);
    expect(network[0].compute.model).toBe("deepseek-v4.1-flash");
    expect(opts.filter((o) => o.group === "mine").map((o) => o.compute.model)).not.toContain("glm-5.3");
    expect(opts.filter((o) => o.group === "mine").map((o) => o.compute.model)).not.toContain("deepseek-v4.1-flash");
    // Other models keep their rows.
    expect(network.some((o) => o.compute.model === "qwen3-coder:30b" && "computeClass" in o.compute && o.compute.computeClass === "gpu")).toBe(true);
  });
});

describe("cloud catalog order and flags", () => {
  it("Flash is the default (rank 1, recommended, auto-eligible); GLM-5.3 is premium and not auto-eligible", () => {
    const byId = Object.fromEntries(BUILTIN_CLOUD_MODELS.map((m) => [m.id, m]));
    expect(byId["deepseek-v4.1-flash"]).toMatchObject({ rank: 1, hint: "recommended", autoEligible: true });
    expect(byId["glm-5.3"]).toMatchObject({ rank: 2, hint: "premium", autoEligible: false });
    expect(orderCloudModels(parseCloudCatalog(undefined), (m) => m.id).map((m) => m.id)).toEqual(["deepseek-v4.1-flash", "glm-5.3"]);
  });

  it("orderCloudModels reorders only the cloud rows, in their own slots", () => {
    const rows = ["glm-5.3", "a", "deepseek-v4.1-flash", "b"];
    expect(orderCloudModels(rows, (r) => r)).toEqual(["deepseek-v4.1-flash", "a", "glm-5.3", "b"]);
  });

  it("CLOUD_MODELS_JSON entries take rank, hint and autoEligible (defaults: 100, none, false) and refuse bad values", () => {
    const base = { id: "kimi-k3", providerModel: "accounts/fireworks/models/kimi-k3", usdPerM: { input: 1, output: 3 } };
    expect(parseCloudModelSpec(base)).toMatchObject({ rank: 100, autoEligible: false });
    expect(parseCloudModelSpec(base).hint).toBeUndefined();
    expect(parseCloudModelSpec({ ...base, rank: 0, hint: "premium", autoEligible: true })).toMatchObject({ rank: 0, hint: "premium", autoEligible: true });
    expect(() => parseCloudModelSpec({ ...base, rank: 1.5 })).toThrow(/rank/);
    expect(() => parseCloudModelSpec({ ...base, hint: "cheap" })).toThrow(/hint/);
    expect(() => parseCloudModelSpec({ ...base, autoEligible: "yes" })).toThrow(/autoEligible/);
  });
});
