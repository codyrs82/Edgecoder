import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";
import { FRONTIER_REFUSED_ERROR, runInferenceSubtask } from "../../src/swarm/inference-runner.js";
import { agentHasModel, normalizeReportedModels, routableModels } from "../../src/swarm/model-catalog.js";
import { routeFromModelId } from "../../src/inference-api/auto-route.js";
import type { Subtask } from "../../src/common/types.js";

/*
 * Frontier models (the user's own API key, docs/frontier-keys.md) are never network work: an agent
 * can't advertise them, the coordinator won't route or accept them, and an agent that is handed one
 * anyway refuses it before anything runs. The agent's code can't even reach the frontier backend.
 */

const FRONTIER = "frontier/anthropic/claude-opus-5-5";

describe("the agent side", () => {
  test("the inference runner refuses a claimed subtask naming a frontier model, before any model call", async () => {
    const posted: unknown[] = [];
    const st = { id: "st-1", taskId: "t-1", kind: "inference", requestedModel: FRONTIER, input: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) } as unknown as Subtask;
    // An Ollama host that would fail loudly if reached.
    const r = await runInferenceSubtask(st, { agentId: "agent-x", ollamaHost: "http://127.0.0.1:9", post: async (path, body) => void posted.push({ path, body }) });
    expect(r).toMatchObject({ ok: false, error: FRONTIER_REFUSED_ERROR, durationMs: 0 });
    expect(posted).toEqual([]);
    // Case and padding don't slip past.
    const r2 = await runInferenceSubtask({ ...st, requestedModel: " Frontier/anthropic/x" } as Subtask, { agentId: "agent-x", ollamaHost: "http://127.0.0.1:9", post: async () => undefined });
    expect(r2.error).toBe(FRONTIER_REFUSED_ERROR);
  });

  test("the agent's code never imports the frontier backend or the key store", () => {
    for (const file of ["src/swarm/worker-runner.ts", "src/swarm/inference-runner.ts", "src/swarm/model-catalog.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src).not.toMatch(/frontier-access|frontier-keys|inference-api\/frontier\.js|frontier-usage/);
    }
  });

  test("frontier ids are never in an agent's catalog, routable, or a route (bots included)", () => {
    expect(normalizeReportedModels(["qwen3-coder:30b", FRONTIER, "FRONTIER/openai/gpt-5"])).toEqual(["qwen3-coder:30b"]);
    const cap = { modelsReported: true, localModelCatalog: ["qwen3-coder:30b", FRONTIER] };
    expect(routableModels(cap)).toEqual(["qwen3-coder:30b"]);
    expect(agentHasModel(cap, FRONTIER)).toBe(false);
    expect(routeFromModelId(FRONTIER)).toBeNull();
  });
});

describe("the coordinator", () => {
  const MESH = "mesh-secret-frontier";
  const TOKEN = "valid-registration-token";
  const REMOTE = "203.0.113.45";
  let portal: Server;
  let app: any;
  const requester = createPeerKeys("agent-frontier-requester");
  const worker = createPeerKeys("agent-frontier-worker");

  const post = (url: string, body: unknown, signer = requester) => {
    const payload = JSON.stringify(body);
    const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
    return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
  };

  beforeAll(async () => {
    portal = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.url === "/internal/nodes/validate" && body.registrationToken === TOKEN ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }));
      });
    });
    await new Promise<void>((r) => portal.listen(0, "127.0.0.1", r));
    process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
    process.env.MESH_AUTH_TOKEN = MESH;
    delete process.env.COORDINATOR_TRUST_PROXY;
    delete process.env.FLY_APP_NAME;
    delete process.env.MESH_PEER_ALLOWLIST;
    delete process.env.DATABASE_URL;
    ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
    await app.ready();
    for (const keys of [requester, worker]) {
      // The worker claims a frontier model among its installed ones (a modified or confused agent).
      const payload = JSON.stringify({
        os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: TOKEN, publicKeyPem: keys.publicKeyPem,
        sandboxMode: "docker", installedModels: keys === worker ? ["qwen-frontier-test:7b", FRONTIER] : [],
      });
      const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
      const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
      expect(res.statusCode).toBe(200);
    }
    await grantCredits(requester.peerId, 1_000_000, "test_funding");
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => portal.close(() => r()));
  });

  test("refuses a submit naming a frontier model, and never lists one", async () => {
    const res = await post("/inference/submit", { taskId: `inf-${randomUUID()}`, submitterAccountId: requester.peerId, model: FRONTIER, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("frontier_model_not_routable");
    const listed = await app.inject({ method: "GET", url: "/inference/models", remoteAddress: REMOTE });
    const models = (listed.json().models ?? []).map((m: { model: string }) => m.model);
    expect(models).toContain("qwen-frontier-test:7b");
    expect(models.some((m: string) => m.toLowerCase().startsWith("frontier/"))).toBe(false);
    const available = await app.inject({ method: "GET", url: "/models/available", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
    expect(available.statusCode).toBe(200);
    expect(available.body.toLowerCase()).not.toContain("frontier/");
  });
});
