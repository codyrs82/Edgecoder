import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * #54 against the real coordinator app (Fastify inject): the routable model catalog is what the agent
 * reported in its signed /register and /heartbeat (read from its Ollama /api/tags), never an assumed
 * default; older agents that don't report keep registering and heartbeating.
 */

const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.54";
const MESH = "mesh-secret-test";
let portal: Server;
let app: any;

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
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

function signed(path: string, agentId: string, keys: PeerKeys, body: Record<string, unknown>) {
  const payload = JSON.stringify(body);
  const headers = signRequest({ method: "POST", path, bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId }) as unknown as Record<string, string>;
  return app.inject({
    method: "POST",
    url: path,
    remoteAddress: REMOTE,
    headers: { "content-type": "application/json", "x-mesh-token": MESH, ...headers },
    payload
  });
}

function register(agentId: string, keys: PeerKeys, extra: Record<string, unknown> = {}) {
  return signed("/register", agentId, keys, {
    agentId, os: "macos", version: "1", mode: "swarm-only", localModelProvider: "ollama-local",
    registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem, ...extra
  });
}

async function networkModels(): Promise<Map<string, number>> {
  const res = await app.inject({ method: "GET", url: "/inference/models", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
  expect(res.statusCode).toBe(200);
  return new Map((res.json().models as Array<{ model: string; agents: number }>).map((m) => [m.model, m.agents]));
}

describe("#54 reported model catalog", () => {
  test("only reported models are routable; a signed heartbeat refreshes them", async () => {
    const keys = createPeerKeys("agent-54-a");
    expect((await register("agent-54-a", keys, { installedModels: ["model-54-x:7b", "model-54-y:3b"] })).statusCode).toBe(200);
    let models = await networkModels();
    expect(models.get("model-54-x:7b")).toBe(1);
    expect(models.get("model-54-y:3b")).toBe(1);

    // The agent pulled one model and removed another: the next heartbeat says so.
    expect((await signed("/heartbeat", "agent-54-a", keys, { agentId: "agent-54-a", installedModels: ["model-54-x:7b", "model-54-z:14b"] })).statusCode).toBe(200);
    models = await networkModels();
    expect(models.get("model-54-z:14b")).toBe(1);
    expect(models.has("model-54-y:3b")).toBe(false);

    // A heartbeat-claimed active model that isn't installed doesn't make it routable.
    expect((await signed("/heartbeat", "agent-54-a", keys, { agentId: "agent-54-a", activeModel: "model-54-fake:70b" })).statusCode).toBe(200);
    expect((await networkModels()).has("model-54-fake:70b")).toBe(false);
  });

  test("an older agent that reports no models still registers and heartbeats, but no model is assumed routable", async () => {
    const keys = createPeerKeys("agent-54-old");
    expect((await register("agent-54-old", keys)).statusCode).toBe(200);
    expect((await signed("/heartbeat", "agent-54-old", keys, { agentId: "agent-54-old", activeModel: "model-54-legacy:7b" })).statusCode).toBe(200);
    expect((await networkModels()).has("model-54-legacy:7b")).toBe(false);
  });
});
